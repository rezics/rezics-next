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
  files: 2
after:
  - 8375cd2f-0d50-41d6-8e32-f92f5720c012
  - 96f6fc6e-3867-4bd6-be67-b582d327c51a
  - cc7c4599-1a6f-447d-a19c-ead25f2b0efb
---

# Regenerate typed client declarations for selected label consolidation

Regenerate the client declarations for review, confirmation, apply, retry, cancel, and result from the installed
Labels consolidation route source and Reylo SQL types. Do not hand-edit generated files. Add a compact typed call-site
assertion for all six routes in `packages/client/tests/client.test.ts`.

The direct declaration generator currently stops before emitting declarations because its compiler has no database
URL (`error reylo4: No database URL: set DATABASE_URL in the environment, .env.local or .env, or "direct_url" in
.reylo.yaml.`). Use the supported managed compiler placement for generation when available; do not force local
placement.

Run `bun run --cwd packages/client typecheck` and `bun test tests/client.test.ts` from `packages/client`. The managed
Kernel acceptance is deferred to the controller after integration.
