---
goal: commerce
manager: commerce
kind: implementation
paths:
  - packages/client/src/kernel/library*
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
---

# Regenerate typed client declarations for selected label consolidation

The native review, confirmation, apply, retry, cancel and result APIs are implemented. The generated client declaration
remains pending because the managed kernel typecheck host failed during preparation. Regenerate declarations from
the route source and Reylo SQL types; do not hand-edit generated files.

Acceptance:

- Run `bun run --cwd services/kernel typecheck --emit-client` on the managed check host and commit its generated
  client declarations for review, confirmation, apply, retry, cancel and result.
- Run `bun run --cwd packages/client typecheck` and add a compact typed call-site assertion for all six routes.
- Do not edit frozen files or widen the public API beyond the installed Labels consolidation endpoints.
