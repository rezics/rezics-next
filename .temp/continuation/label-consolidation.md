---
goal: commerce
manager: commerce
kind: implementation
paths:
  - services/kernel/src/library/label-consolidation*
  - services/kernel/src/library/label-assignment-commands.ts
  - services/kernel/db/library/**
  - services/kernel/test/library/label-consolidation*
  - packages/client/src/kernel/**
  - docs/library-label-consolidation.md
  - docs/library-and-collections.md
  - docs/goals/library.capabilities.md
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
estimate:
  lines: 600
  files: 5
after:
  - 50504ead-c65d-4898-8b51-d433153f0de7
acceptance:
  - Complete typed client and Library schema generation through the kernel compiler database.
  - Run focused native consolidation tests and changed-workspace typechecks under controller policy.
  - Add complete-caller native64/512/4096 growth coverage with fixed selection and page sizes.
---

# Finish delivery and composed growth for selected private label movement

Read docs/library-label-consolidation.md and docs/library-labels.md. The retained native composition is in
services/kernel/src/library/label-consolidation.ts, exact fresh-effect bindings are in
services/kernel/src/library/label-consolidation-binding.ts, and the original assignment commands remain in
services/kernel/src/library/label-assignment-commands.ts. Expiry is in
services/kernel/src/library/label-consolidation-retention.ts, registered by services/kernel/src/library/work-module.ts;
shared terminal erasure is appended in services/kernel/src/library/erasure-owned-graph.ts. The source methods and
compact native cases are present; their successful execution and generated transport/schema artifacts remain required.
Do not infer a passing test or typecheck from the authored source.

Finish the owner journey on verified native source: regenerate the Library schema snapshot and kernel client using
`bun run --cwd services/kernel typecheck --emit-client --emit-schema=library`, fix every source type or native focused
failure, then type-check the client workspace if generated declarations change. Run
`bun run --cwd services/kernel check test/library/label-consolidation.test.ts test/library/label-consolidation-review.test.ts`
under the current controller policy. Preserve the pure review assertions. Do not bypass migration/source preparation
or force compiler placement to obtain a nominal pass. Return the generated typed methods to Web's existing Labels
interface owner using the owner contract's single selection/review/confirm/retry/result/cancel/reopen flow.

Add the remaining composed growth evidence using real native commands at 64/512/4096 unrelated assignments and
retained/deleted label history, holding S<=16 and P<=4 fixed. Include successful move, existing/negative target,
capacity refusal, deep/final preview, maximum names, stale incarnation, original replay, lost acknowledgement,
cancellation and terminal cleanup. Charge complete-caller statements, examined rows/buffers, encoded bytes and effects,
including nested authority, all locks, original receipts, History/events, export fences, serialization and bounded
cleanup. Explain accepted, no-effect, rollback, capacity-refusal and replay work from native index predicates; LIMIT
or the 32 live-label cap must not conceal deleted-parent scans. Reuse the native growth support in
services/kernel/test/support/growth.ts and existing label growth tests, adding only compact tests needed for the
remaining outcome. Native setup failure stays failed/unmeasured. Broader acceptance remains deferred to integration.

Keep one finite 15-minute composition per owner, original per-item keys and addressed source CAS. Never renew undo,
remove source first, reclaim extra reservations or remove the source label. Preserve unselected facts, query operands,
import evidence and public snapshots. Update the owner reference and capability inventory to reflect the actual
verified/generated boundary without adding evidence/audit files.
