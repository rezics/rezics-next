---
goal: web
manager: web
kind: interface
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
waiting: []
paths:
  - apps/web/src/features/catalogue/source-observation/**
  - apps/web/tests/subject-source-observation*.test.ts*
  - docs/subject-pages.md
after:
  - a545f44d-fdef-4c4d-84d0-5c5f763760e0
  - 257dfd84-1047-4508-bb00-2780518ec3d9
  - 8f337800-dc95-4747-a443-f3c114a7372b
  - 46a3ed71-9afd-4024-98b6-52e10d0e13f7
  - ca407eef-3455-46da-8288-d933006d9e7a
  - 130c051d-c6b7-485b-a3cc-88ed4e7d40ab
estimate:
  lines: 150
  files: 4
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - "--private-network"
    - "--"
    - bun
    - test
    - subject-source-observation.test.tsx
  tests:
    - "An ordinary Subject reader opens a displayed provider observation from its exact admitted provider/record/digest, compares current and selected retained provenance and returns to the same Subject sources visit."
    - "Native concealed history can return empty-plus-next without fabricated exhaustion; exact/current concealment, changed source and optional dependency conflict retain distinct failure/retry behavior."
    - "Provider-local retirement releases old payloads and callbacks; VNDB/Bangumi/native enjoyment and classification remain independent, with no inferred importer or write permission."
  failing: true
  placement: default
---

Complete native provider observation inspection through the existing Subject Sources panel once the producer's
generated client publication is installed. The installed
`packages/client/src/kernel/rating/source-statistics.d.ts` still has no observations GET. Keep the existing explicit
unavailable state until that method is available; the mounted native route alone does not provide a typed client.

Read [Provider source observation inspection](../../docs/subject-pages.md#provider-source-observation-inspection),
`apps/web/src/features/catalogue/source-observation/{action.ts,contract.ts,reader.tsx}`, the installed generated method,
and `services/kernel/test/rating/source-observation-http.test.ts` examples before binding.

Bind the actual generated method with the original authenticated credentials, CSRF/session and locale boundary.
Readers must compare the current head with an exact admitted provider/record/digest, traverse one native history page
at a time, and return to the same Realm query with focus on the Sources heading. Preserve sparse empty-plus-next
continuation, exact/current 404, optional 409, same-cursor retry, concealment and retirement of late reads and old
callbacks. Retain one head, one selection and one history page; enjoyment, classification, writes and private import
remain independent. Add no reader, raw endpoint, client cast, substitute DTO or generator.

Preserve the frozen acceptance above. Native/shared producers and the normal controller own generation, preparation
and deferred native acceptance. The unavailable seam is already implemented; completing native inspection remains
the outcome of this continuation.
