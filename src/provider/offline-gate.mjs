export class OfflineTaskGate {
  constructor(orchestrator, { isOnline = () => true, checkedAt = () => new Date() } = {}) {
    this.orchestrator = orchestrator;
    this.isOnline = isOnline;
    this.checkedAt = checkedAt;
  }

  guard(taskId) {
    const online = this.isOnline() === true;
    if (!online) {
      const task = this.orchestrator.getTask(taskId);
      if (["queued", "running"].includes(task.task.state)) this.orchestrator.pauseOffline(taskId, "network-offline");
      return Object.freeze({ online: false, runnable: false, reason: "network-offline", checkedAt: this.checkedAt().toISOString() });
    }
    const task = this.orchestrator.getTask(taskId);
    const policy = this.orchestrator.database.prepare("SELECT offline_reason FROM task_execution_policies WHERE workspace_id = ? AND task_id = ?")
      .get(this.orchestrator.workspaceId, taskId);
    if (task.task.state === "paused" && policy?.offline_reason === "network-offline") this.orchestrator.resume(taskId);
    return Object.freeze({ online: true, runnable: true, reason: null, checkedAt: this.checkedAt().toISOString() });
  }
}
