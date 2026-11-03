---
goal: content
manager: content
kind: claim
paths:
  - services/kernel/src/content/README.md
  - services/kernel/test/content/decision-page-growth.test.ts
  - services/kernel/test/content/decision-page-lifetime-http.test.ts
  - services/kernel/test/content/decision-page-source-http.test.ts
  - services/kernel/test/content/decision-page-author-inbox-http.test.ts
  - services/kernel/test/content/support/growth-appeal-boundaries-fixture.ts
  - packages/client/src/kernel/**
  - contracts/openapi.json
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
after:
  - a17442a3-9169-41a5-bf45-551a8765a5b3
  - 8ab681dc-71a0-4e29-9dfa-37800fa22e2c
  - 9f573536-fee5-478e-b7e7-4b902b04666c
  - 18b600c0-79c6-402a-83b5-777cd2943f1a
estimate:
  lines: 220
  files: 8
inseparable: true
---

# Finish installed consumer handoff and native evidence

Owner: `services/kernel/src/content/README.md`, sections “Cost: exact decision read”, “Web consumer handoff” and
“Cost: exact decision page envelope”. Continue from the committed measurement harness at `22816a3f79`.

The current change adds independent 256/1024/4096 decision-page history axes, mounted page paths, byte and JSON
instrumentation, and exact-source plan assertions. It does not claim native results.

Remaining outcome:

- After the owners resolve the existing Kernel compiler errors and library schema dump mismatch, run
  `bun run --cwd services/kernel typecheck --emit-client --emit-openapi`. Commit generated OpenAPI and installed
  Kernel declarations; never hand-edit those outputs.
- Run the created `decision-page-growth.test.ts` and the named `decision-page-lifetime-http.test.ts` with the Kernel
  landing command. Also run the original decision-page source and author-Inbox mounted suites. Resolve failures caused
  by this change; leave unrelated compiler/schema repairs with their owners.
- Type-check `services/kernel` and `packages/client` after generated outputs land. Confirm full-prefix plans, measured
  physical rows and bytes, cold backend discards, runner phases, and actual results for empty, denied, revoked,
  withheld and nested-Access paths.
- Hand Web the generated `KernelClient['moderation-decisions']({ id }).get({ headers: { authorization } })` and
  unchanged `.$appeal.post({ statement }, { headers: { authorization, 'idempotency-key': key } })` signatures, the
  final generated delivery commit, and the populated, concealed and unavailable examples in the owner document.
  Keep rendered acceptance deferred to the controller.
