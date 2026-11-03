---
goal: imports
manager: imports
kind: implementation
paths:
  - services/importer/src/import-client.ts
  - services/importer/src/import-contract.ts
  - packages/client/src/kernel/rating/source-classifications.d.ts
  - services/importer/tests/import-client.test.ts
  - services/kernel/test/imports/source-classification*.ts
  - services/kernel/test/imports/api-runtime.ts
  - services/importer/README.md
riskAreas: []
criticalPath: false
waiting: []
estimate:
  lines: 400
  files: 8
after:
  - f0e8f3e9-17ae-4f3f-b91b-6cdb8f8a70e7
  - 9d57beb9-94ea-447a-9878-5227d4942189
  - 7ddb94bc-e247-4f93-9e68-4a65ff41e983
acceptance:
  tests:
    - "Import an admitted classification observation through the production converter/coordinator and mounted generated native client; bind the authentic Semantic association, preserve separate provenance/native ballots, recover unknown delivery and deliberate CAS resolution with immutable original intent, and independently read the result. Unadmitted VNDB payload/licence combinations have zero native effects."
---

# Remaining outcome

Replace the documented HTTP classification seam with Content’s generated Kernel client methods and DTOs when they land. Prove the already staged converter projection, Semantic association binding, independent head read, sealed retry and deliberate CAS against mounted native routes. Keep public VNDB fields unadmitted until payload and rights review exists.
