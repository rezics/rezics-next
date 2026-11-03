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
waiting: []
estimate:
  lines: 20
  files: 2
---

# Generate the typed Library viewer facts client

## Acceptance

Generate and commit Library and readable Collection client declarations exposing optional current
`viewerFacts`, row states, producer currentness failures and the 100-row bound. Use
`bun run --cwd services/kernel client` with existing supported compiler/database placement, including
the supported `bun run --cwd services/kernel typecheck --emit-client` entry point. Do not hand-edit
schema or declarations or add a tooling workaround. Preserve unavailable admission until actual
declarations and their producer contracts agree.

Run `bun run --cwd packages/client typecheck`, distinguishing unchanged base diagnostics, and
`bun test packages/client/tests/library-viewer-facts.test.ts` from the worktree root. Broader acceptance
remains deferred to integration.

## Remaining outcome in user terms

Library and readable Collection consumers still need generated viewer-facts declarations. The existing
focused regression already pins both response types, optional current facts, row states, producer
currentness failures and the row bound; preserve those assertions and the original admission gates.
Resume delivery when the supported Kernel compiler/database path permits generation. The schema
repair patch is already present, although its named commit is not an ancestor. Preserve the existing
missing `./kernel/rating/own-votes-counted` declaration and post-history baseline diagnostics rather
than weakening unrelated contracts to obtain generated output.
