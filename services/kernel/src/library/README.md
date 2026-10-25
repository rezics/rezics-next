# Library

Library is the kernel module for a person's shelves and reading state, and for the public projection of public Collection membership.

## Scope

A Collection has ordered members. The same subject may appear more than once. An account keeps library entries, one state per subject. Progress is stored as progress sessions, with units and history for one subject and an optional version subject. Owned items are copies, each a private row. The kernel's single follow model is follows, and community's join step uses the same membership follow. Public snapshots are published logs. The public subject listing is the count and pair rows of public Collection membership.

## Partitions

Everything personal lives in the owner's partition. That includes Collections and their members, entries, progress sessions, units and history, copies, follows and published logs. A partition is `route >>> 4`. It is not a physically partitioned SQL table.

Public Collection membership is copied to each subject's partition, carrying only `public_collection_count` and pair rows. A pair is one `subject_collection` row: collection id, collection route and multiplicity. Private and unlisted membership never write those rows. Nothing in a follow, entry, session or copy is written on the subject's partition.

## Privacy

Private state never reaches public full text, counts or "who also read". Only public Collections and published logs are public. An unlisted Collection can be read by someone who knows its id, and it is not listed. A private Collection is disclosed only to a live grant-capable curator. Everyone else receives the same not-found result as an unknown id.

Events about private state use the account or Collection id as `subject`, never a subject id. Collection updated, deleted, member-changed and listing-changed events use the Collection id. Entry, follow, progress-session, copy and published-log events use the account id. A member-changed payload also carries the member id and the subject id. An entry or follow payload may carry an id in `data`. The public listing event `com.rezics.library.subject.listed.v1` uses the subject id because that projection is public. Follows are never counted in public. A published log shows the subject id, the session state, the start and completion times, and the owner's note. It does not show amount, cursor or the completed-unit set.

## Ordering

Ordering keys are fractional-indexing keys. Keys are generated within 32 characters and stored within 48. They are stored with `COLLATE "C"` and are unique on `(route, collection_id, ordinal_key)`. That unique constraint is deferrable. A respace happens when no generated key fits. A respacing in the same command increments `orderEpoch`, which makes earlier cursors stale. A new Collection starts at epoch 0. Member cursors seal `orderEpoch + 1` because the seal rejects epoch 0. A mismatch is `stale_cursor`.

## Cost

These are derivations from the library commands, SQL, `db/library/schema.sql` and `db/library/migrations/`, not measurements or guaranteed PostgreSQL plans.
`N` is total rows of the relevant relation kind; `P` is rows of that kind in an anchor's partition.
`L(N) = O(log(2+N))` shared blocks for a B-tree probe, with constant rows examined for a unique key; `k` indexed changes cost `O(k L(N))` blocks.
Bounds distinguish rows examined (`R`), shared blocks (`B`) and SQL statements (`S`). A subsection excludes the command envelope and authorization unless it adds them.
Library primary keys are B-trees beginning with `route`.
`M` is the member count of one Collection and is at most 5000. Mounted pages use `s` at most 100. One progress record names at most 100 unit ids. A session's completed-unit count is at most 20000. History length is not capped by that number.
`listing-counts.sql` is the search reader. One statement probes `subject_listing` by primary key, `LIMIT 1`, once per supplied id in one partition. No library growth test measures that reader, so this Cost section does not cite it.
Where a named test does not call the operation, or does not grow the rows that operation can touch, the subsection says so. A bound the indexes do not support is stated as not derivable.

### Command envelope

- Touches: Every library `runCommand`. An attempt starts a serializable transaction, sets the lock timeout and the statement timeout, reads time with `transaction_timestamp()` and no relation, runs authorization, and probes at most one `core.receipt` by `(partition_no, principal_kind, principal_id, command_kind, idempotency_key)`. The fence is one statement. It updates one `core.partition` primary key, inserts one `core.outbox` row per event, zero or one `editorial.write_basis`, and zero or one `core.receipt`. Library bodies emit one event, or two when a public Collection also emits `listing.changed` or an in-progress entry also follows. A matching receipt commits and skips the body and the fence. Listing sync supplies a receipt and no write basis and no authorization callback. Own-account, trusted-account and Collection commands set a 5 second deadline. Listing sync leaves the deadline unset, so `runCommand` uses its 2 second default. Contention retries are deadline-dependent, not a fixed count.
- Bound: Here `k` is 1 or 2. Per attempt `R` is `O(1+k)`, `B` is `O((1+k) L(N))`, and `S` is `O(1)`. Replay omits the body and the fence writes.
- Growth check: `test/library/collections.test.ts`: `create cost stays constant as unrelated collections grow`. That check classifies the whole command, envelope included, as logarithmic rows and blocks and constant statements while unrelated Collections grow at 1, 8 and 64. It does not vary `k` or the deadline.

### Authorization

- Touches: `ownAccount` reads one `access.account` primary key and checks kind, active state, fence, authentication epoch and the request scope in memory. `trustedAccount` reads the same account row for `library:account-command` and does not consult a caller scope list. Collection create adds `parentCreationAuthorization` for `collection:create` on the curator account. That validation reads the account again, and one initialization statement writes access rows. The standing-grant list is empty. The statement inserts one `access.resource_initialization` row and one owner grant `library.collection.owner`. Collection update, delete and member commands use `resourceAuthorization` for `collection:update` or `collection:delete`. Prepare reads the Collection primary key through `visibleCollection` on another connection and runs the Access check. The command transaction then authorizes in memory. A private Collection is hidden from anyone who is not its curator. Entry, copy, follow, progress and published-log commands authorize by the account row and scope, not by a per-row grant. Several also call `readAccount` once before the command. Subject, Collection and Space reads use `subject:read`, `collection:read` and `space:read`. Listing sync passes no authorization callback. The permission-check shape is the Access cost in `src/access/README.md`. A subject resolve also uses the semantic read in `src/semantic/README.md`. This section does not re-derive those probes.
- Bound: Each account or Collection anchor point is `R` `O(1)`, `B` `O(L(N))` and `S` `O(1)`, plus the Access preparation and permission-check bounds for that invocation. Initialization is one statement and two result rows. The temporal owner-grant exclusion check is not a B-tree `L(N)` probe.
- Growth check: `test/library/collections.test.ts`: `create cost stays constant as unrelated collections grow`. The whole command includes own-account authorization and does not isolate Access probes. `test/library/subject-anchor.test.ts`: `subject anchoring has constant resolve cost and input-bounded page cost as unrelated subjects grow`. Resolve rows and statements stay constant and blocks stay logarithmic. Page cost grows with the input id count.

### Create Collection

- Touches: The curator's partition. Inside the command, parent-creation prepare runs on the writer pool, then one Collection insert, one creation-proof primary-key read that includes `xmin`, and one initialization statement. A public Collection emits `collection.updated` and `listing.changed`. Any other visibility emits only `collection.updated`. Both events use the Collection id as `subject`.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus parent-creation Access checks, own-account authorization and the envelope. The GiST exclusion check on the owner grant is not included in that block bound.
- Growth check: `test/library/collections.test.ts`: `create cost stays constant as unrelated collections grow`. Whole-command rows and blocks are logarithmic and statements are constant as unrelated Collections grow. The check does not separate the body from the envelope.

### Update Collection

- Touches: One active Collection primary-key read and one compare-and-swap primary-key update of title, description or visibility. `listing.changed` is emitted only when active-and-public listed-ness changes. The event subject is the Collection id. Members are not rewritten.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus Collection authorization and the envelope. Independent of `M`.
- Growth check: `test/library/collections.test.ts`: `update cost stays constant as unrelated collections grow`. Whole-command rows and blocks are logarithmic and statements are constant at unrelated scales 1, 8 and 64.

### Delete Collection

- Touches: One active Collection primary-key read and one tombstone primary-key update. Members remain. `listing.changed` is emitted only when the Collection was actively public. The event subject is the Collection id. This command does not delete pair rows.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus `collection:delete` authorization and the envelope. No member fanout in this command.
- Growth check: No scale sample calls delete. `test/library/collections.test.ts`: `update cost stays constant as unrelated collections grow` is the nearest whole-command point update and does not call delete. `test/library/collection-http.test.ts`: `curator creates replays updates conflicts and deletes with only the contracted public view` deletes a Collection and does not assert a scale bound.

### Add member

- Touches: Subject resolve starts before the command. Inside: one active Collection read, one neighbour read, and, when no generated key fits, one `listMembers` of at most 5000 rows and one respace statement. Keys are generated within 32 characters and stored within 48. The neighbour statement seeks at most one before key and one after key on the ordinal unique key, plus the named after-member when the position is after. Respace increments `order_epoch` when `member_count` equals the requested set and rewrites those members in the same statement. The insert statement then bumps `member_count` while it is below 5000 and inserts one member. The 5001st member writes nothing. The event subject is the Collection id. Respace does not itself emit `listing.changed`.
- Bound: Fitting key: library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus one subject resolve, authorization and the envelope. Respace of this Collection examines and rewrites `M` member keys, `M` at most 5000, so that path is `R` `O(M)` and `B` `O(M L(N))` on top of the fitting-key reads.
- Growth check: `test/library/collections.test.ts`: `add cost stays constant as unrelated collections grow`. That sample does not grow the target's members and does not respace. `test/library/collection-store.test.ts`: `respacing 500 members rewrites one Collection in one statement and preserves order` shows one statement and `orderEpoch` 1 at 500 members. It is one size, not three scales. `test/library/subject-anchor.test.ts`: `subject anchoring has constant resolve cost and input-bounded page cost as unrelated subjects grow`.

### Move member

- Touches: One active Collection read and one neighbour read. A fitting key updates one member primary key and touches the Collection primary key. When no generated key fits, the command lists at most 5000 members, respaces them, then lists at most 5000 members again to return the moved row. Keys are generated within 32 characters and stored within 48. The event subject is the Collection id.
- Bound: Fitting key: library body `R` `O(1)`, `B` `O(L(N))`, `S` 4, plus authorization and the envelope. The respace path adds two lists of `M` rows and one rewrite of `M` keys, `M` at most 5000, so `R` `O(M)` and `B` `O(M L(N))`.
- Growth check: `test/library/collections.test.ts`: `move cost stays constant as unrelated collections grow`. The sample is a fitting-key move and does not respace. `test/library/collection-store.test.ts`: `respacing 500 members rewrites one Collection in one statement and preserves order`.

### Note member

- Touches: One active Collection read, one member primary-key note update, and one Collection touch. The note is at most 1000 characters. The event subject is the Collection id. Listing rows are unchanged.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus authorization and the envelope.
- Growth check: No scale sample calls note. `test/library/collection-http.test.ts`: `members support duplicate subjects first after last moves notes removal and cursor pages` writes a note and does not assert scale. `test/library/collections.test.ts`: `update cost stays constant as unrelated collections grow` is a point update and does not call note.

### Remove member

- Touches: One active Collection read and one statement that deletes the member primary key and decrements `member_count`. The event subject is the Collection id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus authorization and the envelope.
- Growth check: `test/library/collections.test.ts`: `remove cost stays constant as unrelated collections grow`. Whole-command rows and blocks are logarithmic and statements are constant as unrelated Collections grow. The target's other members are not scaled.

### Collection read

- Touches: `collection:read`, with public eligibility. Eligibility reads the Collection primary key once into a sink, and the load does not read it again when that sink has seen the row. A repeatable-read transaction may also read the viewer account. Public and unlisted rows are returned. A private row is returned only to a live grant-capable curator.
- Bound: The Collection point is `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the account read when the viewer is an account, the Access check, and begin and commit.
- Growth check: `test/library/collection-reads.test.ts`: `reads keep the same statement count as unrelated Collections, members and pairs grow`. It keeps `readCollection` statement counts equal at 1, 8 and 64. It does not classify blocks.

### Curator list

- Touches: An account read when the viewer is that curator and holds `collection:read`. Otherwise the page is public only. A repeatable-read transaction reads the partition epoch and runs the curator page. That statement is two `LIMIT` branches, ordered by `updated_at` descending and `collection_id` descending, for active Collections of that curator. It fetches `s + 1` rows, `s` at most 100. The index `collection_curator_listing` is `(route, curator_account_id, collection_id)` and does not include `updated_at` or state. The store helper that orders by `collection_id` can use that index and is not the mounted read.
- Bound: A row bound independent of that curator's active Collection count cannot be derived from `collection_curator_listing`. `s` caps the returned page, not the rows a plan may examine. `S` is one page statement plus the partition read and begin and commit, and the account read when a full view is considered.
- Growth check: `test/library/collection-reads.test.ts`: `a curator lists every active Collection and everyone else lists only public ones`. That test checks visibility. It is not a scale measurement.

### Members page

- Touches: The Collection load, then one ordinal keyset on `collection_member` ordered by `ordinal_key`, `member_id`, fetching `s + 1` rows. The unique key is `(route, collection_id, ordinal_key)`. The cursor carries `orderEpoch + 1`. `readableSubjects` then filters at most `s` ids, with concurrency 4. Unreadable subjects are omitted from the page. The extra row only decides the next cursor.
- Bound: The member statement is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1, plus the Collection load and up to `s` subject resolves. Those resolves cost linear rows, blocks and statements in the id count.
- Growth check: `test/library/collection-reads.test.ts`: `reads keep the same statement count as unrelated Collections, members and pairs grow` uses limit 1 and compares statements. `test/library/collection-store.test.ts`: `member page, insert and neighbour read have constant row and statement cost at three scales` keeps a limit-1 member page, one insert and one neighbour read at constant rows and statements and logarithmic blocks, against unrelated Collections. `test/library/subject-anchor.test.ts`: `subject anchoring has constant resolve cost and input-bounded page cost as unrelated subjects grow`.

### Subject page

- Touches: One subject resolve, one partition-epoch read, one `subject_collection` keyset on `(route, subject_id, collection_id)` with limit `s + 1`, then one Collection primary-key read per pair on the page. Pairs whose Collection is not active and public are dropped. The mounted page uses `s` at most 100. The pair helper itself accepts a limit through 5000 and is called here with `s + 1`.
- Bound: The pair keyset is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1. The projection adds `S` of `O(s)` Collection primary-key reads, each `R` `O(1)` and `B` `O(L(N))`, plus one subject resolve. A limit-1 sample does not show the `O(s)` term.
- Growth check: `test/library/collection-reads.test.ts`: `reads keep the same statement count as unrelated Collections, members and pairs grow` calls the subject page at limit 1 and compares statements. `test/library/subject-anchor.test.ts`: `subject anchoring has constant resolve cost and input-bounded page cost as unrelated subjects grow`.

### Entry put

- Touches: One subject resolve, then own-account `library_entry:update`. A missing revision inserts one `entry` primary key. A supplied revision compare-and-swaps that primary key. State `in_progress` also runs one follow upsert in the same command and may emit a second event. The event subject is the account id.
- Bound: Planned insert or update: library body `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the resolve, authorization and the envelope. In progress adds one follow upsert, so the body is `S` 2, and `k` is 2 when the follow changes.
- Growth check: `test/library/entries.test.ts`: `put, delete and list statement counts stay equal at three scales of unrelated account entries` keeps `planned` put statements equal at 1, 8 and 64. It does not measure blocks and does not follow. `test/library/entry-store.test.ts`: `entry write, entry page and copy page touch the same rows and statements at three scales` updates one entry at 1000, 8000 and 64000: one statement, constant rows, logarithmic blocks and no sequential scan.

### Entry delete

- Touches: Own-account `library_entry:delete` and one primary-key delete matching account, subject and revision. The event subject is the account id. Copies are left in place.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus authorization and the envelope.
- Growth check: `test/library/entries.test.ts`: `put, delete and list statement counts stay equal at three scales of unrelated account entries`. Delete statements stay equal at 1, 8 and 64. Blocks are not classified.

### Entry read

- Touches: A repeatable-read snapshot, one account admit, and one `entry` primary key. A missing or foreign row is not found. There is no write.
- Bound: The entry point is `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the account read and begin and commit.
- Growth check: No scale sample calls the point read. `test/library/entry-store.test.ts`: `an entry round trip changes state only when the revision matches` reads an entry back and does not grow `N`. `test/library/entries.test.ts`: `put, delete and list statement counts stay equal at three scales of unrelated account entries` does not call the read.

### Entry page

- Touches: A snapshot, an account admit, a partition-epoch read, and one keyset. The unfiltered order uses `entry_account_updated` on `(route, account_id, updated_at, subject_id)`. A state filter uses `entry_account_state`. Two `LIMIT` branches fetch at most `s + 1` rows, `s` at most 100. The cursor is bound to the account and the selected state.
- Bound: `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1 for the page, plus the admit and the partition read.
- Growth check: `test/library/entries.test.ts`: `put, delete and list statement counts stay equal at three scales of unrelated account entries` lists with limit 20 and compares statements at 1, 8 and 64. `test/library/entry-store.test.ts`: `entry write, entry page and copy page touch the same rows and statements at three scales` pages with limit 1 at 1000, 8000 and 64000: one statement, constant rows, logarithmic blocks and no sequential scan.

### Session start

- Touches: One account admit, then a subject resolve for the session subject and, when present, the version subject. The command inserts one `progress_session` in the account partition. The event subject is the account id. The payload carries only the session id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the admit, one or two subject resolves, authorization and the envelope.
- Growth check: The statement sample does not call start. `test/library/sessions.test.ts`: `each mode starts in the account partition, records by CAS and reads its own value` starts a session and is not a scale measurement. `test/library/sessions.test.ts`: `statement counts stay equal at three scales of unrelated sessions and units` does not call start.

### Session record

- Touches: One `FOR UPDATE` of the session primary key, one session read, then optional unit removal and unit addition. Each of those is one statement over an array of at most 100 ids. Addition inserts with `ON CONFLICT DO NOTHING` after confirming the session exists. The session row is compare-and-swapped. A record always appends one `progress_change` whose `change_no` is the new revision. It is not a max scan. A completed-unit count above 20000 rolls the command back. The event subject is the account id.
- Bound: A scalar or cursor record, with no unit writes, is library body `S` 4, `R` `O(1)`, `B` `O(L(N))`. A unit record adds one removal, one addition, or both. For `u` ids, `u` at most 100, those statements are `R` `O(u)` and `B` `O(u L(N))`. History length is not bounded by 20000. Add authorization and the envelope.
- Growth check: `test/library/sessions.test.ts`: `statement counts stay equal at three scales of unrelated sessions and units` records a scalar, a cursor and one repeated unit id. Statement counts stay equal at 1, 8 and 64. It does not grow `u` or that session's unit set. `test/library/progress-store.test.ts`: `unit add, unit page and change page touch the same rows and statements at three scales` adds one unit id at 1000, 8000 and 64000: one statement, constant rows, logarithmic blocks and no sequential scan.

### Session complete

- Touches: The same lock, primary-key read and compare-and-swap as a record. The state becomes completed and `completed_at` is set. There is no unit write and no change row.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus authorization and the envelope.
- Growth check: The scale sample does not complete a session. `test/library/sessions.test.ts`: `statement counts stay equal at three scales of unrelated sessions and units` does not call complete. `test/library/sessions.test.ts`: `completion and abandonment are explicit CAS transitions; rereads preserve earlier completion` completes a session and is not a scale measurement.

### Session abandon

- Touches: The same lock, read and compare-and-swap. The state becomes abandoned and `completed_at` is cleared. There is no unit write and no change row.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus authorization and the envelope.
- Growth check: `test/library/sessions.test.ts`: `statement counts stay equal at three scales of unrelated sessions and units` does not call abandon. `test/library/sessions.test.ts`: `completion and abandonment are explicit CAS transitions; rereads preserve earlier completion` abandons a session and is not a scale measurement.

### Session read

- Touches: A repeatable-read snapshot, one account admit, and one session primary key. A missing or foreign session is not found.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the admit and begin and commit.
- Growth check: `test/library/sessions.test.ts`: `each mode starts in the account partition, records by CAS and reads its own value` reads the session and is not a scale measurement. `test/library/sessions.test.ts`: `statement counts stay equal at three scales of unrelated sessions and units` does not call the session read.

### Session page

- Touches: A snapshot, an admit, a partition-epoch read, and one keyset on `progress_session_account_subject` `(route, account_id, subject_id, started_at, session_id)`. Two `LIMIT` branches fetch at most `min(100, s + 1)` rows. When `s` is 100 and the page is non-empty, a second limit-1 probe runs, because the first fetch is capped at 100. The cursor binds the operation, the account and the subject.
- Bound: `R` `O(s+1)`, or `O(s+2)` when the extra probe runs. `B` `O(L(N)+s)`. `S` is 1 or 2, plus the admit and the partition read.
- Growth check: No scale sample calls the session page. `test/library/sessions.test.ts`: `signed keyset cursors bind the operation, account and session or subject` pages sessions and does not grow `N`. `test/library/sessions.test.ts`: `statement counts stay equal at three scales of unrelated sessions and units` does not call the session page.

### Unit page

- Touches: The same snapshot, admit and session primary key, a partition read, and one `progress_unit` keyset on `(route, session_id, unit_id)`. The first fetch is `min(100, s + 1)`. A non-empty page at `s` = 100 issues a second limit-1 probe.
- Bound: The page is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1 or 2, plus the session read, the admit and the partition read.
- Growth check: `test/library/progress-store.test.ts`: `unit add, unit page and change page touch the same rows and statements at three scales` pages units at limit 1: one statement, constant rows, logarithmic blocks and no sequential scan at 1000, 8000 and 64000. `test/library/sessions.test.ts`: `statement counts stay equal at three scales of unrelated sessions and units` lists units at limit 1 and compares statements at 1, 8 and 64.

### Change page

- Touches: The same session load and snapshot as the unit page, then one `progress_change` keyset on `(route, session_id, change_no)`. The first fetch is `min(100, s + 1)`, with the same extra probe when `s` is 100 and the page is non-empty. A cursor seeks to `change_no`. It does not walk from change 1.
- Bound: The page is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1 or 2, plus the session read, the admit and the partition read.
- Growth check: `test/library/progress-store.test.ts`: `unit add, unit page and change page touch the same rows and statements at three scales` pages changes at limit 1 under the same constant-row and logarithmic-block check. `test/library/sessions.test.ts`: `statement counts stay equal at three scales of unrelated sessions and units` lists changes at limit 1 and compares statements.

### Copy create

- Touches: An account admit, one subject resolve, and one `copy` insert in the owner partition. The event subject is the account id. The payload carries the copy id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the admit, the resolve, authorization and the envelope.
- Growth check: `test/library/copies.test.ts`: `statement counts stay equal at three scales of unrelated copies`. Create keeps statements and rows constant and blocks logarithmic at 1, 8 and 64, with no sequential scan on `library.copy`.

### Copy update

- Touches: An account admit, then a body of three statements: `FOR UPDATE` on the owned copy primary key, one primary-key read, and one compare-and-swap update. A foreign or missing row is not found. The event subject is the account id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus the admit, authorization and the envelope.
- Growth check: `test/library/copies.test.ts`: `statement counts stay equal at three scales of unrelated copies`. Update keeps statements and rows constant and blocks logarithmic at 1, 8 and 64, with no sequential scan on `library.copy`.

### Copy delete

- Touches: The same admit, lock, primary-key read and revision check as update, then one primary-key delete. The event subject is the account id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus the admit, authorization and the envelope. The same shape as update, with a delete in place of the update.
- Growth check: The scale sample does not call delete. `test/library/copies.test.ts`: `statement counts stay equal at three scales of unrelated copies` measures create, update and page. `test/library/copies.test.ts`: `an account records two private copies of one edition and changes each by revision` deletes one copy and does not assert a scale bound.

### Copy read

- Touches: A repeatable-read snapshot, one account admit, and one `copy` primary key. A missing or foreign row is not found.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the admit and begin and commit.
- Growth check: The scale sample does not call the point read. `test/library/copies.test.ts`: `statement counts stay equal at three scales of unrelated copies` does not call it. `test/library/copies.test.ts`: `an account records two private copies of one edition and changes each by revision` reads a copy and is not a scale measurement.

### Copy page

- Touches: A snapshot, an admit, a partition-epoch read, and one keyset on `copy_account_created` `(route, account_id, created_at, copy_id)`. The first fetch is `min(100, s + 1)`. When `s` is 100 and that fetch does not already show a further row, a second limit-1 probe runs. The cursor is bound to the account.
- Bound: `R` `O(s+1)`, or `O(s+2)` with the probe. `B` `O(L(N)+s)`. `S` is 1 or 2, plus the admit and the partition read.
- Growth check: `test/library/copies.test.ts`: `statement counts stay equal at three scales of unrelated copies` lists with limit 1 and classifies statements and rows as constant and blocks as logarithmic. `test/library/entry-store.test.ts`: `entry write, entry page and copy page touch the same rows and statements at three scales` pages copies at limit 1: one statement, constant rows, logarithmic blocks and no sequential scan at 1000, 8000 and 64000.

### Follow

- Touches: An account admit, then a target resolve. A subject uses `subject:read`. A Collection is one primary-key read and must be active and public, unlisted, or curated by the actor. A Space uses `space:read` and one Space read. The command then upserts one `follow` primary key and reads it back. An unchanged row aborts before the receipt. The event subject is the account id. Follows are not counted in public.
- Bound: The follow body is `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus the admit, the target resolve, authorization and the envelope. The Space and subject resolves add their own Access and semantic bounds.
- Growth check: `test/library/follows.test.ts`: `statements per follow, membership step and page stay equal as unrelated follows grow`. Explicit Collection follows keep statement counts equal at 1, 8 and 64. Blocks are not classified. `test/library/follow-store.test.ts`: `apply and page statement counts and examined rows stay constant as unrelated follows grow` applies intent `follow` at 1000, 8000 and 64000: one statement, one `library.follow` row, no sequential scan, constant rows and logarithmic blocks.

### Unfollow

- Touches: The same admit, target resolve, follow upsert and read-back as follow, with intent `unfollow`. A string target first reads the existing row so the stored target type is kept. An explicit unfollow is not overridden by a later implied follow. The event subject is the account id.
- Bound: The same body as follow: `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus one extra primary-key read when the caller passes only an id, the admit, the resolve, authorization and the envelope.
- Growth check: The scale samples do not call unfollow. `test/library/follows.test.ts`: `statements per follow, membership step and page stay equal as unrelated follows grow` measures follow, membership and page. `test/library/follows.test.ts`: `an account follows, unfollows and refollows a readable subject in its own partition` unfollows and is not a scale measurement. The store scale sample applies intent `follow` only.

### Membership follow

- Touches: `trustedAccount` for `library.follow.membership`, then the same follow upsert and read-back, with implied intent and reason `membership`. The library command does not resolve the Space. Community's join step is the caller. An explicit unfollow is preserved by the upsert predicate. The event subject is the account id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus trusted-account authorization and the envelope. No subject, Collection or Space read inside this command.
- Growth check: `test/library/follows.test.ts`: `statements per follow, membership step and page stay equal as unrelated follows grow`. Membership steps keep statement counts equal at 1, 8 and 64. Blocks are not classified.

### Follow read

- Touches: One `follow` primary key for the caller and the target. The read is a single autocommit statement. Another account receives no row. There is no public count.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` 1. No envelope, because this read is not a command.
- Growth check: No scale sample calls the point read. `test/library/follows.test.ts`: `another account reads none of the owner's follows` checks concealment and is not a scale measurement. `test/library/follow-store.test.ts`: `apply and page statement counts and examined rows stay constant as unrelated follows grow` does not call the point read.

### Follow page

- Touches: One keyset on `follow_account_page` `(route, account_id, state, updated_at, target_id)` for `state = following`. The command page is one statement. The HTTP page also reads the partition epoch. Its first fetch is `min(100, s + 1)`. When `s` is 100 and that fetch does not already show a further row, a second limit-1 call runs. The cursor is bound to the account.
- Bound: The page statement is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1. HTTP at `s` = 100 adds the probe, so `S` is 1 or 2, plus the partition read. No command envelope.
- Growth check: `test/library/follows.test.ts`: `statements per follow, membership step and page stay equal as unrelated follows grow` lists with limit 20 and keeps statement counts equal at 1, 8 and 64. `test/library/follow-store.test.ts`: `apply and page statement counts and examined rows stay constant as unrelated follows grow` pages with limit 1 at 1000, 8000 and 64000: one statement, one examined follow row, no sequential scan, constant rows and logarithmic blocks.

### Publish

- Touches: Own-account `published_log:create`. The body reads the owner's session primary key and inserts one immutable `published_log` in the owner partition. The event subject is the account id. Nothing is written on the subject partition.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus authorization and the envelope.
- Growth check: `test/library/published-logs.test.ts`: `statements per publish, retract, read and page stay equal at three scales of unrelated logs`. Publish statement counts stay equal and positive at 1, 8 and 64. Rows and blocks are not classified.

### Retract

- Touches: Own-account `published_log:delete` and one primary-key delete matched to the owner account. The event subject is the account id. The session is left in place.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus authorization and the envelope.
- Growth check: `test/library/published-logs.test.ts`: `statements per publish, retract, read and page stay equal at three scales of unrelated logs`. Retract statement counts stay equal at 1, 8 and 64. Rows and blocks are not classified.

### Published log read

- Touches: A repeatable-read transaction and one `published_log` primary key. The read is public, including anonymous. There is no account admit. A missing row is not found.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus begin and commit. No authorization read.
- Growth check: `test/library/published-logs.test.ts`: `statements per publish, retract, read and page stay equal at three scales of unrelated logs`. Read statement counts stay equal at 1, 8 and 64. Rows and blocks are not classified.

### Published log page

- Touches: A repeatable-read transaction, one partition-epoch read, and one keyset on `published_log_account_page` `(route, account_id, published_at, log_id)`. Two `LIMIT` branches fetch `s + 1` rows, `s` at most 100. There is no second probe. The cursor is bound to the account. The page is public.
- Bound: `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1 for the page, plus the partition read and begin and commit.
- Growth check: `test/library/published-logs.test.ts`: `statements per publish, retract, read and page stay equal at three scales of unrelated logs`. The page uses limit 1 and keeps statement counts equal at 1, 8 and 64. Rows and blocks are not classified.

### Member listing effect

- Touches: `library_member_listing` handles `collection.member.changed`. It reads the Collection source in one statement, releases that connection, then runs one subject-partition command. The source reads the Collection primary key and, only when the Collection is active and public, counts that subject's member rows. Otherwise the multiplicity is 0. Apply writes or deletes one `subject_collection` pair and adjusts `subject_listing.public_collection_count` by the change in listed-ness. An unchanged multiplicity returns no row and rolls the command back, so no receipt is kept. The listing event subject is the subject id.
- Bound: The source is `S` 1. Its count examines `m` member rows of that subject in that one Collection, `m` at most 5000, so source `R` is `O(1+m)` and `B` is `O(L(N)+m)`. Apply is `S` 1, `R` `O(1)`, `B` `O(L(N))`, plus the listing-sync envelope. The effect does not scan unrelated Collections or the rest of the subject's other shelves.
- Growth check: `test/library/work.test.ts`: `member and listing statement costs depend only on this Collection at three unrelated scales`. The member effect's `library.` statements stay at 2, 2 and 2 for scales 1, 8 and 64. `test/library/listing.test.ts`: `sync statements stay equal at three scales of unrelated subjects and Collections` keeps one sync's statement count equal across those scales. Neither check grows one subject's multiplicity inside the Collection.

### Listing-change workflow

- Touches: `library_collection_listing` handles `collection.listing.changed` by enqueueing workflow `library.collectionListing`, keyed by the event id, with reuse of an existing run. Each step `library.syncCollectionPage` reads at most 100 distinct subject ids from `collection_member` through `collection_member_subject`, releases that connection, and syncs each subject with the member effect's source and apply. A full page of 100 continues from the last subject id. Duplicate members of one subject are allowed, so producing 100 distinct ids can examine more member rows than 100. That walk is capped by `M`, at most 5000, so a Collection takes at most 50 steps. 101 distinct subjects take two steps. A retry repeats the page against current source truth. Completed syncs that are unchanged roll back. DBOS persistence, index, block and statement bounds are not established by this wrapper.
- Bound: One step is one subject keyset plus two library statements per subject on the page. For a page of `d` distinct subjects, `d` at most 100, library `S` is `1 + 2d`, plus one listing-sync envelope per subject that changes. A row bound of `O(d)` for the keyset cannot be derived while duplicate subjects exist. The keyset examines at most `M` rows of this Collection. The enqueue itself is not library SQL.
- Growth check: `test/library/work.test.ts`: `member and listing statement costs depend only on this Collection at three unrelated scales`. One subject stays at 3, 3 and 3 library statements. Four subjects stay at 9, 9 and 9. Those are one keyset plus two statements per subject, at unrelated scales 1, 8 and 64. `test/library/work.test.ts`: `a Collection with 101 distinct subjects is synced in durable keyset steps of 100` shows two steps and does not classify rows or blocks.
