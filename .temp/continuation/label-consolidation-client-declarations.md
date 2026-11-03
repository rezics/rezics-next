---
goal: commerce
manager: commerce
kind: implementation
paths:
  - packages/client/src/kernel/library/label-routes.d.ts
  - packages/client/tests/label-consolidation-types.test.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
estimate:
  lines: 100
  files: 2
after:
  - 8375cd2f-0d50-41d6-8e32-f92f5720c012
  - 2bb1fbdd-fd3b-4f51-a945-0faf1a112617
---

# Generate selected label consolidation client declarations

Regenerate the client declarations for the installed Labels consolidation review, confirmation, apply, retry, cancel and
result routes from route source and Reylo SQL types using `bun run --cwd services/kernel typecheck --emit-client` on the
managed check host. Commit the generated declarations without hand-editing them. Add a compact typed call-site
assertion for all six routes, then run the client typecheck and focused test. Keep the public API limited to the
installed Labels consolidation endpoints.
