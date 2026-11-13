# A bounded authority fence for whole-Book activation

Research recommendation, 2026-11-14. Repository evidence is the supplied base
`9eac410548b11cfd427cfe0cc56692fc0c7285a5`; the mechanisms proposed below are not installed.

**Recommend one database-wide, transactional authority epoch, locked through the Book pointer commit.**
Content/Access should own its eligibility meaning, with Kernel owning the database fence and Community owning its
container invalidators. This is the smallest conservative addition for the installed single-PostgreSQL topology.
It requires an explicit owner adoption of shared infrastructure metadata across logical homes. Existing mechanisms
alone do not meet the gate. Keep activation disabled until writer coverage and the native race test land; do not
replace the staged candidate or ordered tree. This report recommends a design; it does not adopt a new contract.

## What is installed

The [activation-currentness gate](../../services/kernel/src/content/hosted-chapters.md#prepared-book-publication)
requires every selected source to remain eligible through activation, independently of release size. It separately
requires current reader disclosure after activation. The installed components provide:

- [Staging](../../services/kernel/src/content/hosted-publication-staging.ts), particularly `observeNewTargets`,
  de-duplicates exact targets and stores thread/Post/revision/digest, author and licence observations. Its
  [attachment observer](../../services/kernel/src/content/hosted-chapters-attachments.ts) runs author metadata
  admission and a retained current check. Neither is anonymous eligibility or retained activation authority.
- [Preparation commands](../../services/kernel/src/content/hosted-publication-preparation.ts) re-admit the author,
  bind stage initiator/authentication epoch and retain bounded progress.
  [Candidate materialization](../../services/kernel/src/content/hosted-version-release-candidate.ts), including
  `sourceFence`, checks the stage/seal, pinned draft, expected publication, expiry and lifecycle under catalogue-home
  locks. It seals private immutable output, not cross-home authority.
- [Consent commands](../../services/kernel/src/content/revision-disclosure-commands.ts) issue/revoke under source
  `post:revise` and container admission. Revoke locks the source-home disclosure row and sets `revoked_at` in that
  command transaction. [Consent observations](../../services/kernel/src/content/revision-disclosure-reads.ts)
  separately read the issued row and current source incarnation. The
  [current-source SQL](../../services/kernel/src/content/revision-disclosure-current.sql) checks exact digest,
  Post/Thread creation transaction identities, availability, opening identity and logical author erasure. It does
  not lock Book activation or prove current Board/Realm eligibility.
- [Access public eligibility](../../services/kernel/src/access/public-eligibility.ts) exports the existing
  [native eligibility capability](../../services/kernel/src/access/eligibility.ts). Its callbacks prepare separately
  anchored evidence and verify current domain state; the capability is neither a durable serialized grant nor an
  aggregate proof. [Content readers](../../services/kernel/src/content/reads.ts), including `readResource`, and
  [Book disclosure](../../services/kernel/src/content/hosted-book-revision-disclosure.ts) remain the policy owners.
  The [point eligibility helper](../../services/kernel/src/content/hosted-publication-point-eligibility.ts) loops
  over bounded operands; expanding that loop to a whole Book would violate the gate.

### Actual transaction topology

[Server composition](../../services/kernel/src/server.ts) creates one Kernel pool from `DATABASE_URL` and passes it
to native modules. [Route encoding](../../services/kernel/src/route/contract.ts) has 65,536 routes and 4,096 logical
partitions. Thread, its Posts, exact revisions and disclosure rows share the source route; the catalogue/stage/root
and Book pointer share the catalogue route, which can differ. Board is independently anchored; its Realm/Space
chain is resolved at the native container home. Account lifecycle is anchored at the account home. Auth has separate
service/database authority; no Auth transaction is included here.

[Partition binding](../../services/kernel/src/database/read-snapshot.ts) currently returns the same physical client
after checking each logical home. This establishes physical co-location, not permission to join arbitrary domains.
[Content snapshots](../../services/kernel/src/content/reads.ts) release each checkout; the
[pool guard](../../services/kernel/src/database/pool.ts) rejects nested checkout from the held pool.
[`runCommand`](../../services/kernel/src/command/command.ts) uses SERIALIZABLE, native authorization before receipt
lookup, finalization, then a [partition fence](../../services/kernel/src/command/fence.sql), receipt/outbox and COMMIT.
That fence updates only the command partition's position. The
[process-local command gate](../../services/kernel/src/command/gate.ts) is keyed by pool and partition.
Neither serializes a foreign source revoke with Book activation.

Other tempting mechanisms also have narrower meanings. Semantic's
[`recordPrivacyReduction`](../../services/kernel/src/semantic/public-filter-source.ts) advances a partition-local
privacy log for its declared causes, not every Content consent/incarnation transition. Access
[Realm transition coordination](../../services/kernel/src/access/README.md#realm-transition-coordination-and-deletion-entry)
uses account-home holds and immutable foreign commit/cancellation proofs to prevent deletion during a particular
membership transition. It is not a lock taken by every source/policy/takedown writer. Suspension expressly bypasses
coordination holds in [its native owner](../../services/kernel/src/access/suspension.ts).

## Required invalidators and boundaries

The fence records changes; it never decides permission. Each batch must obtain positive native eligibility, either
the anonymous public baseline or exact Book-scoped consent plus current native container disclosure. Author-readable
metadata alone must not count. Losing the issuer's ordinary edit role is not itself consent revocation.

| Invalidation | Concrete installed writer/storage | Required epoch boundary |
| --- | --- | --- |
| Explicit exact consent revoke | `revision-disclosure-commands.ts`, `revision-disclosure-revoke.sql`; `content.revision_disclosure` | Same source transaction as the issued-to-revoked change, before its COMMIT. |
| Source incarnation, opening/ancestry, visibility, selected revision availability/digest/licence, author erasure | `content/commands.ts`, `erase-post.ts`, `account-erasure-authored.ts` and their SQL; `content.thread`, `content.post`, `content.revision` | Every mutation/deletion that could invalidate the native observation, including mechanical cleanup. Newer draft bytes do not substitute for the selected revision. |
| Early erasure denial and later physical erasure | `content/account-erasure.ts`, `erasure-fence.ts`, `access/lifecycle-fence.sql`; `content.erasure_fence`, `access.account` | The first native eligibility-closing account/fence transaction, not only eventual revision deletion. |
| Current Board and Realm/Space policy or lifecycle | `content/erase-post.ts`, `takedown.sql`; `community/realm.ts`, `container-lifecycle.ts`, `container-lifecycle-binding.sql`; `content.board`, `community.realm`, `community.space` | Same transaction as visibility, binding, head or lifecycle change. Include ancestor changes without enumerating descendant Books. |
| Takedown of selected Post, Thread, ancestor or Board | `content/moderation.ts` delegates to `erase-post.ts`/`takedown.sql` | Same native mutation transaction; a moderation event consumed later is too late. |
| Home movement/authority reset | `core.partition` ownership epoch, node, moved destination or write-state change | Invalidate proofs when a home ceases to be the observed authority. Ordinary outbox `position` increments are not authority changes. |

These paths are under `services/kernel/src/`. The table names identify the mutation coverage, including SQL triggers
and background callers, rather than only public HTTP endpoints. Media and imported source-tuple fences are not
authority for these stored Post revision bytes; their independent reader obligations do not become Book activation
scope. Source-specific grants cannot turn author metadata into public eligibility.

The initial fence can conservatively cover *all* UPDATE/DELETE statements on the listed domain tables, and all
INSERT/UPDATE/DELETE on `content.erasure_fence`; immutable revision INSERT alone cannot invalidate an existing exact
revision. Cover core ownership columns specifically, excluding `position`, or every preparation command would
invalidate its own proof. False invalidations from ordinary Post edits/account metadata are acceptable costs of this
first design. If an owner adds an eligibility dependency, its mutation table joins this coverage before use.

The target proof uses anonymous native floors and durable exact consent, not retained authenticated role grants.
The anonymous branch in [Access's formula](../../services/kernel/src/access/permission-check.sql) has no authenticated
grant/role lifetime to extend. Activation still re-admits the author under native time/deadline rules. If a later
target predicate can expire without a write, Access must supply its next transition and aggregate the minimum into
the proof; epoch equality alone would then be insufficient. An arbitrary stage TTL cannot supply that evidence.

## Proposed data and protocol

Add one Kernel infrastructure row, conceptually
`core.publication_authority_fence(singleton, generation UUID, epoch BIGINT, ready BOOLEAN)`.
It is not a routed resource, permission table or caller-provided epoch. Epoch advances with a transactional row
UPDATE, never a sequence. Missing/not-ready state refuses fresh proof work and activation. Overflow fails closed.

Install owner migrations with statement triggers on the mutation coverage above. Each covered statement updates
the singleton inside **the same physical transaction**. BEFORE-statement execution obtains the row lock before
that statement's domain mutation; rollback rolls back both. This covers old native command binaries, maintenance
and eventless operational writers without relying on a new optional callback. TRUNCATE, disabled triggers and
restore require a stopped-traffic barrier and a new generation. Install all hooks before marking the fence ready;
never enable activation during partial rollout. Authority tables and the fence must remain in this database.

Content adds a separate authority-generation record bound to the already sealed stage/candidate: catalogue and
stage IDs, source/input version, candidate generation/root commitment, distinct-target coverage, native fence
generation/epoch, raw target frontier, validated count and completion. Store no callbacks or bodies.

1. Capture `(generation, epoch)` **before** the first authority observation, in a fresh native read snapshot.
   Validate at most the existing 20-row target-page bound through the owner eligibility seam. Persist frontier and
   coverage atomically. Each later authority step starts with a fresh snapshot and requires the same fence.
   Do not carry a snapshot from before capture into a source observation.
2. Once every distinct staged target and the catalogue opening have positive native proof, seal this authority
   generation against the immutable target coverage/root binding. A changed fence invalidates the authority pass;
   it does not delete or rebuild the private ordered candidate. Existing sealed candidates need this bounded pass
   over retained target keys because their earlier attachment checks were not eligibility checks. Future work may
   collect the same proof during preparation, without duplicating tree materialization.
3. In fresh activation, preserve `runCommand` author/container admission **before receipt replay**. On a receipt
   miss, lock the singleton with `SELECT ... FOR UPDATE` on the **catalogue command client**, compare generation,
   epoch and ready state, and lock/check the stage/authority seal, expiry and expected pointers. Then write the
   native publication descriptor/root and CAS the Book pointer, with receipt/event, in that transaction. Hold the
   singleton lock until COMMIT. This exclusive mode also avoids concurrent activation lock-upgrade cycles.

No foreign domain callback/checkouts run while this lock is held. The new fence adapter exposes only capture and
locked equality validation; Content/Access exports the batch eligibility producer using their existing formula
and container readers, including the private-opening wrapper exception. Candidate membership is proved internally
by Book, never supplied as a public reader credential. Existing consent-source SQL alone is not that producer.

### Causal schedules and recovery

Without the addition: last batch observes issued consent; source-home revoke commits; catalogue-home activation
checks its still-current seal/draft/publication and commits B. Reader then withholds the target. Both transactions
can be locally SERIALIZABLE: activation need not read the revoke row, and no installed shared conflict exists.
Even a released last-step check followed by a pointer commit leaves this interval.

With proof epoch `e`, if revoke obtains the singleton first, it changes consent and advances to `e+1` atomically.
Activation either sees the mismatch or its stale SERIALIZABLE locking read fails; A stays selected. If activation
obtains the singleton first, revoke cannot commit its mutation until activation commits B and releases the lock.
Revoke then commits, and current readers deny bytes. An attempted but uncommitted revoke is not an earlier revoke.
There is no schedule in which a committed pre-activation invalidation preserves equality at activation.

PostgreSQL documents transaction-held row locks and failure of locking reads against rows changed since a
REPEATABLE READ/SERIALIZABLE snapshot. These are the external guarantees used by this reasoning; SERIALIZABLE alone
does not extend a previously released transaction's observations.
([Row locks](https://www.postgresql.org/docs/19/explicit-locking.html#LOCKING-ROWS),
[isolation](https://www.postgresql.org/docs/19/transaction-iso.html#XACT-REPEATABLE-READ).)

Crash before COMMIT leaves A and no activation receipt; restart resumes the exact durable authority frontier, but
must compare its retained epoch in a fresh snapshot. Crash after COMMIT/lost response replays B's original receipt
after current author admission, even after subsequent revoke. It must not reactivate B or demand the old epoch on
that successful replay. A fresh stale draft/publication CAS rolls back descriptor/pointer/receipt changes. Native
serialization/deadlock/lock-timeout handling keeps the original deadline and never refreshes the proof epoch to
make stale coverage pass. Ordinary database/process restart retains the fence; restore changes generation before
traffic. No process-local cache or post-commit invalidation delivery is needed.

## Feasible alternatives and cost

Let N be placements, U distinct targets, H bounded native ancestry depth, and F dependent preparations.

| Approach | Preparation/batch | Final activation | Invalidating writer and contention |
| --- | --- | --- | --- |
| **Recommended conservative epoch** | O(UH) native checks in 20-row steps; O(1) extra control state/frontier per authority generation beyond retained targets. No locks across requests. | One epoch-row lock/comparison plus fixed seal/CAS work, independent of N. | O(1) extra row UPDATE per covered statement, no Book fanout. All invalidators and activations share a hot row. An unrelated change can require O(UH) revalidation; continuous changes can starve completion. |
| Source/ancestor subscriptions marking each preparation invalid | O(UH) dependency registration, atomic with observations at every dependency home. | One preparation validity check only if all invalidations already reached it transactionally. | O(F) synchronous updates for broad policy changes, or unbounded lock/fanout. Paginating after the source commit reopens the race. More storage, cleanup and cross-home protocol than the conservative fence. |
| Fixed partition/version vector | Capture/retain up to 4,096 entries before checking sources. | Lock/compare the whole relevant vector, capped at 4,096 rather than N. | Existing `core.partition.position` is overly broad and is not advanced by every [operational writer](../../services/kernel/src/command/operational.ts); its [operational fence](../../services/kernel/src/command/operational-fence.sql) only takes FOR SHARE. A dedicated invalidation vector still needs coverage hooks and many final locks. |

A fixed-size striped authority epoch is a possible later compromise: dependencies register a bounded bucket bitmap,
writers update a bucket, activation locks all selected buckets in order. Large releases approach all-bucket
invalidation; it does not eliminate the coverage obligation. Do not add it before contention warrants the extra
protocol. A long-lived shared lock across preparation would instead delay revocation/erasure and fail restart
requirements. A PostgreSQL advisory lock alone retains no change history; a row epoch without a transaction-held
activation lock leaves the final interval. Neither locks across separate databases.

## Immediate implementation handoff

Content consumes the result in the pending whole-Book native activation owner. The first implementable subtask is
the fence primitive, complete invalidator hooks and a native two-connection race fixture; it needs no further
ordered-generation work. The second is Content's bounded authority pass and activation consumption of that proof.
Keep activation disabled between these slices. Owner adoption belongs in
[hosted-chapters.md](../../services/kernel/src/content/hosted-chapters.md#prepared-book-publication), with the shared
fence boundary owned by Kernel/Access and Community invalidation coverage recorded by Community.

Exact existing locations to extend after adoption:

- Kernel `services/kernel/db/migrations/` for the infrastructure row/function, and
  `services/kernel/src/command/command.ts` / `operational.ts` for declared lock/deadline/accounting integration as
  needed; put the new capture/locked-compare adapter beside `database/read-snapshot.ts`.
- Owner hooks in `services/kernel/db/{content,access,community}/migrations/`; the concrete mutation producers and
  SQL are in the invalidator table. These are database hooks, not event-consumer additions. Partition ownership hooks
  belong in the Kernel migration. Native author/source/reader semantics remain with the existing owners.
- Content `hosted-publication-staging.ts` target keyset reader, `hosted-publication-preparation.ts` orchestration,
  `hosted-version-release-candidate.ts` seal binding, and `hosted-publication-point-eligibility.ts`,
  `revision-disclosure-{commands,reads}.ts` / `reads.ts` native eligibility seams; new authority control storage in
  `services/kernel/db/content/migrations/`. Reuse `hosted-version-revision.ts` and the existing publication CAS.

### Smallest executable native acceptance scenario

Add `services/kernel/test/content/hosted-publication-activation-currentness.test.ts` using the real
[hosted fixture](../../services/kernel/test/content/support/hosted-chapters-fixture.ts),
[candidate test](../../services/kernel/test/content/hosted-version-release-candidate.test.ts) setup and
[native consent fixture](../../services/kernel/test/content/revision-disclosure.test.ts) patterns. Use two pools
to the same test database, not one process-local gate or fake Access.

Publish complete A. Build/seal B with 21 distinct exact private-opening targets across two authority pages, at least
one source home different from the catalogue, public native containers and properly issued Book-scoped consents.
Revoke a target validated on page one **after the last page/seal and before activation**. Wait for the real revoke
COMMIT. Fresh activation must refuse and leave A's pointer, root and public contents unchanged, with zero final
per-target metadata/body queries. Then rebuild only the authority proof after deliberate consent re-review/new key.
Pause fresh activation after its singleton lock; a separate-pool native revoke must not commit until activation
commits B, after which an exact anonymous Book reader must deny that source's bytes. Use transaction barriers,
not sleeps. Roll back one revoke to show it does not invalidate committed proof.

Parameterize the same schedule for native Post takedown/erasure, Board takedown, Realm/Space removal and account-home
erasure-fence closure; assert the epoch advances in the mutation transaction. Add interrupted authority-page replay,
stale publication CAS and lost activation-response replay after revoke to the same fixture. Count final target
queries for both one and 21 targets; the count must stay zero. These cases are proposed native acceptance, not
evidence that the fence already exists. Production/native suites were not run for this research-only change.

## Primary sources and confidence

REZICS links above describe installed source behavior, not executed native measurements. External research reused
`/home/edge/projects/rezics/rezics-next/.reference/library-shelf-maintenance/postgres` at
`700b422af7e26cf310caf3fb76d78f4c8ca39c1f`. Sparse-clone files were read with `git show`, without installing,
building or executing upstream code:

- [`doc/src/sgml/mvcc.sgml`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/doc/src/sgml/mvcc.sgml),
  row-lock/deadlock/advisory-lock semantics, plus the official version-19 documentation cited above.
- [`src/backend/utils/adt/lockfuncs.c`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/utils/adt/lockfuncs.c),
  `SET_LOCKTAG_INT64` binds advisory locks to `MyDatabaseId`; transaction variants pass `sessionLock=false`.
- [`COPYRIGHT`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/COPYRIGHT):
  PostgreSQL License. No upstream code or prose is copied. The shared reference index records this reuse.

The installed database script pins PostgreSQL `19rc1` by digest in
[`services/kernel/scripts/database.ts`](../../services/kernel/scripts/database.ts); the web documentation is a
version-19 reference, not a claim about a live server's patch version. Confidence is high in the missing-conflict
counterexample and the co-located row-fence argument. Writer coverage, lock duration and sustainable preparation
success rate require the proposed native implementation/tests. Actual separation of authority homes into different
databases, a new clock-only eligibility loss, or unacceptable global invalidation rates would change this
recommendation and require an owner-designed scoped/transition protocol before activation.
