---
goal: content
manager: content
kind: claim
paths:
  - services/kernel/src/content/schemas.ts
  - services/kernel/src/content/README.md
  - services/kernel/test/content/board-watch-management.test.ts
  - services/kernel/test/content/support/watch-management-fixture.ts
  - packages/client/src/kernel/**
  - packages/client/src/index.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
after:
  - de02e860-8d24-453a-b13e-3d54ef5f1316
  - e214e7d5-d159-4464-97bb-a4135e0b05f1
estimate:
  lines: 450
  files: 6
inseparable: true
---

# Complete KernelClient watch inventory delivery and native proof

The mounted watch operations and closed response schemas are already present in OpenAPI on the current source. The generated KernelClient content schema declaration is missing. The supported `bun run --cwd services/kernel derived` command currently stops during KernelClient emission on existing Kernel TypeScript errors, beginning with `src/community/following-space-targets.ts(75,3): error TS2322`.

## Remaining outcome

- Generate the mounted closed watch schemas into KernelClient with the supported generator. Verify the package exports and hand Web the exact installed factory signature, DTO, generated/source heads, and observed outcomes.
- Run the native fixture cases for Board/thread watches, empty and sparse pages, concealed targets that remain removable, same-ID stop/restart, revision conflicts, target move/removal/Realm revocation, caller/session switch during later-row hydration, exact remove/replay/readback, and unavailable same-cursor retry. Report each runtime case separately from setup or infrastructure failures.
- Complete the fixed-key 256/1024/4096 independent history growth proof for unrelated and selected identity/source/authority histories. Derive SQL, transaction controls, preparations/evaluations, physical rows, foreign pools, materialized/retained/serialized bytes, and registered runner phases, including repeated authority and cold retry paths.
- Keep README Cost to exactly Touches, Bound, and Growth check bullets.

Preserve the existing watch source behavior, exact cursor retry, concealment, and owner decision. Do not hand-edit generated files or change unrelated SQL inputs and schema snapshots.
