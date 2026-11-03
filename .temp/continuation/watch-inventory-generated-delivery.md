---
{
  "goal": "content",
  "manager": "content",
  "kind": "claim",
  "paths": [
    "services/kernel/src/content/schemas.ts",
    "services/kernel/src/content/README.md",
    "services/kernel/test/content/board-watch-management.test.ts",
    "services/kernel/test/content/support/watch-management-fixture.ts",
    "packages/client/src/kernel/**",
    "packages/client/src/index.ts",
    "contracts/openapi.json"
  ],
  "riskAreas": [
    "authorization",
    "disclosure",
    "rights",
    "deletion",
    "account"
  ],
  "criticalPath": false,
  "waiting": [],
  "after": [
    "de02e860-8d24-453a-b13e-3d54ef5f1316"
  ],
  "estimate": {
    "lines": 650,
    "files": 7
  },
  "inseparable": true
}
---

# Complete generated watch inventory delivery and native proof

Finish the existing watch inventory contract already committed in source. The supported OpenAPI and KernelClient generators currently stop on stale PostgreSQL schema objects, and the focused Kernel check stops at Library schema consistency before the fixture runs. Do not hand-edit generated files or change the unrelated SQL inputs and schema snapshots. After the owning schema repair is available, regenerate from complete inputs, type-check the changed workspaces, and install the resulting client contract for Web.

## Acceptance

- Generate the mounted closed watch schemas into OpenAPI and KernelClient with supported generators, then verify the required client exports and hand Web the exact installed factory signature, DTO, generated/source heads, and observed outcomes.
- Run the native fixture cases for Board/thread watches, empty and sparse pages, concealed targets that remain removable, same-ID stop/restart, revision conflicts, target move/removal/Realm revocation, caller/session switch during later-row hydration, exact remove/replay/readback, and unavailable same-cursor retry.
- Complete the fixed-key 256/1024/4096 independent history growth proof for unrelated and selected identity/source/authority histories. Derive SQL, transaction controls, preparations/evaluations, physical rows, foreign pools, materialized/retained/serialized bytes, and registered runner phases, including repeated authority and cold retry paths; keep README Cost to exactly Touches, Bound, and Growth check bullets.
- Preserve the already committed native source behavior, exact cursor retry, concealment, and owner decision. Report each runtime case separately from setup or infrastructure failures.
