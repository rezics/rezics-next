---
goal: commerce
manager: commerce
kind: implementation
paths:
  - packages/client/src/kernel/library*
  - packages/client/tests/library-viewer-facts.test.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
after:
  - 360f7b9b-415b-4952-9625-c349ed050b0f
  - 8e9f5e61-0b92-48fa-aac2-cc370bcaf7e6
  - ba08c3d5-fdf3-4dd4-9cfd-3410ef0d2d25
  - 5139bcb6-26f9-42bf-8b5e-d8ca96a58910
waiting: []
estimate:
  lines: 20
  files: 2
---

# Generate the typed Library viewer facts client

## Acceptance

Use the supported Kernel compiler and database placement to emit and commit Library and readable Collection
client declarations. They must expose optional current `viewerFacts`, row states, producer currentness failures,
and the 100-row bound. Do not hand-edit schema or declarations or add a tooling workaround. Preserve unavailable
admission until the generated declarations and producer contracts agree.

Run `bun run --cwd packages/client typecheck` and
`bun test packages/client/tests/library-viewer-facts.test.ts` after generation. Broader acceptance remains deferred
to integration.

## Remaining outcome in user terms

Library and readable Collection consumers still need generated viewer-facts declarations. On the clean base,
`bun run --cwd services/kernel typecheck --emit-client` exited 2 before declaration emission. Its diagnostics
include the existing missing `./kernel/content/schemas` and `./kernel/rating/own-votes-counted` declarations and
post-history Kernel type errors. Keep those baseline diagnostics and the existing focused regression intact; resume
generation when the supported compiler/database path can complete.
