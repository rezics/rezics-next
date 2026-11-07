# Identity rating currentness

## Reviewed identity and commit participant

Decision: retain Content’s sole vote writer and native owner-row participant; same-home provider commands apply guarded votes with independent counted readback and exact authorized replay, while foreign homes remain unavailable. Native publication acceptance requires Source’s installed Search composition and live maintenance frame. Released review binds the exact requested/canonical pair to bounded native source and persisted control evidence; admission locks the local `core.partition` owner row and compares that operand on the original command connection through COMMIT/ROLLBACK; foreign homes remain unavailable.

Semantic exposes `readIdentityRatingReview(pool, { requestedOriginalId, canonicalTerminalId, deadline })` from `identity-adapters/read.ts` and the `kernel-semantic` public entry `semantic/index.ts`. A reviewed result contains `operand: IdentityRatingReviewOperand`; other results preserve pending `{ jobId, epoch }`, moved `{ home }`, changed `{ canonicalTerminalId }`, absent, undisclosed, and typed unavailable outcomes. Unavailable reasons are `bootstrap`, `missing-owner`, `changed-during-read`, `control-limit`, `redirect-chain`, `canonical-mismatch`, and `operand-too-large`.

Decision: rating-review keys 2 / locators 2 / operand 16,384 bytes live in the identity-core leaf
`rating-review-bounds.ts`. Native Rating review errors bind through `nativeRatingReview` on `SemanticDomainPorts`;
Content cover and imported-tuple routing bind through `nativeContentLifecycle`. Inward subject, summaries and bulk
HTTP resolve that port through `adapters/ports.ts`; they do not import Rating or Content. Cost remains this
document's operand and same-home COMMIT participant bounds.

The version-1 operand freezes the exact ordered requested original and, when distinct, canonical terminal; their sorted source homes; sorted persisted `{ partition, group }` control locators; and strict serialized evidence. Evidence contains the classifier's comparable source-owner epochs and write states, source mapping epochs and owner epochs, dirty/captured/source revisions, immediate closure redirect, target, closure state, enrollment, generation, incarnation, export/install/registration transaction IDs, control-owner epochs and write states, pending job/epoch, published epoch, group generation and closure state, directory install/export/revision/owner evidence, native registration transaction, redirect state, and the exact source disclosure states. `comparableIdentityEvidence` continues to omit unrelated partition position. The reader double-collects released per-home snapshots and releases each connection. It reads at most two source IDs, two source homes and two persisted control locators, uses at most 24 bounded read statements and 24 evidence rows across both collections, and rejects a serialized operand over 16,384 UTF-8 bytes.

The exact public transaction participant is `createIdentityRatingCommitParticipant()` from `identity-rating-commit-participant.ts` and `semantic/index.ts`. Its `prepare(operand)` strictly validates the version, exact fields, ordered source identities, routed homes, sorted unique control locators, row counts, UUID/integer forms and canonical evidence encoding. A current group with no pending job carries a null pending-job/epoch pair; that pair is valid reviewed evidence through both a fresh native read and a JSONB round-trip of the operand, including PostgreSQL JSONB object-key order. An unpaired pending job or epoch is invalid. An exact typed pending job/epoch pair is pending, not reviewed. Preparation carries no command authority or lock. For a fresh command body, after authorized receipt handling and before no-op, cleanup or business effects, Content calls `participant.admit(tx, preparation)` on the original `runCommand` transaction. Admission checks `currentCommand(tx)` and its original deadline, refuses unless every source and persisted control home equals `command.partition`, then uses `deadlineClient(tx, deadline)` to `SELECT core.partition ... FOR UPDATE` before rereading evidence on that same connection. It reuses `classifyIdentityMappings` and compares the complete reviewed operand under the owner row lock. That lock is held by PostgreSQL until the executor commits or rolls back, including timeout and exception paths; there is no independent checkout, finalize callback, process mutex or SERIALIZABLE-only fence.

Successful admission returns `IdentityRatingCommitHeld` with the actual locked `ownerId`, `ownerEpoch`, command `partition`, exact `subjectId`, and each persisted `publishedHeads` `{ partition, group, epoch }`. These descriptive values are valid only for that transaction attempt and are not a reusable authority token. A changed canonical terminal maps to `VoteReviewStaleError('subject_changed')`; changed source, owner, control, generation, pending or registration evidence maps to `VoteReviewStaleError('identity_epoch_changed')`. Pending maps to the existing `identity_pending` vote-review reason. Foreign homes map to `atomic_guard_unavailable`; moved, absent, undisclosed and other unavailable states retain `IdentityRatingCommitUnavailableError.identityState` and map to the existing identity-observation-unavailable reason. The reader does not grant question/voter eligibility. Content still owns current authorization before receipt/replay, question/lifecycle/ballot admission, `VoteReviewGuard` and digest normalization, counted-own-vote evidence, exact authorized replay, one effect, and event/readback handling.

For a same-home command, the single native held row is `core.partition(partition_no = command.partition)`. Native mapping publication, source dirty/redirect updates, group generation and pending/publication control writes in `identity-epoch-store.ts`, `identity-epoch-admission.ts` and `identity-epoch-mapping.ts`; terminal closure and directory enrollment/install/export/registration writes in `identity-terminal-closure.ts` and `identity-epoch-bootstrap.ts`; and ordinary command writes all finish through `command/fence.sql`, which updates that same owner row. No-effect command completion uses `command/no-effect-fence.sql` and takes `FOR SHARE` on the same row. Consequently either writer order is serialized before the final identity comparison or blocked through the guarded command's completion. The participant acquires the owner row before its keyed evidence reread, so it does not rely on missing-row locks for source/control insertions. It does not lock an unrelated global partition or treat co-residence on PostgreSQL as home equality. Foreign control, enrollment, movement or abort remains unsupported and returns `atomic_guard_unavailable` before effects.

Content's original voter command reads the complete identity operand and admits both the standard question and Semantic participant before no-op, cleanup or effects. Historical guards without the operand retain their exact authorized receipt replay but cannot start a fresh effect. Content retains authorization, receipts, independent counted-effect readback and the sole vote writer. Semantic does not create another publisher or manufacture participant acknowledgements.

| Provider caller | Actual guarded request                                                                                                     | Native command custody                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| VNDB            | `list-import-vndb.ts` sends stored `nativeGuard`, canonical observation and owner-selected units to `votes.putVoteOutcome` | Stored original command actor/key and `scoreAdmission` |
| Bangumi         | `list-import-bangumi.ts` sends prepared `command.input` with observation, guard and source admission                       | Retained score command key                             |
| MAL             | `list-import-mal.ts` sends prepared `command.input` with observation, guard and source admission                           | Started score checkpoint key                           |
| AniList         | `list-import-anilist.ts` sends prepared `command.input` with observation, guard and source admission                       | Retained native command key and separate consent       |

The four-provider native test uploads provider records through each mounted owner, explicitly selects a native Subject, reviews and applies the score, then independently reads Content and Semantic. It records requested/canonical Subject UUIDs, standard question UUID/home, native account UUID/command home, source homes and persisted control locators. Subjects and accounts enter through authorized native creation and registration in the question's home and a foreign home. Same-home tuples produce one counted vote and replay the original apply request without changing its revision. Every foreign tuple remains `atomic_guard_unavailable` even on the same PostgreSQL instance and writes no own vote. Semantic does not supply Person identifier merge expectations.

The authorized vote transaction test holds the actual Semantic owner lock inside Content's original command, excludes terminal-closure, Mapping and Library participant writes through both COMMIT and ROLLBACK, reconciles Mapping's native receipt after that command, refuses a prior review after Mapping of that identity, rejects a later review after a native control change, and retains the original successful receipt replay. Successful identity publication in both writer orders requires actual Mapping, Search and Library acknowledgements. The composition root installs same-Pool Access, clock, generation-1 physical owner and the six-operation production declaration on the Search participant. The coordinator wraps produce in the original Source maintenance frame; Search commits native plans then enrolls common receiving inside that frame. Search completes only after every mapping original has a native plan, pending is empty, and the directory witness matches. ALL-Library completes only after a committed 16-route original scan with no affected collections and no building plans, or after six-driver sealed pages are applied; empty registration is not an ACK. Interrupted-install remaining() tracks unclosed topology homes rather than a hardcoded 4096.

Decision: Search and Library acknowledgements complete through that installed composition, independent native receipt reconcile, and exact original tuple plus sealed authorized replay; publication-first stale review still precedes Rating admission. No empty-queue completion, source-epoch observation or vote-side publisher substitutes.

The native writer tests exercise admission, mapping, birth/dirty capture, bootstrap and terminal-closure entry points under a held participant, with both COMMIT and ROLLBACK release. Control-generation replacement with unchanged source epochs invalidates the exact reviewed operand as `identity_epoch_changed`, including when the new directory no longer classifies as current. Missing owners, pending, moved, absent and undisclosed outcomes retain their existing handling.

The growth journey fixes the reviewed Subject/control pair while growing unrelated identities, retained cancelled-job history and noncurrent selected-key directory generations at 64/512/4096. It retains examined rows, statements, owner-lock acquisition and request/response bytes through the existing native growth capture. Imported retained-history rows do not grant publication or receiving authority; growth clones them under replica role so erasure removal is not mistaken for a live command. Job immutability keeps intent and receipts fixed while admission may write pre-arm phase and cancellation locators on that same row. Transaction locators are uuid columns and epoch/position are integer/bigint: writers cast bound CASE/assignment expressions rather than leaving them typed as text. Mapping, growth, provider and authorized-vote fixtures each use a private migrated deployment so Global grants and operator bootstrap stay independent of another test's source. Provider and authorized-vote callers still receive those Global grants on the profile fixture before identity installation, matching the VNDB native scorer path. Default Community worker cases likewise clone a private template before construction. Control-generation replacement writes through replica role so the owner-row pre-arm guard is not mistaken for the stale review. Preparing jobs own the prepare reservation; publication clears it and revisits admission to release homes, bridges and Source holds. Lifecycle supplies platform-native inverse removal on that control home; Identity finish-close does not borrow editorial write-basis. Accounts pre-arm each grant action on the acting token before identity installation, and cancelled admission retains input and source rows until that Lifecycle removal. Fixture parent permissions (space/realm/subject create, steward definitions, active_accounts, library gate, subject:merge) install as trusted grant rows; ordinary product commands still run Access. Source exports `IDENTITY_HISTORY_ORIGINAL_SOURCE_DECLARATION` from owned eight-axis children; History/SDK multiplicities and Core's event-callback profile remain foreign gaps.

## Visibility repair

Visibility repair uses `IdentityRatingParent` as the native Performance boundary. The parent persists the immutable page binding and commit receipt with each effect, verifies the owner incarnation before commit and acknowledgement, and replays those records after an interrupted return. The consumer processes at most 64 work items per page and at most 8 pages per invocation; terminal provenance is reclaimed only after the parent's final-reference check succeeds.

Decision: `createIdentityRatingRepairProducer()` from `identity-rating-repair-producer.ts` and `semantic/index.ts` is the native mapping/obligation producer for Rating identity repair. `hold(tx, page)` on the original voter command locks `core.partition` for that home, classifies at most 64 same-home original-to-visible-terminal mappings, and inserts a retained obligation covering later mapping changes and votes beyond the captured upper key. Empty terminal pages take the same path with no mappings. `complete` binds that obligation to the Rating receipt in the same transaction; a failed handoff rolls the page back. Foreign source or control homes persist a preparing obligation and emit at most eight one-partition prepare continuations; `prepare` locks that home, `handoff` writes the voter receipt, and `drain` pages later_change/later_vote plus trigger overflow 64 rows at a time. Released `readMapping` observations never implement hold. Composition installs the factory and binds Rating's port; Content retains vote/effect/receipt/checkpoint writes and does not import the Semantic factory. The two-key `createIdentityRatingCommitParticipant` remains the reviewed same-home vote guard and is not this 64-vote page authority.

Rating Performance Cost for those hold/complete/drain multiplicities lives in
[identity-repair Cost](../rating/README.md#cost-identity-repair-commit) and `identity-repair-bounds.ts`. Injected
Rating page-seam fixtures are not this producer's native evidence. Later votes beyond the captured upper key set
`later_vote` through the Rating vote trigger; pending continuation events commit the preparing obligation on the
original voter command. Account identity-source consumer custody in
[identity-source-consumer-custody-contract.md](identity-source-consumer-custody-contract.md) is a different
receipt and does not implement this page obligation.

## Retained progress boundary

Decision: native acknowledgement retains the exact page checkpoint; the consumer resumes after an acknowledged nonterminal page and verifies a native tombstone before replaying a reclaimed terminal page.

`IdentityRatingParent` is the minimal native seam on this source. The journal below
supplies retained-page storage. Mapping and retained-obligation authority is
`createIdentityRatingRepairProducer`. Rating vote inventory and moderation
scheduling remain Rating's.
The consumer does not create another rating or erasure writer. Existing parents without
checkpoint support keep their receipt-based behavior; durable continuations require all
three native methods described below and `native` metadata on their selected pages.

The selected page's `native` identity names the retained frontier, phase and revision.
All three enter the selected-page digest together with the scope, owner incarnation,
epoch, cursors and work items. Scheduler ordinals are never substituted for them.
`readRepairCheckpoint` reads the checkpoint committed with native acknowledgement.
It takes precedence over a caller's older saved reply. A nonterminal checkpoint means
the next selection must start at its exact `next` cursor; an unchanged selection stays
pending before another commit. Each invocation still advances at most eight pages.

A reclamation checkpoint reselects the exact retained terminal page, verifies its
committed receipt and acknowledges idempotently before attempting another cleanup step.
`selectPage` with a replay binding must resolve that retained page, even if the live
frontier advanced. An unrelated selection, changed native phase/revision, changed scope,
or different receipt position cannot satisfy a replay.

`reclaimFinalProvenance` may return `continuing` after one bounded removal page.
The caller retains the reclamation checkpoint and schedules the next invocation.
`still-referenced` preserves existing completion semantics: this obligation is finished,
and another real reference retains the payload. The native owner must wake cleanup when
that last reference disappears. Every native cleanup stage must be idempotent.

After the last reference permits payload removal, the native owner retains a compact
tombstone binding the scope, frontier, phase, revision, selected-page digest, owner
incarnation and committed receipt. `verifyReclaimedCheckpoint` checks that evidence
through native full keys, including current ownership; caller JSON grants no authority.
The consumer checks this proof before reselecting payload, including when a cleanup
reply was lost before a `complete` checkpoint reached the caller. A missing verifier
cannot certify terminal replay. Owner ABA leaves replay pending. Compact replay does
not require retained vote payload. This is domain replay evidence, not a funding ticket.

## Consumer structural bounds

Every textual selection operand is at most 256 UTF-8 bytes; the visibility has three
fixed values. A page has at most 64 unique work-item IDs, each with three textual
operands and one safe integer or null. The selection has at most twelve other textual
operands (scope, page identity, two cursors and native identity). JSON escaping expands
each input byte by at most six; numeric values need at most seventeen bytes. Thus an
encoding candidate is below `204 * 256 * 6 + 64 * 17 + 2,048 = 316,480` bytes.
The accepted complete encoding is capped at 65,536 bytes before hashing. Oversized,
duplicate, malformed and nonadvancing pages perform no native commit. Scope and page
identity are frozen before crossing asynchronous boundaries. Receipt identity is frozen
before native verification and acknowledgement. Checkpoints carry fixed identity and
receipt fields, never work-item payload or arbitrary extra properties.

One page calls selection, receipt read, optional commit, verification and acknowledgement
at most once each: five native calls, including conflict, empty and lost-reply recovery
paths. A repair invocation adds one checkpoint read, at most one compact replay check
and at most one reclamation step. Its ceiling is `8 * 5 + 1 + 1 + 1 = 43` native calls;
compact terminal replay takes at most two. Failures terminate the invocation; no local
retry loop repeats IO. Pending paths are prefixes of these finite paths. These are
consumer bounds; they do not claim the absent producer's SQL/index/trigger bounds.
The mapping producer composes its documented per-call bounds with these finite
multiplicities. No quote, prepaid balance or runtime dispatch allowance is required.

## Native retained-page journal

Decision: preserve the retained consumer API and implement its native replay storage as
an additive transaction-local journal; connect the absent producer through
`IdentityRatingJournalProducer`, without importing its incompatible replacement consumer.

`identity-rating-journal.ts` supplies durable selected pages, receipts, acknowledgement
checkpoints and compact terminal replay evidence. It requires a live native command.
The producer's existing wrapper admits and locks once, then passes the whole normalized
selection to its read-only `assertHeldAdmission` in that same transaction. Its sole
`applySelectedPage` writer is called only when no native receipt exists. Persisted
ownership uses `core.partition.node` and its monotonic `epoch`; selected owner fields
must match them. The root never updates its owner incarnation and cannot revive after
reclamation. Moving away and back therefore cannot authorize terminal replay.
Every journal method holds the native owner row lock through the command fence,
including checkpoint and compact-proof reads, so ownership cannot change during verification.

Acknowledgement and the producer's frontier advancement belong in the same transaction.
The journal retains the actual native frontier, phase, revision and selected-page digest,
never a scheduler ordinal. Its checkpoint wins over lost caller replies. Exact selection
uses the full scope digest and page digest and compares the entire scope and binding.
An acknowledged old page cannot rewind progress. A unique partial index admits at most
one unacknowledged selection per scope. Native empty pages follow the ordinary effect
and receipt path; producer failures roll back the page and never certify an empty result.

Journal reclamation is only the final retained-copy stage. The producer must first
finish its provenance, event, obligation and receipt inventories and prove removal of
the final real reference under its held reference fence in the same transaction.
`reclaimIdentityRatingJournalPages` keeps the terminal selection through every bounded
deletion page. The final deletion and compact tombstone commit atomically, so loss of
that reply is recoverable without reading deleted payload. The journal does not claim
that its page count is the producer's reference inventory. Accounts' combined erasure
and historical redirect flattening remain separate outcomes.

### Static journal bounds

There are two tables, each with a full-key primary index. Page insertion also maintains
one partial unique index on the scope for unacknowledged pages; its foreign key probes
one journal root. There are no triggers or cascades. Scope keys are fixed SHA-256 text,
with full JSON comparison after lookup. A selection uses the consumer's 65,536-byte
array encoding limit. Its stored object representation adds at most 64 sets of fixed
field names plus fixed page names (less than 8,192 bytes); 131,072 bytes allows SQL
JSONB whitespace and encoding. Root scope, binding, receipt and checkpoint encodings
have enforced 4,096/16,384/8,192/32,768-byte ceilings respectively. They contain only
the adapter's bounded fields. Whole rows and constant-width indexes are finite.

Commit uses at most five journal statements: one owner lock, root insert, root lock,
receipt seek and page insert. Producer application is an independently composed
cost. Including conflict, uniqueness and foreign-key probes, the journal examines
at most eight rows, writes at most two rows and inserts at most three index
entries. Receipt conflict/replay is its four-statement prefix and never repeats
producer application. Acknowledgement uses at most five
statements, examines at most five rows and updates two rows; it removes at most one
partial-index entry. Checkpoint read and terminal verification use two statements
and at most two rows. Exact page replay uses three statements and at most three rows.

Cleanup uses at most six journal statements: owner/root locks, an indexed ordered
65-row seek excluding at most one terminal row, deletion of at most 64 selected keys,
one terminal-key deletion and one root update. It examines at most 134 rows,
deletes at most 65 page rows, updates one root and removes at most 130 index entries.
It returns `continuing` after the first 64 when more remain. Reclaimed replay uses the
two-lock prefix. Final-reference verification is an additional producer cost on each
nonterminal cleanup invocation. Failures terminate without a local retry loop.
For the consumer's 43-call ceiling a conservative journal allowance is
`43 * 6 = 258` statements and `43 * 134 = 5,762` examined rows, plus the separately
derived producer selection, effect, admission and reference-verification bounds.
No runtime quote, funding ticket, balance or dispatch allowance is accepted.

Native producer caller installation, all other cleanup inventories and their composed
SQL/index bounds remain required before native end-to-end acceptance. This journal
does not activate an alternative vote writer or change moderation authorization.
