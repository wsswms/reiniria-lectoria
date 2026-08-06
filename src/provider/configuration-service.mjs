import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ADAPTERS = Object.freeze({
  deepseek: Object.freeze({ models: ["deepseek-v4-flash", "deepseek-v4-pro"], capabilities: { structuredOutput: true, thinking: true, toolCalling: true, serverSearch: true } }),
  "google-gemini": Object.freeze({ models: ["gemini-fixture-flash", "gemini-approved-fixture"], capabilities: { structuredOutput: true, thinking: false, toolCalling: false, serverSearch: false } }),
  openai: Object.freeze({ models: ["gpt-fixture", "gpt-approved-fixture"], capabilities: { structuredOutput: true, thinking: false, toolCalling: false, serverSearch: false } }),
});
const STAGES = new Set(["translation", "research", "qa", "dictionary", "entity", "web-search"]);
const TOOLS = new Set(["dictionary", "entity", "number", "web-search"]);
const slug = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export class ProviderConfigurationConflictError extends Error {
  constructor(message = "provider configuration conflict") { super(message); this.name = "ProviderConfigurationConflictError"; this.code = "PROVIDER_CONFIG_CONFLICT"; }
}

function required(value, name) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`); return value.trim(); }
function profileId(value, name) { const id = required(value, name); if (!slug.test(id)) throw new TypeError(`${name} must be a lowercase slug`); return id; }
function baseState() { return { schemaVersion: "provider-configuration-v1", revision: 0, sources: [], presets: [] }; }

export class ProviderConfigurationService {
  constructor(root, { now = () => new Date(), id = () => randomUUID() } = {}) {
    this.root = root; this.now = now; this.id = id;
    this.configDir = join(root, "config"); this.secretDir = join(root, "secrets", "providers"); this.file = join(this.configDir, "provider-profiles.json");
  }

  async list() {
    const state = await this.#read();
    return Object.freeze({ schemaVersion: state.schemaVersion, revision: state.revision,
      sources: Object.freeze(state.sources.map((source) => { const { credentialRef: _credentialRef, ...publicSource } = source; return Object.freeze({ ...publicSource, credentialConfigured: true }); })),
      presets: Object.freeze(state.presets.map((preset) => Object.freeze({ ...preset }))), adapters: ADAPTERS });
  }

  async createSource(input, expectedRevision = null) {
    const state = await this.#read(); this.#cas(state, expectedRevision);
    const sourceId = profileId(input?.sourceId ?? this.id(), "sourceId");
    const adapterId = required(input?.adapterId, "adapterId"); const adapter = ADAPTERS[adapterId];
    if (!adapter) throw new ProviderConfigurationConflictError("adapter is not registered");
    const modelId = required(input?.modelId, "modelId"); if (!adapter.models.includes(modelId)) throw new ProviderConfigurationConflictError("model is not allowed by the registered adapter");
    if (state.sources.some((source) => source.sourceId === sourceId)) throw new ProviderConfigurationConflictError("sourceId already exists");
    const credential = required(input?.credential, "credential");
    await mkdir(this.secretDir, { recursive: true, mode: 0o700 });
    const credentialRef = `file:${join(this.secretDir, `${sourceId}.key`)}`;
    await writeFile(credentialRef.slice(5), `${credential}\n`, { mode: 0o600, flag: "wx" });
    const source = { sourceId, displayName: required(input?.displayName ?? sourceId, "displayName"), adapterId, modelId, enabled: input?.enabled !== false, capabilities: adapter.capabilities, credentialRef, createdAt: this.now().toISOString() };
    try { return await this.#write({ ...state, revision: state.revision + 1, sources: [...state.sources, source] }); }
    catch (error) { throw error; }
  }

  async setPreset(input, expectedRevision = null) {
    const state = await this.#read(); this.#cas(state, expectedRevision);
    const presetId = profileId(input?.presetId ?? this.id(), "presetId"); const stage = required(input?.stage, "stage");
    if (!STAGES.has(stage)) throw new TypeError("stage is invalid");
    const source = state.sources.find((item) => item.sourceId === required(input?.sourceId, "sourceId"));
    if (!source || !source.enabled) throw new ProviderConfigurationConflictError("enabled source is required");
    const toolNames = input?.toolNames ?? []; if (!Array.isArray(toolNames) || toolNames.some((tool) => !TOOLS.has(tool))) throw new TypeError("toolNames are invalid");
    if (toolNames.includes("web-search") && !source.capabilities.serverSearch) throw new ProviderConfigurationConflictError("web-search requires a compatible model");
    const temperature = input?.temperature ?? 0.2; if (typeof temperature !== "number" || temperature < 0 || temperature > 2) throw new TypeError("temperature is invalid");
    const preset = { presetId, stage, sourceId: source.sourceId, modelId: source.modelId, thinking: input?.thinking === true, temperature, toolNames: [...toolNames], configDigest: digest(JSON.stringify({ sourceId: source.sourceId, modelId: source.modelId, stage, temperature, thinking: input?.thinking === true, toolNames })), updatedAt: this.now().toISOString() };
    const presets = state.presets.filter((item) => item.presetId !== presetId);
    return await this.#write({ ...state, revision: state.revision + 1, presets: [...presets, preset] });
  }

  async #read() { try { return JSON.parse(await readFile(this.file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; return baseState(); } }
  #cas(state, expectedRevision) { if (expectedRevision !== null && expectedRevision !== state.revision) throw new ProviderConfigurationConflictError("provider configuration revision conflict"); }
  async #write(state) { await mkdir(this.configDir, { recursive: true, mode: 0o700 }); const tmp = `${this.file}.${this.id()}.tmp`; await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); await rename(tmp, this.file); return this.list(); }
}

export { ADAPTERS };
