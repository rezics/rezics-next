---
goal: imports
manager: imports
kind: implementation
paths:
  - services/importer/src/source-classification*.ts
  - services/importer/src/source-observation.ts
  - services/importer/src/import-contract.ts
  - services/importer/src/import-client.ts
  - services/importer/src/importer.ts
  - services/importer/src/run-store.ts
  - services/importer/src/source-registry.ts
  - services/importer/src/cli.ts
  - services/importer/src/record-bindings.ts
  - services/importer/src/inspection-store.ts
  - services/importer/src/binding-inspection-store.ts
  - services/importer/src/import-progress.ts
  - services/importer/src/state-backup-schema.ts
  - services/importer/src/retention.ts
  - packages/client/src/kernel/rating/source-classifications.d.ts
  - services/importer/tests/source-classification*.test.ts
  - services/importer/tests/source-observation*.test.ts
  - services/importer/tests/import-client.test.ts
  - services/kernel/test/imports/source-classification*.ts
  - services/kernel/test/imports/api-runtime.ts
  - services/importer/README.md
riskAreas: []
criticalPath: false
waiting: []
estimate:
  lines: 2200
  files: 21
after:
  - f0e8f3e9-17ae-4f3f-b91b-6cdb8f8a70e7
  - 9d57beb9-94ea-447a-9878-5227d4942189
  - d2243d75-acbc-4fcc-97b4-99303fbe5e4a
acceptance:
  tests:
    - "Import an admitted classification observation through the production converter/coordinator and mounted generated native client; bind the authentic Semantic association, preserve separate provenance/native ballots, recover unknown delivery and deliberate CAS resolution with immutable original intent, and independently read the result. Unadmitted VNDB payload/licence combinations have zero native effects."
---

Finish classification observation import after the generated Content client contract is available. Carry admitted converter output through the coordinator, resolve and verify exact Semantic associations, and persist one immutable operation in the aggregate journal. Complete independent head reads, unknown-delivery retry, deliberate compare-and-swap review, bounded operator inspection, binding inspection, retention, snapshot backup and restore, progress reporting, and the mounted native acceptance. Keep VNDB classification output unavailable until payload and rights admission are reviewed. Use authored fixtures with truthful attribution; do not present fixture data as VNDB data.
