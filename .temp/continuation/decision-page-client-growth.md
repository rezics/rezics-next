---
goal: content
manager: content
kind: claim
paths:
  - packages/client/src/kernel/**
  - contracts/openapi.json
  - services/kernel/src/content/README.md
  - services/kernel/test/content/*decision-page*.ts
  - services/kernel/test/content/support/*decision-page*.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
after:
  - 67d35a0b-0266-40a7-ad13-76769a662e5a
estimate:
  lines: 900
  files: 8
inseparable: true
acceptance:
  - Generate the OpenAPI contract and installed client declarations with the repository generators; verify the decision-page GET signature includes the current envelope.
  - Type-check changed workspaces and run only the focused decision-page tests changed for this continuation.
  - Capture all participating pool and runner phases while independently growing unrelated decisions and selected target, appeal, identity, and authority retained histories at 256, 1024, and 4096; prove physical scan bounds and residual joins.
---

# Finish decision-page client delivery and physical growth proof

The retained decision-page implementation is already present on the clean source: exact source and partition checks,
current appeal advice, minimal current target context, and session/identity rechecks are mounted through the existing
GET. Keep advice non-authoritative; the appeal command remains final. Preserve concealed and unavailable context as
separate states.

The OpenAPI file describes the page envelope, but the installed client declaration at
`packages/client/src/kernel/content/routes.d.ts` still lacks the generated page signature. The repository's
`bun run --cwd services/kernel derived` currently stops while running `scripts/openapi.ts` with:

`ReferenceError: Cannot access 'STANDARD_QUESTION_ID' before initialization`

The direct `bun run --cwd services/kernel client` attempt also stops on the inherited compiler issue
`src/library/list-import-mal-routes.ts(94,17): error TS7056` and, outside the throwaway database runner, reports a
missing `DATABASE_URL`. Resolve the generator prerequisites narrowly, then regenerate rather than editing generated
types by hand. Hand Web the exact generated signature and populated, concealed, and unavailable response examples.

Complete the owner README's exact Cost check bullets. Charge physical rows, full-prefix plans and residual joins,
statements, transaction and runner controls, encoded bytes, JSON copies and serialization, cold release, retries,
and withheld branches through nested Access calls. Measure unrelated decision growth independently from target,
appeal, identity, and authority retained histories at 256/1024/4096 with selected keys, payload caps, represented homes,
and authority depth fixed. Capture every participating pool and registered runner phase, including empty, denied,
revoked, and retry outcomes. Fixture or host failure is no native evidence.
