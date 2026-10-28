# Native entry delete and restore implementation evidence

This is an implementation audit of `6da22999fe24c544551a85562354803a006f2c61` and focused native
acceptance, not another policy proposal or a lifecycle implementation. The adopted
[Library contract](../../services/kernel/src/library/README.md#entry-deletion-identity-and-restoration)
and both integrated [current](library-entry-undo-independent-current.md) and
[deep](library-entry-undo-independent-deep.md) reports supply the policy. The current task's
first-public closure takes precedence over older hold/custody passages in those documents:
legal holds are deferred; no hold driver, custody registry or new lifecycle/receipt engine is required.
Ordinary automatic cleanup and minimization of actual shared evidence remain required.

## Evidence at this checkout

| Surface inspected                                                                                                        | Actual implementation and consequence                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/kernel/src/library/entries.ts`                                                                                 | `createEntryCommands` returns put/delete/read/list only. Delete reads an ordinary entry before `ownAccount`; on absence it resolves the current subject before receipt lookup. Its body calls physical `store.deleteEntry`. It returns the removed entry, including its private old transaction identity, rather than a deletion descriptor. There is no restore command.                                                             |
| `services/kernel/src/library/entry-store-entry-{insert,update,delete,read,page}.sql`, `entry-model.ts`, `entry-store.ts` | The live PK remains owner route/account/subject. Delete guards only revision; a new fill resets revision to one. Its RETURNING projection is incomplete. New fills do not allocate an incarnation or persist the accepted profile pin. Archiving that Entry DTO would lose native columns.                                                                                                                                            |
| `services/kernel/db/library/migrations/20261027231014_entry_retained_storage.sql`                                        | Applied structural `entry_deleted` has all 18 original columns plus deletion ID/revision/times and generated partition. Its PK is `(route,account_id,deletion_id)`; no live-slot FK, subject uniqueness or cascade. The due index is `(partition_no,restore_until,route,account_id,deletion_id)`. DDL is not a writer or worker.                                                                                                      |
| Retention DAO delivery brief                                                                                             | The specified `entry-retention-store.ts` and retain/read/restore SQL files are absent here. The intended real exports are `retainEntryDeletion`, `readRetainedEntryDeletion`, `restoreRetainedEntryDeletion`; their native tests cover bigint `9007199254740993`, independent episodes, exhaustion and empty-slot arbitration. Do not replace those tests with command fixtures or copy their raw positive setup into API acceptance. |
| Incarnation interface delivery brief                                                                                     | The optional fifth delete argument is `incarnationId`. The interface writer is absent here: model and SQL still omit it. The later mandatory cutover also needs the actual Web caller and bounded legacy stamping. An optional guard proves only guarded-request safety.                                                                                                                                                              |
| `services/kernel/src/library/command-support.ts`                                                                         | Own-account scope/kind/state/fence/authentication-floor checks precede the native receipt. This checkout does not import `shareAccount` and exports no `ownAccountPrepared`. The prepared-owner delivery must preserve the owner-barrier delivery, forward the actual core result union and use core preparation; prose readiness is not that code.                                                                                   |
| `services/kernel/src/command/command.ts`                                                                                 | `CommandAuthorization.prepare` runs before the resource checkout and receives a newly minted opaque attempt T; retries refresh it. `authorize` runs before the keyed receipt. Exact replay skips the body, fence and event writes. Body/receipt/outbox commit atomically. This checkout requires a nonempty events array; native `noEffect` is a separate actual-code dependency, not permission to fabricate an event.               |
| `services/kernel/src/request/access.ts`, `access/command-admission.ts`, `access/account-share.ts`                        | Real instance/pool-bound native admission and account share-lock exist. `accessCommandAuthorization` uses native command admission and one-use preparation proofs. `shareAccount` requires a live command transaction and holds the terminal-account barrier through commit. An ordinary `readAccount` is not this lock.                                                                                                              |
| `services/kernel/src/library/profile.ts`, `services/kernel/src/semantic/definitions.ts`                                  | `readRelease(pool,digest)` loads the immutable accepted release; `resolveLibraryProfilePin({digest,release},pin)` resolves that exact meaning. `activeRelease`/`selectLibraryProfile` answer fresh admission, not historical restoration. The promised current profile-source reader is not an export in this checkout.                                                                                                               |
| `services/kernel/src/library/builtin-reference-store.ts` and bind/unbind SQL                                             | Real private `bindBuiltinStateReference` and `unbindBuiltinStateReference` exports exist. Bind validates the exact persisted revision/transaction/state/pin and writes the tuple directory plus source pointer. Unbind guards the OLD revision/transaction witness. `entries.ts` imports neither. The reference producer delivery is actual single-writer code, not proof from the DAO alone.                                         |
| `services/kernel/src/library/personal-routes.ts`                                                                         | DELETE performs `readEntry` before checking revision/calling delete, then records the command and returns 204 with no deletion headers. That pre-read blocks absent-slot replay. There is no restore route. `entryView` intentionally excludes transaction ID and pin; storage assertions must not demand those fields in HTTP output.                                                                                                |
| `services/kernel/src/library/work{,-module}.ts`, `events/effects.ts`, `work/{registry,retention}.ts`                     | Library currently registers Collection-listing effects/DBOS workflow only. Shared effects/checkpoints, queues and UTC schedule composition exist. Workflow-history retention is not entry purge. No ordinary entry-due worker or automatic recovery delivery exists here.                                                                                                                                                             |

The continuation and registered delivery briefs were read from the main checkout's `.temp/goal/commerce/`
read-only: entry-undo research adoption (the shorter suggested adoption filename was absent),
retention DAO, incarnation exposure, prepared owner command, owner barrier, profile source, reference producer,
and first-scope deletion closure. Those brief filenames identify evidence; they are not implementation imports.
No main-checkout file was written.

## Command acceptance and interpretation

`services/kernel/test/library/entry-lifecycle-command.test.ts` imports the existing real
`createProfileEntryFixture`, compiler-built releases, native identities, Access, commands and native subject
creation. It provides no positive SQL rows, replacement command factory, policy map, model backend or receipt reader.
An independent PostgreSQL pool is read-only by connection configuration. Only inspection uses SQL.

A separate planned-state create/read control precedes lifecycle assertions. Another control demonstrates the
missing `restoreEntry` export only after a real successful create/read; reflection avoids an unresolvable future
import. The main case calls the existing actual `deleteEntry`, asserts its real outcome and exact native archive,
then covers replacement, occupied restore, stale guarded delete at the same revision, D1/D2 independent snapshots,
D1-only consumption, restore/reclear D3 with the same incarnation, unchanged old receipts and no archive recreation.
Additional cases cover concealed missing/foreign/wrong-subject handles, stale deletion revisions, current scope,
other account, anonymous, suspension, authentication fence and gate revocation, strict original expiry, retired
profile meaning and source visibility. Rejected attempts compare live facts, archives, receipts, outbox and
partition metadata for no effects. Changed body with the same key must produce the native idempotency conflict.

The command-level descriptor chosen here is `{deletionId, revision}` in `CommandOutcome.value`; the deletion ID
must equal that outcome's real `transactionId`, and revision is r+1. No expiry return/header is required. Restore is
`restoreEntry(actor, storedSubjectId, {deletionId, revision}, requestKey)` and returns `{entry}` inside the native
outcome. Native lifecycle conflicts carry stable `reason: occupied | stale | expired`, ready for distinct 409
transport codes. These are explicit additive command ABI decisions; no current HTTP behavior is inferred or faked.
Existing pre-retention receipts retain their original value/digest and may acknowledge without fictional metadata.

Every archive assertion compares all 18 named original columns. Read-only inspection casts source position to
text **before** JSON decoding, and keeps timestamp strings in PostgreSQL's complete stored precision. Null source
observations remain null; they are never guessed from current type. The DAO's raw large-position edge fixture
remains the extreme-precision proof; the command test compares whatever the real admitted writer persisted.
Restore keeps saved created/updated/activity/finish times, requested/source IDs, original incarnation and accepted
pin, with only revision r+2 and a new real command transaction identity. Custom profile admission has its own
baseline so its known absent-writer failure is distinguishable from planned-state lifecycle failures.

The shared fixture change is optional `{clock?: KernelClock}` plumbing only. The existing kernel, native entry,
lifecycle, grant and suspension compositions receive the same supplied clock; absent options retain their defaults.
No deadlines, mounted registries, positive grants or admission setup changed. The supplied clock follows actual wall
time during fixture provisioning/authentication, then freezes only for explicit lifecycle-time observations. At just-before/exact 720 hours the
suite advances this native domain clock, calls commands directly with the same admitted actor, and observes the
original retained deadline. It neither patches global Date nor substitutes an expired HTTP request for Undo.

There is an additional concrete future-composition issue: `createKernel` forwards its clock into `createAccess`;
`access/index.ts` currently gives it to `createAuthenticator` and `createCommandAdmission`, which compare token
expiry against it. That contradicts `clock.ts`'s stated separation of domain time from authentication wall time
when a future restore preparation uses native admission after a 720-hour advance. Do not hide this with a fixture
Access override, forged actor or replacement credential. The owning native clock/admission composition must honor
that existing separation. The focused boundary case remains required, rather than accepting authentication denial
as evidence of expiry.

## Exact preparation bridge before runtime dispatch

The required sequence uses the existing native owner-admission and prepared-command APIs. It cannot be achieved by
calling `readRetainedEntryDeletion` at the top of today's delete/restore factory, or by fetching a pinned release
inside an owner command connection.

1. Start the existing prepared own-account command. At its real attempt T, run installed native admission on the
   actual authenticated actor (`commandAccessContext`/`requireCommandAdmission`), enforce the operation's existing
   owner scope and current personal-library gate. An owner denial is immediate; possession of a locator cannot
   authorize even a private archive read. Never expand `deriveAccess` to expose a new allow path.
2. In a bounded read-only owner checkout, read only the addressed archive, after that admission, retaining its
   full exact witness: route/account/deletion ID, stored subject, incarnation, deleted revision, original transaction
   and pin. Close this checkout completely. A receipt is not looked up here. An absent archive is deferred evidence,
   because an already-successful authorized restore may have consumed it.
3. After releasing owner resources, load `readRelease(pool, pin.releaseDigest)` on Global. Decode with
   `resolveLibraryProfilePin`, including legacy provenance; obtain the **original** profile's `entryStateSet.id`.
   Release Global before source checkout. Use the real native source-reference/Access reader at the same T to
   authorize the stored original source and any required redirect evidence; readability must not rewrite saved
   `subject_id` or `requested_subject_id`. Current type is not historical pin evidence. No active-head lookup can
   provide the old state-set bridge after a profile is removed.
4. Return attempt-local preparation evidence or an original deferred fresh error (missing/expired archive,
   missing release/profile, inaccessible source, dependency failure). Do not throw a fresh lifecycle/profile/source
   failure ahead of a possible old authorized receipt. This does not defer owner denial. Native reauthorization and
   `shareAccount` run in the final owner transaction before native receipt lookup; exact old receipts skip the body
   and all archive/current-absence/profile validation. Never add a local receipt lookup to solve preparation.
5. On a receipt miss, recheck the addressed archive witness under its lock/CAS, strict native T, original subject,
   revision and source/disclosure fences. Apply the real retention DAO on the SAME transaction. For delete unbind
   the OLD live revision/transaction source witness; for restore bind the restored r+2/new-transaction witness with
   the original accepted release/profile/state-set/state. Failures roll back fact, archive consumption, reference,
   receipt and event together. Do not call another pool from this transaction or bind an active-head tuple.

Today `createLibraryCommandRunner` returns only `{ownAccount,trustedAccount}` and has no `Access` argument or
archive-preparation example. Core `prepare` alone does not authorize a private owner archive read. The smallest
owner integration question before runtime dispatch is: which existing native admission/gate helper is composed
inside `ownAccountPrepared.prepare` before its short owner archive checkout, and how is that same proof fenced at
final authorization? Deliver the already specified prepared-owner and owner-barrier exports and an actual
max-one-connection native example of this ordering. Do not invent a new core port, trust `trustedAccount`, copy an
account authorization formula, or nest owner/Global checkouts to answer it. Native admission's clock issue above
must also be resolved at its owner. A stale archive witness refreshes/retries through existing native attempt rules.

Legacy null incarnations may be stamped only by bounded owner migration or the actual fresh-delete transaction's
exact legacy revision/transaction/null CAS. They cannot be stamped by GET or treated as one identity. Existing null
pins retain their declared legacy meaning. No archive UNION belongs in ordinary reads. The reference producer must
land before the runtime writer adopts its same-command unbind/bind calls; a DAO import without that writer is not
completion of immediate built-in liveness.

## Reviewable runtime slices

These are dispatch boundaries, not changes made by this audit. Prerequisites name actual exports or sole-writer
changes, never documentation readiness. Unqualified production filenames below are relative to
`services/kernel/src/library/`; test filenames are relative to `services/kernel/test/library/`.

| Slice                                                   | Concrete production paths and proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command, at most 400 production lines/eight paths       | Existing `entries.ts`, new focused `entry-lifecycle.ts` helper if needed, `entry-retention-store.ts`, `entry-retention-retain.sql`, `entry-retention-read.sql`, `entry-retention-restore.sql`, `command-support.ts`, and `entry-lifecycle-command.test.ts`. Reuse existing prepared-owner, owner lock, profile pin codec/source reader, incarnation writer and reference producer; if these are missing land those actual deliveries first. No competing entry writer. The lifecycle helper must obtain original pinned release/state-set evidence as above. Split again if it cannot fit.                                                                                                                                                                                                                                                              |
| HTTP/catalogue/generated callsites, at most eight paths | `services/kernel/src/library/personal-routes.ts`, `services/kernel/src/http/problem.ts`, `contracts/openapi.json`, generated `packages/client/src/kernel/library/personal-routes.d.ts`, `apps/web/src/library/entries-read.ts`, `apps/web/src/library/subject-slot-mutation.ts`, `services/kernel/test/library/personal-http.test.ts`, `apps/web/tests/library-entries-cost.test.ts`. Both actual Web delete callers need the guarded interface. DELETE remains 204/empty with `Library-Entry-Deletion-Id` and `Library-Entry-Deletion-Revision`, no expiry header; POST `:restore` has closed `{deletionId,revision}` and current `library_entry:update` scope. Remove ordinary DELETE pre-read and map distinct occupied/stale/expired 409 codes. Regenerate declarations; if generation changes another path, split the slice again before dispatch. |
| Ordinary due worker, separate at most eight paths       | Proposed `entry-due.ts`, typed `entry-due-page.sql` and `entry-due-delete.sql`, existing `work.ts` and `work-module.ts`, plus `entry-due-worker.test.ts`, `entry-due-crash.test.ts` and `growth-entry-due.test.ts`. Use existing effects/WorkClient/DBOS queue and shared UTC periodic registration. The due index recovers commit-before-enqueue. No local timer, hold API or new custody/checkpoint engine. Parked D1 delivery after restore/reclear D3 must touch only D1 and cannot erase D3 or a live replacement.                                                                                                                                                                                                                                                                                                                                 |

## Cost obligations

These are derivations and required future measurements; this focused behavioral suite is not a growth result.
Let E, D and R be unrelated live entry, retained deletion and reference populations; B-tree point work is logarithmic
in the respective physical index population. Access/source/Global preparation and command envelope are charged,
including repeated attempt work, catalogue metadata, receipt/outbox/fence rows and all pools. Use the existing
`test/support/growth.ts` capture/checkGrowth composition and `growth-capture.ts`, `growth-cost.ts`, `growth-model.ts`
all-pool instrumentation/classifier. The populations below correspond to a legal 256-row seed at its native
1/4/16 scales; positive domain populations must come from native accepted writers, not raw permission/pin facts.

### Fresh retained delete

- Touches: Native owner admission/gate/share lock and receipt point, one exact live incarnation/revision CAS, one complete typed archive insert plus due-index maintenance, exact OLD reference unbind, existing live-source/shelf fences, account-subject event, native partition/receipt/outbox/write-basis metadata. No history enumeration or current profile lookup for an old clear.
- Bound: Constant keyed domain rows/statements per attempt; index blocks O(log E + log D + log R), plus actual native Access/envelope/source and metadata bounds. Rollback on stale/exhausted CAS or archive failure. Receipt replay does no fresh domain/reference work.
- Growth check: Measure actual native guarded deletes at 256/1024/4096 legal unrelated rows per relevant owner/same-partition/other-partition axis, including archives/references and Access/receipts/outbox. Use shared all-pool capture/classifier for actual physical rows times loops, rows removed, heap/index blocks and every statement. Preserve failed and replay probes separately; no local classifier or planner settings.

### Fresh exact restore and original-pin preparation

- Touches: Current native owner admission before private archive observation, one addressed archive witness, immutable pinned Global release and original state-set decode, current source-reference/Access checks after owner checkout closes, final owner reauthorization/share/receipt, archive witness CAS, empty live-PK insert, exact archive consumption and restored reference bind, event and native envelope/metadata. No latest-deletion query or active-head historical guess.
- Bound: One addressed archive/live slot and bounded original source/release observations per attempt; domain rows/statements O(1), index blocks O(log D + log E + log R), plus actual Access/source and metadata bounds. Occupied/stale/expired failure leaves both rows unchanged. Native preparation is refreshed on retry, never a serialized capability.
- Growth check: At 256/1024/4096 legal populations measure entire actual restore across owner/Global/source pools, successful empty slot and occupied/stale/expired/missing/foreign branches. Charge all Access and preparation metadata, including the established 8192-row metadata allowance plus actual core-home points for each applicable source identity-basis read. Record real loops/removals/blocks/statements with shared capture, not time-only assertions or synthesized plan classifications.

### Authorized old receipt and denied replay

- Touches: Current owner admission/scopes/account authentication fence/gate and final share lock before exact native receipt. Preparation may observe an absent archive/dependency but defers its fresh error. Exact native receipt returns only the original acknowledgement without current live-slot absence/profile validation, archive recreation or reference repair. Denial returns no private outcome.
- Bound: Constant keyed owner/receipt work, plus the explicitly charged bounded preparation/Access work; no subject-history scan or fresh fact/event/fence writes on replay. Denial cannot inspect retained payload before owner admission.
- Growth check: At the same three populations capture delete/restore old receipts after replacement, consumption, expiry and source/profile retirement, plus each revoked persona. Compare actual full mutation evidence, physical work and shared classifier; no assertion that a cached private success replaces current authorization.

### Ordinary due page and exact purge

- Touches: Native `entry_deleted_due` seek for one partition/fixed cutoff, at most 100 original raw keys before later eligibility filters, then exact archive points/current due checks and native work/checkpoint/envelope metadata through shared workers. Consume only addressed retained payload/evidence under existing owners' minimization protocols, no live slot or second live counter decrement.
- Bound: 1 <= P <= 100 raw keys including lookahead BEFORE filtering, continuation after last examined; O(P) logical source/guard work and logarithmic seek blocks plus actual physical MVCC/index/metadata cost. At most 100 pages per workflow segment and finite native deadlines. LIMIT is not proof of constant physical tuples or blocks.
- Growth check: Separate real automatic worker acceptance at 256/1024/4096 retained/future-due/ineligible predecessor populations, all pools and real plans/physical rows/loops/removals/blocks/statements, including fixed-page progress, crash before commit, commit-before-enqueue and parked D1-versus-D3 delivery. No manual purge call, planner forcing, locally discounted metadata or weakened original worker bounds.

## Reference source inspected

Existing cached source was read only at `/home/edge/projects/rezics/rezics-next/.reference/` after its `INDEX.md`:
Nextcloud `library-entry-undo-independent-current/nextcloud-server`, `Trashbin.php` restore/collision selection and
`Trash/LegacyTrashBackend.php` restore; Discourse `partitioned-sitemap-feeds/discourse`, `trashable.rb`,
`post_destroyer.rb` recover and `post_guardian.rb` recovery eligibility; PostgreSQL
`library-shelf-maintenance/postgres`, `indexcmds.c` predicate immutability and Git-object `subselect.c` CTE inlining;
DBOS `search-worker-outcome-harness/dbos-transact-ts/src/dbos.ts` durable `sleepms` workflow context. Pins and licenses
are recorded in the two adopted reports. These corroborate already adopted separation/collision/materialization/work
constraints; no source was copied and no new external research or standard is required for this acceptance task.

## Validation evidence

The focused command check completed typechecking, formatting and linting before running all eight native tests.
The legal planned-entry create/read control passed. Six cases reached the intended lifecycle gaps: one actual-factory
assertion found no `restoreEntry`; five observed the actual physical delete's Entry result instead of the real
transaction-addressed deletion descriptor. The separate custom-profile baseline failed at the current writer's
`Unknown library entry state` for `listening`, before any archival assertion. Thus lifecycle RED and the already absent
profile writer are reported separately; none is replaced by a fixture outcome or claimed as automatic-purge coverage.
