---
goal: commerce
manager: commerce
kind: implementation
paths:
  - packages/client/src/kernel/library/label-routes.d.ts
  - packages/client/tests/library-label-consolidation.test.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
estimate:
  lines: 172
  files: 2
after:
  - 8375cd2f-0d50-41d6-8e32-f92f5720c012
  - 3c44e574-20cb-43ee-9ae8-0612c5f119d9
  - 81ff4f85-68b9-43ae-a4ae-6e3fcdead62d
---

# Regenerate selected Labels consolidation client declarations

The six installed Labels consolidation routes still lack client declarations. Generate them from the route source and
Reylo SQL types without hand-editing generated output or widening the client API. Then add a focused typed call-site
test for review, confirmation, apply, retry, cancel and result. The confirmation call must preserve review evidence, and
retry must address the selected item.

On the clean source at `b253a60b39f15b10925bda9f173e1f6d79963059`, `bun run --cwd services/kernel typecheck --emit-client`
failed before emission with unchanged TypeScript errors, including `src/history/contracts.ts(317,3): error TS1117` and
missing `KernelClock`/`systemClock` in `src/library/label-consolidation.ts`. Do not weaken type checking. The test draft
was absent from this worktree; write the focused test after declarations are generated. Preserve the existing
`tests/post-publication.test.ts` assertions at lines 46 and 56 and report their unchanged failures if they remain.

Acceptance:

- Generate and commit declarations for the six installed endpoints using managed placement.
- Type-check `packages/client`; fix errors caused by this change and name unchanged base failures.
- Run `bun test packages/client/tests/library-label-consolidation.test.ts` after the last relevant edit and report its
  actual result.
- Leave broader native and browser acceptance to integration.
