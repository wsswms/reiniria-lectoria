async function request(path, options = {}) {
  const response = await fetch(path, { credentials: "include", headers: { "content-type": "application/json", ...(options.headers ?? {}) }, ...options });
  const result = await response.json().catch(() => ({ ok: false, error: { message: "服务器返回了无效响应" } }));
  if (!response.ok || !result.ok) throw Object.assign(new Error(result.error?.message ?? "请求失败"), { code: result.error?.code, status: response.status });
  return result.data;
}

export const session = {
  get: () => request("/api/v1/session"),
  login: (password) => request("/api/v1/session/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request("/api/v1/session/logout", { method: "POST" }),
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
  submitPlan: (workspaceId, workflowId, expectedVersion) => workflow.execute("plan:submit", { workspaceId, workflowId, expectedVersion }),
  decidePlan: (workspaceId, workflowId, expectedVersion, decision) => workflow.execute("plan:decide", { workspaceId, workflowId, expectedVersion, decision }),
};
