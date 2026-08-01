import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function bounded(value, name, maximum) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

export class FakeResearchSearchAdapter {
  constructor(fixtures = []) { this.fixtures = fixtures; this.calls = []; this.id = "fake-search"; }
  async search(input) {
    const query = bounded(input.query, "query", 2_048);
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 10) throw new TypeError("count is invalid");
    this.calls.push(Object.freeze({ query, count: input.count }));
    const selected = this.fixtures.filter((item) => item.match === undefined || query.includes(item.match)).slice(0, input.count)
      .map((item, index) => Object.freeze({ rank: index + 1, url: new URL(item.url).toString(), title: bounded(item.title, "title", 2_048),
        description: typeof item.description === "string" ? item.description.slice(0, 8_192) : "" }));
    return Object.freeze({ adapterId: this.id, adapterVersion: "fake-search-v1", results: Object.freeze(selected),
      responseDigest: sha(stableJson(selected)), usage: Object.freeze({ searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 }) });
  }
}

export class FakeResearchContentAdapter {
  constructor(fixtures = []) { this.fixtures = new Map(fixtures.map((item) => [new URL(item.url).toString(), item])); this.calls = []; this.id = "fake-content"; }
  async extract(input) {
    const url = new URL(bounded(input.url, "url", 4_096)).toString();
    this.calls.push(Object.freeze({ url }));
    const fixture = this.fixtures.get(url);
    if (!fixture) throw Object.assign(new Error("fixture unavailable"), { category: "unavailable" });
    const content = bounded(fixture.content, "content", 262_144);
    return Object.freeze({ adapterId: this.id, adapterVersion: "fake-content-v1", url, content,
      contentDigest: sha(content), lineage: "provider-processed", untrusted: true,
      usage: Object.freeze({ searchCalls: 0, contentUrls: 1, modelTokens: 0, costMicrosUsd: 0 }) });
  }
}

export class FakeResearchModelAdapter {
  constructor() { this.calls = []; this.id = "fake-research-model"; }
  async reason(input) {
    const prompt = bounded(input.prompt, "prompt", 65_536);
    this.calls.push(Object.freeze({ promptDigest: sha(prompt) }));
    const payload = input.fixture && typeof input.fixture === "object" ? input.fixture : {};
    return Object.freeze({ adapterId: this.id, adapterVersion: "fake-research-model-v1",
      questions: Object.freeze(Array.isArray(payload.questions) ? payload.questions.map(String) : []),
      conclusion: String(payload.conclusion ?? "insufficient"), disputed: payload.disputed === true,
      usage: Object.freeze({ searchCalls: 0, contentUrls: 0, modelTokens: Math.max(1, Math.ceil(prompt.length / 4)), costMicrosUsd: 0 }) });
  }
}
