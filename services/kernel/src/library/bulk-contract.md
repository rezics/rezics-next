# Private library bulk operations

This is the proposed contract for durable private operations over a person's saved library and one of their
Collections. It defines no routes or runtime behavior in this change. The implementation belongs to the existing
library module and its composed worker.

The contract adopts bounded discovery-time matching and a frozen private manifest. Its UI and concurrency behavior
follows the [query-scoped bulk report](../../../../docs/research/library-query-bulk.md), especially “Proposed
mechanism” and “Progress, failure, cancellation and retention”, and the shelf study's
[selection behavior](../../../../docs/research/library-shelves.md#34-selection-and-bulk-actions). These sources support
selection affordances and durable server-side work; they do not override the decisions below. Worker composition,
queues and workflow retention follow [kernel durable work](../../../../services/kernel/README.md#durable-work) and
ADR-0033, “DBOS work and CloudEvents”. The current command, Collection and entry boundaries are described in
[`README.md`](README.md), [`command-support.ts`](command-support.ts),
[`durable-initiator.ts`](../access/durable-initiator.ts), and
[`collections.ts`](collections.ts).

## Selection and timing

An operation contains exactly one selection: an explicit list or a query. The browser submits predicates or up to
100 explicit identifiers; it never fetches every matching identifier to construct a bulk request. Subject selections
deduplicate by subject ID, preserving first occurrence. Explicit occurrence selections deduplicate by member ID.
The IDs have distinct meanings: a subject ID names the saved item, while a member ID names one occurrence in one
Collection. A duplicate Collection subject is not a duplicate member occurrence.

Query mode initially accepts only the saved-entry `state` and subject `primaryType` predicates supported by the shelf
reader. An empty filter means all saved entries. Unknown predicates and keys that mix query and explicit selection
are rejected. Sort, layout, presentation cursor and order do not participate in membership. They are neither copied
into the bulk request nor used as a query predicate.

The initial `POST` starts discovery. It does not freeze the exact set that existed when the user clicked or when the
request arrived. The source operation captures an entry high-water mark at admission. New entry incarnations above it
are excluded. Discovery then reads at most 100 raw candidates per page, including candidates that fail a sparse
predicate. Current entry state and current primary type are evaluated when each candidate page is read, so a change
to an older candidate before that read can change inclusion. Once read, a matching target's revision, incarnation and
admission sequence are frozen. This is the accepted membership boundary; no membership-version snapshot is required.

No effect begins until subject discovery is complete and the private manifest is sealed. Collection removals also
finish occurrence expansion before any member is removed. The UI shows the listing's current count before the action,
then the exact frozen manifest count while it is in progress, then changed, unchanged and failed counts when the
operation can report a complete summary. No second preview-and-confirm request exists only to promise a click-time
snapshot.

For an explicit `set_status`, an absent entry can be created only through ordinary `putEntry` validation, after
capturing the absent entry-slot generation. Query mode only selects entries that already exist. A concurrent create,
delete or recreate after an absent slot was captured conflicts; a revision-one recreation can never satisfy an old
target.

## Actions and effects

`set_status` changes the selected saved-entry state. An unchanged desired state is a receipted no-effect only when
the captured entry incarnation and revision still match. A changed revision, incarnation or missing expected entry
is a conflict, even if the current state happens to equal the requested state. The status command may create a
captured absent explicit entry as described above.

`add_to_collection` selects distinct subjects. Under the existing Collection command lock and live authorization,
the command checks whether each subject is already present and appends exactly one new occurrence only when none is
present. A present subject is `no_effect`, even if the Collection contains several duplicate occurrences. The check
and append are atomic. A replay returns its original receipt before checking membership again. A separately
admitted operation checks again and skips a subject that remains present. This rule does not constrain ordinary
single-member additions: intentional duplicates remain supported. There is no uniqueness constraint on ordinary
Collection membership. The existing 5,000-member capacity and fractional-ordinal respacing behavior remain in force;
a full Collection produces a failed target when an append is required.

`remove_from_collection` accepts either explicit member IDs or explicit/query subject selection. An explicit member
selection removes only those captured member IDs. Subject selection first freezes selected subjects, then scans the
target Collection once in bounded raw pages, capturing every matching member ID and incarnation under a separate
Collection high-water mark. It removes those occurrences only. Members added after that target high-water survive,
and a reorder cannot change the captured set. Never retry a subject-wide delete predicate.

`remove_from_library` deletes only the entry through the existing revision and incarnation compare-and-swap. It
leaves progress sessions and history, copies, follows and Collection members intact. The confirmation text must say
that it removes the library entry only. Full erasure is a separate explicit action.

Each target is its own stable, idempotent native command. Target-specific conflict or denial is recorded and other
authorized targets continue. A current source or target authority loss stops undispatched work operation-wide;
already committed effects remain. Restored identity and source/target authority are checked again at every target
attempt and replay, using the exact durable initiator. A stored actor, successful enqueue or `trustedAccount` call is
not continuing authority.

## HTTP contract

All operation routes are private and require an account actor. No body accepts an actor or account ID. The source
account is the authenticated durable initiator; the Collection ID identifies a target only. Foreign and unknown
operation IDs have the same `404` response for summary, outcome and cancellation routes.

The additive route action catalogue entries are `library_operation:create`, `library_operation:read`,
`library_operation:list_outcomes`, and `library_operation:cancel`. They are route authorization data, not grants and
not effect authority. The create/read/outcome/cancel routes use the existing `personal_library` exposure gate.
Membership operations also require the target Collection's existing `collections` gate. The operation checks the
existing effect scopes and current source and target authorities: `library_entry:update` for status, ordinary
validated entry creation and library-authorized membership work; `library_entry:delete` for entry removal; and
`collection:update` plus the installed Collection resource permission for membership mutation. Every target
command rechecks at its authoritative time. Adding these action names creates no role, grant, scope or bypass.

Requests are strict, closed objects. The request body is at most 16 KiB; unknown properties fail with `400`.
Supported saved-entry states are the current `EntryState` values. The `primaryType` predicate is a bounded primitive
string, validated by the existing subject resolver. Explicit subject and member arrays contain 1–100 identifiers
before deduplication; an empty list is invalid. The query selection may match any number of entries.

### Start an operation

`POST /v1/libraryOperations` requires the ordinary `idempotency-key` header. It returns `202 Accepted`, a
`Location: /v1/libraryOperations/{operationId}` header and this body:

```json
{
  "action": "set_status",
  "state": "completed",
  "selection": {
    "kind": "query",
    "filter": { "state": "planned", "primaryType": "book" }
  }
}
```

The four action schemas are discriminated and closed:

```ts
type SubjectSelection =
  | { kind: 'explicit'; targets: { subjectId: string }[] }
  | { kind: 'query'; filter: { state?: EntryState; primaryType?: string } };
type OccurrenceSelection = { kind: 'occurrences'; memberIds: string[] };
type BulkAdmission =
  | { action: 'set_status'; state: EntryState; selection: SubjectSelection }
  | { action: 'add_to_collection'; collectionId: string; selection: SubjectSelection }
  | { action: 'remove_from_collection'; collectionId: string;
      selection: SubjectSelection | OccurrenceSelection }
  | { action: 'remove_from_library'; selection: SubjectSelection };
```

This route validates and authorizes the request, captures the immutable source and durable initiator, commits the
operation plus its creation receipt and initial enqueue intent, and starts asynchronous discovery. A successful
HTTP response means that native admission is durable; it does not mean that discovery, selection or mutation has
completed. If enqueue is unavailable, the native intent remains recoverable and the same key returns the same
operation. A changed request with the same key is an idempotency conflict.

### Read status and outcomes

`GET /v1/libraryOperations/{operationId}` returns `{ "operation": OperationView }`. The operation summary is bounded
and contains counters, never the manifest or outcome array. `OperationView` includes the operation ID, action,
selection kind, requested state or target Collection, phase, selection and occurrence completeness, cancellation
request, counters, optional terminal summary, admission/high-water/expiry timestamps, finish time and a bounded
reason.

Counters distinguish raw candidates, selected subjects, raw Collection occurrences, captured occurrences, immutable
effect targets and each target state. The invariant is
`targets = pending + reconciling + applied + no_effect + conflict + denied + failed + cancelled`. Counters are
maintained in the same source transaction as each unique target transition; a replay cannot increment them twice.
Reads use the operation row's fixed counters and do not count the manifest.

The summary is `null` until selection and occurrence expansion are complete and every target is terminal. It then
contains `{ changed, unchanged, failed }`: `changed = applied`, `unchanged = no_effect`, and summary `failed` is the
sum of conflict, denied, failed and cancelled outcomes. The detailed counters and target outcomes preserve those
categories. `completed` means no failed target; `completed_with_errors` means at least one. A cancelled partial
discovery has `selectionComplete = false` and no complete manifest summary. An operation with an unknown target
receipt remains reconciling and never emits a terminal summary.

`GET /v1/libraryOperations/{operationId}/outcomes?limit=20&cursor=...&state=...` returns
`{ "outcomes": OutcomeView[], "next": string | null }`. `limit` is 1–20; the fixed-size growth check uses 20.
`state` is an optional exact target-state filter. A page carries only bounded private rows, ordered by immutable
operation ordinal. It includes the subject ID, a nullable member ID, state, reason and nullable resulting member ID.
This endpoint is not a second operation summary and never exposes unrelated manifest entries.

Use the accounts-owned `encodeListCursor` and `decodeListCursor` from `src/tokens/list-cursor.ts`, with the kernel
clock. Bind `route` to `GET /v1/libraryOperations/{operationId}/outcomes`, `viewer` to the authenticated account ID,
and `query` to the operation ID, page size and state filter. The cursor position is the immutable outcome ordinal;
its epoch is a positive operation outcome generation. Tampered, expired, retired-key, foreign-viewer, foreign-route,
foreign-operation, changed-filter or changed-page-size cursors fail closed as invalid/stale cursors. Cursors reveal no
position, operation ID or query. Outcome pages are current keyset views, not a snapshot of outcome states; state
filters are evaluated at each page read.

### Cancel

`POST /v1/libraryOperations/{operationId}:cancel` takes an empty strict body and a normal idempotency key. It
returns `202` and the bounded operation view. Cancellation is a request, not rollback: stop between discovery
pages and target commands, reconcile any in-flight target receipt, then mark untouched frozen targets cancelled in
bounded pages. Do not compensate for prior effects or overwrite later edits. Partial discovery remains explicitly
incomplete. Repeated cancellation with the same key replays the same receipt; a distinct cancel key returns the
current state without reopening work.

## Phases and outcome transitions

| Operation phase | Native work and transition rule |
| --- | --- |
| `queued` | The owner partition has the source, creation receipt, high-water and enqueue intent. No target effect is inferred from DBOS registration. |
| `discovering` | Read at most 100 raw source candidates, including nonmatches; atomically commit the manifest page, raw-scan counters, checkpoint and next-segment intent. |
| `expanding` | For Collection removal, transfer selected subject IDs in immutable pages, capture the target Collection high-water, scan its member index once, and acknowledge each occurrence page across partitions. No member is removed until expansion is sealed. |
| `applying` | Execute stable target commands in bounded chunks. Each rechecks restored initiator, source and target authority, then uses the frozen target and exact receipt key. |
| `reconciling` | A commit/checkpoint/ack gap or unavailable receipt is unknown. Read the exact target receipt or retry the same receipt key; never infer from current row state or create a fresh key. |
| `completed` | All selection/expansion is sealed, all targets are terminal, and every target is `applied` or `no_effect`. |
| `completed_with_errors` | All selection/expansion is sealed and all targets are terminal, with at least one conflict, denial or failure. Prior effects remain. |
| `cancelled` | Cancellation is drained; in-flight effects have exact receipts, untouched targets are cancelled, and incomplete discovery remains labelled incomplete. |
| `stopped` | Operation-wide authority loss or missing immutable source stops dispatch. Prior effects remain; unknown receipts stay reconciling and suppress summary. |
| `expired` | Execution horizon is closed. A retained DBOS segment cannot issue another effect; it may only reconcile exact prior receipts and finish bounded accounting. |

| Target state | Meaning |
| --- | --- |
| `pending` | Frozen target has no terminal receipt yet. |
| `reconciling` | An attempt may have committed, but exact receipt evidence is not currently available. No new key or current-state inference is allowed. |
| `applied` | The native target command receipt proves the intended mutation committed. |
| `no_effect` | A native receipt proves the desired status was already present at the captured revision/incarnation, or the subject was already in the authorized target Collection. |
| `conflict` | Exact expected revision/incarnation/member was missing or changed, or an absent entry's slot generation changed. |
| `denied` | Current target-specific authority denies this target. Other targets continue while operation-wide authority remains valid. |
| `failed` | The target command failed for a durable, target-specific reason such as Collection capacity. |
| `cancelled` | The target was not dispatched because cancellation, operation-wide authority loss or expiry closed the remaining work. |

Every pending/reconciling-to-terminal transition is compare-and-swap and unique by `(route, operation_id, ordinal)`.
It updates exactly one terminal counter and the summary generation. Source-bound immutable target evidence and the
target command receipt bridge an effect committed before its source acknowledgement. If account, consent or
delegation authority is revoked after a target commit, private accounting can verify the exact prior receipt without
issuing another effect. It cannot disclose the operation to the revoked caller.

## Native storage and keys

The following names are proposed names for the module-owned migration, not existing relations. Every table is
partition-led by `route`; no transaction spans source and target partitions.

### Shared shelf identity prerequisite

Stable entry and member admission ordering and an entry-slot incarnation fence are not represented by the current
`created_at`, revision or respaceable member ordinal. The implementation requires one shared kernel data contract:

- a route-local, transactionally incremented admission sequence; each new saved-entry incarnation and Collection
  member receives one immutable sequence, and operation admission captures the committed entry high-water under
  that same sequence lock;
- an immutable entry incarnation ID and a persistent `(route, account_id, subject_id)` slot-generation row, whose
  generation advances on create and delete and remains after deletion; and
- an immutable member incarnation ID and admission sequence, independent of `subject_id` and `ordinal_key`.

Present entry targets freeze `{ incarnation, admissionSequence, revision }`. Absent explicit status targets freeze
`{ slotGeneration }`. The creator, ordinary entry/member commands, shelf readers and bulk selectors must use the
same sequence/incarnation values. Do not substitute timestamps, UUID ordering, revision 1, mutable `updated_at`,
`OFFSET`, or member order keys. This prerequisite is a new shared kernel contract for the shelf-storage owner and
the manager to adopt; this specification adds only primitive TypeScript filters and does not silently modify the
unlanded shelf-read contract.

### Operation row

`library.bulk_operation` is source-owned by the account route. It stores the bounded canonical request and digest,
operation ID, owner account, action and selection kind, target Collection ID if any, immutable source digest and
durable-initiator snapshot, entry high-water, phase/checkpoint generation, counters, cancellation flag, optional
collection high-water, creation/cancel receipt locators, and timestamps (`admitted_at`, `expires_at`,
`results_expire_at`, `finished_at`). Its summary fields/counters are fixed-width; no query performs a manifest count.

Proposed keys and seeks:

- primary key `(route, operation_id)`;
- unique admission lookup `(route, owner_account_id, admission_key_digest)` through the supported idempotency
  window;
- expiry scan `(route, results_expire_at, operation_id)`;
- active phase/checkpoint scan `(route, phase, operation_id)` and enqueue-intent key `(route, operation_id,
  generation)`.

The create command's native `core.receipt` uses the initiating account principal, the create command kind, the
client idempotency key and a digest over the exact normalized request. Its response commits the operation ID and
durable-initiator commitment. A same-key/same-digest replay returns that response; a same-key/different-digest
request conflicts.

### Target rows and receipt shapes

`library.bulk_target` is source-owned. Its primary key is `(route, operation_id, ordinal)`. Each immutable target
stores a kind discriminator, subject ID, optional member/Collection ID, exact expected entry or member incarnation,
admission sequence and revision/slot generation, deterministic target command key/digest, target receipt partition,
state, reason, optional resulting member ID, and exact target evidence. `ordinal` is a monotonically assigned
operation-local decimal sequence and never changes on retry.

Indexes are `(route, operation_id, state, ordinal)` for bounded pending/reconciling work and
`(route, operation_id, ordinal)` for outcome keysets. The latter returns `limit + 1` rows (at most 21) for a page
size of 20. The fixed operation summary reads only the operation row.

Each target command uses a stable key derived from operation ID and ordinal, with a command kind specific to its
effect. Its digest covers action, immutable source digest and immutable target payload. The target receipt is on
the target's owning partition: the account route for entry effects, the Collection route for membership effects.
Its committed response contains the operation ID, ordinal, source digest, target receipt identity, terminal outcome,
reason and resulting member ID. The command transaction commits that receipt with the effect and emits a private
library event. Reconciliation reads this exact native receipt and verifies every binding; it never scans receipts
or treats current state as proof.

The admission/checkpoint/counter/acknowledgement command uses a private operation-change event whose subject is the
owning account ID. Target membership commands use the Collection ID as event subject; entry commands use the
account ID. Any new event type is registered with its exact schema in the implementing task. Event data contains no
bulk subject list or manifest page.

### Cross-partition occurrence transfer

The source manifest stays on the account partition. For subject-scoped Collection removal, selected subject pages
are transferred to a target-side operation selection table using source digest, page number, bounded payload and
acknowledgement. The target owns its selected-subject lookup and captured Collection high-water. It scans the
Collection member index once, with at most 100 raw member candidates per page, and selects matching subjects by
the target-side lookup. Every captured occurrence page records immutable `(member_id, incarnation,
admission_sequence, subject_id)` values and a content digest. The source persists those occurrence targets with
page acknowledgements before enabling effects. Replaying transfer/ack repeats the same page and digest; it does not
rescan by selected subject or delete by subject predicate.

For add/remove target commands, the target receipt and effect live on the Collection partition. The source row is
updated only after a bounded acknowledgement carrying that exact target receipt evidence. No transaction or
connection is held across the source and Collection steps.

### Enqueue intents and workflow segments

An enqueue intent is committed with each source checkpoint and manifest page. It stores only operation ID, route,
generation, deterministic DBOS workflow ID and the existing `workflows` queue. The worker passes only
`{ operationId, route, generation }`; a workflow never receives the whole manifest. Enqueue success advances no
target counter and proves no mutation. A worker or API retry can drain an unacknowledged native intent.

One segment processes at most 100 bounded pages. Before reaching that limit it commits the next generation and
enqueue intent with its checkpoint. Stable target receipts survive segment continuation and DBOS replay. Registration
extends the existing library `WorkModule` and composed worker; it does not launch a worker or add a module process.

## Authority, budgets and deadlines

Admission validates and authorizes on the owner partition, requires the personal-library gate and route action,
captures the original durable initiator during `CommandAuthorization.prepare`, and commits its exact operation
source and creation receipt together. Each subsequent source or target command calls `restoreInitiator` at the
same authoritative time as its final resource authorization. `prepare` runs before target checkout. No source
connection is retained during target commands. Each target attempt rechecks the live source account, consent,
delegation, scopes and the relevant Collection gate/grant through installed Access. A source-bound evidence read
can account for a committed target after revocation but cannot authorize a new effect.

Admission itself uses the ordinary route write budget. Every durable discovery, occurrence-transfer and target
effect chunk uses the accounts-owned `DurableWriteRateLimiter.spendChunk(context,
{ operation, index }, 'write', units)` port. Call it asynchronously inside the chunk command's authorization
`prepare`, after `restoreInitiator` and at the same `T`, with `context.actor` exactly the restored actor. `units` is
1–100 and is the raw candidate/occurrence/target count (a checkpoint-only chunk uses one). The operation-wide
chunk index is deterministic and persisted with its checkpoint; a retry uses the same index. A refusal records no
spend, so the worker durably waits `retryAfter` and retries that index. Unavailability is retryable `503`, never
denial. The current `WriteRateLimiter.spend` stays spend-only; this module receives the async port in
`BulkDependencies` until the accounts contract lands. Counter-window expiry or UNLOGGED ledger loss can charge
again; that operational charge is not a target receipt and never changes logical counts.

Each command has the existing finite 5-second command deadline. Discovery, occurrence scans and acknowledgements
touch one partition per transaction, at most 100 raw rows/candidates and at most 100 external anchor probes.
Chunks/pages are retried without a transaction or connection held during a durable wait.

## Cancellation, expiry and garbage collection

Execution and retry stop 24 hours after admission. The source row, target rows, exact target evidence and creation
initiator evidence remain available through a 48-hour HTTP idempotency/results window. Admission and cancel keys
are supported for 48 hours from their committed receipt. During that window, a matching retry returns the same
operation or an expired tombstone response; changed input conflicts. After the window, no permanent key-deduplication
or result promise is made, and clients must create a new key only for new intent. Native command receipts may remain
longer, but the API does not depend on indefinite receipt retention.

At the 24-hour execution boundary, persist `expired` before any retained workflow can run another target effect.
Drain/reconcile in-flight effects by their exact receipts, cancel untouched targets in pages, and suppress summary
while a target remains unknown. If immutable source or receipt evidence is missing, fail closed and stop. At the
48-hour results boundary, retain only a bounded admission tombstone with owner, operation ID, digest and expired
state through the end of the advertised idempotency window; then delete it. Keep target/source evidence no longer
than needed for that boundary. A request outside this window is not a supported retry and cannot reopen a retained
terminal DBOS segment.

The native sweeper is route-keyset based and removes at most 100 target/transfer rows per native transaction. It
uses the expiry index, never a table count or full manifest aggregation. Delete target pages first and source pages
afterward; remove operation rows only after terminal/expired state, DBOS continuation closure and the advertised
idempotency window. Tombstones are bounded by that window, not retained forever. DBOS's own terminal retention is
independent and cannot replace native terminal state.

## Cost and growth checks

Let `A` be raw saved-entry candidates through the captured high-water, `N` selected subjects, `D` captured member
occurrences, `C = 100` the page/chunk cap, `M <= 5,000` Collection members, and `J` unrelated retained operations
and targets. A sparse query may examine `O(A)` candidates even if `N` is small. Discovery and occurrence storage
are `O(N)` and `O(D)` respectively; no claim makes a large operation constant cost. One page examines at most
`C` indexed candidates plus at most `C` bounded primary-type/authority probes, with B-tree seeks logarithmic in
the indexed relation. Collection respacing retains its existing bounded `O(M)` worst case. No cross-target
transaction, `OFFSET`, mutable sort key or unbounded worker payload is permitted.

The operation summary is an indexed operation-row lookup with fixed counter columns, `O(1)` examined rows and
statements, plus logarithmic B-tree blocks. It never counts manifest rows. A fixed outcome page of 20 is `O(21)`
examined target rows, one keyset statement and logarithmic seek cost. Receipt reconciliation is a point lookup by
the exact receipt key. Counters change in the same transaction as one unique target transition.

The acceptance suite must run cost checks with shared catalogue classification and no planner settings:

- Admission replay, operation summary and fixed 20-row outcome page grow independently across 256, 1,024 and
  4,096 unrelated operations, targets and accounts. Warm every measured statement at least once. Rows and
  statements remain bounded; blocks grow logarithmically; no manifest relation is sequentially scanned.
- Discovery, sparse/no-match predicates, session history, unrelated jobs, Collection duplicates and retained
  outcomes grow independently at 256, 1,024 and 4,096 entries/members. Exercise first page, continuation, seal,
  cancellation, recovery and source-to-target transfer. Raw reads and external probes never exceed 100; verify
  the entry `(route, account_id, admission_sequence, subject_id)` and member
  `(route, collection_id, admission_sequence, member_id)` indexes are used without planner pins.
- Manifest/outcome insertion and pending-target access exercise their operation/ordinal and
  operation/state/ordinal indexes. No summary executes `COUNT(*)` over targets. Crash gaps include after a native
  page commit, after seal, before/after enqueue, before/after target commit and before/after source acknowledgement.

These are proposed bounds, not measured PostgreSQL plans. The implementation must add native growth evidence for
the indexes and query shapes before documenting measured performance.

## Implementation split

Each slice below owns no more than eight files including its call sites and tests. The slices have distinct file
owners; in particular the database schema dump, route module, worker registration and Collection commands each have
one writer. Every proposed acceptance is expected to fail before its slice is implemented. No slice adds a worker
process or changes an existing action's grant.

### Shared sequence and slot-generation storage

- Paths: `services/kernel/db/library/migrations/<timestamp>_library_bulk_and_admission_sequence.sql`,
  `services/kernel/db/library/schema.sql`, `services/kernel/src/library/entry-store-entry-insert.sql`,
  `services/kernel/src/library/entry-store-entry-delete.sql`,
  `services/kernel/src/library/collection-store-collection-member-insert.sql`,
  `services/kernel/src/library/collection-store-collection-member-delete.sql`,
  `services/kernel/test/library/admission-sequence.test.ts`.
- Call sites: ordinary entry and member create/delete SQL assigns monotonic admission sequence and incarnation;
  entry deletion advances and retains its slot generation. The same migration creates the bulk operation/target and
  bounded transfer tables and indexes so only one task writes the schema dump.
- Proposed failing acceptance: `entry and member admission sequences are monotonic and entry slot generations reject create delete recreate ABA` in `services/kernel/test/library/admission-sequence.test.ts`.

### Native bulk store and fixed counters

- Paths: `services/kernel/src/library/bulk-store.ts`,
  `services/kernel/src/library/bulk-store-operation.sql`,
  `services/kernel/src/library/bulk-store-targets.sql`,
  `services/kernel/src/library/bulk-store-transition.sql`,
  `services/kernel/src/library/bulk-store-expiry.sql`,
  `services/kernel/test/library/bulk-store.test.ts`,
  `services/kernel/test/library/bulk-store-growth.test.ts`.
- Call sites: `createBulkStore`, operation lookup, atomic manifest/checkpoint/intent commit, unique target
  transition and fixed-counter summary lookup.
- Proposed failing acceptance: `bulk page commit and terminal transition are atomic unique and use indexed counters` in `services/kernel/test/library/bulk-store.test.ts`.

### Admission and operation route module

- Paths: `services/kernel/src/library/bulk-admission.ts`,
  `services/kernel/src/library/bulk-admission.sql`,
  `services/kernel/src/library/bulk-schemas.ts`,
  `services/kernel/src/library/bulk-routes.ts`,
  `services/kernel/src/library/personal-routes.ts`,
  `services/kernel/test/library/bulk-admission.test.ts`,
  `specs/library-bulk-driver.ts`.
- Call sites: mounted private library route group, operation create/read/outcome/cancel handlers and the real-kernel
  driver's setup/request mapping. The route module owns all four paths; later outcome logic plugs into the already
  typed `BulkOperations` port without editing that shared route file.
- Proposed failing acceptance: `bulk admission binds the authenticated initiator freezes only bounded request bytes and returns a recoverable 202 resource` in `services/kernel/test/library/bulk-admission.test.ts`.

### Bounded entry discovery and manifest sealing

- Paths: `services/kernel/src/library/bulk-discovery.ts`,
  `services/kernel/src/library/bulk-discovery-page.sql`,
  `services/kernel/src/library/bulk-discovery-seal.sql`,
  `services/kernel/test/library/bulk-discovery.test.ts`,
  `services/kernel/test/library/bulk-discovery-growth.test.ts`.
- Call sites: native entry high-water read, `discoverBulkPage`, and atomic checkpoint/manifest/intent commit. Worker
  registration is owned by the worker slice.
- Proposed failing acceptance: `query discovery scans bounded raw pages freezes matching before effects and excludes new incarnations above its high-water` in `services/kernel/test/library/bulk-discovery.test.ts`.

### Collection occurrence transfer and capture

- Paths: `services/kernel/src/library/bulk-occurrences.ts`,
  `services/kernel/src/library/bulk-occurrence-page.sql`,
  `services/kernel/src/library/bulk-occurrence-transfer.sql`,
  `services/kernel/src/library/bulk-occurrence-ack.sql`,
  `services/kernel/test/library/bulk-occurrences.test.ts`,
  `services/kernel/test/library/bulk-occurrence-growth.test.ts`.
- Call sites: `captureCollectionPage`, `acknowledgeOccurrencePage`, target-side subject transfer and immutable
  occurrence acknowledgement. The target scan uses one raw member keyset and a separate target high-water.
- Proposed failing acceptance: `subject-scoped removal captures every pre-high-water occurrence once and later additions survive cross-partition replay` in `services/kernel/test/library/bulk-occurrences.test.ts`.

### Entry status and library removal targets

- Paths: `services/kernel/src/library/bulk-entry-targets.ts`,
  `services/kernel/src/library/bulk-entry-status.sql`,
  `services/kernel/src/library/bulk-entry-delete.sql`,
  `services/kernel/src/library/entry-model.ts`,
  `services/kernel/src/library/entry-store.ts`,
  `services/kernel/src/library/entries.ts`,
  `services/kernel/test/library/bulk-entry-targets.test.ts`,
  `services/kernel/test/library/entries.test.ts`.
- Call sites: ordinary `putEntry` validation, exact entry CAS and existing `deleteEntry`; no history cascade.
- Proposed failing acceptance: `status and removal targets preserve exact incarnation CAS no-effect receipts and unrelated history` in `services/kernel/test/library/bulk-entry-targets.test.ts`.

### Collection add and occurrence target commands

- Paths: `services/kernel/src/library/bulk-collection-targets.ts`,
  `services/kernel/src/library/bulk-collection-add.sql`,
  `services/kernel/src/library/bulk-collection-remove.sql`,
  `services/kernel/src/library/collections.ts`,
  `services/kernel/src/library/collection-model.ts`,
  `services/kernel/src/library/collection-store.ts`,
  `services/kernel/test/library/bulk-collection-targets.test.ts`,
  `services/kernel/test/library/bulk-collection-growth.test.ts`.
- Call sites: existing `collection:update` authorization, capacity/respace handling, member insert and exact member
  delete. The atomic bulk membership check is additive and does not constrain ordinary additions.
- Proposed failing acceptance: `bulk add skips a present subject receipts one append per missing subject and preserves ordinary duplicate members` in `services/kernel/test/library/bulk-collection-targets.test.ts`.

### Worker recovery, cancellation and expiry

- Paths: `services/kernel/src/library/bulk-work.ts`,
  `services/kernel/src/library/bulk-cancel.ts`,
  `services/kernel/src/library/bulk-expiry.ts`,
  `services/kernel/src/library/work.ts`,
  `services/kernel/src/work/modules.ts`,
  `services/kernel/src/work/retries.ts`,
  `services/kernel/test/library/bulk-work.test.ts`,
  `services/kernel/test/library/bulk-retention.test.ts`.
- Call sites: `registerLibraryBulkWork`, segment continuation, `restoreInitiator`, receipt-only recovery,
  cancellation checkpoints and bounded native GC. It is the sole owner of worker composition changes.
- Proposed failing acceptance: `DBOS replay reconciles exact receipts stops after authority loss and cannot reopen an expired operation` in `services/kernel/test/library/bulk-work.test.ts`.

### Outcome pagination and growth accounting

- Paths: `services/kernel/src/library/bulk-outcomes.ts`,
  `services/kernel/src/library/bulk-outcome-page.sql`,
  `services/kernel/test/library/bulk-outcomes.test.ts`,
  `services/kernel/test/library/bulk-outcome-growth.test.ts`.
- Call sites: typed `BulkOperations` outcome and summary ports and the outcome handler already mounted by the
  admission-owned route module. It depends on the accounts-owned opaque cursor API; it does not rewrite it.
- Proposed failing acceptance: `outcome pages bind viewer operation query and size while summary is constant work and never counts targets` in `services/kernel/test/library/bulk-outcomes.test.ts`.

The cursor helper and rate chunk port are prerequisites, not replacements for library authorization. If either
accounts contract is not yet available when an implementation is scheduled, order the dependent slice after its
owner. The entry/member sequence and slot-generation contract is the only new shared kernel storage contract called
out for explicit adoption; no route, worker or grant is approved by this specification.
