---
goal: semantic
manager: semantic
kind: implementation
paths:
  - services/kernel/src/semantic/identity-rating-*.ts
  - services/kernel/src/semantic/identity-rating-*.sql
  - services/kernel/src/semantic/identity-rating-currentness.md
  - services/kernel/src/semantic/identity-epoch-prearm.ts
  - services/kernel/src/semantic/identity-epoch-prearm-*.sql
  - services/kernel/src/semantic/identity-epoch-admission.ts
  - services/kernel/src/semantic/identity-epoch-admission-*.sql
  - services/kernel/src/semantic/identity-epoch-coordinator.ts
  - services/kernel/src/semantic/identity-epoch-coordinator-control.sql
  - services/kernel/src/semantic/identity-epoch-store.ts
  - services/kernel/src/semantic/identity-epoch-store-*.sql
  - services/kernel/db/semantic/migrations/*_identity_rating_native_binding.sql
  - services/kernel/src/semantic/work-module.ts
  - services/kernel/db/semantic/schema.sql
  - services/kernel/db/schema.sql
  - services/kernel/src/semantic/moderation.ts
  - services/kernel/src/semantic/moderation-update-visibility.sql
  - services/kernel/test/semantic/moderation.test.ts
  - services/kernel/test/semantic/identity-rating-currentness.test.ts
  - services/kernel/test/semantic/growth-identity-rating-currentness.test.ts
  - services/kernel/test/semantic/identity-rating-progress.test.ts
  - services/kernel/test/semantic/support/identity-rating-currentness.ts
riskAreas:
  - authorization
  - disclosure
acceptance:
  command:
    - bun
    - run
    - '--cwd'
    - services/kernel
    - check
    - test/semantic/identity-rating-currentness.test.ts
    - test/semantic/growth-identity-rating-currentness.test.ts
    - test/semantic/identity-rating-progress.test.ts
    - test/semantic/identity-epoch-home-isolation.test.ts
  tests:
    - 'Native rating visibility callers commit bounded repair and durable checkpoints, recover interruptions through every cleanup stage, reclaim final-reference payload and preserve truthful replay and owner ABA safety without runtime pricing prerequisites.'
  failing: true
estimate:
  lines: 1100
  files: 18
criticalPath: false
waiting: []
after:
  - b5587565-5253-4a2d-aa92-bf8e067ee38c
  - 1940b2af-c3ea-43ec-852f-97e59a662a71
  - 85e8f06f-cfe4-4c96-9bec-9f381a00e72d
  - da2682f8-f3d6-4e2f-8bbb-490c6efb1a84
inseparable: false
citesSources: false
hostileInput: false
---

# Connect native callers and finish owned rating payload reclamation

The retained consumer API is preserved. `services/kernel/src/semantic/identity-rating-journal.ts`
and its native-binding migration now persist exact selected pages, native command receipts,
acknowledgement checkpoints and compact tombstones. The journal delegates effects to
`IdentityRatingJournalProducer`, a minimal port of the absent sole producer. It is not
installed in rating or moderation callers. Read `identity-rating-currentness.md` for its
native ownership, transaction and static-bound contract.

Complete the remaining user outcome: hiding, taking down and restoring a rated subject
must run bounded repair through real positive and negative callers, recover every lost
cleanup reply, and remove all owned payload after its last real reference. Connect the
native producer, preserving the retained consumer and admission APIs. The named producer
branch in the original contract may be merged only with a deliberate compatibility bridge;
its replacement consumer interfaces cannot replace the retained exports. Do not introduce
another rating writer. Remove its completePrice/charging refusals, funding tickets, prepaid
balances and dispatch allowances if integrating that branch.

Implement the native parent adapter's checkpoint read, exact replay-page lookup and
reclaimed-checkpoint verification using the journal or a compatible native wrapper. Keep
producer advancement and journal acknowledgement in one live transaction. The producer's
single admission wrapper must pass the entire normalized selection to its read-only held
admission assertion. Selected native frontier, phase, revision, scope, owner incarnation,
digest and native receipt must remain authoritative, including empty and conflict paths.

Complete indexed, bounded inventories and deletion of provenance, events, obligations,
page receipts and retained copies. The journal only owns retained selected-page copies.
Its final-reference callback must use the producer's real reference inventory and hold its
reference fence through the transaction; returning a constant is not a producer. Wake
cleanup when the last real reference disappears. Recover every cleanup stage after commit
before reply. Compact terminal replay must reject owner ABA and old pins must not revive.

Connect moderation scheduling and identity coordinator progress where required. Keep the
one-indexed-redirect voter behavior and pending second redirect/pending epoch behavior.
Historical redirect flattening and Accounts' combined Source/History/Library/Auth erasure
remain separate outcomes. Derive static producer SQL/projection/index/trigger costs and
compose them with the journal and consumer bounds; increase finite ceilings when needed.

Add minimal real caller tests, retaining existing unchanged assertions and replacing only
obsolete price-protocol assertions. The new journal test covers storage replay, bounded
retained-page cleanup, final-reference refusal, payload-deletion reply loss and owner ABA;
it does not replace the frozen native end-to-end acceptance. Follow the current controller
verification policy: focused changed tests and workspace typecheck, with frozen acceptance
deferred until integration.
