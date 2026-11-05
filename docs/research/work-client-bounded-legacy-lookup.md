# Bounded legacy Realm-leave workflow-step resolution

Research date: 2026-11-02. Evidence only; no owner contract is changed here.
All execution is **UNRUN**: no SDK, database, test, compiler, probe, remote process or
performance campaign was run. Original acceptance is deferred by the launch execution
policy. This documentation change has no changed workspace requiring typing.

## Recommendation and adoption boundary

Adopt a transactionally maintained, rebuildable **Work compatibility locator** in the
DBOS system database. It must represent the best _eligible parent/reservation group_,
not merely the latest parent or last enqueued child. Keep ordered parent and child
candidates so deletion can expose the next candidate by an indexed first-row seek.
Install maintenance at the actual SDK status/input write boundary, covering old
executors and native deletion, rather than only adding an application enqueue callback.
Resolve the legacy key with one equality-prefix ordered seek, then call the original
SDK method with the selected actual ID and the original options.

This is one complete implementation recommendation: compatibility projection,
transactional maintenance, retained-history backfill, cutover, cleanup integration and
native regression/growth tests belong in the same delivery. A point-lookup facade
over an incomplete backfill is not completion. No read-time history scan is part of
the completed path. Incremental deployment may retain the existing implementation
until coverage is established, but cannot call that intermediate state bounded.

Two owner agreements must accompany adoption. Content and Accounts must agree on a
deterministic refinement of the existing unspecified ties, and on custody/erasure of
the additional locator copies. They retain their native membership, reservation,
terminalization and release contracts. This report does not choose a different native
Accounts contract or manufacture a migration-completeness receipt.

Public SDK attributes and PostgreSQL expression indexes are useful primitives, but
neither alone represents whether a parent has a retained matching child. They do not
bound the existing joined lookup for repeated realm/member history, especially misses.
The recommendation is a derived index of existing facts, never a lifecycle authority.

## Current development source and provenance

Inspected the assigned worktree on its required worker branch, at source/base
`883b94a387ada164c7f60c2ed9ff2112cec8ee62`. These are current development sources,
not an inference from a main checkout or an older research report. Repository code
is AGPL-3.0-only. Links below pin that snapshot; last-change revisions help distinguish
the relevant source generations.

| Source                                                 | Last change at inspected snapshot          | Evidence                                               |
| ------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------ |
| `services/kernel/src/work/client.ts`                   | `0ce2fe8f17cad0fd9dcca565c579b24f42772424` | Wrapper, exact fallback SQL, options, pool ownership   |
| `services/kernel/src/community/join.ts`                | `5166d62f59e4ee00fe509bd3d69848e6c00b4b2e` | Production admission, input and parent IDs             |
| `services/kernel/src/community/work.ts`                | `03b9dcee089a1e9c6090789c4444fc4c603da087` | Child ID derivation and enqueue step                   |
| `services/kernel/src/access/membership-work.ts`        | `0ed0729970c197fb080f63f148bc45fe5c66777f` | Exact child input validation and reuse checks          |
| `services/kernel/test/work/growth-work-client.test.ts` | `c5c5631257b6e7358684f88e025ddf07311f3ca9` | Existing linear fallback allowance, UNRUN              |
| `docs/architecture.md`                                 | `4736cfd8a3c3fb1aa86ce7d07691fd9af1ecb62f` | Logical work bound excludes invisible MVCC maintenance |

The installed read-only artifact is
`services/kernel/node_modules/@dbos-inc/dbos-sdk/`, version **5.5.3-preview**, MIT.
It is locally patched through
`patches/@dbos-inc%2Fdbos-sdk@5.5.3-preview.patch` (last change
`19bdf93297c05a87fe70c737fcf88717738ef3d3`). Artifact identity, SHA-256:

| File                          | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `dist/src/client.js`          | `9031a6d260650e4e39f225e366e43eac8d7646fb799ab8270d7117ad0826a971` |
| `dist/src/system_database.js` | `7f8acb0c80120ad0afa59e7848bbebbfcae5d3f0754d459764b923c1b0343f2b` |
| Repository patch              | `16f393956300e03b04794ec58058c98f6398bcac7d55fdbd68a6f8b84c359806` |

Reused reference clones under the explicitly permitted main-checkout `.reference/`:

- `search-worker-outcome-harness/dbos-transact-ts`, commit
  `980dc55095f445b189aecb59e7f3334345179f65`, MIT (`LICENSE`). Its
  [client source](https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/client.ts)
  corroborates caller-owned transactional enqueue. It is an older upstream baseline,
  **not** the identity of the installed patched artifact.
- `library-shelf-maintenance/postgres`, commit
  `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, PostgreSQL License (`COPYRIGHT`).
  Read `src/backend/access/nbtree/nbtsearch.c`: `_bt_search`, `_bt_binsrch`,
  `_bt_first` and subsequent-item traversal distinguish index descent from scanning
  candidates. [Pinned source](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/nbtree/nbtsearch.c).

No reference project was installed, built or run; no new clone was needed. The shared
reference `INDEX.md` records reuse. Designs below are original proposals for this
repository's TypeScript/PostgreSQL stack; no source files or long passages are copied.

## The exact compatibility relation

In [client.ts](https://github.com/rezics/rezics-next/blob/883b94a387ada164c7f60c2ed9ff2112cec8ee62/services/kernel/src/work/client.ts),
`listWorkflowSteps(id, options)` first recognizes only
`^realm:leave:([0-9a-f-]{36}):([0-9a-f-]{36})$`. Preserve that recognition,
including its lowercase character class and loose UUID-shaped length; adding stricter
UUID validation would change the compatibility boundary.

For a recognized key, a successful `client.getWorkflow(id)` takes precedence over
every alias candidate, regardless of status, name, queue or step count. Nonlegacy
IDs go directly to the original bound SDK method. If the exact status is absent,
the SQL defines these sets from _retained_ rows:

- Parent: status name `community.leave`, plus its exact-ID `workflow_input` row.
  Extract realm, member and reservation using `inputs::jsonb #>>` at
  `{json,0,realmId}`, `{json,0,memberAccountId}`, `{json,0,reservationId}`.
- Child: status name `accounts.membership`, plus its exact-ID input row.
  Extract realm at `{json,0,principal,id}`, member and reservation at the same
  latter paths. A matching child shares all three extracted text values.
- Among joined matches choose a row with greatest **parent** `created_at`.
  A newer parent without a matching child is ineligible. Child creation time,
  completion, role and native parent linkage do not participate.

No predicate checks `principal.kind`, `role`, authorization equality, application,
queue, terminal status, or `parent_workflow_id`. Do not add them for convenience.
Two different parents with the same extracted reservation may match the same child;
several child IDs may match one parent. This is a JSON-key correlation, not proof of
an SDK parent-child relationship. SQL null reservations do not equal each other;
`#>>` produces text, so preserve extraction/equality rather than reinterpret values
as UUIDs or compare entire input objects. The selected actual ID is passed unchanged
to the original method. No match passes the original requested ID unchanged.

If several parents share the maximum timestamp, or one chosen parent has multiple
matching children, the current SQL gives no total order. PostgreSQL explicitly
requires a unique ordering for predictable limited results
([LIMIT documentation](https://www.postgresql.org/docs/18/queries-limit.html)).
There is no exact historical tie winner to preserve across query plans. Recommend
owner agreement on parent `created_at DESC`, parent actual ID ascending in `C`
collation, then child actual ID ascending in `C` collation. This refines only ties;
it is a **proposed** compatibility contract, not an adopted fact. Until agreed,
tests must accept any existing-query legal winner in ties, not assert an invented one.

Malformed serialized JSON can make the existing cast fail; it is not permission to
silently exclude a retained row. Backfill must classify parse failures and refuse
complete coverage until addressed by the data owner. Preserve native errors rather
than returning an empty result as a supposed complete miss. The successful-input
compatibility domain here is the actual persisted JSON/SuperJSON envelope, including
missing/null paths, not arbitrary reserialized input with new defaults.

## Actual production callers, inputs and ownership

[join.ts](https://github.com/rezics/rezics-next/blob/883b94a387ada164c7f60c2ed9ff2112cec8ee62/services/kernel/src/community/join.ts)
admits a native Content membership operation through `acceptOperation`/`runCommand`
before enqueue. A production leave input has `realmId`, `spaceId`, the actor's
`memberAccountId`, `role: null`, the exact `reservationId` and an opaque durable
`authorization` seal. Its parent ID is `community.leave:` followed by the first
32 SHA-256 hex characters of actor, realm and reservation joined with NULs.
It is **not** `realm:leave:<realm>:<member>`. Same intent reuse is checked before
enqueue, and the written workflow name and complete serialized arguments are checked
after enqueue. Preserve those checks and the original positional arguments.

[work.ts](https://github.com/rezics/rezics-next/blob/883b94a387ada164c7f60c2ed9ff2112cec8ee62/services/kernel/src/community/work.ts)
registers the parent. Its child ID is `realm:membership:` plus the full SHA-256 hex
digest of the actual parent ID, NUL, and `leave.membership`. The durable enqueue
step passes `{kind:'membership', principal:{kind:'realm',id:realmId},
memberAccountId, role:null, reservationId, authorization}` to
`access/membership-work.ts:enqueueMembership`. The child goes through the named
`accounts.membership` workflow on `workflows`, with return-existing ID reuse and
an exact canonical-input check. The parent then waits for the actual child's result.
`DBOSClient.enqueue` here is not an automatic `DBOS.startWorkflow` child invocation;
do not assume native parent metadata was populated.

New known-parent requests can already derive that child ID; they do not need the
legacy search. Replacing all historical input correlation with this hash would lose
same-input legacy matches whose actual IDs differ. Ban removal in `join.ts` directly
enqueues another `accounts.membership` ID (`realm:ban:` plus a digest), which can
satisfy today's fallback when its three JSON keys match. A compatibility index must
include that candidate even if an owner later wants a narrower new-workflow API.

The kernel's server, worker, HTTP composition, effects, default discovery and library
clients all construct WorkClient through `createWorkClient`; retain that common
abstraction. Current production step inspection appears in tests and consumers of
the returned SDK client; no new membership mutation endpoint is needed. In
`test/community/join.test.ts`, the leave test already addresses the derived actual
child ID. That is a different case from the synthetic compatibility key.

[services/auth/src/membership-workflows.ts](https://github.com/rezics/rezics-next/blob/883b94a387ada164c7f60c2ed9ff2112cec8ee62/services/auth/src/membership-workflows.ts)
owns durable Accounts orchestration. `coordinateMembership` reserves, publishes and,
for leave, releases; compensation terminalizes before inverse cleanup. The kernel
adapter restores native authorization and invokes Content publication and native
reservation/transition ports. An alias says only which execution's steps to inspect.
It must not certify membership completion, discharge a reservation, release an
inverse, close a native operation, invent an authorization reference, or trigger
cancel/delete/retirement. No Accounts public API or lifecycle behavior changes are
required for this recommendation.

## Primary engine/SDK findings and comparison

The public [DBOS Client documentation](https://docs.dbos.dev/typescript/reference/client#enqueueintransaction)
supports enqueue on the caller's open `pg` transaction on the system database.
The caller commits, rolls back and retries. Installed `dist/src/client.js:216-244`
and the pinned upstream `src/client.ts` implement that boundary. This supports an
atomic locator write **if every relevant source mutation is inside that boundary**;
it does not make a later application callback atomic. `workflowIDReusePolicy` and
queue `duplicationPolicy` are different; the latter's return-existing mode is not
supported inside a caller-owned transaction.

The public [workflow-attributes documentation](https://docs.dbos.dev/typescript/reference/methods)
describes creation-time JSON attributes, not inherited by children, with GIN-backed
containment filtering. Installed `system_database.js:3961-4025` implements
`attributes @>` followed by `ORDER BY created_at` and optional limit/offset.
Installed migration definitions add the JSONB column and partial GIN index. No
inspected API maintains a unique legacy alias, a retained eligible-pair head or an
ordered composite parent/child eligibility index automatically.

| Approach                                                                              | Unique uncomplicated match           | Repeated pair history and miss                                                                                                                                                        | Verdict            |
| ------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Current join plus indexes on extracted parent/child input keys                        | Can reduce unrelated-row work        | May test every newer parent whose reservation has no child; miss may test all parents; duplicate joins may multiply candidates                                                        | Insufficient       |
| Attributes on parent/child, `listWorkflows` with limit                                | Can find an attributed workflow      | GIN finds a posting set, not the ordered best joined match; attributes absent on legacy rows; no inherited linkage                                                                    | Insufficient       |
| B-tree expression keys on native status/input                                         | Can seek a specified key/reservation | Timestamp/name are in status, actual input in a separate table; an expression index cannot express cross-table existence; ordered status candidates can still all fail the child join | Insufficient alone |
| Single latest alias maintained by enqueue                                             | Fast hit while present               | Wrong when latest parent has no child, replay changes write order, winner is deleted, old writers bypass the hook, or another child remains                                           | Insufficient       |
| Ordered candidates plus one eligible row per reservation group, maintained atomically | One ordered seek                     | Same seek for empty/nonempty eligible range; deletion takes indexed successors, without scanning pair history                                                                         | Recommended        |

PostgreSQL [expression indexes](https://www.postgresql.org/docs/18/indexes-expressional.html)
move expression computation into index maintenance; they do not materialize an
arbitrary join. A B-tree with equality on its leading keys can restrict its scan
range ([multicolumn indexes](https://www.postgresql.org/docs/18/indexes-multicolumn.html)).
Only an appropriate ordered access path avoids finding and sorting the entire
matching range before a limit ([index ordering](https://www.postgresql.org/docs/18/indexes-ordering.html)).
Thus an indexed nested-loop parent-to-child probe costs O(H log N) for H rejected
parents, even if every individual child probe uses an index. A pair with H parents
and no child gives the counterexample for miss; H newer unmatched parents followed
by one old matched parent gives it for hit. Multiple children add another fanout.

Both DBOS and PostgreSQL share the useful pattern: maintain durable indexed facts
at their owning transaction boundary, then use full keys or ordered leading-key
seeks. Neither source equates `LIMIT 1` or the presence of an index with a bound.
The candidate/eligible relation below is an inference from those primitives and the
actual query, not a DBOS built-in feature or an upstream performance guarantee.

## Minimum complete locator structure and invariant

Proposed names are implementation guidance, not a migration introduced here. Keep
the projection in a separate `work_compat` schema in the same unsharded system
database, not in Content/Accounts source tables and not a cross-partition core join.
It is operational metadata with one realm/member anchor. Do not add an application
filter: current fallback ranges across all matching rows in this database.

1. `leave_source`: one exact-workflow-ID state record for synchronizing the separate
   status/input halves, with existence bits, relevant name/created_at, extracted
   locator fields and a version. No authorization, output, seal, full input, or step
   payload. Its purpose is to serialize both halves without stale-snapshot joins.
2. `leave_candidate`: at most one candidate per actual workflow ID, keyed by ID.
   A parent/child candidate exists exactly when both native halves exist, the name
   matches, and the required extracted keys are nonnull. Retain all candidates,
   not just winners. Parent index: `(realm,member,reservation,created_at DESC,
   actual_id COLLATE "C") WHERE kind='parent'`. Child index:
   `(realm,member,reservation,actual_id COLLATE "C") WHERE kind='child'`.
3. `leave_group`: versioned synchronization state keyed by
   `(realm,member,reservation)`, present while candidates exist. Lock/upsert this
   key before group changes, including creation of the first eligible row.
4. `leave_eligible`: unique `(realm,member,reservation)`. It exists iff that group
   has a parent and a child, carrying its best parent rank and first child ID.
   Its lookup index is `(realm,member,parent_created_at DESC,parent_id COLLATE "C",
   child_id COLLATE "C",reservation)`; include any returned fields as necessary.
5. A singleton versioned coverage record for installed-maintainer identity,
   backfill progress and cutover, read by full key. Operational progress is not
   native lifecycle completion. Do not mark it complete by row count or elapsed time.

The proposed tie order makes group compression exact: for each reservation, every
parent joins every child, so only its greatest parent and least child can win.
Then the greatest eligible parent across groups wins. There is no parent×child
materialization. A read seeks equality on realm/member and consumes the first
eligible row; if that indexed range is empty it proves a complete logical miss.
A separate per-pair head table is optional, not needed for the bound.

Each source change removes its old candidate, installs its new one if eligible and
recomputes at most two reservation groups using **two indexed first-row seeks per
group**, one parent and one child. Upsert/delete that group's eligible row. A child
appearing after many parents promotes the group's existing top parent in one seek;
it does not visit those parents. Deleting the winning child chooses its successor;
deleting the last child removes the eligible row. Deleting the top parent similarly
finds the next parent. Do not repair a stale head by walking history on a read.

## Transaction, replay and SDK integration boundaries

These invariants need native write-boundary coverage, not trust in new callers:

- Source insert/update/delete and its projection delta commit or roll back together
  on the **same database connection and transaction**. Status-only updates that do
  not change candidate facts require no group work. Payload minimization/removal,
  restore/import, SQL enqueue, fork, rewind, old executors and retention must be
  included. Reuse reads the stored facts; it must not publish the attempted input
  or a newer timestamp when the SDK returned an existing execution.
- Serialize each actual-ID source state with a native versioned row upsert/lock;
  merge the changed half from `NEW`/`OLD`, not two unconstrained snapshot reads.
  Under older repeatable-read snapshots a conflicting version must abort/retry,
  not merge an obsolete counterpart. Never rely on an advisory lock alone to make
  an old MVCC snapshot fresh. Status/input arrival in either order and independently
  retained orphan copies must be represented until the second half appears.
- Lock affected reservation groups in deterministic full-key order before candidate
  and eligible maintenance, including the group with no eligible row yet. An
  existing group-state row or transaction advisory lock can serialize that absent
  key; a stale repeatable-read transaction must still conflict through versioned
  state. Use current locked candidate state for recomputation. Multi-ID bulk
  mutations may deadlock; the **whole native transaction** retries, not a detached
  index update. Lock wait time is not evidence of history traversal.
- Native row triggers are the practical exhaustive hook for supported old writers.
  PostgreSQL executes triggers in the source transaction
  ([trigger behavior](https://www.postgresql.org/docs/18/trigger-definition.html)).
  SDK owners must install compatible hooks for both status and input and all three
  mutation types; handle or prohibit bypass by TRUNCATE/restore/disabled triggers
  as an explicit maintenance state. This is a new supported integration requirement,
  **not an API or hook already supplied by upstream DBOS**.

The versioned half-state can record invalid/nonmatching input without storing its
payload; avoid casting every unrelated workflow input in a way that rejects valid
noncompatibility work. Only relevant legacy candidates need the exact extraction
semantics. A parse-error marker on relevant retained data blocks coverage, rather
than making that data disappear. Empty synchronization rows can be removed when
both native halves and candidates are absent, under the same actual-ID lock;
concurrent reappearance must serialize or abort. No permanent account-key tombstone
is needed merely for lookup.

Installed `system_database.js:4540-4595` writes status and `workflow_input` as two
statements, with return-existing conflict behavior. Migration
`109_workflow_payload_tables` stores input separately without an FK to status.
Installed `deleteWorkflowsInternal` explicitly deletes input/output/operations/status
in one transaction. Consequently a status-only expression on `workflow_status.inputs`
is wrong: that legacy column is now normally null. Observe input deletion as well
as status deletion; status retention and orphan-payload retention are distinct.
See the public [system-table documentation](https://docs.dbos.dev/explanations/system-tables)
and the installed `dist/src/sysdb_migrations/internal/migrations.js` for provenance.

`DBOSClient.create` checks schema compatibility; it does not migrate this proposed
projection. Kernel `scripts/database.ts` separately invokes SDK schema migration.
The installed migration runner reserves shared migration indices from 100 across
SDK languages. Do not occupy a shared upstream migration number with a kernel-only
schema change, monkeypatch private queries at runtime, or assume arbitrary changes
to DBOS internals are a public extension API. Add an independently versioned Work
installer, coordinated with the repository's pinned SDK patch, after SDK migration;
keep native-table hook installation SDK-owned and the derived tables Work-owned.
Gate activation on the exact supported schema/hook version. Revalidate hooks,
payload layout, SQL enqueue and deletion on each SDK upgrade. No sharded placement
is proposed; extending this key space to sharding requires a separate SDK contract.

The existing patched SDK's `workflow_writer_fences` is a permanent native closure
authority. Its guards cover inserts/updates; do not replace them with the locator's
locks or infer closure from a locator row. Preserve native fence migration/receipt
semantics and allow owner-authorized deletion after closure. Lookup itself remains
read-only. PostgreSQL isolation/retry requirements are documented in
[transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html).

## Backfill, retention and erasure

Install transactional maintenance before recording the migration frontier. Use
resumable actual-ID keyset pages over both status and input key spaces, since either
half may be absent. Under the same per-ID synchronization used by live writes,
reconcile each ID to current native rows and update candidates/groups idempotently.
Advance a durable page cursor only with committed page work. Inserts behind a
cursor are covered by already-installed hooks. Deletes and updates during backfill
use those hooks too. Initial live events and replayed backfill must converge, not
double-count. A crash resumes the frontier; it never assumes the remaining history
was processed. Each batch costs O(b log N + input bytes) for b reconciled identities;
total finite migration work follows retained history, not an online request budget.

Coverage requires exhausted recorded source frontiers, validated hooks/schema and
indexes, no unresolved relevant parse/coverage gaps, and a synchronization boundary
that excludes an unobserved writer interval. Source-table lock/installer sequencing
must establish that boundary; counts alone cannot. Interrupted restore or hook
disablement invalidates coverage until reconciliation. Keep the old behavior active
before cutover; do not fall back to it on every post-cutover miss. After activation,
an empty eligible range is complete because both historical coverage and live
maintenance hold. Test that property with existing history before installation.

`src/work/retention.ts` currently selects terminal completed workflows under a cutoff
and calls `deleteWorkflows(ids,false)`, at most 1,000 per batch and 60 batches per
sweep. Those are cleanup controls, **not** a lookup age cap. Removing any retained
parent/input or child/input must update eligibility in its deletion transaction and
can reveal an older retained winner. A surviving alias must never keep a deleted
execution logically eligible. Input deletion alone invalidates a candidate even if
status remains. Read races may still cause the SDK to return `undefined` after a
selected child is concurrently removed; preserve the current two-stage semantics
without an unbounded retry/history-repair loop.

`src/work/README.md`, `src/work/sdk-retirement-fence.ts` and
`src/history/durable.ts` distinguish SDK technical writer closure, owner readiness,
supported deletion and exact physical-copy probes. The locator must not collapse
these stages. It is another copy of realm/member/reservation/actual-ID relationships,
so inventory it with the owning history/erasure machinery and its account locators.
Delete its relevant source/candidate records when their source halves disappear;
remove empty group synchronization state and coverage-page payloads when safe.
Retain a group winner only while the underlying retained relation permits it.
An index row is neither an erasure completion receipt nor custody for previously
unmapped workflow copies. Owners must agree how remaining orphan-derived records
are erased through their exact actual IDs before claiming physical absence.

## Cost derivation and honest evidence limits

Let N be retained source/projection/index size, H repeated history for the selected
realm/member, d source rows changed by a native transaction, S their input bytes,
L requested step limit and O requested offset. At a fixed number of retries:

| Operation                                        | Logical examined/changed rows                                                                                          | Indexed work                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Nonlegacy or exact existing status               | Original SDK keyed reads and requested steps                                                                           | O(log N + O + L), unchanged                         |
| Legacy alias hit                                 | One coverage point, exact original status probe, at most one eligible row, original SDK reads/steps                    | O(log N + O + L); no H term                         |
| Legacy alias miss, including H unmatched parents | Same fixed keyed probes, zero eligible rows, original-ID SDK fallback                                                  | O(log N); no H term                                 |
| One source mutation                              | One source state, old/new candidate, at most two group states, four top-candidate results and two eligible-row changes | O(log N) indexed work plus changed input bytes      |
| d mutations/retention batch                      | O(d) logical rows, constant seeks per mutation                                                                         | O(d log N + S), not a parent×child expansion        |
| Backfill batch b                                 | O(b) identities and constant reconciliation per identity                                                               | O(b log N + S); finite total migration may follow N |

Each listed seek has all equality-prefix keys and consumes at most one visible
logical candidate. Empty groups/ranges end at the B-tree boundary; they do not
filter H rows. Candidate indexes must be partial by kind, with no residual JSON,
native-existence or eligibility filter. Otherwise this derivation does not hold.
Storage is O(N), not O(parent×child). Extra write amplification and contention are
real tradeoffs; the derivation does not predict milliseconds, buffer counts or
planner selection. Validate actual plans after implementation.

Include the added nested trigger statements in native dispatch accounting.
`src/work/sdk-retirement-fence.ts` currently prices deletion through
`SDK_MAINTENANCE_DISPATCH` and native locking through `SDK_TRANSACTION_FENCE_COST`;
these cannot silently keep their old costs when new hooks execute. Re-derive the
affected prices with the SDK/Source owners and reserve the work in the existing
frames. This is accounting for actual operations, not a new product budget or an
increase in permission to retire. Measure the failure/rollback path as well.

The architecture revision `4736cfd8a3c3fb1aa86ce7d07691fd9af1ecb62f` excludes
invisible concurrent/unvacuumed MVCC versions from product logical bounds. This
does not excuse visible rejected candidates, JSON filters, join expansion, sorting,
trigger work or migration work. Native growth evidence must report them. Original
SDK step listing uses keyed `operation_outputs ORDER BY function_id LIMIT/OFFSET`
(`system_database.js:1664-1682`); preserve the options and state O+L explicitly.
No new offset/history cap is recommended. Unbounded requested steps remain output
proportional; the claim here removes retained-workflow-history dependence.

The current `test/work/growth-work-client.test.ts` and kernel README Cost row
explicitly permit **linear rows and blocks** for the compatibility fallback.
That test seeds scales `[64,512,4096]`, 16 parent/child history units per scale,
and a ten-step page. Its unrelated/generic pair history differs from each selected
probe; it does not establish bounded repeated selected-pair history or a complete
miss. It is **UNRUN existing linear allowance**, not failed native evidence and not
a bounded acceptance test. Keep its frozen assertions intact; add the stronger
contract in a new group instead of weakening or rewriting old acceptance.

## Complete implementation path and frozen failing acceptance group

Adoption should authorize the following together; names for new files are proposed.

| Path/group                                                                                                                                                                                                                                      | Required change or regression obligation                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/kernel/src/work/client.ts`                                                                                                                                                                                                            | Replace only post-exact-miss legacy resolver; preserve bound SDK method, arguments/options, errors and close semantics                      |
| `services/kernel/src/work/legacy-leave-lookup.ts` and SQL companions                                                                                                                                                                            | Coverage point read and equality-prefix ordered eligible seek; no history fallback after cutover                                            |
| `services/kernel/db/migrations/<UTC>_legacy_leave_lookup.sql`                                                                                                                                                                                   | Derived schema, source/candidate/group/eligible state, explicit indexes and versioned coverage; use real implementation UTC timestamp       |
| `services/kernel/src/work/legacy-leave-backfill.ts`                                                                                                                                                                                             | Resumable installation/backfill/reconciliation/cutover protocol and exact-source removal                                                    |
| `services/kernel/scripts/database.ts`                                                                                                                                                                                                           | Order Work installer after supported SDK migration; do not depend on client construction to migrate                                         |
| `patches/@dbos-inc%2Fdbos-sdk@5.5.3-preview.patch`                                                                                                                                                                                              | SDK-owned exhaustive transactional source hooks and upgrade integration, alongside existing fence guards; never edit installed node_modules |
| `src/community/join.ts`, `src/community/work.ts`, `src/access/membership-work.ts` under kernel                                                                                                                                                  | Audit production enqueue/reuse paths; preserve inputs/IDs and authorization checks; no API or lifecycle changes required                    |
| Kernel `src/work/retention.ts`, `src/history/durable.ts`, history registry/locator owner files                                                                                                                                                  | Integrate projection-copy inventory/removal with existing native custody; no new readiness inference                                        |
| Kernel `src/work/sdk-retirement-fence.ts` and owning Source dispatch derivations                                                                                                                                                                | Include added hook work in existing retirement/deletion reservations; preserve lifecycle permissions and execution bounds                   |
| `services/kernel/src/server.ts`, `src/worker.ts`, `src/http/kernel.ts` and other WorkClient constructors                                                                                                                                        | Regress existing lazy construction, borrowed-pool ownership and shutdown; avoid new caller-specific lookup routes                           |
| `services/kernel/README.md`, `src/work/README.md`                                                                                                                                                                                               | Adopt compatibility order, maintenance/coverage ownership and derived Cost after owner agreement                                            |
| `services/kernel/test/work/legacy-leave-lookup.test.ts`                                                                                                                                                                                         | New exact compatibility and resource-ownership regression group                                                                             |
| `services/kernel/test/work/legacy-leave-lookup-migration.test.ts`                                                                                                                                                                               | New backfill, atomicity, replay, old/native write, retention and upgrade group                                                              |
| `services/kernel/test/work/growth-work-client-bounded-legacy.test.ts`                                                                                                                                                                           | New frozen bounded assertions, including trigger/deletion work and complete misses                                                          |
| Existing kernel `test/community/join.test.ts`, `test/community/ban.test.ts`, `test/work/growth-work-client.test.ts`, `test/work/retention.test.ts`, `test/work/sdk-retirement-fence.test.ts`; `services/auth/test/membership-workflows.test.ts` | Preserve existing acceptance; run through supported placement after integration, without editing frozen tests                               |

Use a production-shaped fixture with real routed realm/member/reservation IDs,
parent/child hashes and complete input envelopes including space, role, kind and
opaque authorization. Fixture insertion may create historical/native counterexamples;
also exercise the actual admission/parent/child enqueue path through existing owners.
At scales **64, 512, 4,096**, independently grow (a) unrelated pairs/partitions,
(b) selected-pair reservations, (c) parents sharing one reservation and (d) children
sharing one reservation. Keep target output at 12 stored steps with limit 10,
offset 0; include distinct child step names so the winner is observable.

Freeze these assertions before implementation (all are proposed and **UNRUN**):

1. Nonlegacy, malformed legacy-shaped and exact-existing legacy IDs call original
   SDK semantics. Exact status wins even if its name differs, it has no steps, or
   a newer eligible alias exists. Preserve options object/values and SDK errors.
2. Absent exact status plus a unique match returns that child's first ten steps;
   no candidate returns the original-ID SDK result. Missing input/status halves,
   null/missing reservation and mismatching keys cannot become matches.
3. A newest parent without a child cannot hide an older eligible parent. Thousands
   of newer unmatched parents keep both old-hit and complete-miss logical rows
   constant, blocks logarithmic and statements constant at fixed step output.
   Native plans include zero residual history filtering/join expansion/sorting.
4. Same-reservation parent and child multiplicity does not multiply examined work.
   Delete the selected parent/child, last child, or either input half: select the
   next retained legal winner or original-ID miss, with O(changed rows log N)
   including transactional projection work. Do not rediscover all group members.
5. Ties accept current legal winners before owner adoption; after explicit adoption
   freeze agreed parent/child ordering for equal timestamps and multiple children.
   Include equal timestamps across reservations and different child creation times.
6. A ban-removal child, different authorization/role, absent native parent linkage,
   and matching retained rows from other applications remain candidates where the
   old predicates permit them. No narrowing to new production hash IDs is allowed.
7. Roll back source enqueue/deletion and assert projection rollback. Replay same
   ID/input without promoting attempted timestamp/input; conflicting reuse keeps
   native rejection. Crash/retry after native commit converges. Exercise status
   and input arriving in both orders, concurrent parent/child and different groups,
   old-snapshot conflicts, deletion/rewind/fork/restore and SQL enqueue hooks.
8. Preinstall historical rows, backfill page interruption/restart, writes behind
   frontier and concurrent retention all converge to the reference relation.
   Missing hooks, invalid indexes or relevant parse gaps prohibit coverage; no
   fixture flag may claim unseen history complete. Post-cutover miss never scans.
9. Borrowed pools remain open; private SDK and lazy lookup pools close once even
   on SDK destruction failure; nonfallback use does not open the lazy lookup pool.
   Lookup never invokes native mutation, retirement, release or authorization ports.
10. Existing membership publish/terminalize/release order, writer-closure receipts,
    supported deletion without descendants and physical-copy inventory remain
    owner-controlled. Include new locator copies in erasure absence assertions.

Measure rows/filters/loops and blocks for lookup **and** source-maintenance operations
using the existing growth harness, including its normal warmup, with fixed output
and separate admitted change count d. Do not substitute statement counts, wall time,
an index-name assertion or EXPLAIN without examined work. Assertions 3 and 4 are the
new architectural failure conditions missing from today's linear test; their current
failure is a source-derived expectation, not an executed result. This report leaves
all original acceptance, native proof, browser verification and workspace execution
UNRUN for the authorized post-integration delivery.
