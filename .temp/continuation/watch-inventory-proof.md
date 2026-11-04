---
goal: content
manager: content
kind: claim
paths:
  - services/kernel/src/content/schemas.ts
  - services/kernel/src/content/README.md
  - services/kernel/test/content/board-watch-growth.test.ts
  - services/kernel/test/content/board-watch-management.test.ts
  - services/kernel/test/content/support/watch-management-fixture.ts
  - services/kernel/src/**
  - packages/client/src/kernel/**
  - packages/client/src/index.ts
  - packages/client/tests/watch-management.test.ts
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
  - de02e860-8d24-453a-b13e-3d54ef5f1316
  - 18b600c0-79c6-402a-83b5-777cd2943f1a
  - 7f224ec2-2da8-4912-80e9-d68e7a570ba2
estimate:
  lines: 700
  files: 40
inseparable: true
---

# Finish generated watch inventory, independent history growth and native proof

The current base already contains the generated Content watch schema and mounted routes. The OpenAPI response for
`GET /v1/accounts/{accountId}/watches` has a closed page schema with `items.maxItems: 20`. Preserve these generator
outputs. KernelClient type checking still reports the missing generated `rating/own-votes-counted` module and its
related type assertions. The supported Kernel compiler-host generator,
`bun run --cwd services/kernel typecheck --emit-client --emit-openapi`, exits before generation with 154 TypeScript
diagnostics across Kernel modules; examples include missing `ReleaseGroupsPage` and `ReleaseChildrenPage` exports
from the release-search grouping contract. Resolve owner diagnostics or use documented minimal seams for source
unavailable from another Goal; do not weaken or bypass checks.

This attempt committed the watch pagination type repair and a focused native assertion that stopping and restarting
the same Board watch rotates its personal watch ID. The mounted board CAS test containing that assertion passed in
the focused run. The run as a whole reported four passing and two failing cases: one setup failed the
`space_head_revision_fk` constraint, and the later-row suspension case returned 200 where it expects 404. Diagnose
and report runtime cases separately from setup failures. The client acceptance test and broader native acceptance
remain controller-owned under the current verification policy.

Complete the fixed-key 256/1024/4096 independent history growth proof for unrelated and selected identity, source and
authority histories. Derive SQL, transaction controls, Access preparations/evaluations, physical rows, foreign pools,
materialized/retained/serialized bytes and registered runner phases, including repeated authority and cold retry
paths. Replace the README's deferred independent-growth statements with observed measurements, keeping each watch
Cost section to exactly Touches, Bound and Growth check bullets. Add only missing user-visible native cases and keep
generated files generator-owned and unrelated SQL inputs/schema snapshots unchanged. Hand Web the exact installed
factory signature, DTO, generated/source heads and observed outcomes when generator validation succeeds.
