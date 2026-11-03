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
  - a4e55488-394a-40c7-b652-808ff70b85ac
waiting: []
estimate:
  lines: 20
  files: 2
---

# Generate the typed Library viewer facts client

## Acceptance

After Library schema repair `1322e3d50121a45cf7faf74d6eaf67c1050f5354` is integrated into this source and supported Kernel database placement is available, run `bun run --cwd services/kernel client` and commit the generated declarations exposing Library and readable Collection `viewerFacts`. Use only the existing supported compiler/database placement; do not add a tooling workaround. Confirm producer currentness and bounded page declarations. Run `bun run --cwd packages/client typecheck` and `bun test packages/client/tests/library-viewer-facts.test.ts` from the worktree root. Preserve the existing three client baseline diagnostics: the missing `./kernel/rating/own-votes-counted` export and the unused expect-error and false/true mismatch in `tests/post-history-contract.test.ts`.

## Remaining outcome in user terms

Library and readable Collection consumers need generated viewer-facts client declarations. The declaration regression checks both response types, optional current facts, row states, producer currentness failures and the row bound. Generate from the repaired schema through supported placement; do not hand-edit schema or declarations. Keep admission unavailable until the generated declarations and producer contracts agree.
