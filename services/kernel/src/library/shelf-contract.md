# Library shelf contract

The private shelf reads of one account: status tab counts, the per-tab sorted entry page with its active progress session,
the type filter and the type facets. `shelf-contract.ts` holds the types and the stubs; this file holds the decisions.
Evidence: [shelf layouts](../../../../docs/research/library-shelves.md) (3.1 structure, 3.3 controls, 3.4 selection),
[shelf activity](../../../../docs/research/library-shelf-activity.md) (Recommended bounded design, Keyset precision, Authorization),
[type identity](../../../../docs/research/library-type-keys.md),
and the Shelves section of [`packages/ui/README.md`](../../../../packages/ui/README.md). They are evidence, not code to copy.
Bulk selection and execution are a separate contract; these reads do not wait for it.

## HTTP

`GET /v1/libraryEntries` gains a shelf mode that is on exactly when `orderBy` is present. Without `orderBy` the route,
its payload and order (`updated_at DESC, subject_id ASC`) stay unchanged. Its cursors also migrate to the shared opaque
helper; old readable HMAC tokens are refused. `direction` and `type` without
`orderBy` are `400 invalid_request`.

| Parameter   | Values                                                                 |
| ----------- | ---------------------------------------------------------------------- |
| `orderBy`   | `lastActivity`, `finishedAt`, `createdAt`, `personalScore`, `priority`, `title` |
| `direction` | `desc` (default), `asc`                                                |
| `state`     | exact validated profile state ID, optional                             |
| `type`      | exact full primary-type CURIE, optional                                |
| `view`      | `BASIC` (default), `FULL`                                              |
| `limit`     | 1 to 100, default 20. The personal page asks 100.                      |
| `cursor`    | opaque, at most 4096 characters                                        |

The response is `{libraryEntries, next}`. Each item has the BASIC entry fields (`subjectId`, optional nullable `incarnationId`, `state`, `revision`,
`createdAt`, `updatedAt`) and four additions. FULL adds only `subject`, as it does today; the embedded session never gains
`subject`.

- `lastActivityAt`: RFC 3339.
- `finishedAt`: RFC 3339 or `null`.
- `priority`: owner-local rank `1`–`100` or `null` (Unranked), present only for `orderBy=priority`.
- `activeProgressSession`: `null` or exactly the BASIC per-session shape of `GET /v1/progressSessions` (`id`, `subjectId`,
  `versionSubjectId`, `mode`, `unit`, `total`, `amount`, `locator`, `position`, `completedUnitCount`, `state`, `revision`,
  `startedAt`, `completedAt`). No `accountId`, `transactionId` or unit rows. Strings and nulls are passed through as the
  session API returns them; `completed_units` returns the maintained count and never the sparse set.

The Continue row is `state=in_progress&orderBy=lastActivity`. Defaults are the web's choice, exported as
`SHELF_DEFAULT_ORDER`: completed `finishedAt`, planned `createdAt`, every other exact profile state `lastActivity`, all `desc`.
The personal Library selects this native route explicitly on every layout. Its URL carries `orderBy` and `direction`
through route validation, the server function and generated client. Sort changes reset the cursor. State filters
use their adopted default until the URL specifies an order, then preserve that explicit order. Layout/size changes
and next-page links preserve the effective sort/filter and cursor. A rejected stale cursor restarts the same query
and displays a restart notice. Label shelves retain their native assignment order and receive no date parameters.
Only the three native dates have sortable table headers; title/type/status remain plain headings. Sort controls
require both advertised entry-list and progress-list admission; current native Access still decides every read.
The profile supplies exact state labels and choices; summary tabs retain their existing legacy bucket meanings.
No new content-family declaration or state coercion is introduced.

Priority order reads the retained entry population before applying the keyset limit and joins the current
`entry_personal_fact.priority` in the same native statement. Ascending uses ranks `1` through `100`; descending uses
`100` through `1`; `null` is last in both directions, and tied ranks use Subject UUID ascending. A page explicitly
returns the accepted rank or `null` for Unranked. It makes no per-row annotation request and adds no public Collection,
feed or Search field. Cursors bind the existing account, query, order and direction; their after-key is the canonical
decimal rank or `''` for Unranked, followed by Subject UUID. Traversal stays live: after a priority edit, the next page
uses current ranks against the existing keyset boundary rather than a retained snapshot.

The priority page runs one owner-scoped native selection with a `limit + 1` lookahead, then the existing batched
session read for emitted rows. At the maximum page size, at most 101 candidate rows leave the SQL statement; filtering
and ordering still cover the full current owner population. The query joins only current `entry` and
`entry_personal_fact` rows and does not load annotation history or issue per-entry reads. Growth fixtures exercise
independent owner populations of 64, 512 and 4096 rows plus same-scale foreign account and route pools. They assert
ordering and scope, not latency or throughput; the controller owns execution of the native growth gate, so no
performance ceiling is claimed here.

`GET /v1/libraryShelfSummary?type=` returns `{tabs}`. `tabs` has the keys `all`, `in_progress`, `planned`, `completed`,
`paused`, `dropped`, `collections`, each `{total, shown}`. `total` ignores the type filter and `shown` applies it; without
`type` they are equal. `all` is the entry count. `collections` is the account's active Collections and ignores `type`.
Counts measure Entries rather than Works, progress, loaded rows or Collection members. Custom states outside the five
legacy buckets still contribute to `all`. Counts and separately admitted shelf rows are independent observations.

The Web transport seam is `readShelfSummaryCurrent` / `loadShelfSummaryCurrent` in
`apps/web/src/library/shelf-summary-read.ts`. It derives `ShelfSummary` from the installed root `KernelClient` method,
performs one no-store GET with only Entry-list authority, validates all seven safe nonnegative count pairs, and returns
`{sessionSubject, authorizationAgrees, requested: {type, locale, source}, page}`. The page discriminates loaded,
signed-out, closed, denied, preparing and unavailable; only loaded includes a summary. No omitted or refused observation
means zero. A consumer must retire this envelope on originating session/account/type/address/locale changes before
rendering counts. This transport does not establish browser currentness or authorize a command. Existing writers and
their revision, incarnation, original-key retry and recovery operands retain command ownership. Native growth and
mounted navigation/acknowledgement measurements remain required; this boundary supplies no population-cost proof.

`GET /v1/libraryShelfTypes?limit=&cursor=` returns `{types: [{type, count}], next}` in stable private UUID order
(the UUID is not returned). Counts are the account's entries of the type in any state. Limit 1 to 100, default 20.

Every new path is `x-exposure: gate:personal_library` and `x-action: library_entry:list`; the summary and the facets
need no progress authority because they carry no progress.

### Default producer composition

The HTTP kernel binds `createDefaultShelfReads` to the existing `createShelfMaintenanceOps` factory with its configured
pool, installed Access, lazy WorkClient and clock. This adds no pool, worker lifecycle or queue. Before the final RR
checkout, an admitted bounded current-state gate probe can request the original guarded owner initialization command.
That command authorizes before receipt lookup, rechecks under the native gate lock, and publishes an advancement event
only when it actually installs initialization. Warm page, summary and facet reads create no initialization receipt or
event. An absent gate alone never establishes empty: only the original exact owner `hasEntries`/`hasCollections`/
`hasSessions` decision publishes an empty nil generation. Nonempty owners retain the native durable backfill intent;
the existing maintenance worker/recovery resumes bounded pages using the original identity-only source preparation
and private Type allocator. Reads remain unavailable until committed complete producer state is published.

The same RR client as each page/metadata read proves initialized, open, ready native owner state, a current active
generation and owner epoch. Missing, moved, rebuilding, purging or otherwise unproved currentness is unavailable.
Summary keys and facet discovery bind the exact active `shelf_count.generation_id`; returned dictionary values bind
that generation's positive type count and the exact private `(route,account_id,type_id)` identity. The dictionary
itself has no generation column. Sparse absent counters mean zero only under this complete producer proof. Retained
generations never contribute a duplicate count. Cursor bindings include both the owner epoch and active generation,
in addition to the original viewer, query and partition epoch. Entry incarnation CAS guards survive every date shape.

### Authorization

All three are owner-only and private. Anonymous callers get `401`; suspended, fenced or stale-authn owners and callers
without the scope get `403 forbidden`; another account sees only its own library. The shelf mode additionally needs
`progress_session:list` and the `reading_progress` gate, because `lastActivityAt`, the order and the embedded session all
disclose progress. A token with `library_entry:list` alone gets `403 forbidden`, and a closed `reading_progress` gate gets
`403 platform_closed`. There is no entry-only fallback. No new action, scope or grant exists, and the old list does not
depend on either progress control. The list route calls `admitShelfRead`, which checks the scope and then calls the shared
`admitGroup` of `access/gates/admission.ts` with group `reading_progress` and `clientAction` `progress_session:list`. No
shared module changes: that function already exists and is the interface this read needs.

### Cursors

All touched entry lists and facets use the async shared opaque helper through `ShelfCursorCodec`, structurally identical
to `encodeListCursor`/`decodeListCursor`: existing `KeyRing`, `{route, viewer, query}`, `{epoch, after}`, and required
`now: Date`, returning promises of string / existing `CursorResult`. It uses the kernel's tokens and clock, accepts current
and previous keys and supplies no local cryptography or wall-clock default. Abstract types do not import its runtime.

`shelfCursorBinding(accountId, query)` returns route `GET /v1/libraryEntries`, viewer account id and the effective
`{state, typeId, orderBy, direction, limit}`. `normalizeShelfQuery` gives missing state/typeId `null`, direction `desc`,
limit `20`; orderBy is required for shelf mode. Normalize once and use the SAME resolved predicate for SQL and binding.
Resolve the public full type exactly in the owner's dictionary before decode. Never put raw type text in AAD or after.
`shelfTypeCursorBinding(accountId, limit)` uses route `GET /v1/libraryShelfTypes` and query `{limit}`. The caller supplies
the validated effective limit, including its default. Neither binding contains cursor or presentation view.

The old-mode entry list uses the same route/viewer but query `{state: state ?? null, orderBy: 'updatedAt',
direction: 'desc', limit}`. This distinct order prevents an old-list token from becoming a shelf position. Do not accept
old HMAC tokens on either mode. Changing owner, state, resolved type, order, direction or page size, using another list's
token, tampering or expiry gives `400 invalid_cursor`; a partition-epoch mismatch gives `409 stale_cursor`.
Shelf after-keys are exact stored timestamp text (microseconds kept, `''` for null finished date), canonical priority
rank (`1`–`100`, `''` for Unranked), or score key, followed by subject UUID;
facet after is only the last emitted private type UUID. No timestamp passes through `Date`.

Walking is a live traversal: every entry appears exactly once while the data does not change. Under concurrent writes a
continuation resumes from its key. An unseen entry whose key moves before the boundary is not returned until the next first
page; a seen entry is not returned again unless its key moves back after the boundary (delete and recreate). There is no
snapshot retention and no transaction held across pages. A client deduplicates by `subjectId` and restarts on refresh.

## Semantics

- `lastActivityAt` is the later of the entry's `updated_at` (create or state change) and the latest change of any progress
  session of this account and subject: start, record, complete or abandon. An accepted, non-replayed record counts even when
  its value has no net effect; a replay or a rolled-back command counts for nothing. Another subject or account never
  counts. Progress never edits an entry's state, revision, `created_at` or `updated_at`, and never creates an entry.
- Time is the command's authoritative T from the kernel clock. Domain code uses neither `Date.now` nor database `now()`.
  Stored maxima use `GREATEST`, so a later T is never overwritten by an earlier one.
- Deleting an entry keeps its sessions and the subject's progress head. Recreating the entry uses the later of the new T
  and the head.
- `finishedAt` is the latest finish evidence and is never cleared. A command that moves an entry into `completed` from
  another state, or creates it `completed`, sets it to the later of its value and T. A completed re-put sets nothing. A
  session completion sets it to the later of its value and T whatever the entry state is, so a reread that completes later
  advances it. Start, record and abandon never touch it. An entry never finished is `null`; recreating an entry takes the
  head's latest completion. A completed entry without any session gets T of the command that completed it.
- Sorting. `desc` is newest first and ties break by `subject_id ASC`; `asc` is the exact reverse, ties by `subject_id DESC`,
  so one index serves both directions by scanning backward. A null `finished_at` is smaller than every date: last in
  `desc`, first in `asc`, ordered by the tie rule inside the null group.
- `activeProgressSession` is the active session of this account and subject with the greatest
  `(last_changed_at DESC, session_id ASC)`, or `null`. Several active sessions stay legal. Completing or abandoning the
  shown one reveals the next. A reread is a new session id and never borrows a finished one. The choice is unrelated to
  which session set `lastActivityAt`.
- Type. `type` is the subject's primary type from `semantic.subject.type`. Each entry stores its private `type_id`, source
  subject (`type_source_id`, its own subject until a merge), and the observed source stamp. Private state never enters
  a semantic, search or public table.

## Storage

This is a storage plan, not an applied migration. Every private primary key begins with `(route, account_id)` and is checked
against the account route. No new private directory, holder hint or Library row lives on subject partitions.

- `library.entry` adds `activity_at timestamptz`, nullable `finished_at`, `type_id uuid`, `type_source_id uuid`,
  `type_source_partition integer`, `type_source_epoch integer`, `type_source_position bigint`, and immutable
  `incarnation_id uuid` (the creation transaction id). Existing `transaction_id` remains the last user command identity.
  Type metadata correction changes neither that identity nor revision/update/activity time. Required new columns become
  NOT NULL only after cutover/backfill. Full type text is not an entry index key.
- `progress_session.last_changed_at timestamptz` becomes NOT NULL after backfill.
- `progress_head(route, account_id, subject_id)` has nullable `last_changed_at` and `last_completed_at`. `ensure` creates
  and locks an empty head, even without any progress. Deleting an entry retains it.
- `shelf_count(route, account_id, generation_id, bucket, type_id)` has nonnegative integer `n`. The reserved nil UUID is the all-types
  rollup and the only Collection key; it is never allocated as a type. Buckets are the five states, `all`, `collections`.
  One entry in state s/type y contributes `(s,nil)`, `(s,y)`, `(all,nil)`, `(all,y)`. A Collection contributes
  `(collections,nil)`. Zero counts may remain. Dictionary identities remain even if counters are rebuilt or removed.

Twelve entry indexes: for each K in `activity_at`, `created_at`, `finished_at`, use `(route,account_id,K,subject_id)`,
plus state, plus type_id, plus both state/type_id before K. K is DESC and subject_id ASC; finished is DESC NULLS LAST.
Backward scans serve the reverse direction. `entry_type_source(type_source_id,route,account_id,subject_id)` seeks holders.
`progress_session_active(route,account_id,subject_id,last_changed_at DESC,session_id ASC) WHERE state='active'` serves
one active-session probe. `shelf_count_types(route,account_id,generation_id,type_id) WHERE bucket='all' AND type_id<>nil AND n>0`
excludes historical zero counts before pagination. Existing old-list indexes remain.

### Exact private dictionary

Adopt the full-value / compact-identity separation recommended by the type-key study. This contract supersedes its
proposed public UUID interface: only full CURIEs cross HTTP. A private `typeId` is stable, account-scoped, one-to-one,
immutable, non-reused and not authority. An unknown, foreign or stale full value is `400 invalid_argument`; a retained
known zero-count value is valid and yields an empty page / zero shown counts. Lookup never allocates on reads.

All text is exact ASCII, without Unicode, case, prefix or IRI normalization. There is no per-identifier limit. The
release-wide 4 MiB validation bound is not a 256-character limit. Persist every byte in unindexed TOAST-able text.
The proposed private tables (all account scoped, with route checks and scoped foreign keys) are:

| Relation                 | Keys and values                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shelf_type_value`       | PK `(route,account_id,type_id)`, unindexed full text, stored byte length and JSON-encoded byte length. Full text has no index, including expression/unique indexes.                  |
| `shelf_type_root`        | PK `(route,account_id,digest)` with a fixed-size digest, immutable primary type_id and root node UUID. A digest is an accelerator, never proof of identity.                          |
| `shelf_type_node`        | Unique `(route,account_id,parent_id,chunk bytea)` with chunk at most 256 ASCII bytes; scoped unique node UUID; nullable terminal type_id. A terminal and outgoing edges may coexist. |
| `shelf_type_reservation` | PK `(route,account_id,reservation_id)`, full input text, digest, progress node/offset, candidate UUID, account fence/generation. No full values in workflow inputs or results.       |

`ShelfTypeKeys.lookup(client,route,accountId,fullType)` reads one digest root and compares its primary full value for
exact equality. A match returns its ID. A missing root returns null without allocation. A different value with the same
digest walks exact fixed-chunk edges from that root, then checks terminal/full equality. No collision bucket scan, digest
alias, raw-text B-tree key or prefix truncation is permitted. A value and its strict extension are distinct terminals.
Use a fixed digest (e.g. SHA-256) only to select the root; forced equal digests must preserve correctness.

`reserve(write,fullType)` first follows the same path. A root miss atomically publishes the complete primary mapping
under the unique root; concurrent losers reread and compare. A collision reserves native text, then walks/inserts edges
root to leaf by unique point keys. `continue(write,{reservationId})` stages at most 100 edges per maintenance transaction.
Shared staged nodes may exist without a terminal. Publish the final terminal and complete value mapping atomically;
never expose a half identity. Concurrent same-value attempts converge through root/terminal uniqueness, not a scan.
A candidate UUID conflict retries with a fresh non-nil UUID, with bounded attempts per continuation, never aliases or a
permanent length failure. Published mappings and root/terminal identities remain when counts reach zero. Reads encountering
unfinished reservations see no known value yet; writers finish resolution before entry/counter mutation. Revalidate the
account fence and source binding before publishing or using staged results. Observation objects with full values remain inside a native step; save a reservation reference before a step returns.
Workflow arguments/results contain only
bounded UUIDs, offsets and canonical decimal position strings; large input and source values stay in native reservations.

Usual digest hit/miss touches constant indexed rows/statements plus O(input bytes) hashing, comparison and storage.
Forced collisions touch O(ceil(input bytes / 256)) point edges, independent of the number of unrelated identities.
Lookup may walk those edges in the read snapshot; allocation uses bounded resumable transactions. Eventual completion of
long valid values is required, including across retries. Input-size work is separate from database-population growth.

Library owns dictionary/lookup/staging and the `shelf-erasure` module contract. It must supply bounded account erasure
for value/root/node/reservation rows, counts, heads and source metadata, children before parents, fenced against stale
workers recreating data. The account-erasure orchestration owner must call and await that module contract before declaring
account purge complete. No account-erasure integration API exists here to assume already wired: that call site and writer
fencing are real cutover prerequisites, owned by final wiring with the account-erasure owner. Account deletion ends the
account namespace; normal entry/type deletion never erases retained identities or reuses keys.

## Helpers and call points

`ShelfWrite` carries the real command client, route and account id. `ShelfHeads.ensure` runs before the entry statement:
one no-op upsert locks the head and returns both nullable timestamps. `ProgressActivity.touch` runs after a successful
session statement: first upsert/lock the head with GREATEST(old,T), also completion when appropriate; then a NEW statement
raises the existing entry's activity/finish maxima. The second statement sees an entry committed while the first waited.
It never inserts an entry. The head lock serializes entry/progress writes; session lock precedes head then entry then
sorted counter keys. The all-types `all` counter locks first. Negative counters abort.

Entry create resolves source and exact private identity before the command, outside receipt input; it records source
stamp and immutable creation identity. Under the head lock, activity is max(T,head change), finish is max(head completion,
T when completed). State changes retain type/source, raise activity and raise finish only on entering completed. Counter
transition runs only for changed placement. Delete removes entry/counters, retaining sessions/head/dictionary. Every
session start/record/complete/abandon raises its own last_changed_at with max(old,T), then touches head/entry. Complete
also raises completion/finish. An accepted no-net-effect record counts; a CAS miss throws before touch, rollback restores
all state, and receipt replay skips the body. No `now()` or `Date.now()` supplies domain time.

`ShelfReadDependencies` supplies actual pool, resolved Access, existing tokens, KernelClock, separately injectable
page/summary/facet readers, exact type lookup and async codec. `admitShelfRead` takes pool/access/clock plus actor/deadline,
checks progress scope and calls real `admitGroup({pool,access:()=>access,actor,group:'reading_progress',
clientAction:'progress_session:list',deadline,clock})`. The existing route admits `personal_library` once. No stub returns
successful invented data. Concrete implementations import contract types; the final wiring owner alone replaces stubs.

## Queries

One fenced, owner-admitted `REPEATABLE READ READ ONLY` snapshot covers source-independent dictionary resolution, partition
epoch, page/summary/facet work and cursor validation. A public type must resolve BEFORE cursor decode. SQL and binding
receive the same normalized `ShelfQuery`, distinct from public `ShelfListQuery.type`. Retained known-zero filters still
resolve to their original private ID. FULL retains existing authorized bounded subject enrichment.

All SQL is in its own typed `.sql` file. `ShelfDateReader` supplies candidates, `ShelfActiveReader` supplies the independent session batch and the dispatcher
returns the complete `ShelfPageReader` result. Six page adapters (three date keys × two directions) each select four fixed
state/type-id predicate statements; no generated SQL strings and no optional-filter OR. Each branch has LIMIT, producing
at most O(limit) candidates. A bounded merge sort over branch results is allowed; a population scan/sort is not.
DESC seeks K < boundary or equal K with subject_id > boundary; ASC mirrors both. Finished dates include the null group
last in DESC, first in ASC; within it seek by subject id. Compare exact stored timestamp text cast to timestamptz,
never JavaScript Date. One separate active-session statement probes the partial index once per emitted entry and returns
only BASIC session fields, never sparse units/history. Summary uses at most thirteen exact counter keys, never COUNT of
entries, sessions or Collection members.

Facet discovery first reads at most limit+1 positive private keys, counts and stored encoded lengths. It then chooses the
emittable prefix and fetches ONLY those full values, by primary key. The serialized response (including escaped values,
counts, envelope and next token) has an 8 MiB budget, large enough for any one valid release-bounded identifier. Reserve
space for the maximum token/envelope before choosing the prefix. A page may be shorter than its row limit. If more remain,
next seeks strictly after the last EMITTED UUID, never after an unreturned discovery row. No empty page with next and no
truncation. Discovery cannot eagerly transfer a hundred huge values before applying the budget. Store full and encoded
lengths when allocating; emitting a full release-bounded value always makes progress. Cursor tokens carry only UUIDs.

## Type projection

`subject.revised` identity events enqueue `library.shelfTypeSync` by subject/revision; merge events by old/survivor.
Payloads are invalidation hints, never authoritative type/redirect truth. `observeShelfType` obtains the current owner,
opens one RR client at that authoritative source partition and calls `readPartition` AND semantic `readItemTypes` on that
SAME client. Capture `{partition,epoch,position}` with the type and current merge binding from that snapshot.
`ShelfSourceSnapshot.binding` remains stamped even when a merged/invisible source has no visible type observation. Position
is bigint throughout native comparisons/storage; only JSON/DBOS boundaries use canonical decimal strings restored to
bigint before comparison. Moved/fenced source ownership uses normal partition retry/routing, not a successful miss.

Resolve/check the merge in that same source snapshot, following only ONE hop. A source switch observes survivor data
separately in an RR snapshot at its own owner; never label survivor data with the old source's stamp. If the survivor has
also moved/merged, revalidate the binding through a later bounded retry rather than recursively following a chain in one
step. An invisible source keeps the last known type; an event without a type cannot invent one.

Each entry stores current source id/stamp, immutable incarnation id and last user transaction id. Within the SAME source
partition compare `(epoch,position)` monotonically; never compare positions from different partitions. Source switches
require expected current source/incarnation/transaction/stamp equality, a non-older observation of that same current
source binding, and a revalidated one-hop redirect with a separately observed survivor stamp. An old snapshot paused before apply cannot replace a newer applied stamp, even when event
workflow IDs differ. A false CAS triggers a bounded retry rereading current entry AND source binding/truth, not reuse of
an old snapshot against a new expectation. A same-source older/equal stamp is a no-op; equal stamps may repair a proved
inconsistent value only under exact expected-version CAS. Metadata correction updates private type/source/stamp and
counter deltas atomically, without entry revision, transaction/update/activity time changes or entry.updated emission.

Sweep all existing partitions in bounded visits, then holder pages through `entry_type_source`, ordered by the FULL
unique `(route,accountId,subjectId)` tuple. An account may retain several merged-away entries following one source; do
not drop its unreturned tail at a page boundary. Each candidate uses the expected-version CAS and counter transition.
A step has O(page size) statements when doing per-account transitions. Total cost includes existing-partition visits as
well as holders; no private directory/hint is added at the subject. Resume/retry revalidates source binding and stamp.

`library_shelf_type_verify` listens to existing entry.updated CloudEvents. Key `library.shelfTypeVerify` by immutable
`event.id` (`shelfTypeVerifyWorkflowId(eventId)`), not (account,subject). Read the CURRENT entry and observe its
incarnation/transaction/source/stamp, even when revision is no longer one; use bounded CAS/retry as above. Old work must
not overwrite a recreated entry or newer stamp. A later state change/recreation has another event id and can verify anew.
No event schema change is needed to access CloudEvent.id. Verification never emits an entry.updated loop.

## Migration, backfill and cutover

Add nullable columns, dictionary and head/count tables and indexes first. Deploy concrete writer hooks before fixtures
or requests depend on shelf reads. Backfill session change time from max(start,completion,stored change records), then
heads, entry activity/finish, exact type IDs/source stamps and counters in bounded keyset batches. An abandon time never
stored is not invented: tied historical ordering is best-known and reproducible. Long identity allocation is staged
separately, not embedded in one large backfill transaction.

Maintenance rebuild takes an explicit writer fence/quiescence across bounded account batches and final generation swap;
normal writers, projection and fixture seeding must honor it. `rebuildShelfCounters(write,batch)` has bounded limit,
continuation, fence and generation identity. No whole growing account scan in one transaction. Retried batches are
idempotent; partial generations are not served. Validate concurrency/fencing and resume before NOT NULL/read cutover.
Final wiring owns writer and real-driver fixture cutover, account-erasure integration and the shared contract re-exports.

## Worker split

Every row below is a separate runnable implementation, at most 400 added/changed lines and eight files. Split again if
that limit cannot hold; do not consolidate readers/resolver/maintenance. All tests start red against the throwing stubs or
missing concrete modules, never by returning fixture-shaped success. Each acceptance command is
`bun run --cwd services/kernel check test/library/<test file>`; literal test titles are given below. Reader rows expand
into six independent tasks/files/tests, one per named key/direction. Typed SQL depends on its actual schema, not a report.
Only final wiring edits `shelf-contract.ts`; every other worker imports types and tests its concrete module directly.
No worker imports a cursor runtime until its helper implementation exists. HTTP, old-list and read-service workers that
import `tokens/list-cursor.ts` declare the shared opaque-helper code prerequisite; abstract specification does not.

| Owner                | Exclusive files / call sites                                                                                                                                   | Code prerequisites                                               | Failing acceptance: test file — literal title                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Base schema          | one shelf-columns migration, `test/library/shelf-schema.test.ts`                                                                                               | none                                                             | `shelf-schema.test.ts` — `shelf heads counts stamps and bounded indexes exist`                                     |
| Dictionary schema    | one dictionary migration, `test/library/shelf-type-schema.test.ts`                                                                                             | base schema                                                      | `shelf-type-schema.test.ts` — `dictionary keys are bounded and owner scoped with retained terminals`               |
| Heads/activity       | `shelf-heads.ts`, three head/activity `.sql`, `test/library/shelf-heads.test.ts`                                                                               | base schema                                                      | `shelf-heads.test.ts` — `empty heads serialize entry create and progress raise in two statements`                  |
| Counters             | `shelf-counters.ts`, two delta `.sql`, `test/library/shelf-counters.test.ts`                                                                                   | base schema                                                      | `shelf-counters.test.ts` — `placement and Collection deltas roll back atomically`                                  |
| Entry store          | `entry-store.ts`, its insert/update/delete `.sql`, `test/library/shelf-entry-store.test.ts`                                                                    | base schema                                                      | `shelf-entry-store.test.ts` — `entry CAS preserves incarnation and returns shelf placement`                        |
| Entry hooks          | `entries.ts` write paths, `test/library/shelf-entry-writes.test.ts`                                                                                            | heads, counters, entry store, type allocation/source observation | `shelf-entry-writes.test.ts` — `entry writes preserve progress maxima and replay placement`                        |
| Progress store       | `progress-store.ts`, its insert/update `.sql`, `test/library/shelf-progress-store.test.ts`                                                                     | base schema                                                      | `shelf-progress-store.test.ts` — `session changes persist monotonic command time`                                  |
| Progress hooks       | `sessions.ts`, `test/library/shelf-progress-writes.test.ts`                                                                                                    | heads, progress store                                            | `shelf-progress-writes.test.ts` — `accepted progress raises activity while CAS and replay do not`                  |
| Collection hooks     | `collections.ts`, `test/library/shelf-collections.test.ts`                                                                                                     | counters                                                         | `shelf-collections.test.ts` — `active Collection commands maintain only the owner rollup`                          |
| Date readers         | Six owners: `shelf-page-{activity,finished,created}-{asc,desc}.ts`, four fixed predicate `.sql` each, one matching test each                                   | base schema                                                      | each `shelf-page-<key>-<direction>.test.ts` — `fixed predicates seek dates nulls and ties without population work` |
| Active sessions      | `shelf-active.ts`, one lateral `.sql`, `test/library/shelf-active.test.ts`                                                                                     | base schema                                                      | `shelf-active.test.ts` — `active probes preserve sparse BASIC sessions and activity ties`                          |
| Closed dispatcher    | `shelf-page.ts`, `test/library/shelf-page.test.ts`                                                                                                             | six date readers, active sessions                                | `shelf-page.test.ts` — `every shelf shape dispatches to a bounded fixed reader`                                    |
| Summary              | `shelf-summary.ts`, one counter `.sql`, `test/library/shelf-summary.test.ts`                                                                                   | counters                                                         | `shelf-summary.test.ts` — `shown totals use exact private keys including known zero`                               |
| Facets               | `shelf-facets.ts`, discovery/value `.sql`, `test/library/shelf-facets.test.ts`                                                                                 | dictionary schema, counters                                      | `shelf-facets.test.ts` — `facets budget bytes before fetching full values and continue by emitted UUID`            |
| Exact lookup         | `shelf-type-lookup.ts`, root/value/edge `.sql`, `test/library/shelf-type-lookup.test.ts`                                                                       | dictionary schema                                                | `shelf-type-lookup.test.ts` — `exact full values resolve without allocation across forced collisions`              |
| Allocation           | `shelf-type-keys.ts`, reserve/root/publish `.sql`, `test/library/shelf-type-keys.test.ts`                                                                      | dictionary schema, exact lookup, trie staging                    | `shelf-type-keys.test.ts` — `concurrent identities never alias or expose partial terminals`                        |
| Trie staging         | `shelf-type-stage.ts`, reservation/edges/progress `.sql`, `test/library/shelf-type-stage.test.ts`                                                              | dictionary schema                                                | `shelf-type-stage.test.ts` — `long collision paths finish in bounded resumable transactions`                       |
| Source observation   | `shelf-type-source.ts`, one merge-read `.sql`, `test/library/shelf-type-source.test.ts`                                                                        | existing partition/semantic reads                                | `shelf-type-source.test.ts` — `source stamp type and one hop binding share the authoritative RR client`            |
| Projection apply     | `shelf-type-apply.ts`, version-read/apply/page `.sql`, `test/library/shelf-type-apply.test.ts`                                                                 | counters, allocation, source observation                         | `shelf-type-apply.test.ts` — `paused old source snapshots cannot overwrite a newer apply or incarnation`           |
| Projection workflows | `shelf-type-sync.ts`, `shelf-type-verify.ts`, `test/library/shelf-type-sync.test.ts`                                                                           | projection apply                                                 | `shelf-type-sync.test.ts` — `tuple continuations and event keyed verification converge without entry events`       |
| Dictionary erasure   | `shelf-erasure.ts`, three bounded purge `.sql`, `test/library/shelf-erasure.test.ts`                                                                           | dictionary schema, base schema                                   | `shelf-erasure.test.ts` — `account purge fences reservations and removes private dictionary state in batches`      |
| Dictionary backfill  | `shelf-type-backfill.ts`, two `.sql`, `test/library/shelf-type-backfill.test.ts`                                                                               | allocation, source observation                                   | `shelf-type-backfill.test.ts` — `type backfill resumes long identities without publishing partial entries`         |
| Activity backfill    | `shelf-backfill.ts`, three batch `.sql`, `test/library/shelf-backfill.test.ts`                                                                                 | heads, writer hooks                                              | `shelf-backfill.test.ts` — `backfill resumes bounded historical maxima under writer fencing`                       |
| Counter rebuild      | `shelf-rebuild.ts`, three generation `.sql`, `test/library/shelf-rebuild.test.ts`                                                                              | counters, writer hooks                                           | `shelf-rebuild.test.ts` — `fenced counter generations rebuild in bounded batches before atomic cutover`            |
| Read service         | `shelf-reads.ts`, `test/library/shelf-reads.test.ts`                                                                                                           | dispatcher, summary, facets, exact lookup, opaque helper         | `shelf-reads.test.ts` — `read dependencies bind the normalized owner predicate and effective page size`            |
| HTTP                 | `personal-routes.ts`, `shelf-admission.ts`, `test/library/shelf-http.test.ts`                                                                                  | read service                                                     | `shelf-http.test.ts` — `shelf HTTP preserves full CURIEs and requires progress admission`                          |
| Old-list cursors     | `shelf-old-cursors.ts`, `test/library/shelf-old-cursors.test.ts`                                                                                               | opaque helper                                                    | `shelf-old-cursors.test.ts` — `old mode keeps payload and order but rejects readable and shelf tokens`             |
| Real driver          | `test/support/library-shelves-driver.ts`, `test/support/shelf-seed.ts`, `test/library/shelf-driver.test.ts`                                                    | production commands/Access, hooks, releases, projection          | `shelf-driver.test.ts` — `driver transports real commands and pauses production boundaries without policy`         |
| Final wiring         | `shelf-contract.ts`, `work.ts`, `shelf-wiring.ts`, composition `../http/kernel.ts`, account-erasure orchestration adapter, `test/library/shelf-wiring.test.ts` | all concrete modules, account-erasure call site                  | `shelf-wiring.test.ts` — `production wiring and fixtures use the concrete shelf services and purge lifecycle`      |
| Growth reads         | `test/library/growth-shelves.test.ts`                                                                                                                          | readers, summary, facets, real driver                            | `growth-shelves.test.ts` — `shelf reads stay bounded as private populations grow`                                  |
| Growth writes        | `test/library/growth-shelf-writes.test.ts`                                                                                                                     | hooks, projection, maintenance                                   | `growth-shelf-writes.test.ts` — `shelf writes and projection pages stay bounded as private populations grow`       |
| Type input costs     | `test/library/growth-shelf-type-keys.test.ts`                                                                                                                  | exact lookup, staging, facets                                    | `growth-shelf-type-keys.test.ts` — `type work follows input bytes and forced collision path length`                |

Entry hooks own `entries.ts` exclusively, including importing the old-mode adapter once available; the old-list owner
supplies that adapter and its test without editing entries.ts. HTTP owns personal-routes; final wiring owns work.ts and
shelf-wiring.ts, the kernel composition call site and the shared stubs. No six readers touch one shared dispatcher. Reader tests grow entries and session
populations at geometric scales `[256,1024,4096]`, fixed page sizes 1 and 48, all four predicates, null/tie boundaries,
and EXPLAIN classification allowing bounded branch Sorts. Growth acceptance uses those same geometric populations for
heads/counters/Collections/holder pages/retained zero identities independently, warmups and the shared classifier, no
planner pins. Input acceptance separately grows byte lengths `[512,8192,131072]` under forced equal digests with a strict
extension and same-prefix siblings; a near-release-sized identifier must finish staging and serialize intact. These are
required future checks, not measured passing results. Production acceptance also runs the complete real-driver outcome
suite after all workers land. A green no-driver red-suite verifier proves only executable specification integrity.

Title/release/progress sorting and bulk execution remain separate owning contracts; personal-score ordering is specified in [the score contract](../../../../docs/library-personal-score-order.md). No semantic assertion or
existing shelf/sitemap/bulk research adoption is removed by this specification.

## Cost

These are planned derivations, not measurements or passing growth results. N is relation population, s the bounded page
size, L(N)=O(log(2+N)), V existing source partitions, H matching holders and b input bytes. Input bytes, response bytes,
examined rows, blocks and statements are separate dimensions. Growth check citations below are required implementation
tests; they name file and literal test title only. Their geometric scales belong in test code/acceptance above.

### Shelf page

- Touches: owner admission/epoch, one fixed keyset shape, then bounded active-session probes; FULL adds existing subject reads.
- Bound: R O(s), B O(s L(N)), S constant for BASIC; no account/session population sort, sparse-unit or history scan.
- Growth check: `test/library/growth-shelves.test.ts` — `shelf reads stay bounded as private populations grow`.

### Summary

- Touches: exact rollup and resolved type counter keys; Collection rollup ignores type.
- Bound: R O(1), B O(L(N)), S constant. Public full-type resolution adds the separate input-size cost below.
- Growth check: `test/library/growth-shelves.test.ts` — `shelf reads stay bounded as private populations grow`.

### Type facet page

- Touches: positive key/count/length discovery, then only emitted dictionary values; retained zero keys are excluded by index.
- Bound: R O(s), B O(L(N)+s) for discovery plus emitted TOAST bytes; S constant. Transfer/serialization O(emitted bytes),
  bounded by the response byte budget independently of row count. Never fetch all discovered large values eagerly.
- Growth check: `test/library/growth-shelves.test.ts` — `shelf reads stay bounded as private populations grow`.
- Growth check: `test/library/growth-shelf-type-keys.test.ts` — `type work follows input bytes and forced collision path length`.

### Exact identity lookup and allocation

- Touches: one digest root and full-value comparison; on collision only the input's own trie edges and terminal.
- Bound: ordinary path constant indexed rows/statements plus O(b) bytes; collision R and S O(ceil(b/chunk)), B that times
  L(N), plus O(b) hashing/comparison/storage. Staging bounds each transaction's edges; total input work is not constant.
- Growth check: `test/library/growth-shelf-type-keys.test.ts` — `type work follows input bytes and forced collision path length`.

### Entry and Collection writes

- Touches: entry head lock, entry CAS/delete and sorted counter deltas; Collection command adds one counter delta.
- Bound: command body R O(1), B O(L(N)), S constant, plus existing envelope/source read and separate identity input cost.
  Delete retains head/sessions/dictionary. CAS/replay cannot advance maxima or counters.
- Growth check: `test/library/growth-shelf-writes.test.ts` — `shelf writes and projection pages stay bounded as private populations grow`.

### Progress start, record, complete and abandon

- Touches: existing session operation, then head lock and a second entry-raise statement. Complete also raises finish.
- Bound: existing operation plus R O(1), B O(L(N)), S constant; unit intent remains independently input-bounded.
- Growth check: `test/library/growth-shelf-writes.test.ts` — `shelf writes and projection pages stay bounded as private populations grow`.

### Type sweep and verification

- Touches: authoritative source snapshot, bounded existing-partition visits, holder tuple pages, per-account CAS/counters.
  Event-keyed verification reads current entry/source and retries a bounded number of times per step.
- Bound: sweep R O(s), B O(s L(N)), S O(s) per holder page, plus dictionary input work. Total steps O(V+H/s), including
  empty partition visits. Source/survivor observations are separate when owners differ. Verification has constant row work
  per attempt, plus source/value bytes; no stale worker can lower a stamp across retries.
- Growth check: `test/library/growth-shelf-writes.test.ts` — `shelf writes and projection pages stay bounded as private populations grow`.

### Initialize or inspect a current owner generation

- Touches: indexed account/partition/native gate and current installed Access. Guarded first initialization uses the
  original owner-input EXISTS decision and durable backfill intent; warm reads have no command/receipt/event history.
- Bound: constant indexed readiness work. Existing maintenance continues bounded pages, never a request-time owner scan.
- Growth check: existing native maintenance/read growth assertions remain the deferred integration proof.

### Backfill, erasure and counter rebuild

- Touches: bounded maintenance batches and dictionary continuations under explicit writer/account fences; generation swap.
- Bound: per-batch R O(batch), S O(batch) where per-owner transitions are needed, with separate O(input bytes) work.
  Whole runs are linear in relevant stored rows/bytes; no growing account is scanned in one transaction.
- Growth check: `test/library/growth-shelf-writes.test.ts` — `shelf writes and projection pages stay bounded as private populations grow`.

## Installed native writer ports

`createShelfTypeKeys()` is exported by `shelf-type-keys.ts` (also its default export) and the installed contract module.
Lookup is read-only. Allocation is admitted only through the producer's private same-command preparation closure;
caller-constructed evidence cannot open it. `createTypePreparationPorts` and `createTypePreparationContinuation` provide
the public closed helper declarations. The native maintenance runner composes the same dictionary core using its
private WeakMap page and reloaded same-transaction run/build guard; no boolean fallback exists.

`createShelfCounters()` is exported by `shelf-counters.ts` (also its default export) and the installed contract module.
Entry creation/state/deletion/restoration and active Collection creation/deletion/restoration call these ports in the real command.
The shared maintenance `enterShelfWrite` holds account share and the maintained generation gate before the
`shelf_writer_owner` counter serialization point and native placement rows. Only the shared gate owns readiness,
epoch and active generation. Empty initialization publishes the exact nil generation; existing entry/Collection/session history records a
pending initial-backfill intent and defers all deltas until the separate maintenance runner publishes completeness.
Each counter statement targets only the locked active generation and rolls back on missing negative, negative result,
bigint overflow or values outside the response's safe integer range. Accepted profile states outside the five shelf
tabs still contribute to both all-entry rollups; their stored state and profile pin are preserved.

## Personal score extension

[Personal-score ordering](../../../../docs/library-personal-score-order.md) owns the added native question,
indexed access path, explicit installation, identity-currentness port and cursor rules. Existing date semantics
and defaults remain unchanged. An unbound Content identity-currentness producer returns preparing/unavailable;
installing the score index alone does not enable a successful personal-score page.

## Title key policy and installation status

The title key uses the same disclosed Semantic label selection as the page (`languageRanges` followed by
`chooseLabel`, including original-language, English, and deterministic language fallback). The versioned
`semantic-sort-name-v1` key is the UTF-8 byte sequence of `sortName(label)` truncated to 256 codepoints. It is a
reproducible key for this policy, not a universal human collation. Missing or empty labels are explicit missing-title
coverage and sort after labelled rows in both directions; Subject-ID ties follow the selected direction. A change to
label selection or key normalization requires a new policy version, a rebuilt materialized basis, and cursor retirement.

The native producer, reader and cursor bindings below require an installed complete-input source adapter. Until that
adapter proves current disclosed source material for the entire selected shelf and preparation installs its generation,
title ordering returns preparing or unavailable; it must not return a successful empty or date-ordered page. Root client
publication and the receiving page remain outstanding, so saved preferences cannot select title yet.

## Native title order

Title mode is `GET /v1/libraryEntries?orderBy=title&direction=asc|desc`, with the existing state, Type, view, limit and
opaque cursor operands. `Accept-Language` is selected by Semantic's `languageRanges`; repeat it for every page and
preparation command. No label string or normalized ordering key appears on the wire. Each returned title row adds
`titleCoverage: 'labelled' | 'missing'`. Missing labels sort last in both directions. Equal keys, including missing
labels, use Subject UUID in the selected direction. Selection covers the entire native selected shelf, using separate
indexed labelled/missing ranges before the bounded Entry/session enrichment.

`POST /v1/libraryShelfTitlePreparation` has no body and uses the existing idempotency header and `library_entry:list`
authority. Its response is `{installation:'pending'|'installed',prepared:number}` (0 through 100). The caller uses a new
request key for each next page and retains the original key for retry. A replay returns the original preparation effect;
only an admitted GET against the current source/native basis establishes present readiness. No Entry action operand,
revision, incarnation or writer changes. Preparation uses the existing owner command fence; Entry writers and backfill
atomically invalidate the population version, and the existing purge cleans derivative keys in batches.

One account retains one selected-language generation. A policy, population or complete source-basis change starts
bounded cleanup/build before the replacement is installed. Pages bind the exact key/language policy, source basis,
materialized generation and population, account authentication lifetime and effective query. Rename, ownership changes,
source denial, hidden identities or incomplete maintenance cannot silently fall through to an older index or a date page.

Content publishes the root `KernelClient` route/enum above, its title row coverage DTO and preparation response/method;
there is no new cursor DTO (the existing opaque `next` remains authoritative). Content also installs `ShelfTitleSource`
from `shelf-title-source.ts`: its bounded whole-source version must account for all relevant foreign title and disclosure
changes, and its exact <=100-subject batch must either cover every disclosed identity or report unavailable. A page digest,
cached summaries or per-Entry Subject requests are insufficient. The native factories fail closed without this port.
Until that root client is installed, the Web recognizes/preserves title URLs and shows preparation without sending an
unsupported generated query, and saved title preferences do not replace a working date order.
