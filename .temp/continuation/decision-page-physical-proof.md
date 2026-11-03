---
goal: content
manager: content
kind: claim
paths:
  - services/kernel/src/content/decision-page*.ts
  - services/kernel/src/content/decision-page*.sql
  - services/kernel/src/content/moderation-decisions.ts
  - services/kernel/src/content/moderation-routes.ts
  - services/kernel/src/content/README.md
  - services/kernel/test/content/*decision-page*.ts
  - services/kernel/test/content/support/*decision-page*.ts
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
estimate:
  lines: 1250
  files: 9
inseparable: true
---

# Complete connected decision-page proof

Finish the remaining mounted decision-page lifetime cases, including delegated principal and client/session changes
between selection and final disclosure, plus the sparse retained-source outcomes. Keep exact-read and not-original-
decider command behavior intact. The native author Inbox journey now covers takedown projection, opening the exact
decision and withholding an in-flight read after author erasure; extend it only for missing lifetime states.

Capture independent native 256/1024/4096 histories for unrelated decisions, selected target history, appeals,
identities and authority while holding selected keys, homes, payload caps and authority depth fixed. Prove full-prefix
physical plans and residual joins. Record every pool and registered runner phase, transaction/control work,
physically examined rows, UTF-8 and serialized bytes, JSON copies and serialization, cold release, retries, and the
empty, denied, revoked, withheld and nested-Access branches. Use the installed native fixture; fixture or host failure
provides no evidence.

After successful compiler placement, generate OpenAPI and installed Kernel client declarations with repository
generators. Hand Web the installed signatures, delivered commit and populated, concealed and unavailable examples.
Do not add frontend implementation or rendered acceptance. Controller acceptance remains the final native and
browser verification.
