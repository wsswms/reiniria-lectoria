import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { dictionaryLookupRequestContract, entityLookupRequestContract } from "./contracts.mjs";
import { verifyReferenceResult } from "./reference-result.mjs";
import { TranslationToolConfigurationService } from "./translation-tool-configuration-service.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const requestContract = (kind, input) => kind === "dictionary"
  ? dictionaryLookupRequestContract(input) : entityLookupRequestContract(input);

export class TranslationReferenceCacheConflictError extends Error {}

export class TranslationReferenceCacheService {
  constructor(database, workspaceId, { configurations, now = () => new Date() } = {}) {
    this.database = database; this.workspaceId = workspaceId; this.now = now;
    this.configurations = configurations ?? new TranslationToolConfigurationService(database, workspaceId, { now });
  }

  get(taskId, kind, input) {
    if (!["dictionary", "entity"].includes(kind)) throw new TypeError("reference tool kind is invalid");
    const request = requestContract(kind, input);
    const binding = this.configurations.binding(taskId, kind);
    const requestDigest = sha(stableJson(request));
    const row = this.database.prepare(`SELECT result_json AS resultJson FROM translation_reference_cache_entries
      WHERE workspace_id = ? AND task_id = ? AND tool_kind = ? AND provider_id = ? AND provider_version = ? AND request_digest = ?`)
      .get(this.workspaceId, taskId, kind, binding.providerId, binding.providerVersion, requestDigest);
    return row ? verifyReferenceResult(JSON.parse(row.resultJson)) : null;
  }

  persist(taskId, kind, requestInput, resultInput) {
    if (!["dictionary", "entity"].includes(kind)) throw new TypeError("reference tool kind is invalid");
    const request = requestContract(kind, requestInput);
    const result = verifyReferenceResult(resultInput);
    const binding = this.configurations.binding(taskId, kind);
    if (result.toolKind !== kind || result.term !== request.term || result.providerId !== binding.providerId
      || result.providerVersion !== binding.providerVersion) throw new TranslationReferenceCacheConflictError("reference result binding mismatch");
    for (const source of result.sources) {
      const hostname = new URL(source.url).hostname.toLocaleLowerCase();
      if (!binding.allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
        throw new TranslationReferenceCacheConflictError("reference source is outside configured domains");
      }
    }
    const requestJson = stableJson(request); const requestDigest = sha(requestJson);
    const resultJson = stableJson(result);
    const existing = this.get(taskId, kind, request);
    if (existing) {
      if (stableJson(existing) !== resultJson) throw new TranslationReferenceCacheConflictError("reference request has a conflicting result");
      return existing;
    }
    const cacheEntryDigest = sha(stableJson({ taskId, kind, providerId: binding.providerId,
      providerVersion: binding.providerVersion, requestDigest, resultDigest: result.resultDigest }));
    try {
      this.database.transaction(() => {
        const count = this.database.prepare(`SELECT count(*) AS value FROM translation_reference_cache_entries
          WHERE workspace_id = ? AND task_id = ? AND tool_kind = ? AND provider_id = ? AND provider_version = ?`)
          .get(this.workspaceId, taskId, kind, binding.providerId, binding.providerVersion).value;
        if (count >= binding.maxCalls) throw new TranslationReferenceCacheConflictError(`${kind} tool call limit exceeded`);
        this.database.prepare(`INSERT INTO translation_reference_cache_entries
          (workspace_id, cache_entry_digest, task_id, tool_kind, provider_id, provider_version, request_digest,
            request_json, result_digest, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(this.workspaceId, cacheEntryDigest, taskId, kind, binding.providerId, binding.providerVersion,
            requestDigest, requestJson, result.resultDigest, resultJson, this.now().toISOString());
      })();
    } catch (error) {
      if (error instanceof TranslationReferenceCacheConflictError) throw error;
      const concurrent = this.get(taskId, kind, request);
      if (!concurrent || stableJson(concurrent) !== resultJson) throw new TranslationReferenceCacheConflictError("reference cache persistence conflict");
      return concurrent;
    }
    return result;
  }
}
