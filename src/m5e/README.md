# M5E isolated knowledge-effect experiment

This directory is an additive experiment boundary. It does not replace or modify the M5C production workflow.

The experiment provides deterministic knowledge-need clustering, coverage-capacity planning, four-arm cold/warm coordination, exact persisted-knowledge reuse probes, reference-family adjudication, blinded evaluation contracts, aggregate audit reporting, and fail-closed real-resource preflight.

Every arm invokes Planner independently. Source digests, the Planner configuration digest, knowledge snapshot lineage, and the external reference-family set are fixed and audited; candidate-set digests are outputs and may differ. Historical reference families are evaluation-only and are rejected if injected into Planner input.

Boundary rules:

- no direct Provider, Search, Fetch, or network calls;
- no imports from M5C, Provider, or Research production modules;
- no schema or migration ownership;
- no automatic knowledge approval;
- no fuzzy or LLM-authoritative cluster merges;
- no product-path integration until the experiment produces accepted effectiveness evidence.

Run `npm run test:m5e` for the isolated suite. The aggregate `npm test` also includes M5E while this experiment branch is under evaluation.
