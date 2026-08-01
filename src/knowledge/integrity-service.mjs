export class KnowledgeIntegrityService {
  constructor(database, trustedWorkspaceId, { facts, retriever, investigations, iterations } = {}) {
    if (!facts || !retriever || !investigations || !iterations) throw new TypeError("knowledge integrity dependencies are required");
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.facts = facts;
    this.retriever = retriever;
    this.investigations = investigations;
    this.iterations = iterations;
  }

  async diagnose() {
    const failures = [];
    if (this.database.pragma("integrity_check", { simple: true }) !== "ok") failures.push("database");
    if (this.database.pragma("foreign_key_check").length > 0) failures.push("foreign-key");
    const sources = await this.facts.verifySources();
    if (sources.failures.length > 0) failures.push("fact-source");
    const snapshots = this.database.prepare("SELECT fetch_snapshot_id AS id FROM internet_fetch_snapshots WHERE workspace_id = ? ORDER BY fetch_snapshot_id")
      .all(this.workspaceId);
    for (const row of snapshots) try { this.investigations.getFetch(row.id); } catch { failures.push(`fetch:${row.id}`); }
    const applications = this.database.prepare("SELECT proposal_id AS id FROM knowledge_proposal_applications WHERE workspace_id = ? ORDER BY proposal_id")
      .all(this.workspaceId);
    for (const row of applications) try { this.iterations.get(row.id); } catch { failures.push(`application:${row.id}`); }
    let manifest;
    try { manifest = this.retriever.manifest(); } catch { failures.push("index"); }
    if (failures.length > 0) throw Object.assign(new Error("knowledge integrity check failed"), { failures: Object.freeze(failures) });
    return Object.freeze({ workspaceId: this.workspaceId, facts: sources.checked, fetchSnapshots: snapshots.length,
      applications: applications.length, factSetDigest: manifest.factSetDigest, status: "ok" });
  }

  async repairDerived() {
    await this.retriever.rebuild();
    return this.diagnose();
  }
}
