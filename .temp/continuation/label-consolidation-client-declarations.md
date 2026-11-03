---
goal: commerce
manager: commerce
kind: implementation
paths:
  - packages/client/src/kernel/library*
  - packages/client/tests/client.test.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
estimate:
  lines: 120
  files: 4
after:
  - 8375cd2f-0d50-41d6-8e32-f92f5720c012
  - 96f6fc6e-3867-4bd6-be67-b582d327c51a
---

# Regenerate typed client declarations for selected label consolidation

The client declaration is missing typed methods for review, confirmation, apply, retry, cancel and result. The native
route source already defines these operations. Regenerate the declarations from the route source and Reylo SQL types;
do not hand-edit generated files.

The managed `bun run --cwd services/kernel typecheck --emit-client` reached a check host but exited with TypeScript
errors across the base workspaces, including errors in `src/library/label-consolidation.ts`; no client declaration
output was produced. The client typecheck also confirms the six methods are not present in the current declarations.

Acceptance:

- Run `bun run --cwd services/kernel typecheck --emit-client` successfully on the managed check host and commit the
  generated client declarations for all six routes.
- Add a compact typed call-site assertion for all six routes in `packages/client/tests/client.test.ts`.
- Run `bun run --cwd packages/client typecheck` and the focused client test.
- Do not edit frozen files or widen the public API beyond the installed Labels consolidation endpoints.
