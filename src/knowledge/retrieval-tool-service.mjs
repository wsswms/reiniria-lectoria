function attemptScope(database, workspaceId, input) {
  const row = database.prepare(`
    SELECT attempt.workflow_id AS workflowId, attempt.segment_id AS segmentId,
           attempt.document_id AS documentId, attempt.target_language AS targetLanguage
    FROM translation_attempts attempt
    JOIN translation_tasks task ON task.workspace_id = attempt.workspace_id AND task.task_id = attempt.task_id
    JOIN translation_workflows workflow ON workflow.workspace_id = attempt.workspace_id
      AND workflow.workflow_id = attempt.workflow_id
    WHERE attempt.workspace_id = ? AND attempt.task_id = ? AND attempt.attempt_id = ?
      AND attempt.state IN ('queued', 'leased', 'running', 'retry-wait')
      AND task.state IN ('queued', 'running')
      AND workflow.state NOT IN ('stale', 'rejected', 'exported')
  `).get(workspaceId, input.taskId, input.attemptId);
  if (!row) throw new Error("retrieval tool scope denied");
  return row;
}

export function createRetrievalToolHandlers(database, trustedWorkspaceId, retriever) {
  const rows = database.prepare("SELECT workspace_id AS workspaceId FROM workspace_meta").all();
  if (rows.length !== 1 || rows[0].workspaceId !== trustedWorkspaceId) throw new Error("workspace identity mismatch");
  if (!retriever || typeof retriever.search !== "function") throw new TypeError("retriever is required");
  const invoke = (input, kinds) => {
    if (input.workspaceId !== trustedWorkspaceId) throw new Error("retrieval tool scope denied");
    const scope = attemptScope(database, trustedWorkspaceId, input);
    return retriever.search({
      query: input.query, language: scope.targetLanguage, kinds, tags: [],
      documentIds: [scope.documentId], topK: input.topK,
    });
  };
  return Object.freeze({
    lookupTerms: (input) => invoke(input, ["term"]),
    searchKnowledge: (input) => invoke(input, ["knowledge"]),
  });
}
