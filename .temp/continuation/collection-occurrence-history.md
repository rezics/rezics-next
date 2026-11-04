---
goal: commerce
manager: commerce
kind: implementation
paths:
  - apps/web/src/library/collection-structure-history*
  - apps/web/src/library/collection-page.tsx
  - apps/web/src/library/collection-editor.tsx
  - apps/web/src/library/collection-commands.ts
  - apps/web/src/library/collection-metadata-history-view.tsx
  - apps/web/tests/collection-structure-history*
  - packages/client/src/kernel/library/collection-routes.d.ts
  - services/kernel/test/library/collection-structure-history*
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
after:
  - 03bf8208-8c33-47e5-b1e6-105fc3a9c25a
  - a3639f95-f222-431e-8a16-9a082e85108e
waiting: []
estimate:
  lines: 1100
  files: 10
acceptance:
  tests:
    - "The curator History section switches metadata and structure streams, preserves selected signed addresses through refresh/back, compares deltas, and returns to the exact current occurrence editor."
    - "Repeated Subject occurrences stay separate; loading, empty, incomplete, unavailable, keyboard, phone and late-response states work; stale responses retire after viewer, curator or Collection changes."
    - "Public readers and cached receiving state never expose private history notes, labels or withheld Subject identity."
    - "Native cases cover filtered bulk removal, current account retirement and actual pruning while preserving archive recovery, stale-address, hidden-Subject, deletion, minimization and visibility coverage."
    - "Independent 64/512/4096 growth cases account for live member, retained delta and foreign Subject populations, raw rows/lookahead, bytes, authority checks, negative observations, retries, append/prune and lifecycle cleanup."
  failing: true
  workerOwned: true
---

# Finish the Collection occurrence history receiving journey

Complete the curator History experience with the generated structure-history client methods and DTO types published
from the native route. The service route and native DTOs are present, but the retained client declaration does not
include either structure-history endpoint. The workspace client install resolves to `packages/client`; its root exports
`KernelClient` and `createKernelClient`, while the mounted collection declaration is stale. The supported declaration
generator currently fails because its compiler has no database URL (`No database URL: set DATABASE_URL in the
environment, .env.local or .env, or "direct_url" in .reylo.yaml.`). Generate and inspect the declarations on the
supported check host; do not hand-write declarations, cast the client or use an untyped request path.

Integrate the two streams in the current Collection page and editor. Keep signed selected addresses in refresh/back
navigation, compare addressed changes, and return to the current editor occurrence without reusing historical write
operands. Keep duplicate occurrences distinct and explicit when Subject context is withheld. Complete loading, empty,
incomplete, unavailable, keyboard, phone and stale-response states, and prove private-history disclosure stays closed
for public readers and cached receiving state.

Complete the remaining filtered bulk-removal, account-retirement and actual-pruning native cases. Add independent
64/512/4096 growth evidence for live members, retained deltas and foreign Subjects, measuring raw rows and lookahead,
bytes, authority queries, negative observations, retries, append/prune behaviour and lifecycle cleanup.
