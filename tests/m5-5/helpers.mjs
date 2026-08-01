import { randomUUID } from "node:crypto";
import { BraveSearchAdapter } from "../../src/search/brave-search-adapter.mjs";
import { RestrictedFetchProxy } from "../../src/search/fetch-proxy.mjs";
import { InvestigationService } from "../../src/search/investigation-service.mjs";
import { KnowledgeProposalService } from "../../src/search/knowledge-proposal-service.mjs";
import { capture, enqueueEvidence, evidenceWorkspace } from "../m5-3/helpers.mjs";
import { termInput } from "../m5-1/helpers.mjs";

export const user = Object.freeze({ type: "user", id: "m5-5-user" });
export const fixtureActor = Object.freeze({ type: "fixture", id: "m5-5-fixture" });
export const secretCanary = `M5-BRAVE-SECRET-${randomUUID()}`;

export function bravePayload(query = "workspace terminology") {
  return {
    type: "search", web: { type: "search", results: [
      { title: "Workspace terminology", url: "https://example.com/knowledge", description: `Public result for ${query}`, extra_snippets: ["ignored"] },
      { title: "Backup guide", url: "https://www.iana.org/help/example-domains", description: "Public backup reference" },
    ] }, query: { original: query }, extra: { ignored: true },
  };
}

export async function internetWorkspace({ html } = {}) {
  const setup = await evidenceWorkspace();
  const bound = enqueueEvidence(setup, capture(setup), "m5-5-task");
  const observations = [];
  const adapter = new BraveSearchAdapter({ fetchImpl: async (url, init) => {
    observations.push({ url, init });
    return new Response(JSON.stringify(bravePayload(new URL(url).searchParams.get("q"))), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const transportCalls = [];
  const fetchProxy = new RestrictedFetchProxy({
    now: setup.fixture.clock.now,
    resolver: async () => ["93.184.216.34"], robotsAllowed: async () => true,
    transport: async (request) => {
      transportCalls.push(request);
      return new Response(html ?? "<html><head><title>Public terminology</title><script>approve()</script></head><body><h1>Workspace</h1><p>Use 工作区 for the product term.</p></body></html>",
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  const investigations = new InvestigationService(setup.fixture.database, setup.fixture.workspaceId, {
    now: setup.fixture.clock.now, searchInvoker: (request) => adapter.search(request, { credential: secretCanary }),
    fetchProxy, handleKey: Buffer.alloc(32, 7),
  });
  const proposals = new KnowledgeProposalService(setup.fixture.database, setup.fixture.workspaceId, { now: setup.fixture.clock.now });
  const investigation = investigations.create({ taskId: bound.task.task.task_id, workflowId: setup.workflow.workflowId,
    segmentId: setup.workflow.segmentId, query: "workspace terminology", maxResults: 2, country: "US", searchLanguage: "en" }, user);
  return { ...setup, bound, adapter, observations, transportCalls, fetchProxy, investigations, proposals, investigation };
}

export async function searchAndFetch(setup) {
  const search = await setup.investigations.search(setup.investigation.investigationId);
  const result = search.results[0];
  const snapshot = await setup.investigations.fetch(setup.investigation.investigationId, result.resultId, result.handle, user);
  return { search, result, snapshot };
}

export function proposedTerm(setup, overrides = {}) {
  return termInput({
    factId: randomUUID(), revisionId: randomUUID(), language: "en",
    scope: { targetLanguages: ["zh-CN"], tags: [], documentIds: [setup.workflow.documentId] },
    content: { term: "workspace", preferredTranslations: [{ language: "zh-CN", text: "工作区" }],
      forbiddenTranslations: [], variants: [], note: "Public internet proposal" },
    ...overrides,
  });
}
