---
goal: content
manager: content
kind: claim
paths:
  - packages/client/src/kernel/**
  - packages/client/src/index.ts
  - contracts/openapi.json
  - services/kernel/test/rating/own-votes-page.test.ts
acceptance:
  requirements:
    - Generate OpenAPI and the KernelClient together with the supported database-backed typecheck --emit-client --emit-openapi command from the complete mounted source after existing SQL compiler and declaration-emission failures are resolved; do not filter inputs or hand edit declarations.
    - Typecheck the kernel and client workspaces and run the focused Kernel test file once after the final edit; distinguish compile and infrastructure failures from executed outcomes.
    - Run the controller's frozen native counted-score acceptance for actual commands, identity jobs, source races, and fixed-key history growth with physical plans.
    - Publish the installed generated export, DTO, source and generated heads, currentness obligations, and distinct result states to Commerce and own-score receivers.
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
after:
  - fde5a113-246b-4aff-a56c-f209ac6ac5a5e
  - 848a1823-b046-48db-894a-d9a9a42729be
  - 4eb719ca-83ba-40ce-9172-5d91df345bbf
estimate:
  lines: 120
  files: 4
inseparable: true
---

Complete the installed generated delivery for the counted own-vote reader. The package entry already names its public DTOs, but the generated module and matching OpenAPI output are still needed. Generate both from the complete mounted source with `bun run --cwd services/kernel typecheck --emit-client --emit-openapi` once the existing compiler failures are resolved. Verify the exported DTO states and same-input currentness contract, run the kernel and client typechecks and the focused fixture, and leave the frozen native acceptance to the controller. Keep the existing reader and caller protocol.
