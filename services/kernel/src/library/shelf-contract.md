# Library shelf contract

The private shelf reads of one account: status tab counts, the per-tab sorted entry page with its active progress session,
the type filter and the type facets. `shelf-contract.ts` holds the types and the stubs; this file holds the decisions.
Evidence: [shelf layouts](../../../../docs/research/library-shelves.md) (3.1 structure, 3.3 controls, 3.4 selection),
[shelf activity](../../../../docs/research/library-shelf-activity.md) (Recommended bounded design, Keyset precision, Authorization),
and the Shelves section of [`packages/ui/README.md`](../../../../packages/ui/README.md). They are evidence, not code to copy.
Bulk selection and execution are a separate contract; these reads do not wait for it.

## HTTP

`GET /v1/libraryEntries` gains a shelf mode that is on exactly when `orderBy` is present. Without `orderBy` the route,
its payload, its order (`updated_at DESC, subject_id ASC`) and its cursors are unchanged. `direction` and `type` without
`orderBy` are `400 invalid_request`.

| Parameter   | Values                                        |
| ----------- | --------------------------------------------- |
| `orderBy`   | `lastActivity`, `finishedAt`, `createdAt`     |
| `direction` | `desc` (default), `asc`                       |
| `state`     | the five entry states, optional               |
| `type`      | a primary type, 1 to 256 characters, optional |
| `view`      | `BASIC` (default), `FULL`                     |
| `limit`     | 1 to 100, default 20. The web asks 48.        |
| `cursor`    | opaque, at most 4096 characters               |

The response is `{libraryEntries, next}`. Each item has the BASIC entry fields (`subjectId`, `state`, `revision`,
`createdAt`, `updatedAt`) and three additions. FULL adds only `subject`, as it does today; the embedded session never gains
`subject`.

- `lastActivityAt`: RFC 3339.
- `finishedAt`: RFC 3339 or `null`.
- `activeProgressSession`: `null` or exactly the BASIC per-session shape of `GET /v1/progressSessions` (`id`, `subjectId`,
  `versionSubjectId`, `mode`, `unit`, `total`, `amount`, `locator`, `position`, `completedUnitCount`, `state`, `revision`,
  `startedAt`, `completedAt`). No `accountId`, `transactionId` or unit rows. Strings and nulls are passed through as the
  session API returns them; `completed_units` returns the maintained count and never the sparse set.

The Continue row is `state=in_progress&orderBy=lastActivity`. Defaults are the web's choice, exported as
`SHELF_DEFAULT_ORDER`: completed `finishedAt`, planned `createdAt`, in progress, paused and dropped `lastActivity`, all `desc`.

`GET /v1/libraryShelfSummary?type=` returns `{tabs}`. `tabs` has the keys `all`, `in_progress`, `planned`, `completed`,
`paused`, `dropped`, `collections`, each `{total, shown}`. `total` ignores the type filter and `shown` applies it; without
`type` they are equal. `all` is the entry count. `collections` is the account's active Collections and ignores `type`.
The web hides empty overview sections from these counts.

`GET /v1/libraryShelfTypes?limit=&cursor=` returns `{types: [{type, count}], next}` ordered by `type` bytewise ascending
(`COLLATE "C"`). Counts are the account's entries of the type in any state. Limit 1 to 100, default 20.

Every new path is `x-exposure: gate:personal_library` and `x-action: library_entry:list`; the summary and the facets
need no progress authority because they carry no progress.

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

The shelf and facet cursors use the account-owned opaque helper (`ShelfCursorCodec`): AES-256-GCM through the existing key
ring with route, viewer and query as associated data, current and previous keys accepted. The module adds no readable
signed position and no encryption of its own. The scope is `shelfCursorScope` (account, state, type, order, direction) and
`shelfTypeCursorScope` (account). A cursor from another owner, state, type, order or direction, from the old list or the
facets, a malformed, tampered or expired one, is `400 invalid_cursor`. A partition-epoch mismatch stays `409 stale_cursor`.
The position is `ShelfSeek`: the stored timestamp text with microseconds, `''` for a null finished date, and the subject id.

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
- Type. `type` is the subject's primary type from `semantic.subject.type`. Each entry stores it with the subject that is
  its source (`type_source_id`, the entry's own subject until a merge). Private state never enters a semantic, search or
  public table.

## Storage

One additive migration in the owner's partition; nothing is written on a subject partition. `route` leads every key.

```sql
ALTER TABLE library.entry
  ADD COLUMN activity_at timestamptz,        -- = GREATEST(updated_at, progress_head.last_changed_at); NOT NULL after backfill
  ADD COLUMN finished_at timestamptz,        -- nullable, see Semantics
  ADD COLUMN subject_type text COLLATE "C",  -- NOT NULL after backfill, CHECK char_length BETWEEN 1 AND 256
  ADD COLUMN type_source_id uuid;            -- NOT NULL after backfill

ALTER TABLE library.progress_session
  ADD COLUMN last_changed_at timestamptz;    -- NOT NULL after backfill

CREATE TABLE library.progress_head (
  route integer NOT NULL, account_id uuid NOT NULL, subject_id uuid NOT NULL,
  last_changed_at timestamptz, last_completed_at timestamptz,   -- null until the first session change
  PRIMARY KEY (route, account_id, subject_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)));

CREATE TABLE library.shelf_count (
  route integer NOT NULL, account_id uuid NOT NULL,
  bucket text NOT NULL CHECK (bucket IN ('planned','in_progress','completed','paused','dropped','all','collections')),
  type text NOT NULL COLLATE "C",            -- '' is the rollup over all types and the only value for 'collections'
  n integer NOT NULL CHECK (n >= 0),
  PRIMARY KEY (route, account_id, bucket, type),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)));
```

Indexes. K is `activity_at`, `created_at` or `finished_at`; the order column is `K DESC` (`finished_at DESC NULLS LAST`)
then `subject_id`. Twelve entry indexes serve every combination of key and filter, named `entry_shelf_<key>[_state][_type]`:

- `(route, account_id, K, subject_id)`
- `(route, account_id, state, K, subject_id)`
- `(route, account_id, subject_type, K, subject_id)`
- `(route, account_id, state, subject_type, K, subject_id)`

Also: `entry_type_source (type_source_id, route, account_id, subject_id)` for the type sweep;
`progress_session_active (route, account_id, subject_id, last_changed_at DESC, session_id) WHERE state = 'active'`;
`shelf_count_types (route, account_id, type) WHERE bucket = 'all' AND type <> '' AND n > 0`. The old `entry_account_*`
indexes stay for the old list. A counter row at zero may linger and readers ignore it; only a rebuild removes it.

Counters, for one entry in state `s` with type `y`: `(s,'')`, `(s,y)`, `('all','')`, `('all',y)`. Each Collection create adds
`('collections','')`, each delete removes it. The counters are written in the command's transaction, so a page and its
counts agree within a snapshot.

## Helpers and call points

All helpers take `ShelfWrite` (`client`, `route`, `accountId`) and run in the owning command transaction.

| Helper                     | Statements | Called by                                                         |
| -------------------------- | ---------- | ----------------------------------------------------------------- |
| `ShelfHeads.ensure`        | 1          | `putEntry`, before its entry statement                            |
| `ProgressActivity.touch`   | 2          | every session command, after its session statement succeeds       |
| `ShelfCounters.transition` | 1          | `putEntry` (when placement changes), `deleteEntry`, type retyping |
| `ShelfCounters.collection` | 1          | Collection create and delete                                      |

- `ensure` upserts the head with a no-op update and returns its two timestamps. The row is the serialization point between
  entry and progress writes on one subject.
- `touch` is two statements on purpose. The first upserts the head with `GREATEST` of its columns and T (and
  `last_completed_at` when `completed`) and takes its lock. The second, in a new statement so it sees entries committed
  while it waited, runs `UPDATE library.entry SET activity_at = GREATEST(activity_at, T)` (and `finished_at` when
  `completed`) for the exact key and does nothing when there is no entry.
- `putEntry` insert: `ensure`, then one insert that sets `activity_at = GREATEST(T, head.last_changed_at)`, `finished_at =
  GREATEST(head.last_completed_at, T if the state is completed)`, `subject_type` and `type_source_id`, then `transition`.
  `putEntry` update: `ensure`, then the existing compare-and-swap with `activity_at = GREATEST(T, head.last_changed_at)` and
  `finished_at = GREATEST(finished_at, T)` only when the state moves into completed. `transition` runs only if the state
  changed. `deleteEntry`: the existing delete, then `transition`.
- The type is read before the command by `readItemTypes(pool, [subjectId])` (at most 256 ids, visible rows only) next to
  the existing subject resolve. It is not part of the receipt input, so a replay with a changed type is not an idempotency
  conflict. An update keeps the stored type.
- Session commands: `updateSession`/`insertSession` write `last_changed_at = GREATEST(old, T)`, then `touch`. A start has no
  session lock. Record, complete and abandon keep their `FOR UPDATE` first, so the lock order is session, head, entry,
  counters. A compare-and-swap miss throws before `touch`, so the rollback leaves everything as it was. A receipt replay
  skips the body.
- `transition` upserts at most eight counter rows in one statement with keys sorted, so `('all','')` is always locked
  first. A rebuild takes the same row first. A delta that would make a count negative aborts the command.

## Queries

Shelf page, one snapshot (`REPEATABLE READ READ ONLY`, as the old list). The statement text is chosen from a closed set of
fixed shapes (key × direction × state × type); values are always parameters and no shape uses an optional `OR`. Each shape
fetches at most `limit + 1` rows with two `LIMIT` branches, as the old list does.

- `desc`, key not null: `K < :c`, or `K = :c AND subject_id > :id`. `asc`: `K > :c`, or `K = :c AND subject_id < :id`.
- `finished_at` adds the null group. `desc` after a date: the two branches above, then `finished_at IS NULL` ordered by
  `subject_id`; inside the null group only `subject_id > :id`. `asc` is the mirror: inside the null group `subject_id < :id`
  then every dated row ascending; after a date the two `asc` branches.
- The timestamp is compared as the stored text cast back to `timestamptz`, never through `Date`.

Active sessions for the page: one statement with a lateral probe per returned entry, at most `limit` probes:

```sql
SELECT ... FROM unnest(:subject_ids::uuid[]) AS e(subject_id)
LEFT JOIN LATERAL (
  SELECT <session columns> FROM library.progress_session s
  WHERE s.route = :route AND s.account_id = :account_id AND s.subject_id = e.subject_id AND s.state = 'active'
  ORDER BY s.last_changed_at DESC, s.session_id ASC LIMIT 1) a ON true
```

The summary reads at most 13 exact counter keys by primary key (`(bucket, '')` for seven buckets, and `(bucket, :type)` for
six). The facets read `shelf_count_types` with `type > :after ORDER BY type LIMIT :l + 1`.

## Type projection

`subject.revised` carries no new type, so the library re-reads. Source events enter through the effect registry beside the
existing `library_member_listing` effect and enqueue `library.shelfTypeSync` with the workflow id `shelfTypeSyncWorkflowId`.

- `com.rezics.subject.revised.v1` with `kind: 'identity'` (other kinds are ignored): `{kind: 'revised', subjectId, revision}`.
- `com.rezics.subject.merged.v1` (`id`, `survivor`): `{kind: 'merged', subjectId: id, survivorId: survivor}`.

The workflow reads the current type once through `readItemTypes` (`revised`: the subject; `merged`: the survivor; a miss
ends the run and keeps the last known type), then walks the partitions that exist. One step is one partition and one page of
at most 100 entries: `entry_type_source` selects entries with `type_source_id = subjectId` in route order from the cursor,
the update changes only rows whose type or source differs, and `transition` moves each touched account's counters in the
same transaction. A merge also sets `type_source_id` to the survivor, so later revisions of the survivor reach those entries
through the index. Re-running changes nothing, so duplicates, replays and reordered revisions converge on the type current at
read time; the workflow id also skips a revision already handled. Two accounts holding one subject are two rows of the same
sweep. The total work is proportional to the entries of the subject, in pages; no step is larger than a page.

A new entry can race a type change that finished its sweep first. The effect `library_shelf_type_verify` listens to
`com.rezics.library.entry.updated.v1`, reads the entry, skips it unless `revision = 1`, and corrects the type if
`readItemTypes` differs. That is one point read and one batch of one id.

An entry whose subject becomes invisible keeps its last known type. No type is inferred from an event that lacks it.

## Migration and backfill

1. Add the nullable columns, the two tables and the indexes. Deploy writers that fill every new column.
2. Backfill in bounded batches ordered by `(route, key)`, 1000 rows per statement, each batch under the head lock:
   sessions get `last_changed_at = GREATEST(started_at, completed_at, latest progress_change.recorded_at)`; heads are
   inserted per account and subject from those maxima with `last_completed_at = max(completed_at)`; entries get
   `activity_at = GREATEST(updated_at, head.last_changed_at)`, `finished_at = GREATEST(head.last_completed_at, updated_at if
   state = 'completed')`, and their type from `readItemTypes` in batches of 256 with `type_source_id = subject_id`; counters
   are rebuilt per account under the counter lock.
3. A time that was never stored is not invented. An abandoned session has no stored abandon time, so its change time is its
   last known start or record. Order among old tied or abandoned sessions is therefore reproducible, not historical.
4. Set the columns NOT NULL once every row is filled, and switch the shelf mode on.

## Worker split

Each worker owns the files named and nothing else. One writer per shared file. The only edit any worker makes to
`shelf-contract.ts` is replacing its own stub with a one-line re-export of its implementation. `after` lists real code
needs: typed SQL needs the schema. Every worker below except storage can start once the storage migration has merged.

| Task                             | Files (at most 8, 400 lines)                                                                                                       | After                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `library-shelf-storage`          | the migration, regenerated `db/library/schema.sql`, `test/library/shelf-schema.test.ts`                                            |                                                                 |
| `library-shelf-store`            | `shelf-store.ts`, its five `.sql` statements (ensure, touch, raise, counts apply, counts lock), `test/library/shelf-store.test.ts` | storage                                                         |
| `library-shelf-entry-writes`     | `entries.ts`, `entry-store.ts`, `entry-store-entry-insert.sql`, `entry-store-entry-update.sql`, one test                           | storage                                                         |
| `library-shelf-progress-writes`  | `sessions.ts`, `progress-store.ts`, `progress-store-session-insert.sql`, `progress-store-session-update.sql`, one test             | storage                                                         |
| `library-shelf-collection-count` | `collections.ts` create and delete hooks, one test                                                                                 | storage                                                         |
| `library-shelf-reader`           | `shelf-reader.ts`, `shelf-reader-sql.ts`, `shelf-reader-active.sql`, `shelf-reads.ts`, two tests                                   | storage                                                         |
| `library-shelf-summary`          | `shelf-summary.ts`, `shelf-summary-counts.sql`, `shelf-summary-types.sql`, one test                                                | storage                                                         |
| `library-shelf-type-projection`  | `shelf-type-sync.ts`, `shelf-type-sync-page.sql`, `shelf-type-sync-apply.sql`, `work.ts`, two tests                                | storage                                                         |
| `library-shelf-backfill`         | `shelf-backfill.ts`, three `.sql` batches, `rebuildShelfCounters`, one test                                                        | storage                                                         |
| `library-shelf-http`             | `personal-routes.ts` (list shelf mode, summary, facets, `admitShelfRead`), one test                                                | reader, summary                                                 |
| `library-shelf-driver`           | `test/support/library-shelves-driver.ts` (the real driver), `test/support/shelf-seed.ts`, one driver test                          |                                                                 |
| `library-shelf-growth`           | `test/library/growth-shelves.test.ts`, `test/library/growth-shelf-writes.test.ts`, the module `README.md` Cost sections            | entry-writes, progress-writes, reader, summary, type-projection |

Nine workers (store, entry, progress, collection, reader, summary, type projection, backfill, driver) run in parallel after
storage, and the driver does not even wait for it. The wiring changes outside the files above are limited to
`collections.ts`, `work.ts` and `personal-routes.ts`, each owned by exactly one task. The outcome suite
`specs/library-shelves-outcomes.test.ts` passes when all of them have landed.

Outside this contract, each needing its own data contract with the owning module: sort by title (subject label and
collation, per reader language), by rating (the rating module's per-account value), by release date (a semantic fact of
the subject) and by progress (mode-dependent; a cursor position has no total). None is implemented here.

Open questions for the manager: (1) the accounts task ID and the API of the opaque cursor helper; (2) whether a coarse
"partitions holding this subject" hint may live outside the owner's partitions to skip empty partitions in the type sweep;
without it the sweep visits every existing partition once per source event, at one bounded step each.

## Cost

These are derivations from the SQL above and the existing schema, not measurements. `N` is the rows of the relevant
relation, `s` the page size (at most 100), `L(N) = O(log(2+N))` blocks for a B-tree probe. Rows (`R`), blocks (`B`) and
statements (`S`) are bounded separately. Every Growth check is a `checkGrowth` case at scales `[256, 1024, 4096]` with
`warmups >= 1`, constant rows and statements, logarithmic blocks and the shared catalog classifier, and no planner pins.

### Shelf page

- Touches: One account partition. A snapshot, the account admit, the partition epoch, then one keyset statement on the
  index for the chosen key, direction, state and type: at most `s + 1` entry rows, then one statement with at most `s`
  lateral probes of `progress_session_active`. FULL adds the existing per-subject summary reads, at most `s`. No whole-library
  or whole-session sort and no per-card request.
- Bound: `R` `O(s)`, `B` `O(s L(N))`, `S` constant (admit, epoch, page, probes, begin and commit). Independent of library
  size, sessions per subject, sparse unit history and other accounts.
- Growth check: `test/library/growth-shelves.test.ts` grows the owner's entries and its active and inactive sessions
  independently, plus unrelated accounts, at `[256, 1024, 4096]` with page 48 and measures the first page, a continuation,
  a state-filtered page and a type-filtered page for each key and direction (the 24 shapes are also checked for a Sort node).

### Shelf summary

- Touches: A snapshot, the admit and at most 13 counter primary-key probes in one statement.
- Bound: `R` at most 13, `B` `O(L(N))`, `S` constant. It never counts entries, members or sessions.
- Growth check: `growth-shelves.test.ts` measures the summary with and without `type` while entries, types and Collections
  grow at `[256, 1024, 4096]`.

### Type facet page

- Touches: A snapshot, the admit, the epoch and one range scan of `shelf_count_types` for at most `s + 1` rows.
- Bound: `R` `O(s)`, `B` `O(L(N) + s)`, `S` constant, independent of zero-count rows and of the account's entries.
- Growth check: `growth-shelves.test.ts` grows distinct types per account at `[256, 1024, 4096]` with page 100, a first and
  a continuation page, and also leaves many zero-count rows.

### Entry put

- Touches: The subject resolve and the type read before the command. In the command: one `ensure` (head upsert), the entry
  insert or compare-and-swap, one `transition` of at most eight counter rows when placement changes, and the existing follow
  upsert. At most the entry's twelve shelf indexes and the head row change; no other entry and no other partition.
- Bound: `R` `O(1)`, `B` `O(L(N))` with the constant 12 indexes, `S` 3 (4 with the follow), plus the envelope. No
  projection, count or search write.
- Growth check: `test/library/growth-shelf-writes.test.ts`: a fresh create and a state-changing update at `[256, 1024, 4096]`
  while the account's entries and heads, other accounts' entries and the subject's history grow; a conflict rollback keeps
  the original row, head and counters.

### Entry delete

- Touches: The existing delete and one `transition`. The head and sessions stay.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus the envelope.
- Growth check: `growth-shelf-writes.test.ts` deletes a fresh entry at `[256, 1024, 4096]` while entries and sessions grow.

### Session start

- Touches: The session insert (`last_changed_at = T`), then `touch`: one head upsert and one entry update by primary key
  that does nothing when the entry is absent. No scan for another session.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus the envelope. Independent of the subject's session history.
- Growth check: `growth-shelf-writes.test.ts` starts a session on a fresh subject and on a subject with 256, 1024 and 4096
  existing sessions, with and without an entry, while unrelated subjects grow.

### Session record

- Touches: The existing lock, read, unit statements, compare-and-swap and change append, with `last_changed_at` in the
  update, then `touch`. A miss throws before `touch`.
- Bound: As today plus `S` 2 and `R` `O(1)`. The unit statements keep their existing bound of 100 ids.
- Growth check: `growth-shelf-writes.test.ts` records a scalar value at `[256, 1024, 4096]` while the session's history and
  the subject's sessions grow separately; a stale revision leaves heads and entries unchanged.

### Session complete

- Touches: The same as record without a change row; `touch` also raises `last_completed_at` and `finished_at`.
- Bound: As today plus `S` 2, `R` `O(1)`, `B` `O(L(N))`. The next active session is chosen at read time, never here.
- Growth check: `growth-shelf-writes.test.ts` completes a fresh session at `[256, 1024, 4096]` while the subject's inactive
  and active sessions grow.

### Session abandon

- Touches: The same as complete; `touch` does not raise the completion columns.
- Bound: As complete.
- Growth check: `growth-shelf-writes.test.ts` abandons a fresh session at `[256, 1024, 4096]` while the subject's sessions grow.

### Collection create and delete

- Touches: The existing Collection statements and one `transition`-style counter upsert of `('collections','')`.
- Bound: As today plus `S` 1, `R` 1, `B` `O(L(N))`.
- Growth check: `growth-shelf-writes.test.ts` creates and deletes a Collection at `[256, 1024, 4096]` while the account's
  Collections grow.

### Type sync step

- Touches: One partition and at most 100 entries: a range scan of `entry_type_source` for the subject, an update of rows
  whose type or source differs, and one `transition` per touched account in the same transaction. The type itself is read once
  per run, not per step.
- Bound: `R` `O(s)`, `B` `O(s L(N))`, `S` constant per step. A run is `O(partitions + holders / 100)` steps and no step grows
  with unrelated entries or sessions.
- Growth check: `test/library/shelf-type-sync.test.ts` runs a step for a subject held by 256, 1024 and 4096 accounts' entries
  while unrelated entries grow; a repeated run changes no row and no counter.

### Entry type verify

- Touches: One entry point read, then (revision 1 only) one `readItemTypes` batch of one id and at most one correction step.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` constant.
- Growth check: `shelf-type-sync.test.ts` verifies one entry at `[256, 1024, 4096]` while the account's entries grow.

### Backfill and counter rebuild

- Touches: Maintenance only, never a request. A batch updates at most 1000 rows of one relation in one route range under the
  head or counter lock; a rebuild reads one account's entries and rewrites its counter rows.
- Bound: `R` `O(batch)`, `S` constant per batch; the whole run is linear in stored rows, once.
- Growth check: `test/library/shelf-backfill.test.ts` runs a batch at `[256, 1024, 4096]` unfilled rows and shows constant
  statements per batch; it is not a request-path check.
