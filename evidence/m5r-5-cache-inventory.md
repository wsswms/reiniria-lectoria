# M5R.5 cache inventory and cleanup guidance

The machine-readable companion is `evidence/m5r-5-cache-inventory.json`. It records one fixed, offline populated-workspace measurement; byte lengths are UTF-8 bytes for database text and file bytes for the derived FTS index.

| Class | Location | Role | Backup | Rebuildable | Cleanup guidance |
| --- | --- | --- | --- | --- | --- |
| Web Search artifacts | `web_search_artifact_results` | Normalized discovery evidence | included | no | Keep with its Report; remove only through a future audited retention migration |
| Provider content snapshots | `provider_content_snapshots` | Citation-verifiable processed content | included | no | Keep while citations depend on it; review on workspace archive |
| Restricted Fetch snapshots | `internet_fetch_snapshots` | Direct bounded Web evidence | included | no | Keep while proposals or citations depend on it; review on archive |
| Research reports | `research_reports` | Immutable research outcomes | included | no | Keep as an audit fact while dependent proposals exist |
| Proposal research bindings | `knowledge_proposal_research_evidence` | Claim/Citation provenance | included | no | Keep with proposal decisions and applications |
| Knowledge FTS index | `derived/knowledge-index.sqlite3` | Local retrieval acceleration | excluded | yes | Delete when stale or before backup; rebuild from active facts |

The first five classes are business or audit facts, not disposable performance caches. Automatic deletion is intentionally not implemented in M5R. The FTS index is the only safely disposable class in this inventory.

The fixed M5R.5 verification result is recorded in `evidence/m5r-5-result.json`. The complete 293-test regression ran with no network, a read-only root filesystem, and a bounded temporary filesystem; M5R.5 made no external service calls.
