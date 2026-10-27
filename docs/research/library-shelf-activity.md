# Library shelf activity and embedded progress

## Status and method

This is research evidence and an adoption proposal, not the authoritative Library contract. No product code or acceptance tests were changed. The question is how to serve a private recently-active shelf, including progress for 48 cards, within one account partition and without reads proportional to reading history.

Research inspected three implementations: Jellyfin, Audiobookshelf and Komga. Only shallow source checkouts were read; no reference dependencies, applications, containers or tests were installed, built or executed. The snapshots below are default-branch source, not a claim about a particular released version. Official API and PostgreSQL documentation supplement the source.

The instruction to write only inside the assigned worktree conflicts with the requested external reference directory. To preserve that explicit write restriction, reference clones were placed in the ignored `.temp/library-shelf-activity-refs/{jellyfin,audiobookshelf,komga}/` inside the worktree. They are untrusted research data, not repository dependencies. No reference code was copied into this report.

| Implementation snapshot                                   | Inspected licence                              | Use in this report                                              |
| --------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| Jellyfin `02c2951eb72d7282ff9e1c7610489edb924898c3`       | [Root `LICENSE`, GNU GPL version 2][j-license] | Playback activity, user data batching and version selection     |
| Audiobookshelf `edb1f7efc92ecacdef51aafb4d9d5054ce10604f` | [Root `LICENSE`, GNU GPL version 3][a-license] | Continue shelves, audio/ebook progress and current-state writes |
| Komga `023ec905c10a35bbb8e29095420d266cd3adad60`          | [Root `LICENSE`, MIT][k-license]               | Book cards, per-user progress and transactional aggregates      |

Patterns may be followed freely. A pattern does not authorize copying implementation code. Repository policy permits code copying only from MIT, Apache-2.0 or BSD projects, with attribution and applicable notices. Jellyfin and Audiobookshelf are evidence only under that policy; Komga's MIT code would still require attribution if copied. PostgreSQL documentation is covered by the [PostgreSQL License](https://www.postgresql.org/about/licence/), a distinct licence; no PostgreSQL code is copied. The Audiobookshelf API site and Komga guide are cited as documentation, not treated as separately verified licences to reproduce their text. All descriptions here are original paraphrases.

## What REZICS already fixes

The maintainer fixes the following requirements; the references do not reopen them:

- `GET /v1/libraryEntries` orders by the later of the entry's change and that subject's progress change, and embeds the active progress session so 48 cards need one HTTP request.
- Personal entry and progress data stay private, in the owner's account partition. They are not subject-partition projections, public search material or public activity counts.
- `scalar_amount`, `cursor_position` and sparse `completed_units` remain distinct. A reread creates a new session ID. Multiple active sessions are legal.
- Research recommends a mechanism; adoption belongs in the owning Library document.

Local baseline: `b83e8ec43c3056755cc6593b35dafa2e52f2e7f0`. Relevant current evidence:

- [`packages/ui/README.md`, Shelves](../../packages/ui/README.md#shelves) already requires a cover grid, progress, last-activity ordering and status filters. The adjacent cover-card guidance hides unknown progress rather than drawing an empty bar.
- [`services/kernel/src/library/README.md`](../../services/kernel/src/library/README.md) defines owner-partition privacy and bounded reads. There were no `docs/library*` files at inspection; this module README is the existing Library document.
- [`entry-store-entry-page.sql`](../../services/kernel/src/library/entry-store-entry-page.sql) currently orders `updated_at DESC, subject_id ASC`, with separate older-time and equal-time keyset branches. [`entry-model.ts`](../../services/kernel/src/library/entry-model.ts) contains no shelf activity or embedded session field. [`entries.ts`](../../services/kernel/src/library/entries.ts) binds cursors to account and status, checks partition epoch, and uses a read-only repeatable-read transaction.
- [`schema.sql`](../../services/kernel/db/library/schema.sql) has entry indexes for all statuses and one status, both ordered by entry update time. The session index is `(route, account_id, subject_id, started_at DESC, session_id)`, not an active-session activity index.
- [`sessions.ts`](../../services/kernel/src/library/sessions.ts), [`progress-model.ts`](../../services/kernel/src/library/progress-model.ts) and [`progress-store-session-update.sql`](../../services/kernel/src/library/progress-store-session-update.sql) show session creation, revision-checked records and completion/abandonment. Sessions have start/completion times but no general last-change or abandonment time. Only `record` appends timestamped `progress_change` history; terminal changes do not. The session page orders by start time and has no active-only filter.
- [`personal-routes.ts`](../../services/kernel/src/library/personal-routes.ts) uses `personal_library` and `library_entry:list`; [`progress-routes.ts`](../../services/kernel/src/library/progress-routes.ts) uses `reading_progress` and separate progress scopes. Route admission in [`http/app.ts`](../../services/kernel/src/http/app.ts) checks route exposure; calling a progress store internally does not automatically admit its separate gate.
- [`apps/web/src/library/continue-read.ts`](../../apps/web/src/library/continue-read.ts) currently lists entries then requests sessions per subject and finds an active row in a limited session page. That can miss an older active session hidden behind newer terminal sessions. [`views.ts`](../../services/kernel/src/library/views.ts) separately controls readable subject summaries; one HTTP request does not imply all subject metadata lives in the account partition or takes one SQL statement.

## Observed implementations

### Jellyfin: resume list plus embedded per-user state

**Ordering and activity.** [`Jellyfin.Api/Controllers/ItemsController.cs`, `GetResumeItems`][j-items] constructs a resumable-items query ordered by `DatePlayed DESC`, accepts `startIndex`/`limit`, and returns item DTOs with configurable user-data inclusion. It excludes virtual items and applies the requesting user's library preferences. An optional switch excludes currently playing items; that is a playback-device concept, not a REZICS reading-session state.

[`Emby.Server.Implementations/Session/SessionManager.cs`][j-session] updates `LastPlayedDate` on playback start with a rewatch qualification, and on progress/stop when playback reaches completion or a resumable position. Failed stops do not update it. Thus media recency is driven by accepted playback activity rather than catalogue metadata edits. These thresholds and automatic completion are Jellyfin behavior, not requirements for REZICS.

**Selection and field shape.** [`MediaBrowser.Model/Dto/UserItemDataDto.cs`][j-dto] exposes `PlaybackPositionTicks`, `PlayedPercentage`, `PlayCount`, `Played`, `LastPlayedDate` and related user fields. [`Emby.Server.Implementations/Library/UserDataManager.cs`][j-user] resolves current per-user/item data keys and can overlay the most recently played eligible alternate version's resume data. [`MediaBrowser.Controller/Library/VersionPlaybackSelector.cs`][j-selector] selects by greatest last-played time, keeping the first encountered candidate on ties. This is evidence for an explicit winner rule, but it is not a history of rereads with distinct durable reading-session IDs.

**Batching, indexes and privacy.** `GetUserDataBatch` in `UserDataManager.cs` gathers missing item IDs and fetches their rows in one user-filtered query. The DTO endpoint delivers the page and user data together. [`src/Jellyfin.Database/Jellyfin.Database.Implementations/ModelConfiguration/UserDataConfiguration.cs`][j-index] defines a compound key including item, user and custom key, plus user/item/date and other predicate indexes. Those indexes support its own query shapes; they do not establish a bounded account-wide REZICS activity seek. [`Jellyfin.Api/Helpers/RequestHelpers.cs`, `GetUserId`][j-auth] defaults to the authenticated user and requires administrator status to request another user's data. REZICS should retain its own owner authorization rather than adopt that administrator exception.

**Disappearance and recreation.** [`Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs`][j-persistence] detaches user data to a placeholder when deleting items, preserves a retention date, and can reattach matching user-data keys when an item returns. Reconciliation chooses recent user state rather than blindly duplicating it. [`Emby.Server.Implementations/ScheduledTasks/Tasks/CleanupUserDataTask.cs`][j-cleanup] can purge detached rows older than 90 days when that task runs. This demonstrates that media membership and private progress have separate lifecycles; its metadata-key reconciliation and retention period are not REZICS requirements.

### Audiobookshelf: current progress separated from listening history

**Ordering and activity.** [`server/utils/queries/libraryFilters.js`, `getMediaItemsInProgress`][a-filters] builds Continue Listening/Reading shelves from unfinished progress, ordered by progress descending. [`server/utils/queries/libraryItemsBookFilters.js`][a-book-filters] maps that sort to `mediaProgresses.updatedAt`, joins progress for `user.id`, filters positive audio time or ebook progression, and honors `hideFromContinueListening` on home shelves. Book permissions are also applied. This is a current-state timestamp used as a sort key, separate from item creation/update ordering.

[`server/models/MediaProgress.js`][a-progress] stores `currentTime`, `duration`, `isFinished`, `ebookLocation`, `ebookProgress`, `finishedAt`, `hideFromContinueListening` and timestamps. Its legacy JSON exposes update/start times as epoch milliseconds. `applyProgressUpdate` saves changed state, supports resetting completion and clears the hidden flag when audio position changes. Local-sync payloads can explicitly restore `updatedAt`; consequently client/offline time can affect its order. REZICS already has authoritative command time and should not inherit that override.

**Sessions and batching limits.** [`server/models/User.js`][a-user] finds current progress for a media item and updates it, creating a row if absent. Rereading can reset that current state rather than creating REZICS-style session identities. Listening history is exposed separately by [`server/controllers/MeController.js`][a-me]. The implementation is not evidence that concurrent active reading sessions should be forbidden or that an arbitrary first session is a suitable winner.

[`server/controllers/LibraryController.js`, `getUserPersonalizedShelves`][a-library] returns multiple shelf groups in one request. However, its in-progress item JSON is not equivalent to a full session embedded in every card. `User.toOldJSONForBrowser` can deliver the user's entire progress array separately, and `getAllLibraryItemsInProgress` in `MeController.js` filters cached user progress, loads matching items, then sorts/slices in memory. That latter path explicitly leaves query-level sort/limit as future work. It skips missing items rather than manufacturing cards. These are useful API-shape comparisons, not bounded-read designs to copy.

**Maintenance.** `MediaProgress.js` defines an `updatedAt` index and a compound `(userId, mediaItemId, isFinished, currentTime)` index. Updates persist the current row and user-cache maintenance accompanies writes/removals. It demonstrates stored recency and current-state reuse, but does not prove a bounded query for an account shelf ordered by the maximum of entry and progress activity. The [official API reference](https://api.audiobookshelf.org/#get-a-library-39-s-personalized-view) documents personalized shelves; the pinned source above is the authority for the observed SQL and serialization behavior.

### Komga: card progress and maintained per-user aggregates

**Ordering and field shape.** [`komga-webui/src/views/DashboardView.vue`, `setupLoaders`][k-dashboard] requests Keep Reading books with in-progress status and `readProgress.readDate,desc`; Recently Read uses completed status with the same sort. Catalogue-created and release-date shelves are separate. [`komga/.../infrastructure/jooq/main/BookDtoDao.kt`][k-book-dao] maps both read-date and last-modified sorts and left-joins progress by book and user while assembling book DTOs. [`komga/.../interfaces/api/rest/dto/BookDto.kt`][k-dto] embeds nullable `readProgress` containing page, completed, read date, creation/modification times and device identifiers; book media supplies page count. No client request per card is required. The [official progress guide](https://komga.org/docs/guides/read-progress/) confirms user-separated progress and card indicators.

**Selection, rereads and writes.** [`komga/.../domain/model/ReadProgress.kt`][k-model] represents one current book/user progress. [`komga/.../infrastructure/jooq/main/ReadProgressDao.kt`][k-progress] upserts that pair, replacing page/completion/read date and setting modification time. [`komga/.../domain/service/BookLifecycle.kt`][k-lifecycle] records a page or completion and deletes progress when marking unread. Its progression import path rejects an incoming read date older than the saved one. There is no winner among multiple durable reread sessions in this model. [`komga/.../interfaces/api/rest/BookController.kt`][k-controller] uses the principal's user and content restrictions for progress commands; book queries likewise scope embedded state by the principal.

**Materialization and its limits.** `ReadProgressDao.kt` transactionally maintains `READ_PROGRESS_SERIES` on saves and deletes, including read/in-progress counts and maximum read date. Its current maintenance deletes/rebuilds affected aggregate rows from books/progress; that work can grow with the series and is unsuitable as a constant-row REZICS write recipe. [`komga/.../infrastructure/jooq/main/BookCommonDao.kt`, `getBooksOnDeckQuery`][k-common] consumes that summary to find the first unread book in a partly read series with no book in progress, ordering by series recency. On Deck is a different surface from Keep Reading.

`BookDtoDao.findAllOnDeck` uses page-size/offset and a count query. [`V20210914111439__read_progress_read_date.sql`][k-migration] establishes the book/user primary key and backfills read date from last modification. [`V20220715213721__perf_indices.sql`][k-index] adds an index on progress modification time; [`V20261002174155__missing_indices.sql`][k-user-index] adds user indexes. These are concrete indexing and backfill patterns, not evidence that offset/count or unbounded aggregate rebuilding meets REZICS's cost model.

## Shared patterns and database evidence

The implementations share four useful patterns: per-user current progress stored separately from catalogue metadata; a stored reading/playback timestamp; a single response or batch path for card state; and explicit maintenance of indexes, caches or derived summaries on progress writes. They differ on progress eligibility, completion thresholds, offline timestamps and rereads. None of these three sources supplies REZICS's exact maximum-of-entry-and-progress rule or its multiple-active-session contract.

PostgreSQL's official documentation supplies the relevant database constraints:

- [Multicolumn indexes](https://www.postgresql.org/docs/18/indexes-multicolumn.html): leading equality keys and then the range key determine a B-tree's useful scan bounds. Put route/account, and status for filtered pages, before shelf activity.
- [Indexes and ordering](https://www.postgresql.org/docs/18/indexes-ordering.html): an index matching order plus limit can fetch the leading rows without sorting the whole relation. Mixed ascending/descending order needs a matching index definition. An index on entry time alone cannot order a maximum involving another table's progress time.
- [Limit and offset](https://www.postgresql.org/docs/18/queries-limit.html): ordering must be unique for predictable pages; skipped offset rows still require computation. A stable subject-ID tiebreaker and keyset seek fit a growing shelf better than offset plus total count.
- [Date/time types](https://www.postgresql.org/docs/18/datatype-datetime.html): `timestamptz` has microsecond resolution. Passing a cursor key through JavaScript `Date` can discard precision present in the stored key.
- [Transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html): repeatable read supplies a consistent transaction snapshot. It does not preserve that snapshot across independent HTTP requests.

The bounded design below is an inference from those properties and the local data model, not a claim that any reference already implements it.

## Recommended bounded design for adoption

### Materialize activity; select one active session through an index

Use the existing entry as the shelf membership row. Add a materialized `activity_at`, leaving `updated_at` and the entry revision to mean entry changes. Add a general `last_changed_at` to progress sessions. Maintain a small account/subject progress-head row keyed by `(route, account_id, subject_id)` with the greatest accepted progress-change timestamp; keep that head independently of shelf membership. These are proposed storage names, not a new public contract.

Maintain the invariant `entry.activity_at = max(entry.updated_at, head.last_progress_changed_at)`, treating a missing progress time as absent. The head covers all sessions of the subject, including completed/abandoned sessions. The displayed session is chosen separately from active sessions only. Otherwise completing a session could erase its activity or make shelf order depend on which active session happens to be displayed.

Use three matching B-tree indexes:

- Entries: `(route, account_id, activity_at DESC, subject_id ASC)`.
- Entries with a status filter: `(route, account_id, state, activity_at DESC, subject_id ASC)`.
- Active sessions: `(route, account_id, subject_id, last_changed_at DESC, session_id ASC) WHERE state = 'active'`.

Read at most `pageSize + 1` entry candidates using the applicable index. Prefer separate filtered/unfiltered SQL shapes over an optional-status `OR` that might prevent the intended index bounds. For the displayed candidates, use a lateral top-one probe or an equivalent bounded batch of index probes into the active-session index. Do not group/rank every session, sort the whole account, or repeatedly page through session history. Recommend choosing the active session with greatest `last_changed_at`, ties by session ID ascending. That makes recently used older sessions resumable and gives deterministic ties without comparing revision numbers across sessions. A newly started zero-progress session is still active and eligible. Completion/abandonment removes it from the partial index, allowing the next active session to win.

The private data read stays in one owner partition: one bounded entry page and at most one active session result per displayed entry. For 48 cards, 49 entry candidates and at most 48 top-one session results suffice; no sparse-unit/history scan is needed. Derivable index work is approximately `O(log N + p + p log S)` for page size `p` and session relation size `S`, rather than proportional to all sessions for each subject. This describes logical query work with suitable plans, not a guaranteed count of physical blocks under MVCC. Owning implementation checks must verify plans and growth with many terminal sessions, many active sessions for one subject, unrelated accounts and sparse units. Subject-summary enrichment retains its existing access checks and separate bounded cost.

### Write maintenance and concurrency

Use the existing command transaction, authoritative timestamp, revision checks, receipts and account-scoped events. Maintain the session, progress head and existing shelf entry atomically; a new asynchronous projection would let a successful record leave a stale shelf.

| Accepted operation                                  | Progress/head maintenance                                                 | Shelf maintenance                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Start a session                                     | Initialize its change time; advance the subject head                      | Update activity if an entry exists                                               |
| Record scalar/cursor/unit intent                    | Change session time with its revision; advance head                       | Update activity, preserving entry revision and entry update time                 |
| Complete or abandon                                 | Record terminal change time; advance head; remove active-index membership | Update activity even if no active session remains                                |
| Create/recreate or change an entry                  | Read retained subject head                                                | Compute activity from entry time and head; retain normal entry revision behavior |
| Delete an entry                                     | Retain sessions and head                                                  | Delete membership; progress writes must not recreate it                          |
| Receipt replay, rejected CAS or rolled-back command | No new activity                                                           | No change                                                                        |

Proposed meaning of “progress change”: every newly committed start, record, complete or abandon command that the domain accepts as a session revision. Existing record commands can record a repeated value or a sparse-set operation whose net count does not change; count those accepted revisions as activity rather than adding different no-op rules for each mode. Fetches, subject metadata edits, copy/follow writes, view enrichment and publishing a log are not entry/session activity.

For subject-head maintenance use a maximum with the accepted command time so overlapping transactions cannot overwrite a later timestamp with an earlier one. Apply the same monotonic rule to existing session change time and entry update time before deriving activity; this handles an older transaction timestamp reaching the subject lock later. Establish one lock order across entry and session commands: ensure and lock the account/subject head before locking the affected session/entry, then update all derived rows. The head may initially have no progress timestamp. A retained head serializes deletion/recreation against progress without locking every session. Do not infer commit order from a transaction-start timestamp; if strict commit ordering is desired, that is a different contract.

Each progress write touches one session, one head and at most one existing entry, plus the already bounded unit/history writes. There is no “find next active session” scan on completion: the partial index handles selection at read time. Updating the activity indexes adds write cost and per-subject contention, but not work proportional to the account's session history. Rebuilds/backfills are maintenance work, not request-path reads.

### Embedded progress shape and presentation

Return an explicit nullable active-session object with each entry, in the same list response as its subject summary: `GET /v1/libraryEntries?limit=48&view=FULL` should suffice for the grid. Recommend a field such as `activeProgressSession`, carrying the existing private session DTO: `id`, `subjectId`, `versionSubjectId`, `mode`, `unit`, `state`, `revision`, `startedAt`, `completedAt`, `amount`, `total`, `locator`, `position`, `completedUnitCount`, and the adopted change-time field. Keep storage routing, transaction IDs and all history/unit rows out of the card DTO. Exact field naming is for the owning contract.

| Mode              | Card data and interpretation                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scalar_amount`   | Preserve `amount` and optional `total` as decimal strings. Display amount/unit; derive a fraction only with a usable positive total, or an explicitly defined percent unit. Null is unknown; zero is known zero.       |
| `cursor_position` | Preserve locator and decimal-string position as an opaque resume coordinate. Existing contracts have no total for this mode; do not invent a percentage from the position or locator.                                  |
| `completed_units` | Embed the maintained `completedUnitCount`. Do not enumerate the sparse set, imply a contiguous prefix, or infer a denominator from the largest completed unit. Unit membership remains a separately paged detail read. |

`null` means there is no active session in the authorized snapshot. Do not substitute a completed session or a synthetic zero-valued object. Preserve session identity and revision for subsequent commands. An older active session can be displayed after a newer session ends; the shelf's activity still reflects that terminal change. A reread never borrows a completed previous session's progress. Entry status filters remain entry-status filters, independent of active-session existence.

### Keyset precision and moving keys

Retain the local mixed order: `activity_at DESC, subject_id ASC`. Continuation means an older activity timestamp, or an equal timestamp with a greater subject ID. Use two bounded branches as in the existing entry SQL if needed to obtain index bounds. Do not use a simple tuple comparison that accidentally reverses the ascending ID part. Seal both keys with account, status filter, operation/version and existing partition-epoch binding; changing sort semantics must reject old cursors rather than reinterpret an entry-time cursor as an activity cursor.

Encode the exact database activity key before presentation conversion, for example canonical UTC text retaining all stored fractional digits. Do not round-trip the seek key through `Date`/`toISOString`. Current entry adapters do that conversion, so they are unsafe templates if stored activity has finer precision. Tied timestamps need the subject key even if newly written command timestamps currently have only millisecond precision.

One request should read entry activity and active-session selection in the same repeatable-read snapshot. Pages across requests are a live traversal: an unseen subject updated to a position before the cursor can be missed until refresh. A seen subject whose key moves backwards, or whose entry is deleted/recreated with an earlier effective key, can recur. Monotonic activity maintenance reduces backwards movement but does not give a historical snapshot. A first-page time ceiling alone cannot recover old positions after updates. Recommend documenting live traversal, restarting on refresh and client deduplication by subject ID; do not hold a transaction open across user pagination. A snapshot-stable export would require a separate versioned design.

### Authorization, gates and lifecycle edges

Require authenticated, live own-account authorization and exact account predicates, not route alone: multiple accounts can share a partition. Session joins must include route, account and the canonical stored subject. Keep private values out of public Collection summaries, subject listings, public caches and published logs. A private shelf response should use the project's private/non-shared cache policy.

Embedding is also a progress read. The current `personal_library` route gate does not transitively check `reading_progress`, and `library_entry:list` is distinct from `progress_session:list`. Merely omitting progress values when the progress gate/scope is absent can still reveal progress through the new activity timestamp and order. Recommend fail-closed admission for the activity shelf unless both gates and both list scopes authorize it, checked once per request using existing admission mechanisms. Do not silently return entry-only ordering: that contradicts the maintainer's fixed order. This admission change needs the manager's explicit adoption; references with simpler user credentials cannot decide REZICS's scope contract.

Missing membership is not missing progress. If a session exists without an entry, maintain the head/session but emit no shelf card. Deleting an entry removes its card and does not delete its sessions or retained progress activity. Recreating the same account/subject entry combines its new entry time with retained progress time and selects from retained active sessions. Never let a late progress update upsert the deleted entry back into existence. Use one head-lock discipline for both operations, not a request-time check followed by an unrelated write.

If a subject summary is deleted or inaccessible, retain the private membership and progress facts while returning the established unavailable/null subject summary; do not leak hidden metadata, silently erase progress, or scan further through arbitrary entries to fill 48 visible covers. A stale page cursor can continue from its sealed keys even when its former boundary entry has been deleted. Subject redirect/merge semantics should continue to follow the existing subject-anchor contract; this report does not create automatic progress merging across distinct subject IDs.

### Migration and limits of historical recovery

Backfill session change time from the greatest **known** timestamp: start, latest timestamped progress record and completion when present. Backfill heads by account/subject from those values, then entry activity from entry update and head. This may scan historical rows once in bounded migration batches; it must not become a page-time aggregate. Keep live dual maintenance and backfill coordinated through the same locking/maximum rules, or perform the backfill with writes quiesced. Install/validate the new indexes and switch readers only after the new invariants are ready.

Historic abandonment time cannot be reconstructed from the current session state, revision or transaction UUID. `sessions.ts` appends history only for record intents; abandoning clears completion time without storing an abandonment timestamp. A revision gap shows that another accepted operation occurred, not its time. Existing events/outbox data would be usable only if an independently verified retention and timestamp contract guarantees complete evidence; this report assumes no such guarantee. Do not stamp migration time as if every abandoned session was just used.

Recommend documented best-known historical recency, exact for new commands after rollout, with unknown old terminal timing explicitly acknowledged. The same limitation affects ranking surviving old active sessions whose last recorded time ties: the deterministic ID tiebreaker is reproducible, not proof of historical intent. Komga's migration from modification time illustrates reuse of evidence that exists; it cannot supply a timestamp REZICS never stored.

## Adoption questions and assumptions

The manager can adopt the indexed activity/head design without changing the fixed shelf requirement. It should decide these remaining semantics in the owning document before implementation:

1. Confirm most-recently-changed active session, ties by ascending session ID, rather than newest-started or a user-pinned session. Multiple active sessions remain legal under all choices; references do not settle that selection rule.
2. Confirm accepted record revisions count as activity even when their submitted value has no net effect. Recommendation: preserve existing command acceptance semantics and count them.
3. Decide the composite scope/gate policy. Recommendation: require both list scopes and both gates for this activity surface, including metadata/order. If entry-only credentials must remain useful, the manager must specify their capability boundary without leaking gated progress or violating the required ordering.
4. Accept best-known historical ordering where abandonment time is absent, and live rather than snapshot-stable pagination. Exact historical abandonment ordering would need evidence outside the current stores; changing a timestamp default cannot recover it.

Assumptions behind the recommendation: activity refers to accepted server-command time, not offline occurrence time or physical commit order; state-changing progress commands have no deletion/reopen API beyond the inspected operations; session subject identity remains fixed; subject summaries keep existing readability rules; and a response may contain an unavailable subject summary rather than scan without a bound. Future session deletion or subject reassignment would need explicit head-maintenance rules. These are proposed interpretations for adoption, not decisions already made by the sources.

## Pinned source paths

Each implementation citation above resolves to a source file at the inspected commit. Paths abbreviated with `komga/...` expand to the full path in their links. Official web documentation is versioned where available; implementation claims rely on the pinned source.

[j-license]: https://github.com/jellyfin/jellyfin/blob/02c2951eb72d7282ff9e1c7610489edb924898c3/LICENSE
[j-items]: https://github.com/jellyfin/jellyfin/blob/02c2951eb72d7282ff9e1c7610489edb924898c3/Jellyfin.Api/Controllers/ItemsController.cs
[j-session]: https://github.com/jellyfin/jellyfin/blob/02c2951eb72d7282ff9e1c7610489edb924898c3/Emby.Server.Implementations/Session/SessionManager.cs
[j-dto]: https://github.com/jellyfin/jellyfin/blob/02c2951eb72d7282ff9e1c7610489edb924898c3/MediaBrowser.Model/Dto/UserItemDataDto.cs
[j-user]: https://github.com/jellyfin/jellyfin/blob/02c2951eb72d7282ff9e1c7610489edb924898c3/Emby.Server.Implementations/Library/UserDataManager.cs
[j-selector]: https://github.com/jellyfin/jellyfin/blob/02c2951eb72d7282ff9e1c7610489edb924898c3/MediaBrowser.Controller/Library/VersionPlaybackSelector.cs
[j-index]: https://github.com/jellyfin/jellyfin/blob/02c2951eb72d7282ff9e1c7610489edb924898c3/src/Jellyfin.Database/Jellyfin.Database.Implementations/ModelConfiguration/UserDataConfiguration.cs
[j-auth]: https://github.com/jellyfin/jellyfin/blob/02c2951eb72d7282ff9e1c7610489edb924898c3/Jellyfin.Api/Helpers/RequestHelpers.cs
[j-persistence]: https://github.com/jellyfin/jellyfin/blob/02c2951eb72d7282ff9e1c7610489edb924898c3/Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs
[j-cleanup]: https://github.com/jellyfin/jellyfin/blob/02c2951eb72d7282ff9e1c7610489edb924898c3/Emby.Server.Implementations/ScheduledTasks/Tasks/CleanupUserDataTask.cs
[a-license]: https://github.com/advplyr/audiobookshelf/blob/edb1f7efc92ecacdef51aafb4d9d5054ce10604f/LICENSE
[a-filters]: https://github.com/advplyr/audiobookshelf/blob/edb1f7efc92ecacdef51aafb4d9d5054ce10604f/server/utils/queries/libraryFilters.js
[a-book-filters]: https://github.com/advplyr/audiobookshelf/blob/edb1f7efc92ecacdef51aafb4d9d5054ce10604f/server/utils/queries/libraryItemsBookFilters.js
[a-progress]: https://github.com/advplyr/audiobookshelf/blob/edb1f7efc92ecacdef51aafb4d9d5054ce10604f/server/models/MediaProgress.js
[a-user]: https://github.com/advplyr/audiobookshelf/blob/edb1f7efc92ecacdef51aafb4d9d5054ce10604f/server/models/User.js
[a-me]: https://github.com/advplyr/audiobookshelf/blob/edb1f7efc92ecacdef51aafb4d9d5054ce10604f/server/controllers/MeController.js
[a-library]: https://github.com/advplyr/audiobookshelf/blob/edb1f7efc92ecacdef51aafb4d9d5054ce10604f/server/controllers/LibraryController.js
[k-license]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/LICENSE
[k-dashboard]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga-webui/src/views/DashboardView.vue
[k-book-dao]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/main/kotlin/org/gotson/komga/infrastructure/jooq/main/BookDtoDao.kt
[k-dto]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/main/kotlin/org/gotson/komga/interfaces/api/rest/dto/BookDto.kt
[k-model]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/main/kotlin/org/gotson/komga/domain/model/ReadProgress.kt
[k-progress]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/main/kotlin/org/gotson/komga/infrastructure/jooq/main/ReadProgressDao.kt
[k-lifecycle]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/main/kotlin/org/gotson/komga/domain/service/BookLifecycle.kt
[k-controller]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/main/kotlin/org/gotson/komga/interfaces/api/rest/BookController.kt
[k-common]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/main/kotlin/org/gotson/komga/infrastructure/jooq/main/BookCommonDao.kt
[k-migration]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/flyway/resources/db/migration/sqlite/V20210914111439__read_progress_read_date.sql
[k-index]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/flyway/resources/db/migration/sqlite/V20220715213721__perf_indices.sql
[k-user-index]: https://github.com/gotson/komga/blob/023ec905c10a35bbb8e29095420d266cd3adad60/komga/src/flyway/resources/db/migration/sqlite/V20261002174155__missing_indices.sql
