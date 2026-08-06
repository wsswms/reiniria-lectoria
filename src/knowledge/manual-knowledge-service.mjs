import { randomUUID } from "node:crypto";
import { KnowledgeFactService } from "./fact-service.mjs";

const KINDS = new Set(["term", "style", "knowledge"]);
const required = (value, name) => {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} is required`);
  return value.trim();
};

/**
 * The HTTP-facing, intentionally small manual knowledge facade. It creates
 * immutable fact revisions through KnowledgeFactService and never exposes
 * direct table CRUD to callers.
 */
export class ManualKnowledgeService {
  constructor({ root, database, workspaceId, retriever, id = () => randomUUID() }) {
    this.facts = new KnowledgeFactService(root, database, workspaceId);
    this.retriever = retriever;
    this.id = id;
  }

  list(input = {}) {
    const state = input.state === undefined ? undefined : required(input.state, "state");
    const kinds = input.kinds === undefined ? undefined : input.kinds;
    return this.facts.list({ state, kinds });
  }

  async create(input, actor) {
    const source = this.#source(input, false);
    const created = await this.facts.create(source, actor);
    if (input.initialState === "draft" || input.initialState === "discarded") {
      this.facts.setActive(created.source.factId, created.head.version, false, actor);
    }
    await this.retriever?.rebuild?.();
    return this.facts.get(source.factId);
  }

  async revise(input, actor) {
    const source = this.#source(input, true);
    const revised = await this.facts.revise(source.factId, input.expectedHeadVersion, source, actor);
    await this.retriever?.rebuild?.();
    return revised;
  }

  setState(input, actor) {
    const active = input.state === "active";
    if (!active && !["inactive", "discarded", "draft"].includes(input.state)) throw new TypeError("state is invalid");
    const result = this.facts.setActive(input.factId, input.expectedHeadVersion, active, actor);
    return this.retriever?.rebuild?.().then(() => result) ?? result;
  }

  #source(input, revision) {
    if (!input || typeof input !== "object") throw new TypeError("manual knowledge input is required");
    const kind = required(input.kind, "kind");
    if (!KINDS.has(kind)) throw new TypeError("kind is invalid");
    const source = {
      schemaVersion: "1.0",
      factId: revision ? required(input.factId, "factId") : this.id(),
      revisionId: this.id(), kind,
      language: required(input.language, "language"),
      scope: input.scope ?? { targetLanguages: [], tags: [], documentIds: [] },
      content: input.content,
    };
    return source;
  }
}
