---
goal: content
manager: content
kind: claim
paths:
  - packages/client/src/index.ts
  - packages/client/src/kernel/content/watch-management-contract.ts
  - packages/client/tests/watch-management.test.ts
  - contracts/openapi.json
  - services/kernel/src/content/board-watch-notices.ts
  - services/kernel/test/content/board-watch-management.test.ts
  - services/kernel/test/content/board-watch-growth.test.ts
  - services/kernel/test/content/support/watch-management-fixture.ts
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
  - 1999e5da-60c2-4a04-bd0d-1d85b2bc88b1
  - c4b0f225-d8b2-4886-9c57-ffc332947dbd
estimate:
  lines: 250
  files: 8
inseparable: true
---

# Install the generated watch client and complete native proof

The watch DTOs, mounted client source adapters, focused typed client test, and owner contract are in place. Finish the
native inventory proof and replace the source adapters with supported generated declarations after the existing
Kernel source type repairs are available to the complete-input generator.

## Acceptance

- Use the supported complete-input generator to install the exported `WatchManagementKind`, `WatchManagementItem`,
  `WatchManagementPage`, board-watch methods, and account-watches list/remove methods. Do not hand-edit generated
  declarations.
- Keep the documented Web `createKernelClient(origin, options)` signature, options, DTO branches, and idempotency
  header codec; update its handoff when generated and source heads change.
- Complete native coverage for Board/thread watches, sparse and empty pages, concealed removable targets, episode
  restart and stale CAS, target move/removal/Realm revocation, caller/session switching during hydration, and exact
  remove/replay/readback plus unavailable same-cursor retry.
- Complete independent 256/1024/4096 growth for unrelated and selected identity, source, and authority histories with
  fixed selected keys, homes, page limits, and byte caps. Derive SQL, controls, Access work, physical rows, foreign
  pool work, byte counts, and registered runner phases, including cold same-cursor retry. Preserve the three Cost
  bullets in each owner section and do not weaken the growth bounds.
- Follow the launcher's current minimal workspace typecheck and changed-test landing policy; broader native
  acceptance remains an integration check.

The latest growth landing run reached native execution but exceeded the shared telemetry cap at 33,700,231 charged
bytes against 33,554,432. Earlier native management execution had six passing cases and two failures: target hydration
hit `space_head_revision_fk`, and account suspension during later hydration returned 200 where the test expects 404.
The client typed test passed; its typecheck still reports the pre-existing missing rating module and generated Realm
`home` route. Kernel compilation still reports the pre-existing Community, Content, Library, Search, and Semantic
source errors. Keep these compiler/setup outcomes separate from runtime case results.
