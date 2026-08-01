import { stableJson } from "../src/domain/contracts.mjs";
import { ResearchCacheInventoryService } from "../src/research/cache-inventory-service.mjs";
import { populatedResearchWorkspace } from "../tests/m5r-5/helpers.mjs";

const setup = await populatedResearchWorkspace("inventory-measurement");
try {
  const inventory = await new ResearchCacheInventoryService(setup.fixture.setup.fixture.root, setup.fixture.setup.fixture.database,
    setup.fixture.setup.fixture.workspaceId, { now: setup.fixture.now }).recordCurrent();
  process.stdout.write(`${stableJson({ schemaVersion: inventory.schemaVersion, coverage: inventory.coverage,
    entries: inventory.entries, recordedAt: inventory.recordedAt })}\n`);
} finally { await setup.fixture.close(); }
