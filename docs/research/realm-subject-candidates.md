# Realm subject conditions: proposed Content owner specification

Research evidence, 2026-10-29. Inspected `dev` and the assigned branch at
`ca7c319edefd8d8a272b8fb51c6d57eff5fa2383` (the same commit). This is proposed text for
Content to adopt, not a claim of runtime support. No production code is changed.
Repository citations below are paths and line numbers at that revision; proposed names
are explicitly marked. Search and Access remain the owners of their shared contracts.

Recommend maintained native support/count indexes, a public-only association projection,
and prepared results for Realm conditions. Use the existing privacy-reduction protocol
for invalidation, including foreign dependencies. Do not implement a four-thread sampler
as a complete predicate. The relevant shared requirements are
`docs/filtered-lists.md:28`, `docs/filtered-lists.md:103`, and `docs/filtered-lists.md:225`.

## Evidence and implementation gaps

| Inspected authority on dev | What it establishes |
| --- | --- |
| `services/kernel/src/content/README.md:135` | Subject-thread lists are candidates followed by current disclosure, not a complete membership index. Both kinds use the same path. |
| `services/kernel/src/content/subject-thread-index.ts:11`, `:94`, `:139` | The current effect handles thread/post/revision creation and groups writes by subject home. Its projected event names one representative subject, not every affected subject. |
| `services/kernel/db/content/schema.sql:1192`, `:1520`, `:1691` | `subject_thread` has subject route/home, PK `(route, subject_id, thread_id)` and page index `(route, subject_id, place_id, kind, last_activity_at DESC, thread_id)`. No reverse Realm-to-subject access path exists there. |
| `services/kernel/src/content/subject-thread-upsert.sql:12` | Unlink physically deletes a row. Comparing foreign source positions on surviving rows does not fence resurrection after deletion. Do not reuse this as the new counter protocol. |
| `services/kernel/src/content/subject-threads.ts:86`, `:150` | Existing lists open their own snapshots, split by kind, scan `4 × limit`, and hydrate candidates independently. Calling them for every subject breaks batching, connection, absence and useful-page requirements. |
| `services/kernel/src/content/reads.ts:175`, `:223`, `:302`, `:400` | Disclosure checks the opening head/revision, thread, board and current subject reference/place, and rechecks the board. Drafts are author-only; protected content can require explicit Access. Erased placeholders are not evidence that retained subject references may be indexed publicly. |
| `services/kernel/src/community/realm.ts:175`, `:212` | Realm resolution is an exact Realm key plus Access; protected Realm reads also enforce a current ban. Public is spelled `public` in Community, `published` in Content. |
| `services/kernel/db/content/schema.sql:583`, `:1557`, `:1719` | A Realm board has the Realm's route, indexed board enumeration and an immutable `realm_id`. There is no supported board-to-Realm move. |
| `services/kernel/src/content/commands.ts:876`, `:882`, `:922` | Revision cannot move a thread to another board. Only the opening revision changes the thread's subject-reference set; a review must retain its original one-subject target. Reply references alone do not add Realm subject membership. |
| `services/kernel/src/request/access.ts:105`, `:122`; `services/kernel/src/access/permission.ts:501`, `:635` | Request-scoped read preparation and supplied-client batch decisions exist. A decision batch accepts 200 IDs, not 201 or 256, and does not enumerate granted resources. |
| `services/kernel/src/access/permission.ts:553`; `services/kernel/src/access/membership-inverse.ts:15` | At most 1,000 group memberships per identity is a membership bound, not a bound on boards readable through those groups, direct grants or active-account grants. |
| `services/kernel/src/access/permission-candidates.sql:7`, `:22` | Preparation probes proposed resource keys. It is not a protected-board discovery directory. |
| `services/kernel/src/semantic/public-filter-source-contract.md:39`, `:121`; `services/kernel/src/search/README.md:83` | The shared producer, same-transaction reduction recording, behind/changed observation and refresh-visible ACK are required future native boundaries, not already-working implementations. |
| `services/kernel/src/search/document.ts:14`; `services/kernel/src/search/service.ts:307`, `:433` | Current subject documents have no Realm field; ordinary search requires a positive anchor and uses three refill rounds (currently capped at 200, below the contract's 201 ceiling). A Realm leaf/compiler and complete native preparation still need implementation. |

The eager batch Access preparation reads the complete membership inverse and role proofs
(`services/kernel/src/access/permission.ts:553`, `:585`); its 1,000-group ceiling alone
does not close small-page budgets. The minimum native integration must let existing
Access preparation retain bounded discovery progress and match current authority/dependency
keys for this Realm/read definition, then share those current checks with the page. Do
not run that eager preparation anew per candidate, round or continuation. If a bounded
current authority observation is unavailable, the shape remains unsupported; no cost
claim below exempts authorization or counts a 1,000-row inverse as one point.

The smallest changes are Content migrations/effects and ports described below; reuse
Access's preparation and add a bounded **resource discovery adapter**, not a new permission.
Search must wire the admitted leaf, prepared plans and shared safety boundary before
exposing it. Until that native capability exists, return `422 unsupported_query` before
enumeration; unavailable previously admitted preparation returns the owning readiness
outcome, not a fabricated empty result (`docs/filtered-lists.md:110`, `:120`).

## Primary-source comparison

Reference repositories were read only, never installed, built or executed. Paths below
are relative to the permitted main-checkout `.reference/`; the reference index records
reuse. REZICS source is AGPL-3.0-only (`package.json:5`). No external source is proposed
for copying.

- **Discourse**, commit `589325e2b8466178ee83acac9ec411de555a0093`, GPL-2.0-or-later:
  `partitioned-sitemap-feeds/discourse/lib/search.rb:1331` applies public-or-readable-secure
  category scope before ordering/paging (`:1345`); `lib/guardian/category_guardian.rb:56`
  supplies the readable set. [Pinned search source](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/lib/search.rb#L1331),
  [licence](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/LICENSE.txt).
  Adopt the placement of authorization before membership/order, not its unbounded category
  list or OFFSET. REZICS needs bounded preparation for that set.
- **PostgreSQL**, commit `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, PostgreSQL License:
  `library-shelf-maintenance/postgres/doc/src/sgml/mvcc.sgml:504`, `:520` explain why a
  repeatable-read snapshot cannot see a later reduction. [Pinned documentation source](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/doc/src/sgml/mvcc.sgml#L504),
  [official documentation](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-REPEATABLE-READ),
  [licence](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/COPYRIGHT).
  Keep the page snapshot, but perform final shared safety observation after releasing it,
  using the same page connection, so a concurrent commit cannot hide behind that snapshot.
- **OpenSearch official documentation source**, commit
  `9bf360dee6e0930aa0bd66ba91e992b9ee2828bf`, Apache-2.0:
  `search-rating-populations/documentation-website/_api-reference/document-apis/index-document.md:284`,
  `:306` distinguish searchable refresh from version acceptance. [Pinned source](https://github.com/opensearch-project/documentation-website/blob/9bf360dee6e0930aa0bd66ba91e992b9ee2828bf/_api-reference/document-apis/index-document.md#L284),
  [official version API](https://docs.opensearch.org/latest/api-reference/document-apis/index-document/),
  [official refresh API](https://docs.opensearch.org/latest/api-reference/index-apis/refresh/),
  [licence](https://github.com/opensearch-project/documentation-website/blob/9bf360dee6e0930aa0bd66ba91e992b9ee2828bf/LICENSE).
  Require source-version fencing and refresh-visible repair before ACK; a successful
  index write alone establishes neither query safety nor current permission.

These sources share the separation of candidate storage, authorized query population and
searchable observation. None supplies REZICS's cross-home privacy protocol or its numeric
budgets. Those remain repository requirements, not conclusions borrowed from competitors.

## Proposed README section (verbatim adoption text begins)

## Subjects discussed in a Realm

A subject filter `{ realm: { id } }` means that at least one discussion or review thread
on a board in that Realm names an eligible original of the canonical subject in its
**current opening-post revision**, and the viewer may currently read that supporting
thread and its reference. It grants no subject, Realm, board or thread permission. Reply
mentions alone do not qualify. Current original **and** terminal subject eligibility are
required; a hidden original cannot lend its reference to a visible survivor. This follows
the existing reference check and canonical-list rules
(`services/kernel/src/content/reads.ts:400`; `services/kernel/src/content/commands.ts:922`;
`docs/filtered-lists.md:128`).

Resolve the leaf once per read: routed identity, current Realm visibility/`realm:read`,
and the actor's and, when applicable, delegating principal's ban state. This is fixed
work, independent of board/thread count. Unknown and denied Realms are concealed by the
existing target-resolution behavior. A ban does not remove the public anonymous floor;
it denies protected Realm/board access as current Content rules require
(`services/kernel/src/community/realm.ts:212`; `services/kernel/src/content/reads.ts:257`;
`services/kernel/src/content/README.md:21`). Suspended valid bearers remain denied
(`docs/filtered-lists.md:85`). Use current native authorization on every continuation.

### Native storage and listability

The following tables are **proposed**, owned by Content. `home(x)` means
`partitionOf(routeOf(x))`, one of 4,096 homes, each containing 16 routes
(`services/kernel/src/route/route.ts:3`, `:28`). All keys include their owning route.
No cross-partition join or write is introduced (`docs/architecture.md:25`).

| Proposed table | Partition, primary key and access paths | Meaning |
| --- | --- | --- |
| `content.realm_subject_support` | Original subject home; PK `(route, original_subject_id, thread_id)`; reverse indexes `(route, original_subject_id, realm_id, board_id, thread_id)` and `(route, terminal_subject_id, realm_id, board_id, original_subject_id, thread_id)` | Internal source/reference and dependency locator, including ineligible inputs; opening revision ID, thread kind, place/board, original/terminal mapping, component revisions, active/listable contribution and home apply position. Not public evidence by itself. |
| `content.terminal_realm_support` | Terminal subject home; PK `(route, subject_id, realm_id, board_id, thread_id, original_subject_id)` | Absolute per-original support mirror with original-home version; deduplicates repeated original delivery before changing distinct-thread multiplicity. Native-only. |
| `content.subject_board_thread` | Terminal subject home; PK `(route, subject_id, realm_id, board_id, thread_id)` | Number of eligible originals supporting this distinct thread. Only zero/nonzero transitions change the board count; never scan a canonical group. Native-only. |
| `content.subject_board_listed` | Terminal subject home; PK `(route, subject_id, realm_id, board_id)`; count-positive range `(route, realm_id, board_id, subject_id)` | Number of distinct eligible supporting threads with publicly readable thread/opening content **within this board**. A protected board may have such threads; its row remains native-only. Aggregate across both kinds; no per-kind calls. |
| `content.subject_realm_listed` | Terminal subject home; PK `(route, subject_id, realm_id)` | Public listed support count across public boards; absolute count plus home apply version. Only positive, safe associations are exported. |
| `content.realm_board_subject` | Board/Realm home; PK `(route, realm_id, board_id, subject_id)`; positive index in that order | Absolute native mirror of `subject_board_listed`, with its subject-home version, for enumeration inside an authorized board. Includes protected-board associations only in PostgreSQL. |
| `content.realm_subject_listed` | Realm home; PK `(route, realm_id, subject_id)`; positive index in that order | Public-only mirror of `subject_realm_listed`, one row per distinct public Realm subject, so no query-time `DISTINCT` over thread or board history. |

A public contribution requires all of: current Realm visibility `public`; board visibility
`published`, in that Realm and available; thread visibility `published` and availability
`available`; opening post and its current revision available and publicly readable;
current opening reference contains the eligible original; original and terminal are
publicly eligible. Takedown, protection, draft, erasure, board removal or Realm hiding
removes public support. Erasing the opening post removes its association even if a thread
placeholder remains readable: retained erased references cannot supply public evidence.
This is a stricter **association disclosure** rule than merely reading a thread skeleton
(`services/kernel/src/content/README.md:155`, `:214`;
`services/kernel/src/content/reads.ts:223`, `:400`, `:429`).

The within-board count omits the requirement that the board/Realm itself be public; its
consumer must establish current board/Realm read authority. It does not count arbitrary
protected/draft threads as public-floor threads. Such viewer-specific support, including
author-readable drafts where current native disclosure permits their reference, goes
through native per-viewer preparation. Ineligible/taken-down/erased references never
become public merely because an editor can inspect them
(`services/kernel/src/content/reads.ts:223`, `:278`, `:429`;
`services/kernel/src/semantic/public-filter-source-contract.md:82`).

For OpenSearch, use **normalized public association documents**, keyed by
`(realmId, canonicalSubjectId)`, carrying scalar `realmId`, subject ID and the subject-home
version. Use the existing Search engine/index lifecycle, not a new service or engine.
This avoids an unbounded Realm-ID array on a subject document; neither protected Realm
IDs nor protected board IDs, references, counts or dependency locators enter this public
projection. A zero-support association is deleted with durable version fencing. The
native positive-key index remains the complete public enumeration source. Existing
subject documents do not implement this projection (`services/kernel/src/search/document.ts:14`).

### Transitions, replay and dependency repair

For one source thread revision, maintain at most 128 current opening references and at
most 256 old/new reference identities; bounded work is per reference, not per thread's
history (`services/kernel/src/content/commands.ts:308`, `:922`). A thread event schedules
bounded home-local chunks; it does not synchronously visit every foreign home. The
following table names existing authoritative commits and required new maintenance.

| Change | Authoritative commit on dev | Required projection work and Search input |
| --- | --- | --- |
| Create discussion/review | Thread target home; discussion target is idempotency-routed, review is author-routed; `services/kernel/src/content/commands.ts:187`, `:592`, `:675` | From `com.rezics.content.thread.created.v1`, reconcile opening references and state; constant per reference. Draft creation creates only internal locators. |
| Revision link/unlink | Same thread/post home; head update and event in `services/kernel/src/content/commands.ts:866`, `:905`, `:925` | `com.rezics.content.revision.created.v1` reconciles old/new opening references. Unlink records reduction in this transaction, before relay; replies only update activity, not membership. |
| Takedown/lift | Target home; `services/kernel/src/content/erase-post.ts:225`, `:296`; lift uses caller's target transaction, `services/kernel/src/content/lift-takedown.ts:12` | Consume `com.rezics.content.moderation.takedown.v1`/`restored.v1`; thread or opening-post changes reconcile bounded references. Board takedown starts paged board drain. Lift does not revive erased content or the review uniqueness slot (`services/kernel/src/content/lift-takedown.sql:2`). |
| Erase opening post/thread | Existing post erase at post/thread home, `services/kernel/src/content/erase-post.ts:260`, `:296`; SQL tombstones post, not thread, `services/kernel/src/content/erase-content.sql:7` | `com.rezics.content.post.erased.v1` resolves its containing thread, retires opening support and records same-transaction reduction. Reply erasure does not remove unrelated opening support. No general thread-erasure command exists here; any future one must use its thread home and the same protocol. |
| Draft → published; thread protection | Creation only accepts published/draft; revision does not change visibility (`services/kernel/src/content/commands.ts:682`, `:905`) | No general publish/protect command/event exists on this base. Smallest addition: authorized state mutation, security revision and typed changed event in thread home; reconcile opening support, and record reduction for protection. Do not pretend revision-created already covers it. |
| Board create/publish/protect/remove | Create is board home, `services/kernel/src/content/board-create.ts:254`; removal/takedown SQL is board route, `services/kernel/src/content/takedown.sql:6` | Creation emits `com.rezics.content.board.created.v1`; general publish/protect commands are missing. New state changes must commit there and page the board's thread-reference repair locators; reduction recorded immediately for remove/protect. No all-thread transaction. |
| Realm public ↔ protected | Realm home, current head and immutable revision; `services/kernel/src/community/realm.ts:404`, `:435`, `:447`, `:466` | `com.rezics.community.realm.updated.v1` requires current-state reconciliation, not inference from payload (payload contains only IDs). Hiding records reduction in that transaction; page boards then their dependent support. Publicizing adds support only after complete repair. |
| Realm ban/unban; Access loss | Realm ban commits Realm home, `services/kernel/src/community/ban.ts:85`, `:110`, `:133`; resource grants/denials commit their authority home (`services/kernel/src/access/README.md:915`) | Register scoped reduction on ban/read-grant loss; invalidate affected private preparations through native dependency routing. Public support remains where anonymous disclosure remains. Unban/regrant is restoration, not permission inherited from an old result. |
| Board/thread move | Board `realm_id` is immutable (`services/kernel/db/content/schema.sql:1719`); revision rejects board changes (`services/kernel/src/content/commands.ts:876`) | No move is currently legal. If an owning command is added, record old-place reduction at source authority; drain old-board supports, add new-board supports, repair both public/native mirrors and preparations. Cross-route board relocation needs existing routed-resource migration/replacement semantics, not an UPDATE bypassing the trigger. Do not add a move endpoint for this feature. |
| Subject merge/repoint/unmerge | Merge commits redirected-original home, `services/kernel/src/semantic/merges.ts:66`, `:150`; foreign move steps use their own homes, `services/kernel/src/semantic/merge-moves.ts:310` | Consume `com.rezics.subject.merged.v1` plus shared identity publication/reversal work; page original support by indexed key, rekey terminal-home counts and Realm mirrors while identity epoch is pending. Participate in complete publication, not reaction-only merge handling. |

After `A → Z`, a thread whose opening reference still says A supports canonical Z **via
original A**, only while A and Z are eligible. It does not gain a rewritten stored
reference to Z, and A is not another result card. A thread explicitly naming Z supports
Z via Z. If it names both, count a distinct thread once for existence and deduplicate
canonical result rows. Keep original provenance so hiding A removes only A's support;
Z's independent support survives. Unmerge reconstructs original-derived membership
from that provenance, without rewriting immutable revisions. Existing review targets
stay original IDs. Current exact-ID `readSubjectThread` does not implement alias-aware
reference checks; add canonical-aware reference validation for this new port, not a loop
over aliases (`services/kernel/src/content/reads.ts:405`;
`services/kernel/src/content/commands.ts:882`; `docs/filtered-lists.md:128`, `:140`).

Apply a contribution as **old stored state → new reconciled state** in a serialized
subject-home command. Store component versions separately for thread/reference, board,
Realm and identity; compare a source position only with the same component's source.
Never lexicographically compare unrelated foreign logs. A stale component update is a
no-op. At terminal home, apply each absolute original contribution to `terminal_realm_support`
using its original-home version. Atomically update `subject_board_thread` multiplicity
only when that original contribution changes eligibility. Its zero/nonzero transitions
alone change board counts, so multiple originals never double-count a thread. The
original-home and terminal-home transactions are separate durable phases, each with
its own committed frontier and anchored output version; neither joins foreign rows.

The subject-home command atomically changes support/count state and emits the proposed
`com.rezics.content.realm-subject.projected.v1` **for every changed subject** with subject,
Realm and its home position. Use the existing command envelope position/ownership epoch
as the source version, not a new clock. The event's foreign cause position is provenance
only. Search consumes absolute membership at this subject-home version; Realm mirrors
also accept absolute values per subject/board key, never unguarded increments. A delayed
foreign update cannot overwrite a newer home observation. Projection commands must CAS
the home state observed before foreign reads; losing CAS schedules fresh reconciliation,
not publication of a mixed snapshot. Existing command/event positions and envelopes are
native (`services/kernel/src/content/subject-thread-index.ts:139`;
`services/kernel/src/events/log.ts:107`).

Retain removal tombstones/component fences until all dependent consumers and repair
registrations are past the removal, including rebuild/late-event custody; only then may
bounded reclaim advance a source replay floor and delete them. Replays below that floor
must rebuild from current native authority, never recreate a removed row. Preserve the
home's monotonic version through ownership changes and sink deletion/recreation. Search
uses its existing coordinated source/sink version fencing; an expired OpenSearch delete
version must not resurrect support (`docs/filtered-lists.md:58`).

### Currentness and query privacy

Every actual reduction above appends a bounded cause and affected Realm-leaf dependency
key to the **existing required 4,096-home privacy-reduction heads/log** in the
**authoritative reducing command transaction**. This includes original/terminal subject
loss, opening unlink/erasure, thread/board protection or removal, Realm hiding and bans.
A broad board/Realm cause is one indexed repair locator, not all its subjects copied
into the reducing transaction. No new per-Realm marker, safety clock or certificate
store is introduced. This is integration with the future shared producer, whose native
implementation is still missing (`services/kernel/src/semantic/public-filter-source-contract.md:121`).

Register reverse dependencies for both selected eligible and ineligible support, keyed
by actual authority home/resource and the affected source leaf (`realm:<id>`), including
negative branches and order dependencies. A Realm/board change is local to its own home
but may invalidate subjects on every home. ACK its contiguous prefix only when all local
and dependent foreign native/public repairs are actually refresh-visible at the physical
Search target/incarnation and consumer generation. Neither ordinary relay checkpoints,
source position, complete prepared generation nor successful bulk indexing acknowledges
privacy (`docs/filtered-lists.md:43`, `:58`; `docs/dynamic-collections.md:158`).

Search performs the shared page start observation and final revalidation with indexed
behind/changed coverage of all homes, including excluded subjects. A reduction during
execution must be detected even if repaired and ACKed before final observation. The
final observation must be fresh, outside the page's old repeatable-read snapshot; release
that snapshot before final observation on the same connection. No all-home vector scan,
per-board/thread privacy read or positive-hit recheck substitutes for this gate
(`docs/filtered-lists.md:65`, `:312`; PostgreSQL source cited above).

A public Realm field is usable only with complete identified coverage and clean,
unchanged relevant page safety. “Exact” means exact for the admitted indexed observation
and no unapplied decrease, not zero-lag ordinary additions: ordinary freshness remains
60 seconds healthy/5 minutes readiness (`docs/filtered-lists.md:89`). If stricter native
currentness is needed, select the native prepared observation. Missing coverage, pending
identity, pending reductions or changed safety makes the leaf `unresolved` and the page
prepare. A complete native plan may replace an unsafe public plan **only if its own
complete population and same request safety are established**. Rechecking positives
cannot repair stale NOT, exclusions or order; never turn unknown into false
(`docs/filtered-lists.md:15`, `:35`, `:70`).

### Native candidates, readable boards and finite progress

For public associations enumerate `realm_subject_listed` by exact `(route, realmId)`
and `subject_id > after`, `ORDER BY subject_id LIMIT k+1`. It contains one canonical key
per subject, so no runtime thread scan, OFFSET, duplicate collapse or foreign join is
required. For an authorized board enumerate `realm_board_subject` by exact
`(route, realmId, boardId)`, then the same subject keyset. Neither range includes an
unreadable board's subject rows. Other ordering is produced by a prepared ordered result,
not by sorting an unbounded native range (`docs/filtered-lists.md:110`, `:128`).

Access preparation currently **cannot return the viewer's readable protected boards**.
It yields opaque membership/decision evidence for supplied IDs, not a complete resource
inverse. Board population is finite on finite input but has no constant cap (one review
board per Realm does not bound discussion boards). The smallest adapter pages Content's
Realm board-key index and feeds bounded metadata keys to existing prepared Access
batch decisions; only boards passing current Realm, ban and board authority contribute
subject ranges. No thread or subject association from a denied board is scanned.
This discovery is background preparation, never part of fixed leaf resolution
(`services/kernel/src/content/board-realm-page.sql:1`;
`services/kernel/db/content/schema.sql:1550`;
`services/kernel/src/access/permission.ts:635`).

Cap a discovery step at **32 board keys**, lower if its measured Access work needs it;
this is a work cap, not a product cap on readable boards. More boards retain a frontier
and return `unresolved` until preparation finishes. Preparation retains the authorized
board-key workset and sorted subject streams internally; it is never reusable permission.
For protected/draft thread exceptions, traverse only authorized boards, retain a
thread/reference frontier, check current native disclosure, and settle canonical result
membership. Permission changes invalidate relevant work through the same dependency
protocol. A viewer's result counts toward the existing **32 live prepared owner results**,
expires after **24 idle hours**, and is reauthorized on every read
(`docs/filtered-lists.md:115`, `:333`).

A positive within-board count proves existence after current board/Realm authority and
complete privacy dependencies pass; it avoids revisiting an ineligible thread prefix.
A zero count proves absence only of public-floor threads in that board, not absence of
viewer-readable protected/draft support. The latter requires completed per-viewer native
preparation. Preparations advance over every examined candidate, retain settled work,
and on finite ready input finish; the fifth eligible thread is eventually discovered
after four ineligible ones. Never replay the same four unresolved candidates forever.
A changed source repairs indexed affected work; it does not restart unrelated settled
ranges (`docs/filtered-lists.md:120`, `:333`).

### Batch disclosure port

Proposed server-only signature; `Queryable` is a supplied client's `query` subset, never
a Pool. The final reviewed cross-home contract supersedes the earlier single-home,
256-ID draft. One logical round has at most **201 unique canonical subject IDs total**,
not 201 per backend. Dispatch once per touched backend, not once per home.

```ts
type Queryable = Pick<import('pg').PoolClient, 'query'>;
type RealmSubjectVerdict = 'listed' | 'none' | 'unresolved';
type RealmSubjectKey = Readonly<{ route: number; subjectId: string }>;
// ResolvedRealmRead and RealmSubjectReadBasis are opaque, request-scoped owner types.
// They bind current Realm/Access preparation, complete source/prepared observation,
// identity epoch, and the page's shared privacy observation. They are not grants.
declare function discloseRealmSubjectsOnBackend(
  client: Queryable,
  context: import('./model.ts').ReadContext,
  input: Readonly<{
    realmId: string;
    realm: ResolvedRealmRead;
    basis: RealmSubjectReadBasis;
    subjects: readonly RealmSubjectKey[];
  }>,
): Promise<ReadonlyMap<string, RealmSubjectVerdict>>;
```

Return one entry per requested ID. `listed` requires at least one current disclosed
support; `none` means complete native absence over **all** this viewer's eligible
support, both kinds, with current original/terminal identity. A missing, denied or
truncated candidate window is `unresolved`, not `none`. Essential unknown remains
unknown under NOT (`docs/filtered-lists.md:15`, `:124`).

The ready batch probes exact `(route, subject_id, realm_id)` public counts, or exact
prepared native membership for the viewer/definition/generation. It never invokes
`listSubjectThreads`. Final per-subject revalidation means that the current Realm and
ban resolution, board authority, thread/opening availability/security, current opening
revision's original reference and terminal mapping all belong to the completed native
observation **and its complete current reduction dependencies**. Those dependencies
are checked by the page gate, not N per-board/per-thread reads at query time. A count
with missing dependency registration cannot validate a candidate. Native readiness must cover additions as well
as reductions for an exact `none`; a public-index miss alone is insufficient. For viewer-specific
exceptions, native preparation actually runs the equivalent thread/opening/revision and
board checks from `services/kernel/src/content/reads.ts:302`, `:400`, `:463` before settling
membership; a bare prepared Boolean is never authority. The owning prepared store needs
a native membership row kind on subject home, keyed
`(route, subject_id, definition, generation, principal)`, and a result-order index on its
existing preparation owner. This is an adapter to the shared prepared-result machinery,
not a per-subject permission cache. Both copies and their erasure are charged below.

At most four thread candidates per subject total, across both kinds, may be inspected
by any bounded disclosure work window; zero are needed by a ready counter/result probe.
Full current `readSubjectThread` cannot be costed as two points per thread: it checks
board, thread and opening post, plus revision/reference dependencies and subjects.
Conservatively reserve **6 points per inspected thread**: board 1, thread 1,
opening/head-reference bundle 1, original and terminal 2, source/dependency 1; Realm/ban
and shared safety remain fixed page work. Thus a synchronous candidate can afford at
most **one** such thread, leaving 2 of its 8 points for other mandatory checks, not
four threads × 6. If other leaves consume that reservation, inspect zero and prepare.
Preparation may use four windows only when each inspected thread is charged as its own
input candidate; it does not get 24 points for one subject. This is an admission
reservation to prove with native captures, not a claim that today's many-query reader
fits it (`docs/filtered-lists.md:259`, `:319`).

For the recommended ready path, current subject eligibility is shared with the page's
existing disclosure batch; Content adds one native membership key point, not a second
subject/board/thread hydration. All leaves together must fit `8c`; at most 16 examined
rows per candidate and six blocks per budgeted row. A missing ready native observation
returns preparation rather than attempting an over-budget synchronous fallback.

One PostgreSQL statement can probe multiple homes **on one backend**: tables have
route-leading keys, the storage client is an ordinary PostgreSQL query client, and
Access already derives a route for each target in one statement
(`services/kernel/src/access/permission-check.sql:20`;
`services/kernel/src/database/pool.ts:31`; `docs/architecture.md:27`). Use paired
`(route, subject_id)` input keys and lateral exact-key probes; no cross-home join, global
`DISTINCT` or per-home wrapper loop. Verify ownership for the named partitions in the
page's shared batched partition read; moved/missing ownership is unavailable, never zero.
The current `readPartition` helper is scalar: a multi-key partition read and page-owned
backend routing/connection adapter still need wiring
(`services/kernel/src/partition/partition.ts:15`).

Use one membership statement per touched backend per round on that backend's **existing
page connection and repeatable-read transaction**. Across up to three rounds that is
at most three Content membership statements per backend, **inside** the page's 12
(one read) or `8+4R` (composed) statement ceiling. No connections are opened here.
Share statements across reads and row kinds where the existing architecture permits;
all remaining Access, partition, summaries, control, transaction and safety work must
fit the same ledger. If native integration cannot close that ledger, admit only the
prepared ready path or reject the shape, never add statements. For an initial ready plan, deliberately use one refill window of at most
`2s+1` candidates (≤201), below the ready-result ceiling. A concrete one-read/backend
statement allocation is: privacy start/final 2; BEGIN/settings/COMMIT 3; current
Realm/ban/Access resolution 1; shared control/identity 1; batched partition ownership 1;
ready ordered range 1; shared subject disclosure 1; Content membership 1; summaries 1:
**12 total**. These are operation reservations: if an adapter needs another statement
(for example an independent Access anchor), it must fuse/share an existing same-kind
read where lawful or prepare/reject that plan; it cannot exclude it from accounting.
A reduction final observation runs after COMMIT, with no extra connection. Growing
round count is not a reason to exceed 12; the prepared initial slice need not implement
an unbudgeted three-round fallback. The present Access
batch limit of 200 cannot silently split 201 into per-home calls; keep the existing
200 refill clamp, or extend the same native batch validator to the 201 contractual
ceiling with evidence. The port accepts 201 for a counter-only batch without calling
that Access validator (`services/kernel/src/search/service.ts:433`;
`services/kernel/src/access/permission.ts:642`; `docs/filtered-lists.md:272`, `:294`).

### Composition and admission

A Realm leaf is **never** the positive anchor of a direct plan. The smallest complete
implementation prepares the whole Realm-containing query, including its order; a future
independently anchored direct plan is admitted only with measured useful-page work.
The same request reads a ready native result and performs current authorization/safety;
background preparation does not authorize a later request. This follows
`docs/filtered-lists.md:103` and avoids promising useful pages from sparse catalogue
post-filtering.

| Realm/viewer state | Positive condition | NOT/exclusion | Ordering and pagination |
| --- | --- | --- | --- |
| Public, only anonymous-floor associations applicable | Prepare public result from public listed stream/association projection; no protected inputs | Prepare against complete admitted catalogue population; subtract only complete safe membership | Prepare the complete filtered order; read ready canonical keyset, `≤2s+2` candidates and `≤2` index reads |
| Protected and readable | Native per-viewer prepared result, current Realm/ban and board authority | Native complete absence required; unresolved remains unknown | Same ready bound, one per-viewer result within the 32-result principal quota |
| Public with viewer-readable protected boards or thread exceptions | Union public stream and complete authorized native streams in per-viewer preparation; never silently omit protected support | NOT applies to the complete union, never to public membership alone | Deduplicate before ordered preparation and keyset; same ready bound and current safety gate |
| Denied/unknown or missing capability | Conceal denied target; missing plan is `422 unsupported_query` | Neither case establishes a negative membership fact | No cursor carrying private candidates; readiness only for an admitted progressing preparation |

An independently selective positive anchor may use a ready native membership batch for
at most three rounds, each `≤2 × remaining slots + 1` (≤201), and total
`c≤min(600,6s+3)`. If it cannot fill or prove exhaustion, prepare the **whole** query;
never emit an empty/short success over sparse matches. Realm-only positive queries,
Realm-only NOT, arbitrary order without a direct bound, and unions without a complete
native population require preparation. Until that capability is wired they return
`422 unsupported_query`. Ready results use `c≤2s+2`, current safety and current subject
checks; cursors bind viewer, meaning, order, generation and published identity epoch.
No private count or unsafe engine total/facet is emitted
(`docs/filtered-lists.md:81`, `:128`, `:259`, `:288`).

### Support and listed-count projection cost

- Touches: one source thread/opening-reference change, old/new support keys, distinct-thread support reconciliation, board/Realm public counts and indexed dependency locators; subject-home commands and existing outbox. No command reads all boards or all threads.
- Bound: O(k) keys for k≤256 old/new references; O(k log N) blocks and constant work per reference. Each durable home-local chunk admits at most 32 support keys, ≤1,000 input/result keys, ≤8 points per input, ≤16 statements/backend and one frontier write under [Filtered lists](../../../../docs/filtered-lists.md#budgets). Count deduplication uses the terminal-home per-original mirror and distinct-thread multiplicity row, with O(1) exact-key updates per original and no scan of up to 4,096 aliases. No unchanged-history fold.
- Growth check: native captures at 64/512/4,096 threads, references, aliases and unrelated revisions; duplicate originals naming one thread, unlink/delete/replay, source reordering, concurrent first apply and interrupted home handoff. Assert both row/statement ceilings and correct counts, including only the last eligible original.

### Public association export and native mirror cost

- Touches: changed subject/Realm and subject/board absolute counts, keyed Realm-home mirrors, one public association document per positive subject/Realm, existing Search generation/outbox/effect infrastructure.
- Bound: O(1) rows per changed association and O(log N) blocks; no all-Realm array in a subject document. Public association storage O(U), board counts/mirrors O(V), support and its terminal mirror/distinct-thread rows O(E), where U is distinct public Realm/subject pairs, V distinct board/subject pairs, E current original/thread references plus bounded retained removal debt. A source event's many homes are paged background writes, not one request's fan-out. Same step ceilings as above; refresh-visible dependent completion precedes ACK.
- Growth check: grow Realms per subject, subjects per Realm and boards per subject at 64/512/4,096; capture first/deep public keysets, stale delete versions, physical index recreation, missing foreign registration and delayed mirror repair. No protected IDs appear in any indexed payload.

### Board, Realm and identity repair cost

- Touches: indexed board-thread/reference locators, Realm board keys, canonical original support ranges, changed dependent counts/mirrors and affected prepared definitions only.
- Bound: a board with T threads and E_B references costs O(T+E_B) total repair; a Realm with B boards costs O(B+Σ(T+E_B)); a merge costs O(E_group+changed association keys), with group admission ≤4,096 originals. No reducing command fans out: one reduction cause plus existing event, then steps of ≤32 input keys (or lower measured Access cap), ≤16 statements/backend, one connection/backend and one retained frontier. O(log N) indexed blocks per key; replay rereads at most one step. Concurrent registrations must be caught by the shared registration barrier before ACK.
- Growth check: vary B, T, E_B and canonical groups independently at 64/512/4,096, pause before each dependent foreign repair and refresh, then reverse protection/move/merge. NOT, excluded and ordered pages remain preparing until safe; quiescent finite input finishes and sparse useful-page delivery resumes.

### Readable-board discovery and viewer preparation cost

- Touches: Realm board metadata keys, Access's current preparation/decisions, only authorized board-subject ranges, eligible thread exceptions, canonical identities and existing private prepared results/dependencies.
- Bound: ≤32 board metadata keys/step, with actual points and grant/group probes determining a smaller admitted chunk when necessary. Thread checks reserve 6 points/input and share no extra allowance; all work including rejects fits [Filtered lists](../../../../docs/filtered-lists.md#budgets). Total work is linear in relevant finite board metadata and authorized support, plus admitted catalogue input for complements/order; no denied-board subject/thread scan. One current and one building public generation; private results consume the principal's 32 live slots and expire after 24 idle hours. Retained work prevents rewalking an ineligible prefix.
- Growth check: first/deep/sparse pages with s+1 Realm subjects behind 64/512/4,096 catalogue nonmatches; many denied boards, readable protected boards beyond the step cap, and fifth/later eligible threads. Interrupt and resume; prove bounded per-step work and a filled or genuinely exhausted eventual page, not permanent preparation.

### Realm resolution, batch disclosure and ready page cost

- Touches: fixed Realm identity/visibility and actor/principal ban keys, page-shared Access/identity/partition observations, exact native membership keys on each routed backend and page-level privacy start/final observations. No per-subject `listSubjectThreads` calls or query-time board/thread privacy sweep.
- Bound: one membership statement/backend/round, ≤3 rounds/read and ≤201 IDs in a logical round across all homes; ready-only execution may use fewer rounds. Membership adds ≤c rows/key points and O(c log N) blocks. Whole-page work, including preparation of Access and failed candidates, stays within [Filtered lists](../../../../docs/filtered-lists.md#budgets): 16+8c points, 64+16c examined rows, six blocks/budgeted row, 12 statements/backend for one read or 8+4R composed, one connection/backend, byte ceilings and output ceilings. Privacy is the existing two-statement behind/changed observation, ≤64+2×(behind homes+changed homes) examined rows; no 4,096-head read. This is a required integrated cost proof, not a claim current helpers meet it.
- Growth check: capture real native/API first/deep/NOT/ordered pages with candidates on 1, 16 and many homes co-resident on one backend and split across backends; include 200/201 IDs, three rounds and 16 reads/128 slots. Verify no per-home statement growth, duplicate connection checkout, hidden ACL enumeration or stale negative; measure served share under growing reduction arrival rate at 64/512/4,096 homes.

### Retention, reclaim and account-erasure cost

- Touches: every new table/index, public association documents, private preparation work/results and existing account-erasure/effects-frontier custody. Apply the same fence before late projection work; no author text, author ID or private grant payload is added to public count rows.
- Bound: `realm_subject_support`, `terminal_realm_support` and `subject_board_thread` are O(E), reclaimed by exact source/terminal fences after dependent consumers finish; `subject_board_listed` and `realm_board_subject` O(V), delete zero rows after replay floors permit; `subject_realm_listed` and `realm_subject_listed` O(U), likewise reclaim zero rows with sink delete fencing. Dependency locators are O(E+V+U), not one per historical event. Pending tombstone debt is O(changed keys not yet safely retired), measured and drained, never claimed constant under a stalled consumer. Each cleanup step ≤32 keys and the shared preparation ceilings. Existing retained public content may retain de-identified structural support; private/erased source support is removed immediately from disclosure and purged in bounded work. Private prepared owner rows/frontiers/dependencies are revoked at erasure T and erased, not retained for 24 hours. Public preparations survive only if their current public sources do. No new table is exempt because it is derived.
- Growth check: register all seven named tables, their dependency indexes and prepared membership/order copies in Content/Search's erasure inventory. Discover source-thread rows through existing author-erasure traversal, and prepared copies by principal; inverse locators follow source/subject/board keys without scanning all homes. Prove erase-before-relay, late arrival, deleted-principal preparation, tombstone reclaim and no resurrection at 64/512/4,096 rows. Content and Search acknowledge only actual cleanup plus dependent effects-frontier completion under `docs/deletion.md:29`, `:35`; no dispatch-only acknowledgement.

## Proposed README section ends

## Rejected alternatives and adoption evidence

- Raw `subject_thread` → OpenSearch: includes private/unlisted candidates and lacks current negative safety.
- Recheck only positive hits: cannot inspect a subject excluded by stale NOT or order.
- Per-Realm dirty flag/certificate: duplicates the required native privacy-reduction protocol and misses foreign homes.
- Four newest witnesses as absence: a fifth eligible thread defeats it; bounded sampling is not completeness.
- Counters alone for all viewers: public-floor counts cannot prove absence of individually readable protected/draft threads.
- Unbounded inline readable-board list: Access preparation bounds groups, not granted resources; prepare its finite input.
- Full Realm-ID array per catalogue document: unbounded subject degree; normalized public postings bound each mutation.
- Direct Realm anchor or sparse catalogue refill forever: no useful-page growth proof; prepare complete filtered order.
- Foreign event position as external version: unrelated sources reorder; serialize and version at subject home.
- Per-home batch calls/new connections: violates page statement/connection ceilings even if each call is small.

The report's acceptance is source-backed design, not an executable feature claim. Adoption
must freeze native outcome scenarios for: public/denied/protected/banned/suspended viewers;
both thread kinds and opening-vs-reply links; protected boards of public Realms;
positive/NOT/ordered/deep pages; four misses then a fifth match; complete native absence;
200/201 cross-home IDs; all listed transitions including unsupported move guards;
merge/unmerge original privacy and deduplication; replay/crash/delete-version pruning;
paused foreign repair, reduction committed-and-ACKed between observations; sparse useful
pages; erasure inventories and bounded reclaim. Run real growth captures using the six
Cost subsections before enabling the capability. Shared producer/consumer gaps are
implementation prerequisites, not new research questions or permission requests.
