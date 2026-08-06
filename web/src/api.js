let csrfToken = null;
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

async function request(path, options = {}) {
  const method = options.method ?? "GET";
  const response = await fetch(`${API_BASE}${path}`, { credentials: "include", headers: { "content-type": "application/json", ...(method !== "GET" && csrfToken ? { "x-csrf-token": csrfToken } : {}), ...(options.headers ?? {}) }, ...options });
  const result = await response.json().catch(() => ({ ok: false, error: { message: "服务器返回了无效响应" } }));
  if (!response.ok || !result.ok) throw Object.assign(new Error(result.error?.message ?? "请求失败"), { code: result.error?.code, status: response.status });
  return result.data;
}

export const session = {
  async get() { const data = await request("/api/v1/session"); csrfToken = data.csrfToken ?? null; return data; },
  async login(password) { const data = await request("/api/v1/session/login", { method: "POST", body: JSON.stringify({ password }) }); csrfToken = data.csrfToken; return data; },
  async logout() { const data = await request("/api/v1/session/logout", { method: "POST" }); csrfToken = null; return data; },
};

export const workspaces = {
  list: () => request("/api/v1/workspaces"),
  create: (displayName) => request("/api/v1/workspaces", { method: "POST", body: JSON.stringify({ displayName }) }),
};

export const workflow = {
  execute: (command, payload) => request("/api/v1/execute", { method: "POST", body: JSON.stringify({ command, payload }) }),
  importDocument: (workspaceId, input) => workflow.execute("document:import", { workspaceId, ...input }),
  getImport: (workspaceId, importId) => workflow.execute("document:get", { workspaceId, importId }),
  confirmImport: (workspaceId, importId) => workflow.execute("document:confirm", { workspaceId, importId }),
  create: (workspaceId, input) => workflow.execute("workflow:create", { workspaceId, ...input }),
  get: (workspaceId, workflowId) => workflow.execute("workflow:get", { workspaceId, workflowId }),
  list: (workspaceId) => workflow.execute("workflow:list", { workspaceId }),
  submitPlan: (workspaceId, workflowId, expectedVersion) => workflow.execute("plan:submit", { workspaceId, workflowId, expectedVersion }),
  decidePlan: (workspaceId, workflowId, expectedVersion, decision) => workflow.execute("plan:decide", { workspaceId, workflowId, expectedVersion, decision }),
  assembleContext: (workspaceId, workflowId) => workflow.execute("context:assemble", { workspaceId, workflowId }),
  getContext: (workspaceId, workflowId) => workflow.execute("context:get", { workspaceId, workflowId }),
  decideContext: (workspaceId, workflowId, expectedVersion, decision) => workflow.execute("context:decide", { workspaceId, workflowId, expectedVersion, decision }),
  enqueueTranslation: (workspaceId, workflowId, request) => workflow.execute("translation:enqueue", { workspaceId, workflowId, request }),
  getTask: (workspaceId, taskId) => workflow.execute("translation:task-get", { workspaceId, taskId }),
  runNextOffline: (workspaceId) => workflow.execute("translation:run-next", { workspaceId }),
  getBundle: (workspaceId, workflowId) => workflow.execute("working-copy:get", { workspaceId, workflowId }),
  listCandidates: (workspaceId, workflowId, segmentId) => workflow.execute("candidate:list", { workspaceId, workflowId, segmentId }),
  selectCandidate: (workspaceId, workflowId, segmentId, candidateId, expectedHeadVersion) => workflow.execute("candidate:select", { workspaceId, workflowId, segmentId, candidateId, expectedHeadVersion }),
  editSegment: (workspaceId, workflowId, segmentId, expectedHeadVersion, text) => workflow.execute("working-copy:edit", { workspaceId, workflowId, segmentId, expectedHeadVersion, text }),
  validate: (workspaceId, workflowId) => workflow.execute("validate", { workspaceId, workflowId }),
  getValidation: (workspaceId, validationRunId) => workflow.execute("validation:get", { workspaceId, validationRunId }),
  confirmWarning: (workspaceId, workflowId, validationRunId, findingId) => workflow.execute("warning:confirm", { workspaceId, workflowId, validationRunId, findingId }),
  review: (workspaceId, workflowId, validationRunId, expectedWorkflowVersion, qualityRunId = null) => workflow.execute("review", { workspaceId, workflowId, validationRunId, expectedWorkflowVersion, ...(qualityRunId ? { qualityRunId } : {}) }),
  approve: (workspaceId, workflowId, validationRunId, expectedWorkflowVersion, qualityRunId = null) => workflow.execute("approve", { workspaceId, workflowId, validationRunId, expectedWorkflowVersion, ...(qualityRunId ? { qualityRunId } : {}) }),
  runQuality: (workspaceId, workflowId, options = {}) => workflow.execute("quality:run", { workspaceId, workflowId, options }),
  confirmQualityWarning: (workspaceId, workflowId, qualityRunId, findingId) => workflow.execute("quality:confirm-warning", { workspaceId, workflowId, qualityRunId, findingId }),
  reviewList: (workspaceId, workflowId) => workflow.execute("review:list", { workspaceId, workflowId }),
  export: (workspaceId, workflowId, validationRunId, format, qualityRunId = null) => workflow.execute("export", { workspaceId, workflowId, validationRunId, format, ...(qualityRunId ? { qualityRunId } : {}) }),
  getFlow: (workspaceId, workflowId) => workflow.execute("flow:get", { workspaceId, workflowId }),
  resolveFlow: (workspaceId, workflowId, expectedVersion, action, request = null) => workflow.execute("flow:resolve", { workspaceId, workflowId, expectedVersion, action, request }),
};

export const providerConfig = {
  list: () => request("/api/v1/provider-config"),
  createSource: (input) => request("/api/v1/provider-config/sources", { method: "POST", body: JSON.stringify(input) }),
  setPreset: (input) => request("/api/v1/provider-config/presets", { method: "POST", body: JSON.stringify(input) }),
};

export const knowledge = {
  search: (workspaceId, request) => workflow.execute("knowledge:search", { workspaceId, request }),
  rebuild: (workspaceId) => workflow.execute("knowledge:rebuild", { workspaceId }),
  list: (workspaceId, input = {}) => workflow.execute("knowledge:fact-list", { workspaceId, ...input }),
  create: (workspaceId, input) => workflow.execute("knowledge:fact-create", { workspaceId, ...input }),
  revise: (workspaceId, input) => workflow.execute("knowledge:fact-revise", { workspaceId, ...input }),
  setState: (workspaceId, input) => workflow.execute("knowledge:fact-state", { workspaceId, ...input }),
};
