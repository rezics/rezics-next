# Community

A Space is the stable, routed identity for a future Realm (community) or Zone (site).
Its metadata is an append-only revision chain; the Space points to its current head.
This module provides commands, point reads and HTTP routes.

## Public Realm discovery

Popular ranks originally qualified public discussion starts in the previous 30 complete UTC days. Trending ranks
the previous complete UTC day; it measures recent volume. Both order count descending, then Realm ID ascending,
and omit zero. Membership, unique people, views, votes, replies, edits and reviews contribute nothing. A start
qualifies only at its original authoritative creation time: discussion thread and root available and published,
published board, active explicitly public Realm and anonymously readable active host Space. Making private activity
public later never qualifies it. Returning from protected visibility starts a new public epoch without backfill.

The public API contract is `GET /v1/realms/discovery?sort=popular|trending&cursor=…&limit=…`, with the closed response
`{realms:[{realmId,spaceId,name,description,avatar:RealmPresentationImage|null}],next:string|null}`. IDs are native routed IDs, name is the
current Realm title, and description collapses whitespace, trims and truncates the current summary to 160 Unicode
characters. Avatar is only the current Realm revision's selected `presentation.avatarMediaId`, resolved through
Content's native `readRealmPresentationImages` as anonymous with `bannerMediaId:null`. The exact shared
`RealmPresentationImage` type/schema belongs to `content/realm-media.ts`: only the native available same-Realm,
matching-purpose derivative summary is returned. Unset, erased, hidden or unavailable optional images yield null;
no owner/profile fallback, original URL, hotlink, hidden media identity or permission is returned. No count, score,
account ID or target content is returned. Query limit is 1–100, default 20; a page examines at most `min(limit,20)` rank
candidates, allowing sparse or empty results with continuation. There is one indexed rank seek and no refill loop.
Consumers deduplicate Realm IDs because retractions can reorder candidates between pages.

Each examined candidate has fixed native media point work for at most one selected avatar; an unset slot makes no
media call. The first Realm/Space snapshot is released before invoking the original media authority. Final anonymous
Realm/Space/source checks must still pass, and the Realm head, host identity/head, Context pointer and presentation
must match the first binding before returning the image or card. A changed binding is omitted without retry or
refill. An unreadable or removed Realm is omitted even when its optional image is null. There is no per-row HTTP,
banner enrichment, member-count read, private membership read or additional media authority. Existing ranking,
original qualification, completed-day windows, source generations, expiry and signed cursor gates are unchanged.

Continuation uses the native signed cursor bound to sort, normalized limit, definition version, completed UTC
cutoff, current partition/publication epoch and the last examined count/Realm ID. A day or epoch change uses
`stale_cursor`; invalid signatures and query changes use `invalid_cursor`. An omitted limit and explicit 20 bind
identically. Counts stay exact bigint decimal strings internally and never enter the public card.

Derived storage belongs on one explicit routed discovery anchor: Realm/public-epoch totals, at most 31 current day
buckets per board, native source-version deduplication, guarded pending generation, two indexed rank orders and an
indexed due frontier. Each write uses one home through the ordinary command executor under committed native source
authority, after releasing the source anchor. Retraction/restoration uses only the original contribution and its
current epoch/version. Replays and reordered delivery cannot double count or reset fences. Board invalidation
subtracts at most 31 buckets per bounded step. Only actual application or native recovery may clear its exact fence;
pending or mismatched generations never serve. Expiry consumes at most 50 indexed due keys per scheduled step on
the shared worker, at kernel authoritative time. Overdue ranks are withheld. There are no Realm, board, thread,
history or table sweeps, deployment scans or historical backfills.

Candidate reads independently require native anonymous Realm and Space access, active explicitly public Realm,
active host and matching carried slot, current publication and source gates. Bearer privileges never widen this
check. Point reads are grouped by actual home in released per-partition snapshots; current heads, lifecycle,
publication and source gates are rechecked before serialization. Unavailable authority or deadline produces the
native error. A removed container never falls back to Global, and classification keeps its Context pointer.

**Implementation.** `discovery.ts` installs the bounded signed page reader, `discovery-projection.ts` consumes
at most 50 committed source records per step, and `discovery-expiry.ts` consumes at most 50 indexed due keys. Each
source record uses its own aggregate command, with at most 31 board buckets. The designated derived anchor is route
0, partition 0; it has a publication epoch advanced on source epoch changes. Current and final native owner reads
use anonymous batched Access decisions and independent Realm source gates, never the requesting bearer's grants.
Original board buckets remain separate from board publication, so restoring a board never changes a start's day.
Original qualification establishes the published-board baseline until a committed board fact overrides it. Derived
settlement uses the exact caught-up native head, including initial settlement and epoch changes without gate records.
The consumer never resolves or clears source fences. It serves only an exact applied-generation match to a settled
native source head. The shared Community worker registers wake-driven catch-up and minute-scheduled due work;
continuations are durable and each history remains bounded. Old thread/bucket caches expire by exact indexed keys;
old-epoch board gates have separate bounded cleanup. Current-epoch board gates remain available without rescanning
threads. An overdue aggregate is suppressed until its indexed rollover runs.

**Producer integration.** The consumer reads the committed source log and current gate through the original
`discovery-source.ts` implementations. Content owns original qualification, source versions, guarded mutation
outcomes and exact fence recovery. The Community wake retains the producer's closed `{realmId,realmEpoch}` schema;
it only starts a committed-log read. No provisional producer declarations or alternate source coordinator remain.
The native fixture in `test/community/discovery-native.test.ts` covers the integrated path. Runtime, physical,
native worker, lifecycle-removal and growth proof remain integration obligations; compiler typing alone establishes
none of them. The focused discovery test additionally exercises ordinary Realm media upload/processing/selection,
actual native image summaries, optional source failure and retry, changed final selection and privacy, and the same
one-candidate continuation. These are source integration cases; this change makes no additional native cost or
physical-proof claim.

The adopted design evidence is [Realm discovery research](../../../../docs/research/content-realm-discovery-design.md).
Its proposed `items` envelope is superseded here by the kernel resource-plural `realms` envelope.

## Public Space discovery invalidations

Decision: reuse native Space/Realm revisions and lifecycle events as change evidence; publish dependency scope
invalidations for shared gates instead of enumerating Spaces in a mutation or copying the bootstrap reader.

`space-discovery.ts` is registered in the production Community worker as `community_space_discovery` through
the ordinary durable effects relay. It consumes Space creation, metadata/address edits and removal/restoration;
Realm creation, revision/board-scheme edits and removal/restoration; native media availability/removal events;
Context lifecycle changes, source-tuple fences and API exposure changes. Realm title/description/avatar selection
and public/protected changes already produce `realm.updated.v1`. A Space has no native visibility or avatar
field: the carried Realm is independently guarded enrichment of that Space identity. Popular/Trending Realm
discussion activity changes no Space metadata; its native source-gate wake is consumed because an unsettled
carried-Realm source gate suppresses the Space during current hydration.

The closed `com.rezics.community.space-discovery.invalidated.v1` payload names a Space or a dependency scope,
the original log `(partition, epoch, position, eventId, type, resourceId)`, and any native revision/lifecycle/security version.
All positions remain decimal strings. It contains no title, description, image, removal reason or eligibility
claim. A Realm delta resolves its immutable host with one exact native identity read, including removed Realms;
an unavailable binding retries rather than losing a removal. Direct invalidations commit in the target Space home;
dependency scopes commit in their originating home. Address acceptance/activation retain the foreign address-home
origin and target the native Space home. Its own envelope is the delivery position; the retained origin identifies the native change, never a
replacement source snapshot or a globally ordered resource version. Native positions from different homes or
epochs must not be compared as one scalar.

Command receipts coalesce duplicate origin/target deliveries. Ordinary effects retain failed work across crashes;
the receipt and emitted event commit together. Replaying after receipt expiry can emit another harmless wake.
Consumers must hydrate current native truth on every wake, including removal, restoration and reordered old edits;
never apply an old event body or interpret its type as current permission. Search owns registration, index
replacement/removal and query behavior. Current native Space/Realm/Content hydration remains the final disclosure
authority while delivery lags. This producer does not establish index convergence or whole-query privacy proof.

**Space-source seam.** The population/bootstrap producer below uses current native positions alongside these existing native events
and the retained origin tuple, without importing its reader here. Direct targets are canonical Space IDs. Shared
`context`, `media`, `source-fence` and `exposure` targets are durable invalidation obligations, not expanded Space
lists or an assertion that no Spaces depend on them. The bounded native inverse and durable drain below propagate
connected dependencies. Search registration and consumer integration remain Search's responsibility; Space discovery
remains unenabled until that adapter and every required native dependency capability connect.

Cost: the original mutation adds no reads or writes. A direct Space effect adds no source checkout; a Realm effect
adds one exact retained `(route, realm_id)` point read, released before its delivery command. Each delivered
invalidation adds one same-home command, receipt and outbox event, bounded independently of population/history.
A shared dependency change emits one scope obligation with no Space enumeration. Generic effect admission and
retry retain their existing per-event bounds. Physical/native/main convergence costs remain unmeasured; focused
`test/community/space-discovery.test.ts` covers actual native edit/gate/removal/restoration delivery, reordering,
duplicate delivery and one actual source-fence scope obligation.

## Exact publication preparation

`GET /v1/realms/:realmId/publications/:subjectId/preparation` is private operational inspection for an existing
publisher. It returns `{preparation}` with the selected Realm/host titles and identities, the disclosed original
and current terminal Subject references, the exact native current decision or `null`, supported command destinations
and their expected head/quoted `If-Match`, and the current account/client/authentication epoch. Its operation is
`publication.prepare`, its action is actual `realm:publish`, and its resource type is `community.realm`.
Anonymous, denied and unknown selections use the same `not_found` response. Management, Context editorial power,
membership and public-read success confer no publication authority. Both ordinary Realm and host disclosure remain
required. Orphaned, removed, erased or unreadable sources cannot supply preparation.

The resource never consults receipts, creates keys, writes state or repairs projections. `current:null` means the
selected native slot has no decision; an unavailable partition or required Subject reference is an error instead.
An existing head returns only `publicationId`, actual `adopt|withdraw|reject` and `decidedAt`, without its author,
private grants or predecessor chain. Any existing head supplies publish/replacement, withdrawal and rejection
destinations; no head supplies only creation. These are advice for the ordinary mounted commands, which still
reauthorize and enforce their existing preconditions and exact replay rules. A changed head is never a receipt.
`recovery:{requestIdentity:"unknown",replay:"original-command"}` remains explicit even when the observed verdict
matches a lost request. Preserve that request's original method, body, key and expected head for an explicit replay.

Decision: publication preparation presents the current terminal Subject's selected language label and permitted cover; missing fields are empty, withheld fields concealed, and failed optional presentation reads unavailable.

The resource keeps the selected original Subject for the native publication slot and every command, and discloses its independently readable terminal reference separately. Its optional presentation uses the bounded Semantic summary observation and Content's source-backed cover descriptor; a hidden, rejected, erased or fenced cover never contributes its media identifier or rights metadata. This is not a Subject picker, history, public shelf or a complete rendered publisher interface.

Preparation releases the Realm snapshot before Semantic's reference owner runs. The latter independently checks at
most the original and one terminal reference, then repeats those exact references with newly prepared Access
evidence. A second redirect is unsettled. Final Realm observation freshly checks publication authority, disclosure,
the host and exact source identities/heads/lifecycle/ownership, the selected publication decision and native home
epoch/position. Any changed binding withholds the result without retry. Each reference has its own native home
component; these are independent observations, never a global atomic snapshot. Successful reads record those actual
components through the existing session-token mechanism, without inventing a command result. Operational responses
use `Cache-Control: private, no-store` and no ETag. Public adopted-publication GET, its representation and ETag stay
unchanged; terminal decisions remain absent there.

### Operation: publication.prepare

- **Touches:** One normal registered HTTP admission and two read-only RR Realm snapshots, each with BEGIN, SET LOCAL
  statement_timeout, one native partition probe, authoritative read time, current Access verification, one exact
  preparation query and COMMIT (or ROLLBACK). Initial checks prepare `realm:publish` and `realm:read`; final checks
  repeat them and prepare `space:read`. Each original/terminal reference round prepares `subject:read` outside
  checkout and uses Semantic's RR reference owner. The terminal Subject then receives one released Semantic summary
  observation: active release, representative selection and summary reads by addressed home, Content cover metadata
  reads by media home, and exact source-tuple fences in chunks of 100. A changed representative plan releases its
  snapshot, prepares the newly selected key and retries under the same deadline; at most three summary snapshots run.
  Final summary verification repeats Access preparation and checks actual partition epoch/position observations in a
  new RR snapshot. No receipt, mutation, publication writer, HTTP subrequest or list cursor is used.
- **Bound:** Realm and publication SQL touch one Realm, its exact revision, one host, its exact revision and zero or
  one selected publication head. Reference reads probe at most two exact `(route,subject_id)` keys and their latest
  redirect rows. The presentation observation admits one current terminal Subject, at most 64 requested/fallback
  language keys plus its original language, at most 12 representative locators and one selected edition; the chosen
  cover descriptor uses Content's existing import bounds (8 KiB credit, 12 variants) and exact source fence. Titles
  admit 1024 Unicode characters each (at most4096 UTF-8 bytes before JSON escaping); labels admit 4096 characters and
  media/credit fields retain their producer limits. Summary SQL may inspect current selected fact rows and each
  metadata read batches by physical home; returned-row counts do not prove a physical scan bound. Access, Auth,
  source-fence, transaction and serialized JSON costs remain charged to their owners and repeated final checks.
- **Growth check:** `test/community/publication-preparation.test.ts` covers current label plus empty cover, optional
  presentation unavailability, source change during hydration, absent/adopted/terminal heads, exact replay after a
  discarded response, stale head, non-publisher management/membership, hidden/unknown Subjects and failed reference
  dependencies. Controller acceptance still owns populated/concealed media cases, Realm/caller revocation, exact
  media-source replacement races, strict full-prefix plans and connected 256/1024/4096 growth. It must independently
  grow unrelated and selected source/identity/authority histories with fixed keys, homes and admitted byte caps, and
  capture physical rows, UTF-8/serialized bytes, transactions, preparations/evaluations, pools and registered runner
  phases for empty, denied, revoked, retry, cold-release and withheld paths. A fixture failure is zero native evidence.

## Realm home publication shelf

Decision: `GET /v1/realms/:realmId/publicationShelf` exposes the fixed twelve-item native summary continuation;
the initial Realm-home envelope will reuse its reader, and Web retains every interface and consumer integration.

`createRealmHomePublicationReader` in `realm-home-publications.ts` composes one ordinary publication raw window
with Semantic's actual `readSubjectSummaryObservation`. Each item keeps its exact `publication` alongside its
current `summary`, including the native language choice and cover reference. It accepts `cursor` and optional
`languages` (at most sixteen preferences), never a client-selected page size. It returns `{items,next}`;
`next` is the unchanged publication cursor bound to this Realm, viewer, raw limit12 and native placement epoch.
It also accepts ordinary publication cursors issued with that same limit. It reads no boards and cannot advance
their shelf. Existing publication commands, list/point reads and their revision decision inputs remain available.
Responses use `Cache-Control: private, no-store`; neither an account's cursor nor its disclosure can be shared.

Publication selects once and releases its connection before Semantic runs. `preparePublicationPage` retains the
original Realm/Space lifecycle/head binding and the exact selected publication heads. Its final `current()`
reprepares native Realm and Subject decisions outside the origin connection and checks those exact keys and the
original container binding. A replacement publication of the same Subject invalidates the earlier selection.
Semantic retains independent native `(partition,epoch,position)` components for every home actually read: release,
Subjects, representative editions, media and source fences. Its final check compares each component in its native
domain and rechecks disclosure. Components are neither combined into a global version nor compared across homes.
Changed evidence produces a retryable failure with the caller's original cursor; it cannot certify stale text/media.

Concealed/missing Subjects are omitted with the raw frontier retained, without refill or an unavailable-row count.
Failed hydration propagates its native failure rather than a successful empty page. An absent active Semantic
release is failed preparation for this composed shelf. A genuinely empty raw window needs no Semantic data hydration; final observation still dispatches Semantic BEGIN, SET LOCAL and COMMIT.
Shelf exhaustion never certifies the complete Realm population. The existing Web reader still issues per-cover
Subject calls until its owner binds this mounted transport; this shelf alone is not the complete Realm-home journey.

### Cost

- **Touches:** One publication raw seek of at most13 heads, up to12 initial exact head/disclosure reads, and one
  released container observation; finalization prepares fresh native Realm/Subject Access checks, reads up to12
  exact heads and rechecks the original container. Semantic deduplicates selected identities, groups each native
  batch by home, and uses its existing maximum three representative-plan attempts. Each attempt resolves the active
  release, exact Subject/current labels, image/original-language slots, representative-edition selection, native
  media references and source fences. Preparation executes before snapshots. Final Semantic equality performs both metadata batches (`partitionReadClients` and `readPartitions`) for
  participating homes and rechecks admitted Subject/edition disclosure. Charge preparation and all three possible
  representative-plan attempts, including unsuccessful dispatched statements and failed rollback attempts. All these operations use
  the supplied Kernel pool, including Access preparation/verification and partition dispatch; there is no HTTP or
  direct membership, ban, member-count, board or presentation reader in this shelf. Nested Access membership/ban
  work remains chargeable. Native executor/Access
  retries retain their own controls and the original deadline. Empty selection skips Semantic data hydration but still dispatches final BEGIN/SET/COMMIT; denial conceals;
  missing preparation, failed dependencies and changed sources propagate failure without another raw selection.
- **Bound:** Twelve limits selected keys, not examined rows or bytes. Publication seeks use
  `(route,realm_id,published_at,subject_id)` and exact heads `(route,realm_id,subject_id)`; Semantic uses its native
  per-home requested full keys and slot/source protocols. Source-specific histories, label-language aggregation,
  representative selection, media variants/credit and nested Access work retain their producer bounds. In
  particular the current summary port aggregates every current label language for each selected Subject: no fixed
  response/source byte or retained-memory ceiling follows from twelve keys. Source strings, JSON escaping,
  materialized rows, maps and serialization copies must be included before certifying the full home bound.
  The Semantic owner extension needed for that certification is a bounded current display-label/reference read
  with admitted UTF-8 payload/dependency limits, preserving the existing language choice and cover fields.
- **Growth check:** Focused shelf scenarios cover actual mounted native empty/populated reads, raw continuation,
  disclosure, exact-head replacement, changed source witnesses and dependency failure/retry. Physical-prefix
  evidence, all participating pool/runner costs at256/1024/4096, independent history/label/media growth and nested
  Performance review remain required for the complete home. No measured constant-work or byte ceiling is claimed
  by a small emitted page. Compare the real batch calls with Web's current one-Subject-request-per-cover pattern.

## Realm home page

Decision: expose the initial native assembly at `GET /v1/realms/:realmId/home` and a fixed twenty-row
`GET /v1/realms/:realmId/boardShelf` continuation; include the installed native viewer observation for signed-in
readers, preserve anonymous sign-in advice, and exclude the older presentation `join` projection.

`createRealmHomeReader({pool,access,routeKey,tokens,clock?})` returns `RealmHomePage | null` with separate Realm
and Space identity, presentation, boards and publications. `RealmHomePageSchema` is closed and mounted through
Community's existing dependency pattern. The initial query accepts only native summary language preferences.
The board and publication cursors go exclusively to their respective continuations, without a second raw window,
refill, sibling shelf read or cursor translation. Board items carry the existing native board fields without
repeating community presentation on every row. The ordinary board/publication routes and command inputs persist.

`createRealmHomePublicationObservationReader` retains the delivered summary and exact publication-head observations
through the entire assembly. The ordinary publication reader delegates to it and finalizes immediately, preserving
its existing behavior. Board selection extracts the existing raw page/cursor implementation. Its observation uses
the ordinary native exact-key batch disclosure and private row signature, refreshing Access preparation for its
final round; concealed rows remain absent. Empty board selection needs no board hydration. Neither shelf certifies
complete catalogue population.

The page selects one raw board limit20 and one publication limit12 window, then invokes the existing presentation
producer once. That producer owns optional avatar/banner/rules and member-count treatment; unknown remains unknown.
The page finalizes the original board and publication observations, then freshly reads the Realm, prepares Space
read authorization and revalidates the original native container binding. Head/lifecycle/context/Space relocation
changes fail retryably without returning earlier descriptions or covers. Connections are released before preparing
another authority. The Space address is read freshly at finalization; it remains distinct from Realm identity.
`Cache-Control: private, no-store` applies to the initial page and both continuations, including failures.

Decision: Realm home returns the native `enter`, `manage` and `leave` advice unchanged; the separate membership
commands retain their own authorization and receipt rules.

Decision: Community Web offers Join to a current signed-in nonmember with allowed participation as a separate
membership command; that command still performs its own authorization and receipt checks.

A signed-in response carries the native `viewer` fields: readability, exact current membership episode (or none),
and participation. Its `actions` is the producer's current `enter`, `manage` and `leave` advice. `enter` names the
mounted Realm GET. An owner member receives `unavailable: 'last_explicit_holder'` when no other explicit open-ended owner remains, or permitted `DELETE` advice otherwise. The read observation binds to the exact owner grant transaction, so replacing that grant retries even when the advice booleans stay equal. Anonymous readers retain `{state: 'anonymous'}` and
`{state: 'sign-in'}`. Concealed home remains 404; failed dependencies retain their native problems. The original
viewer observation is finished after presentation, shelves and ordinary context hydrate. Realm/Space binding,
membership episode, participation or advice changes retry the exact original request; no refreshed boolean or
public JSON comparison replaces the native source observation.

Connected outcomes are distinct: an empty home has empty shelves and a signed-in `membership.state: 'none'`; a
populated member home carries its `since`, reservation and publication transaction with current actions; a concealed
home is 404; dependency failure keeps its native unavailable problem; and changed Realm, containing-Space, membership
episode, participation or action source returns `transaction_retry_exhausted` for the exact input to be retried.

The installed producer signature is `createRealmHomeReader(deps: RealmHomeDependencies)`, where
`RealmHomeDependencies` extends `RealmDependencies` with `tokens: KeyRing`; it returns the closed
`RealmHomePageSchema` DTO, mounted at `GET /v1/realms/:realmId/home`. The full-input OpenAPI contract includes that
operation. The checked-in KernelClient declaration still lacks the mounted `home`, `boardShelf` and
`publicationShelf` methods, so the existing Community Web receiver uses a narrow local DTO and route seam until the
shared declaration is delivered. This seam does not establish installed consumer typing. Join remains a command
offer, and Realm claims still use their separate current claim reader; neither path executes from home advice. The
receiver preserves its existing presentation, lifetime and mutation ownership without adding another frontend or
Search dependency.

#### Recent discussions in the Board shelf

Decision: each original admitted Board receives at most three newest ordinary thread candidates, without pins or
refilling concealed candidates; join advice remains exclusively the personal viewer-actions batch.

`realm-board-home.ts` extends only the closed Home/shelf row with `recent`; the generic `BoardRecord` and ordinary
Board directory stay unchanged. `recent.state: 'current'` contains reading-only `thread`, exact `target` and native
`comments`, plus `complete` for the original raw prefix. An empty complete prefix means no admitted recent discussions;
it grants no posting authority. An erased Board has unavailable recent context. Withheld Boards remain absent in
their original shelf positions. Unknown activity is `comments.state: 'unavailable'`, never an invented zero.
The existing conversation producer supplies public exact/lower-bound counts and source heads. No posts are counted
by this consumer, and no protected cohort is relabelled as public. Source changes return the ordinary retry problem.

The native observation retains the original Board and thread/opening lifecycle witnesses through presentation,
publication and other foreign hydration. Final admission reopens the exact original keys with fresh native Access
decisions, compares private thread/post/revision fingerprints and placement epochs, confirms activity's original
generation/cohort/source head, then finishes the shelf's original Board/Realm observation. Empty and sparse prefixes
take the same parent observation; a changed opening cannot acquire fresh advice around old content.

The three-thread decision adds at most20 indexed `(route,board_id,created_at,thread_id)` LIMIT4 seeks (80 raw rows),
two exact disclosure rounds per selected Board, and one initial plus one final activity batch for at most60 keys,
within its existing100-key cap. Each disclosure reads up to three thread, opening-post and revision metadata keys,
up to three admitted revision bodies and the existing Board/Realm keys; native Access preparation, partition batches,
transaction controls and bounded citation disclosure are included in those existing producer costs. Connections are
released between authorities. There are no pin reads, author hydration, reactions, full opening-page reads, history
walks or output-driven refill. Source memory includes both rounds' bounded bodies, private fingerprints and activity
witnesses; response memory includes at most60 native opening bodies with their existing document/reference limits,
60 titles (at most1024 scalars each), targets and count/source tuples, including serialization copies. This adds the
derived sum of the existing body/citation/Access bounds to the Home Cost below; it makes no measured growth claim.

Both mounted operations (`realm.home` and `realm.board_shelf`) use `RealmHomeBoardPageSchema`, including the closed
recent projection, through the existing registrations and dependencies. Publication's sole receiver must deliver
the official package-root-derived callable before Web extends its Home transport; the older handwritten envelope
does not authorize another substitute ABI. Web's agreed `RealmCommunityBoards` seam retains its existing shelf,
focus, continuation and navigation slots. Client publication, browser receiving/join retirement and rendered journey
acceptance remain follow-on work; this native source alone does not complete the connected product outcome.

### Cost

- **Touches:** Initial home reads Realm identity/Access, mints a released native time and reads one exact container
  binding. The viewer performs its initial Realm read and two separated native rounds (observation and finish).
  Each round prepares four Realm/Space Access checks outside a released REPEATABLE READ transaction, then reads
  partition metadata, one exact Realm settings head and container binding, and at most one selected membership;
  owner-role keys are read only for a permitted member leave. An explicit owner with leave authority also gets one
  holder observation in each round, including initial and finish, at the same T; its exact transaction ID stays private.
  Participation is checked after each round on a released
  connection. Board selection freshly prepares Realm read, then dispatches BEGIN/SET LOCAL, partition metadata,
  Realm decision, one raw seek of at most21 board identities and COMMIT (or rollback). Initial and final board
  hydration each prepare the ordinary board/Realm decision bundle outside their snapshots, then dispatch BEGIN,
  one partition metadata batch, full-key board and containing-Realm batches, native disclosure/authority work and
  COMMIT. Only up to20 selected keys hydrate; final raw-page partition metadata checks the original placement epoch,
  including empty pages; no second page is selected. Presentation invokes its existing two
  released Realm/Space rounds: prepared Realm/Space/join decisions, BEGIN, native read time, Realm/Space and
  partition batches, own membership/ban rows, join decisions and optional native member-count reads, then COMMIT.
  Between these rounds it resolves exact selected rules and at most two selected presentation media keys using
  their existing source/disclosure protocols. Publication adds the complete shelf cost above: at most13 raw heads,
  up to12 exact initial heads/Subject checks, original container binding and Semantic hydration grouped by homes.
  All three possible Semantic representative-plan attempts count, including preparation, unsuccessful queries,
  rollback and failed rollback dispatch. Each batch has representative-slot and summary statements; original and
  extra representative sets can each contain12 distinct identities. Final Semantic equality dispatches BEGIN/SET,
  both metadata batches (`partitionReadClients`, then `readPartitions`), admitted-key checks and COMMIT, including
  BEGIN/SET/COMMIT with zero selected Subjects. Final publication observation freshly prepares Realm and admitted
  Subject decisions, reads exact heads and rechecks its original container. Home additionally freshly reads the
  final Realm and its native Access evidence, prepares Space authorization, mints fresh time, reads final Space
  and revalidates the initial container binding. Board continuation omits publication and presentation work;
  publication continuation keeps its original shelf-only path. Empty/denied/stale/failure paths charge all work
  reached before stopping, including retries, controls and cleanup; no failure is counted as a zero result. These
  calls use the supplied Kernel pool and each dependency's actual authority/executor preparations and participating
  homes; sharing a pool does not combine their native source tuples. The installed viewer producer contributes its
  actual initial Realm read, two released source rounds, membership and conditional owner-role reads, two
  participation checks, and final advice comparison. Native executor attempts, Access/catalogue/ban/membership
  preparation and deadline controls remain nested producer terms requiring review, not a fitted per-item allowance.
- **Bound:** Board raw SQL is driven by `(route,realm_id,board_id < cursor)` with descending board identity and
  LIMIT21; exact board batches use `(route,board_id)` LATERAL LIMIT1 and containing-Realm full keys. Membership
  presentation uses `(route,realm_id,account_id)` with open/current validity and LIMIT1; history examined beneath
  that predicate remains an independent source term until physical-prefix plans are reached. The viewer performs
  at most one exact `(route,realm_id,account_id)` membership lookup per round and reads owner-role keys only after
  leave permission succeeds; its envelope contains at most one membership episode and three native action entries.
  An owner home adds at most two holder statements, one per round; each target uses the current exact-role point key,
  and the remaining-owner probe uses `realm_owner_continuity` with `valid @> T` and `upper_inf(valid)`. Each emits one
  row and a 36-byte source transaction ID, so the source check is physically indexed as well as result-bounded.
  Publication uses its
  existing raw `(route,realm_id,published_at,subject_id)` and exact head keys. A page's selected keys do not bound
  examined membership/ban, label languages, selected compact statement histories or expanded adoption/candidates.
  Let R/S be admitted Realm/Space source bytes, B the selected board bytes, P exact publication-head bytes, L all
  selected stored labels, F selected fact/representative histories, M materialized media/variants/credit/fences, D
  selected rules body and A dependency preparation/bind bytes. Source materialization and retained memory include
  R+S+B+P+L+F+M+D+A plus all native per-attempt inputs/results, maps, original/representative copies, both presentation
  rounds, returned objects and serialization buffers. Realm/Space titles admit1024 Unicode scalars and summaries4096, totaling5120
  scalars per identity: UTF-8 can use four bytes per scalar; JSON may use six
  ASCII bytes per escaped BMP scalar, plus field/framing overhead. Count actual strings for every producer, escaping
  and repeated serialization; character counts and16 language preferences are not byte admission. Selected board
  titles, rules, all-language labels, source fact histories, media credit/variants and dependency binds retain their
  actual independent producer limits; the uninstalled Semantic UTF-8 display-label/reference extension is required
  before a fixed complete source/response/retained-memory ceiling can be certified. No local all-language truncation
  or twelve-key byte claim substitutes for it. The real baseline is up to12 mounted Subject requests per selected
  cover plus separate identity, presentation, board and viewer calls; the home replaces that transport with bounded
  native batches but does not claim constant examined work from small emitted output.
- **Growth check:** Focused mounted scenarios cover the initial empty/populated envelope, twenty-board and
  twelve-publication limits, independent ordinary cursor continuation, unknown count, anonymous sign-in, empty
  nonmember and current member advice, last-holder and permitted owner leave advice, exact owner-source replacement
  with unchanged advice, exact join retry around native readback with one
  stored effect, leave/rejoin, role revocation, Realm and containing-Space change during summary hydration, exact
  publication replacement and dependency retry. `apps/web/tests/realm-home-native-visit.test.tsx` covers the current
  DTO projection, independent cursors and retained anonymous/member/concealed/unavailable flow across source,
  credential, account and reader replacement.
  No native growth evidence has been reached here. Controller admission must independently grow unrelated
  Realm/Space/board/publication/Subject/authority rows at256/1024/4096 while fixing raw limits, selected keys, homes
  and admitted bytes; independently grow publication and membership/ban histories and unrelated Semantic labels,
  facts and media. Capture actual route+identity/cursor physical-prefix plans and strict withholding across all
  participating pools and runner phases, initial and both continuations, empty/denied/stale/retry branches. Fixture
  or approved-host failure contributes zero evidence. Performance review must resolve nested producer terms in
  this journey. Native growth, shared checks and Web's populated/empty/retry/account-switch rendered review remain
  controller obligations; a source-only delivery does not complete the person journey.

## Public Space discovery source

`spaceDiscoverySource({pool,access,clock?}, {deadline}?)` in `space-discovery.ts` exports Community's internal
`SpaceDiscoverySource`: `read(partition, ids)`, `page(partition, after, limit)` and `count(partition)`. Search owns
kind registration, index generations, query admission and frontend integration. This interface adds no HTTP
endpoint or public count. Its identity is the existing Space UUID and native route, including when carrying a Realm;
it never manufactures a second Realm identity in mixed discovery. Popular/Trending discussion ranking above remains
independent and unchanged.

Decision: bootstrap traverses all retained Space identities with a private candidate census and sparse eligible pages;
the census is never an eligible-result count, and consumers must follow native frontiers even on an empty page.
`read` accepts at most 100 input IDs, deduplicates them and rejects malformed or cross-partition keys. `page` accepts
1–100 candidates and a full `{route,id}` frontier in that partition. It examines one indexed range of at most `limit`
candidates plus one continuation probe, returns eligible `spaces`, and returns the last examined key as `next` only
when that probe exists. Protected/removed candidates still advance the frontier. There is no scan/refill to fill an
eligible page. `count` returns the exact number of retained native candidates, including protected/removed identities,
from one `space_discovery_population` row. Its insert/delete trigger runs inside the native writer transaction;
metadata, visibility and lifecycle transitions do not change that identity census. The migration initializes the
census once under a Space write lock; requests never reconstruct it by counting a table.

All three return `{partition,position,...}` with `position` the exact bigint `core.partition.position` from the same
released REPEATABLE READ snapshot as the candidates/census and projected current text. An unavailable, fenced or
moved partition fails the operation rather than becoming an empty population. `spaces` contains
`{id,realmId,name,description,revision}`; `revision` is the current native Realm head UUID for a carried Realm, or Space
head UUID otherwise. It is an equality witness, never an ordering/version surrogate for `position`.

`readSpaceDiscoverySummaries(deps, ids, {deadline})` hydrates at most 100 fixed full keys across their actual homes and
returns a map of current `{id,realmId,name,description,avatar}`. Both source reads and hydration always prepare native
anonymous Space and Realm decisions, independent of caller privileges. Standalone text uses `readSpace`; occupied
slots use the same exact native Realm/current-revision reader as community presentation. A slot occupied by an
unreadable, protected, removed or source-unsettled Realm suppresses the whole Space, without standalone fallback.
Both containers must be active and their current heads available at the native read time. Name is the current native
title; description uses `discoveryDescription` (collapsed whitespace, 160 Unicode characters). No text copy is stored.

Hydration releases each first owner snapshot before resolving only its selected avatar through the original
`readRealmPresentationImages` as anonymous, with no banner. Unset, erased, denied or unavailable optional images
yield null, using the exact native `RealmPresentationImage` schema when available. It then repeats owner reads and
anonymous/source decisions. A changed placement epoch, head, lifecycle version, slot, Context, source gate or
presentation omits the candidate without retry/refill, including remove/restore cycles. Missing candidates stay
absent regardless of index evidence. No member counts, rules, private membership or copied media authority are read.

### Cost and lifecycle handoff

Read/page use one released snapshot in one requested partition: one placement/position seek, at most 101 keyset rows,
at most 100 exact Space/head and occupied-slot reads, one exact Realm/head batch, two native Access batches and at
most 100 exact current Realm source gates. Count uses one placement/position and one census seek. Hydration groups
only the supplied keys, with two such owner rounds per occupied partition and at most one native optional avatar
protocol per candidate (at most twelve derivatives). Work is linear in the fixed input limit, with logarithmic
indexed seeks; there is no all-partition scan, ranking read, historical text scan or refill. Focused outcomes live in
`test/community/space-discovery.test.ts`; physical/growth and broader acceptance remain integration obligations.

Bootstrap and current hydration are delivered here alongside the native invalidation relay above. Decision: retain
both producer interfaces and their existing names; direct invalidations identify exactly the Space keys accepted by
this source. Consumers reread those keys at current native positions, never apply invalidation bodies as projections.
Search owns the consumer and registered generations. The Realm discussion source gate is checked on every owner
round and its `realm-discovery.changed` events now produce direct Space wakes through the same retained host binding.
Search must use current hydration and must not expose this private census as kind-count evidence.

### Shared dependency frontiers

`space-discovery-dependencies.ts` initializes the native inverse; `space-discovery-frontier.ts` exports
`openSpaceDiscoveryFrontier` and `drainSpaceDiscoveryFrontier`. The production default worker registers their
invalidation effect, bounded continuation workflow and minute recovery schedule in `work.ts`. No Search writes,
registration, source reader or hydration implementation are added here.
`spaceDiscoverySource().dependencies()` exposes explicit preparation/capability state for registration;
`readSpaceDiscoveryFrontier` reports native acknowledgement and exact decimal progress independently of relay delivery.

Decision: expose tuple-fence readiness only after an owner registers an explicit source generation/cut and publishes an
exact current witness for every retained Space; an empty Search page never proves that a Space has no source tuples.
Realm icons still do not carry imported provenance.

Deferred native Space/Realm writer triggers update only that retained Space's inverse keys in the same transaction
as its native change. Removed and protected identities retain dependencies. Context selection and optional avatar
selection use the exact current Realm head; standalone Spaces have neither dependency. The inverse holds identities
only. Its `(dependency, ordinal)` covering index supports an exact dependency seek, independent of partition count;
its owner index bounds replacement to this Space's at most four keys. It never filters by anonymous eligibility.

Migration initialization captures one indexed native endpoint per partition under writer locks. Each initialization
command examines at most 50 raw Space keys in that partition, locking each current owner before registering it.
New identities and changed heads maintain themselves on either side of the cut. The pending-install index supplies
one next locator; no shared-scope mutation or drain enumerates partitions. A scope remains preparing until this
captured inventory finishes, including when its currently eligible population is empty.

An obligation retains its original native tuple, decimal positions, payload, inverse cut, cursor, examined count and
state. A drain examines at most 50 indexed dependency keys through the captured cut, releasing its checkout before
each exact Space command. Each examined retained identity gets one canonical direct invalidation; its retained
obligation/Space deduplication and event commit together in the Space home. Only after all wakes commit does a
compare-and-set advance the cursor or settle the obligation. Concurrent or restarted drains cannot double count
progress or duplicate wakes after command receipts expire. There is no cross-partition or cross-epoch scalar clock.

The native source-tuple producer records the exact Space and Realm heads, producer generation/epoch/source position,
and up to 50 source tuples for each retained Space. A missing witness is unavailable, including for a Space with no
Realm or no imported dependencies. Tuple inverse rows live in the source tuple's partition; current Space
references, expected tuples and resumable work stay with the Space. A revision trigger advances the Space witness
generation and queues removal of both acknowledged references and tuples whose earlier edge work may already have
committed. Tuple-home upserts and removals compare that generation, so delayed work cannot restore a retired edge.
The default supervisor repairs at most 50 exact tuple edges per page and acknowledges them separately at the Space
home. Readiness includes the captured dependency installation and per-partition tuple witness counters; it is never
derived from an empty inverse.

`spaceDiscoverySource().tupleWitnesses(partition, ids)` reads the complete native tuple capability. It compares two
current Space/Realm owner rounds, reads Content source fences before and after, then checks the exact capability
generation and cut again. A moved owner, changed witness, unavailable source partition or fenced tuple withholds
the whole tuple witness. Search must apply this before publishing and during final hydration. The existing Search
adapter still needs an owner method such as `currentSourceTupleWitnesses(spaceKeys)` that returns the authoritative
current Space/Realm revisions, tuple list, producer generation/epoch/source position and an explicit complete bit;
eligibility pages cannot supply those facts.

Decision: the default publisher proves empty provenance only for the current native authored Space/Realm revision types; it preserves any separately registered imported relationship producer.

`space-discovery-publisher.ts` installs the authored-head capability and publishes one retained native owner per
maintenance step. It reads both exact current revisions and the real partition epoch/position from one released
snapshot, then rechecks that placement/position and the heads inside the publication command. Missing revision
rows and changed owner cuts withhold publication. Native authored revision schemas accept no imported provenance;
their explicit empty tuple set is independent of protected, removed or filtered public results. This capability
does not infer absence for imported relationship producers. A separately registered producer retains its generation,
cut and explicit tuple inventory.

The existing minute recovery workflow first repairs tuple edges and initializes dependency inventory, then runs at
most twenty native witness steps before continuing. The pending-witness index supplies one locator; each step adds
one producer point read/registration, one locator seek, one placement read and one exact Space/Realm head query,
plus the existing bounded publication transaction. No source pages, member census or individual card hydration are
used. Only the existing final owner/fence reader grants `complete: true`; publication acknowledgement remains
provisional. Focused native outcomes are in `test/community/space-discovery-publisher.test.ts`.

Decision: a current Space tuple read certifies `complete: true` only after native placement equality and exact expected/reference tuple coverage; missing tuples never stand in for complete provenance.

Each ready read includes its native `partition`, `epoch`, `position` and per-partition capability `generation`/`cut`
under `native`. Both owner rounds must retain those same observations, heads and producer witness. Expected tuples
and acknowledged references must each equal the declared tuple count and identity set, and references must belong
to the current witness generation. Each exact owner/tuple-generation prefix reads at most 51 rows to detect overflow
against the 50-tuple admission limit. Missing, stale or partial native projection rows withhold the witness even when
the aggregate installation counters still say ready. A provisional publication acknowledgement does not carry
`complete`; only the released owner/fence read can certify it. This does not install the production relationship
source publisher or make a filtered or empty page a capability certificate.

Dependency removal may delete an unexamined inverse key; the native change's own direct wake rehydrates that Space.
Insertions behind a captured cursor, including late commits and changes during initialization, are covered by their
own committed native change events. New inverse keys beyond the cut are likewise covered by that live relay. Old,
duplicate and reordered wakes always invoke the existing current anonymous hydration, including remove/restore cycles.

One scope costs one durable obligation, bounded inverse pages and at most one retained exact wake per examined
dependency. A workflow runs at most 20 pages (1,000 examined keys), then enqueues a locator-only continuation.
Initialization costs 4,096 endpoint seeks once, then one bounded owner pass; ongoing native changes replace at most
four dependency keys. Failed command steps use the shared eight-attempt retry policy; the minute indexed recovery
schedule retries unfinished initialization/frontiers after exhausted attempts or restarts. Unavailable source-fence
obligations are retained without acknowledgement. Frontiers, inverse keys and wake deduplication have no expiry;
they must not be pruned using the shorter command-receipt lifetime. Native runtime costs, Search convergence and main
promotion remain distinct integration verification obligations. Focused cases live in
`test/community/space-discovery-dependencies.test.ts`.

#### Cost: tuple capability readiness

- Touches: One aggregate query reads the fixed 4,096 dependency-install rows, the fixed 4,096 per-partition tuple counters and the singleton producer row; it does not join native resource partitions.
- Bound: 8,193 summary rows and one statement, with at most about 1 MB of aggregate text input from the schema's fixed UUID/position widths and 20-digit counters, plus PostgreSQL tuple/index overhead.
- Growth check: Space count, tuple history and unrelated scopes do not increase these row or byte bounds; the partition count is fixed at 4,096.

#### Cost: source producer registration

- Touches: One partition-0 `runCommand` performs its standard receipt, partition fence and eventless command path; the callback locks and upserts one singleton producer row.
- Bound: At most two producer-row statements, one 128-character generation, one 256-character cut, and the standard fixed Kernel command overhead.
- Growth check: The singleton is independent of Space and source-tuple population.

#### Cost: per-Space tuple witness publication

- Touches: One producer point read and one Space-home `runCommand` lock the Space head and witness, read current references plus pending tuple work, replace the exact expected tuple set, queue tuple-home edges, and emit one direct Space invalidation with the producer's original source event.
- Bound: At most 50 expected tuples, 50 current references and no outstanding prior edge jobs; the callback performs at most 160 SQL statements and stores at most 50 expected rows plus 100 edge-work rows. Each source id is at most 1,024 UTF-8 bytes.
- Growth check: Publication work depends only on the selected Space's current and pending tuples; unrelated Spaces and retained inverse history are not read.

#### Cost: tuple witness repair locator

- Touches: One ordered seek on `space_discovery_tuple_work_pending` returns a single Space key with outstanding work.
- Bound: One statement and one locator row; no tuple or Space history is scanned.
- Growth check: The partial work index keeps locator work independent of completed Space witnesses and unrelated Spaces.

#### Cost: tuple witness repair page

- Touches: One Space-home query selects at most 50 work rows; each row runs one tuple-home inverse upsert and one Space-home acknowledgement in separate `runCommand` transactions.
- Bound: At most 50 edge rows and 100 command transactions per invocation, plus 50 fixed command/transaction overheads on each side; each acknowledgement is bounded to the selected Space and work key.
- Growth check: Unrelated inverse edges and retired tuple history are not examined. Tuple-home paging uses its active partial index; the 50-row limit remains fixed as unrelated Spaces grow.

#### Cost: current tuple witness read

- Touches: Two exact owner rounds cover at most 100 requested Spaces, their current expected/reference tuple prefixes and one native capability point per owner partition; two grouped current-fence reads cover at most 5,000 tuples, and two capability observations scan the fixed install/counter summaries.
- Bound: Each owner contributes at most 50 tuples, with at most 51 rows from each expected/reference prefix to reject overflow; each source-fence statement carries at most 100. In the worst spread, each fence round reads at most 5,000 tuple identities across at most 4,096 tuple homes, with one anchor per home. The two owner rounds retain at most 20,400 expected/reference rows, 200 owner rows and 200 capability points, plus at most 10,000 fence rows across both rounds, before fixed transaction and index overhead.
- Growth check: Work is bounded by the 100-key interface and 50-tuple witness limit, not by source-fence table history, unrelated Spaces or unrelated tuples.

#### Cost: source-fence frontier page

- Touches: One readiness observation, one active tuple-inverse prefix page, at most 50 current Space wakes and one progress acknowledgement.
- Bound: The page examines no more than 50 active inverse rows through its captured ordinal cut. Each wake is a separate exact Space-home command; the source-fence cut uses the tuple-home partial index.
- Growth check: Retired inverse tombstones are excluded from the active page index, and unrelated source tuples do not extend the selected prefix.

## Space commands and reads

`createSpace` derives its route from the authenticated account and idempotency key.
It requires `space:create` on the Global Context through `parentCreationAuthorization`.
One `runCommand` transaction inserts the Space, its first revision and native Access initialization:
`community.space.owner` grants the creator `space:read` and `space:manage`, and
`community.space.standing` grants active accounts `space:read`. Initialization never grants on the parent.
The installed action catalogue must contain these actions for the template to resolve.

`updateSpace` requires `space:manage` on the Space. It preserves omitted fields, appends a revision
and moves the head with a compare-and-set against `expectedHead`. `SpaceConflictError` means that
head has changed; the transaction rolls back without a revision, receipt or grant write.
Authorized same-key replays return the stored outcome before checking the old expected head.
`SpaceInputError` identifies invalid metadata. Titles contain 1–1024 Unicode characters and
summaries at most 4096; PostgreSQL independently enforces these limits and revision immutability.
The initial state is `active`; removal and restoration use the lifecycle commands below.
Creator and author accounts are external identities and can have different routes from the Space.

`readSpace(client, spaceId, time)` joins the identity to its exact head on the supplied connection.
It returns metadata and the head's active address without implying permission. Callers compose Access `space:read` with
`spaceReadEligibility`, which prepares non-null domain evidence and verifies the current active
Space and head at Access's authoritative time. Missing domain evidence denies public reading.

Every HTTP Space representation includes the output-only `realmId`. `readSpaceForViewer` reads
its exact `realm_route_space_id_key` slot in the Space's partition, then calls `readRealm` once
only when that slot carries a Realm. The id is exposed only when the Realm is active and the
viewer passes its ordinary `realm:read` check, including its read eligibility. Otherwise it is
null, with the same body, status and headers as before the Space carried a Realm. Space
creation returns null without a slot lookup; a replay derives the field from current visibility.
This field is derived per viewer, outside the Space's revision chain. The Space ETag remains
its head revision id and the `If-Match` token for Space writes; a Realm or membership change
can change `realmId` without changing that ETag. Space authorization is unchanged.

`PUT /v1/spaces/{spaceId}/address` requires `space:manage`, `If-Match`, and `Idempotency-Key`.
Addresses use Access's ASCII handle normalization but live in `community.space_address_claim`,
their own namespace. A handle claim is checked by one routed point read: an active or unexpired
reserved handle blocks the same address unless the claimant is that account or an owner of its
organization. A free address is receipted as pending in its address partition, added to a new Space
revision with a head compare-and-set, then activated in the address partition. A changed address's
previous claim is reserved for 30 days. Pending claims expire after 30 minutes and can then be
reclaimed. Every step is a separate single-partition command with the request's idempotency key;
retries resume from the saved receipts. `GET /v1/spaceAddresses/{address}` point-reads an active
claim and returns `{ spaceId }` only when the Space passes its ordinary `space:read` check.

A Realm is the community carried by a Space. `createRealm` mints its distinct identity
and initial revision on the Space's route, with `realm:create` on the Global Context
and `space:manage` on the host. Both checks use the same trusted command context and
share one admission observation. The host must exist and be active at T. Its single
Realm slot is observed at T and enforced before new writes and by a unique database
key, so concurrent creations cannot both commit. Authorized receipt replays can return
their original result without attempting to claim the slot again.

The classification `contextId` must name an existing Context readable through
`publicContextEligibility`. Context authorization is prepared before target checkout
and verified at the command's T. `updateRealm` requires `realm:manage`, appends a
revision and compares `expectedHead` before moving the head. It preserves omitted
metadata and rechecks any supplied Context. Visibility and classification on the
identity must agree with its head; a deferred foreign key enforces this in PostgreSQL.
Realm identity, host and creation provenance are immutable, and revisions are append-only.

`community.realm.owner` grants `realm:read`, `realm:manage`, `realm:ban`, `realm:publish`,
`board:create`, `access:grant` and `moderation:takedown`. `community.realm.moderator` grants
`realm:read`, `realm:ban`, `realm:publish`, `board:create` and `moderation:takedown`.
The takedown action applies to threads and posts in that Realm. The standing role grants
active accounts `realm:participate`; `community.realm.member` grants both `realm:read`
and `realm:participate` through the Realm's `member` group. `realmReadEligibility`
supplies public read eligibility only while the current Realm is public.
`readRealm(deps, actor, realmId, { deadline })` performs the head read inside that
eligibility verification at Access's authoritative T. A protected Realm requires a
native `realm:read` grant; denied and missing reads both return null.

The native `realmReadEligibility` (including `readRealm`'s private row observer),
`spaceReadEligibility` and `realmParticipationAnchor` callbacks supply optional
`ResourceEligibilityOptions.work` producers to the existing Access/Source ledger.
Realm preparation reserves its exact container binding read, including the pool
wait. Verification reserves the current Realm/head/active host, current binding
and, for an account, at most two protected-read ban probes for the fixed actor and
delegating principal. Public Realms do not dispatch the ban plan. Space preparation
and verification each read the active identity and exact head; their closed
eligibility projection excludes revision address text. Participation preparation
constructs identity data without IO; verification dispatches one native Realm read.
The SQL/schema derivations are adjacent in `eligibility-access-work.ts`.

These declarations admit work only. Every verification still uses Access's supplied
authoritative T, current lifecycle/head/binding comparisons and ordinary grant and
denial formula. Receipts belong to one callback context/result and charge dispatched
plan bounds even on empty results; successful receipts release only undispatched
branches, unused projection bytes and unused empty seeks. Failure or timeout retains the full envelope.
No membership, actor, authentication, scope or general formula accounting is supplied
by these resource callbacks; those remain Access's independent producers. Unsupported
identity/time variants have no bound and are refused before callback IO. Focused
callback admission coverage lives in `test/community/eligibility-access-work.test.ts`.

`createRealmParticipationCheck({ pool, access })` checks `realm:participate` and the
independent `realm:read` anchor at one T. The read anchor ensures that the standing
participation grant cannot expose a protected Realm to a non-member. The
`GET /v1/realms/{realmId}/participation` route returns 204 when both checks pass, 403
when a readable Realm denies participation and the ordinary 404 when the Realm cannot
be read. A `realm_ban` denial applies to `realm:participate` even when the Realm is public.

`ensureRealmMemberGrant(tx, { realmId })` installs the identity role grant for the Realm's
`member` group only while that Realm is protected. It is idempotent and requires the
current command to target that exact Realm. `updateRealm` calls it after moving the head
when the new visibility is protected, in the same transaction as `realm.updated`.

The native membership `roleReader.work` and `roleReader.batchWork` implement Access's
optional six-axis work producer contract at the existing role SQL dispatches. They
support routed pairs at finite ISO instants; batch supports unique pairs for at most
two human accounts, each within the existing membership inverse limit. Other shapes
return an unknown bound, so metered Access refuses before invoking the callback.
An empty batch has no native dispatch; a missing Realm still charges the dispatched
plan and its empty seek. The adjacent derivation in `membership-access-work.ts` bounds
native anchor probes, finite relational intermediates and the closed parameter/range
projection. Native rows retain their dispatch charge even when no proof is returned;
completed receipts use the actual native projection bytes and empty-seek evidence.

Receipts belong to one exact callback context and returned object, are consumed once,
and contain no permission or retained client. Each metered invocation needs a fresh
context object, including calls at the same T; reuse is unknown before dispatch.
Ordinary callers retain their existing input and result behavior. The content worker's
existing lazy wrapper forwards the original producers by identity after Access is
constructed, without a pool read or an eager membership factory. Absent configuration
provides no producer. Focused accounting and forwarding cases live in
`test/community/membership-access-work.test.ts`; native physical growth proof remains
with the existing membership acceptance.

When Accounts reuses the current live membership reservation for another join or
owner add, publication confirms the exact current membership by its open-key index
and records the fresh transition proof without changing the interval or emitting
another membership event. A different reservation does not satisfy the operation.
Authorization and the current-ban check still apply.

`PUT /v1/realms/{realmId}/bans/{accountId}` opens a Realm-owned ban record and
`realm_ban` identity denials for `realm:join` and `realm:participate` at the command's T.
`banAccount` requires `realm:ban` on that Realm. Owners and moderators carry that action.
A target holding the Realm's owner or moderator resource role is refused with 409 and
must have the role removed first. Removal acceptance and delayed publication repeat this
guard at their own authoritative T, so a role granted while removal is queued protects
the current membership. From T, a protected Realm's read eligibility checks
one indexed current-ban key for the actor and, when delegated, the principal, in one
statement in its own partition, and refuses every grant if either account is banned.
The Realm, carried Realm ID, boards, threads, posts and publications are hidden
even while removal is pending or an independent read grant remains. Public reads still
answer exactly as for an anonymous reader. A read identity denial would also veto public
eligibility, so protected reads consult the ban record instead. Join and add-member acceptance and membership
publication refuse a currently banned target without writing an operation, membership,
grant or follow. After unban, join and add-member work again.
An existing member is removed by Accounts' native leave workflow: publish closes the
Realm interval before release clears the account's inverse slot. The workflow is keyed
by the ban. Its operation commits the moderator as initiator (see Durable initiators
below), and each step needs that moderator's own `realm:ban` on the Realm; the member's
permission is irrelevant. A non-member starts no workflow. Retrying a receipted
ban resumes enqueueing with the same durable key.

`DELETE /v1/realms/{realmId}/bans/{accountId}` requires the same action and ends both
denials in the record's transaction. Both mutations use `Idempotency-Key`. Unban never
restores membership. Independent grants remain intact and become readable on the next
request with the original bearer, without rejoining or regranting.
`GET /v1/realms/{realmId}/bans` requires `realm:ban` and returns
current records ordered by account ID. Its review envelope is described below. A record's `actor` is null once the moderator's account is erased. Denials stay on the Realm; content writes must check
Realm participation directly, and public reads remain open.

The Space home exposes Realm ban management through these native endpoints. Its personal current-ban list
is also the current `realm:ban` authority check, independent of membership or cached role labels. Each page
requests 20 records and keeps the native continuation; unavailable or denied reads never become empty lists.
The ban response's non-null `workflowId` means removal was queued, not completed. The list supplies no removal
completion status, so refreshing it cannot prove settlement. Unban permits later admission under the Realm's
ordinary rules without restoring membership or changing follows; existing removal work may still be pending.
A role-conflict response asks for genuine owner/moderator role removal before another ban attempt.

### Current ban review page

`listBans` remains the producer for `GET /v1/realms/{realmId}/bans`. Existing `items` and `next` consumers keep
all four native record fields. `account` and `moderator` present only Accounts' current bounded public identity
projection. A concealed/deleted/missing identity has the label `Account`, the operational account key and no
link; the ban remains visible. A native null actor stays null, including after moderator erasure. No biography,
operator identity, authentication state, private profile or former handle enters presentation. Accounts continues
to decide disclosure; Realm moderation never broadens its public identity projection.

Decision: `selectedAccountId` is an optional exact current observation independent of list continuation; context
requires both ordinary Realm and host Space reads, and a changed observation withholds the whole page for exact retry.

The default limit is 20, maximum 100. `selected` is `not-requested`, `current` with the actual current ban, or
`absent` with the exact account key and its permitted presentation. Absence is operational absence after native
ban admission, including after unban. The effective instant and internal transaction identity qualify the current
episode; replacing it during hydration cannot substitute a new reason or moderator. There is no receipt/history
lookup. The selection does not enter cursor binding and never moves the raw window or `next`. Continuations bind
Realm, limit, viewer, client, delegation, authentication epoch, native partition epoch and Realm/Space lifecycle
and source epochs. Invalid or stale cursors retain the native typed errors. Retry uses exactly the same cursor and
selected key; an explicit restart omits the cursor. No count is inferred from exhaustion.

`viewer.unban` identifies `realm.unban`, its actual `realm:ban` action and Realm resource. Its viewer binding
includes account, client, delegation and authentication epoch. Each row's `unban` identifies that exact account
and observed effective instant for confirmation. This advice is a current observation, never a permission token
or optimistic mutation. The existing command always reauthorizes. A failed required read returns a native error,
never a successful empty page or uncertain permission. `removal.state:unavailable` explicitly means this read
cannot establish workflow completion; the ban receipt remains the only existing workflow-reference disclosure.
Unban restores neither membership nor grants. Reading never retries a write or generates an idempotency key.

`context` is `available` with the current Realm/Space titles only when both installed ordinary readers permit
it, or `concealed`. Source failure withholds the page. Realm/Space lifecycle and heads, raw page including
lookahead, optional exact selection, caller standing/session epoch, permitted identities and ordinary read
observations are checked again after hydration. Empty pages use the same final protocol. Preparation releases
all foreign homes before Realm checkout. This is a sequence of current native observations across homes, not an
atomic cross-home snapshot. A later command still needs a new inspection and its normal native admission.

The existing Web reader/control and its caller lifetime retain list, selected-write uncertainty and cursor
recovery. `ban-review-page-schemas.ts` owns the mounted `realm.bans` response/query and exports
`BanReviewPage`, `BanReviewPageItem`, `BanReviewIdentity` and `BanReviewPageQuery`. Installed client delivery
must carry this mounted declaration through the normal generator; these source exports alone do not publish
the installed contract. `test/community/ban-review-page.test.ts` covers populated, erased identity, empty/current
absence, unavailable and intervening change outcomes. Rendered review belongs to the existing Web owner.
The private-name fallback reference is `legacy-final:apps/web/features/realm/roster.ts`; refusal/exact receipt
references are `legacy-final:apps/web/features/realm-appeal/{ban-read,reading}.ts`. The other behavior reference
is `apps/web/features/realms/{realm-members.tsx,data/membership-preconditions.ts}` in the older Rezics checkout.
These supply user behavior only; current native commands retain authority.

Publication uses the normal native generator; consumers derive the response and query from the installed `realm.bans` route, rather than maintaining a forked DTO.

#### Cost: current ban selection and inspection

- Touches: each successful read retains its initial and final Realm/host source, raw window, optional exact
  selected episode and caller state through both observation rounds. Two Realm snapshots each run BEGIN/COMMIT;
  a failed snapshot charges its dispatched reads and ROLLBACK/release. Four native read-time preparations cover
  the initial/final Realm checks and two optional context rounds; `releaseOperationalTime` removes only a WeakMap
  entry and executes zero SQL. Six independent Access checks prepare fresh clock/deadline and candidate state,
  then evaluate their native formulae. The mounted x-rate-limit stage costs one counter statement. The GET does
  not invoke a worker, receipt lookup, command fence or membership writer; only the separate ban/unban command
  charges its actual registered runner and removal phases.
- Bound: with page limit p<=100 and selection flag s in {0,1}, the reader statement expression is
  `34+2s+2I+b1+b2+sum_i(3+d_i+k_i+V_i)` across six Access checks. Here I is the actual count of distinct routed
  identity queries over global chunks of at most 100 keys in each of two rounds; b1 and b2 are the protected
  delegated-ban probes in the two context rounds; d<=1, k<=2 and V<=1000k are the admitted assignment, inverse
  and matching-group proof work for each check. The maximal admitted expression is 12,478 reader statements,
  source-derived rather than a measured ceiling. Mounted SQL adds the one rate counter and actual authentication
  reads (one Account read, or three statements when `requested_by` is present), with JWKS/network and serialization
  bytes retained separately. Each raw round examines at most p+1 current keys and p+1 exact temporal payload
  keys, plus the optional selected pair; both rounds together are 2(p+1+s) pairs, independent of closed history.
  Payload reason admits 1024 Unicode scalars (4096 UTF-8 or 6146 escaped JSON-string bytes), and the cursor admits
  4096 wire bytes. The reader compares the whole raw window and never fills from history or retries a command.
- Growth check: `test/community/ban-review-page.test.ts` pins mounted bounds and readback; native physical
  selection plans and independent retained-history growth are in `test/community/ban-review-page-growth.test.ts`.

Decision: create production Auth with the captured Auth pool before its handler is constructed; each cold growth request receives a fresh verifier/cache.

#### Cost: ban identities and currentness

- Touches: each of two real `readPublicIdentities` rounds materializes the exact routed current identities for
  the page, lookahead and optional selection. The keys are split into global chunks of at most 100, so one route
  can occur in multiple chunks. Two caller-state reads retain the full Account/session observations; both Access
  rounds retain delegation, assignments, grants, roles, fences and group proofs. The native Auth verifier and its
  database use the pool supplied when the fixture constructs the handler; the growth fixture captures that pool
  through a second `GrowthDatabase` around the same awaited request. Each database is catalog-validated alone,
  then foreground costs are added per invocation before repetition summaries. No broad account lookup, profile
  history scan, membership reader or workflow-status probe is added.
- Bound: before deduplication u<=2p+2<=202; for each observation round, I is the sum of distinct routes present
  in each actual global chunk and I<=u. Thus identity SQL is 2I across both rounds, not the sum of per-home
  ceilings. Each full dependency row admits 26,624 JSON UTF-8 bytes; two retained rows per key cost at most
  2u*26,624 = 10,756,096 bytes before route maps, canonical copies and final projection. Output omits
  authentication/operator fields. Bound every copied display name, handle, label, repeated moderator and reason
  at source limits; JSON escaping is included. The 12 MiB response cap applies after materialization and does not
  cap peak allocation. Keep cumulative dependency, map/canonical, serialized response and wire bytes as separate
  terms, including the permitted full Realm/Space observations and cold JWKS response; do not infer them from
  `responseBytes` alone.
- Growth check: `test/community/ban-review-page.test.ts` uses native Accounts and failure/change barriers;
  `test/community/ban-review-page-growth.test.ts` fixes represented homes and text while growing unrelated and
  historical bans, unrelated native identities and closed authority intervals. It captures the production Auth
  pool around the same awaited mounted request, validates each database catalog separately, adds both captures
  before repetition summaries, and retains database, serialized HTTP and cold JWKS byte costs. The installed
  identity producer reads the current Account key directly; it does not traverse former profile or handle history.
  All native identity and authority plans retain missing-plan refusal.

#### Cost: optional context and serialization

- Touches: each of two optional-context rounds prepares and verifies the ordinary Realm and host Space reads,
  reauthorizes each through its own Access preparation/formula, then compares the source and, only when both
  reads permit disclosure, loads the exact current Realm and Space titles. The complete Realm revision is
  hydrated by native eligibility even though only its title is disclosed. Both observations are retained and
  compared in final disclosure, including identity, lifecycle and head; a changed source withholds the page.
  This does not borrow management grants or inspect a management-only projection.
- Bound: the two context rounds add 10+b1+b2 statements: six ordinary Realm/Space eligibility statements plus
  two Realm and two Space Access checks, with up to one protected actor/principal current-ban statement per
  round. Their bounded plan declarations total at most 26 source keys and 86 finite rows when both protected
  probes reach two identities. Each permitted round reads at most one exact title row per home; title limits are
  1024 Unicode scalars, 4096 UTF-8 bytes or 6146 escaped JSON-string bytes, with a full 16,384-byte dependency
  ceiling. Failed, denied, concealed and stale paths retain only work actually dispatched and never turn a
  required source failure into false absence. Serialize all 101 maximum records, controls, selected identity and
  context with escaped JSON under the 12 MiB wire cap while accounting separately for peak and cumulative copies.
- Growth check: `test/community/ban-review-page.test.ts` covers denied/current/changed pages and exact retry;
  `test/community/ban-review-page-growth.test.ts` supplies strict native plan coverage for the new key paths.

The same ban precedence applies to non-public boards and their descendants in a public
Realm, whether the independent grant names an account, an organization role or a
delegated actor. Content owns those board checks. Protected Realm eligibility uses
`read-ban-current.sql`: one statement probes at most the actor and principal's indexed
current keys in the Realm partition, with O(log B) work per key for B ban records.
It does not enumerate grants, boards or members. `test/community/growth-ban.test.ts`
covers both identities as B grows through 256, 1024 and 4096 records, holding statements
and returned rows constant.

## Realm ownership continuity

Access owns explicit owner roles, the last-holder leave guard, candidate ordering and erasure succession.
Self-leave acceptance in `join.ts` first completes ordinary full Access admission, then locks the native Realm
ownership source in its existing command effect. At that command's authoritative time, `resourceRoleHeld` probes
the admitted actor's direct `community.realm.owner` key solely to select `assertRealmOwnerMayLeave`. This data
never authorizes the action. Non-owners retain ordinary leave; an explicit owner needs another current open-ended
explicit owner. A scheduled expiring owner, an inferred administrator or action copies cannot supply continuity.
The existing `createRealmMembership.publish` writer repeats this sequence before a new self-leave close, under
its current restored initiator admission and its own command time. Authenticated legacy self-leave uses the same
boundary; moderator removal and account erasure keep their independent native obligations. Receipt replays still
reauthorize first and return the committed result without performing the new-effect guard again.

The native ownership error is preserved through `communityProblem` for the central HTTP mapper. Access owns the
required `RealmLastOwnerError extends ResourceAccessWriteDeniedError` export from `access/realm-ownership.ts`
and the central `PROBLEMS.realm_last_owner` definition/mapping. Those declarations are absent in this base:
the existing guard refuses generically until Access delivers them. The leave response schema binds the original
catalogue's discriminator when present, retaining the old conflict alternative without duplicating the catalogue
or manufacturing an error. The required specific response is HTTP 409, code `realm_last_owner`, title
`Realm Ownership Transfer Required`, type `https://rezics.com/problems/realm_last_owner`, `retryable:false`,
`effect_status:not_applied` and the standard `request_id`, with no owner, grant or evidence extensions. Missing
source/target, denial and source unavailability retain native generic errors. This source binding and compiler
typing do not establish native acceptance or delivery of the missing HTTP producer.

Recovery uses the existing `/access/{resourceId}` interface to grant another eligible native owner before retrying
leave. There is no delivered HTTP/UI for the native `createGrantCommands.transferRealmOwner` helper, and leave
never grants or transfers ownership automatically. Focused native outcomes are in `test/community/owner-leave.test.ts`;
the original membership and transition acceptance remains required at integration.

Per new self-leave effect, acceptance and publication each add one exact native initialization-row lock and one
direct owner-key probe. Only an explicit owner adds the guard's repeated lock of that same row and its one native
statement containing two indexed EXISTS probes (target and one open-ended remaining owner). Thus a non-owner
adds two statements and an owner four, each with constant result rows and logarithmic indexed key work. There is
no count, scan, membership expansion or additional command. Existing SERIALIZABLE retries retain the source lock
through commit and recheck concurrent grant changes; receipt returns add none of this work.

Content does not infer ownership from membership, Global grants or unavailable candidate evidence. Succession is
Realm-only. A successor's native grant and the Realm resource's returned owned-or-orphaned decision must commit
in the same Realm-home transaction. The account-erasure participant remains the sole orchestrator and ACK writer;
a Content transaction result alone never acknowledges account erasure.

The existing Realm identity stores `ownership_state`, `orphaned_at` and `claim_eligible_at`, independently of its
classification Context and Global subject identity. Orphaning keeps ordinary public/authorized reads and discussion
participation. `RealmView` exposes `ownershipState`, `orphanedAt`, `claimEligibleAt` and `governanceReadOnly`.
`realmGovernanceAuthorization` consumes existing Access admission and locks the current native Realm/head before
receipt replay or mutation. Orphaned metadata, board scheme, vote configuration, publication and board creation
are read-only even for an independently granted or Global actor. It never grants an action or changes a role.
The locked identity serializes governance against the actual succession transaction and preserves removal's
separate lifecycle check.

`requestRealmClaim(deps, actor, realmId, { idempotencyKey, deadline })` uses ordinary `realm:participate` admission and an
independent current `realm:read` check. It accepts only an orphan whose original `orphaned_at + 720 hours` has
elapsed at authoritative command time. The database preserves that deadline during orphan retries. A native
pending request is unique per Realm, original orphan instant and requester; a fresh idempotency key returns the
same pending request without another event. The result is always `pending`; neither expiry nor requesting grants
ownership. Approval requires a genuine platform decision establishing a native Access owner. The native command exposes no
approval operation without that authority.

`POST /v1/realms/{realmId}/claimRequests` mounts this command as `realm.claim_request`, using the existing
`realm:participate` action and its independent read admission. It requires an account, `Idempotency-Key` and a
strictly empty JSON object. A 202 response is the native `RealmClaimRequest` directly: `realmId`, `requestId`,
`state: 'pending'`, `orphanedAt`, `claimEligibleAt` and `requestedAt`, with UTC date-time strings. The ordinary
command deadline, receipt/session transport and problem responses apply. This operational route introduces no
resource-grant declaration. A 409 requires a current-source refresh; it does not shorten or restart the original
waiting period. Approval remains a separate platform authority and is not exposed by this request route.

`readOwnRealmClaim({pool, access, clock?}, actor, {realmId, requestId?}, {deadline})` in
`realm-claim-status.ts` returns `RealmClaimStatus | null`. The closed status contains `realmId`, `requestId`,
`state: 'pending' | 'approved'`, the stored original `orphanedAt` and `requestedAt`, nullable `approvedAt`, and
`currentEpisode`. Dates are normalized to UTC ISO only for disclosure; episode identity retains native precision.
The actual authenticated account must equal the stored claimant. Current ordinary `realm:read`,
`realm:participate` and host `space:read` admission apply before the request read and again before disclosure.
Removed, hidden or denied containers return 404; unavailable native authority remains a typed failure.

`GET /v1/realms/{realmId}/claimRequests/mine` returns `{claimRequest: RealmClaimStatus | null}` for only the
current native orphan episode's exact `(route, realm_id, orphaned_at, account_id)` key. Null means known point
absence after current admission, including an active Realm with no current orphan episode. The static route
precedes `GET /v1/realms/{realmId}/claimRequests/{requestId}`, which returns `{claimRequest: RealmClaimStatus}`
for an own exact receipt. Missing, unrelated and unreadable receipts share 404. Neither route lists history.
An obsolete pending or approved receipt can have `currentEpisode: false`; approved is an original request fact,
never current ownership or management authority. These reads neither reset the thirty-day clock nor resubmit.
Accounts retains sole approval authority, source locking and account-erasure disposition remain unchanged, and
the read adds no durable payload, event or locator.

Cost per read: one locating snapshot and two admitted snapshots, each with one native partition key,
one active Realm/Space binding and one continuity key. Each admitted snapshot reads at most one request:
the existing `(route, realm_id, request_id)` primary key or `(route, realm_id, orphaned_at, account_id)` unique
key. Each admission prepares three ordinary Access decisions on released anchors, then evaluates them at one
native read time. Final disclosure repeats both source and authority; changed bindings, episode or receipt return
typed unavailability. Rows and statements are constant, with logarithmic indexed key work plus bounded native
Access work. No history, account-wide enumeration or new index is needed. Focused native outcomes live in
`test/community/realm-claim-status.test.ts`; physical, growth, replay and erasure proof remains deferred.

The approval source is `lockRealmClaimApprovalSource(tx, {realmId, requestId})`. It locks the actual current
Realm/head and exact routed `realm_claim_request`, retaining the original `orphaned_at`, `claim_eligible_at`,
`account_id` and `requested_at`. Only an active, pending, same-episode request after the original 720-hour deadline
qualifies at the native command time. Private object identity binds the frozen source to this exact live transaction;
copying its fields or carrying it to another command does not carry source custody. Missing rows return null;
stale, premature or replaced sources conflict. `applyRealmClaimApproval` rechecks those locks and the claimant's
real native owner role through Access's `resourceRoleHeld`, then clears the Realm orphan fields and marks this
request `approved` with command-time `approved_at` in that same transaction. It returns the original orphan instant.
It writes no Access grants and exposes no second approval command.

`POST /v1/realms/{realmId}/claimRequests/{requestId}:approve` delegates to Accounts' sole `approveRealmClaim`
command and returns `{claim:{realmId,requestId,claimantAccountId,state:'owned',orphanedAt,approvedAt}}`.
The delivered Accounts command checks current DIRECT Global `realm:approve_claim` before receipt replay, prepares
current claimant admission and writes the real owner grant. Source locking belongs to the new effect after receipt handling, allowing
a successful replay after its own state change. Resource-only event payloads do not remove actor, principal or
claimant custody: the native command owner must declare their actual associations through shared-history facilities.
The route consumes its exact public approval result directly; it does not invent command metadata or a second
approval operation. No role gains approval or restoration actions through this seam.

`lockRealmOwnershipSource(tx, realmId)` locks the existing continuity fields, including a removed Realm for mechanical
cleanup. `applyRealmOwnershipSuccession(tx, source, erasedAccountId)` itself calls Accounts'
`readAppliedRealmErasureSuccession(tx,{realmId,accountId})`; no caller decision, timestamp or structural proof is
accepted. Accounts owns verification of the actual applied erasure root, tombstone, candidate, grant and source
binding. A missing applied result remains unavailable. The state update preserves an existing orphan episode at
PostgreSQL timestamp precision and verifies the exact 720-hour relation. A newly orphaned instant comes from the
original immutable Access erasure root; a genuine successor grant returns owned state with null orphan fields.
`eraseAccountRealmOwnership` in the existing membership-erasure module consumes the delivered Accounts
`createRealmOwnershipCommands` constructor. Its native `erasureSuccessionAuthorization` prepares and releases the
immutable account root before Realm checkout; the body calls `applyErasureSuccession(tx)`, which invokes this
Content state port before returning in the same writer. The exact native `readAppliedRealmErasureSuccession`
implementation replaces the provisional reader. Pending results retain the membership producer's owner locator;
terminal replay returns the original operation without minting a new applied proof or resetting the orphan episode.
The delivered `member_locator` schema and native projector feed the default Community membership page.
The registered participant supplies installed worker Access, its trusted clock and one finite page deadline;
the page composes this segment before membership cleanup and locator retirement. Pending segments retain their
locator, skip ordinary membership cleanup and resume through the existing bounded coordinator and cursor wrap.
Ordinary non-owner memberships require Accounts' exact owner-at-root or durable-replay qualification before
deciding whether to call the segment. The required constructor port is
`qualifyErasureSuccession({resource,accountId},{deadline}): Promise<'owner-or-replay'|'not-owner'>`.
It must read the committed erasure root, release account checkout before Realm checkout, and throw on unavailable
sources; its result is selection only and never replaces native command authorization. It matches durable replay
to the same root as the exact owner interval. Decision: only a qualified non-owner takes ordinary cleanup; missing
root or role evidence fails closed and retains the locator, and authorization denial is never non-ownership.
`account_erasure_progress` is orchestration only; neither role loss nor a final ACK supplies succession authority.
The existing Community participant remains the sole coordinator and ACK writer. Native default-path readiness still
requires executed registered-path acceptance; authored composition alone does not establish it. Domain ownership
and the Cost budgets below remain unchanged and unmeasured here.

Claim requests are held in the Realm home. A request point touches one native identity/head, one full requester
key and a bounded receipt/event bundle, without enumerating members, requests or grants. The claim-requested
event extends the existing party locator: it point-reads the full Realm/request key, releases that connection,
then registers requester custody in the account home under the existing erasure fence. The existing Community
records eraser deletes the exact request under the committed account-erasure obligation. A late event uses the
same eraser and resolves its existing late-item obligation; replay reads current attribution and cannot recreate
a deleted request or locator. The account-erasure participant remains the sole ACK writer.

## Realm transition publication proof

Every positive native membership publication requires the fresh Access transition returned by inverse reservation.
Stable reservation and transition generation are separate. Under the Realm row lock the transaction writes
membership (or confirms the same live reservation), its native receipt response and an immutable
`realm_membership_proof` keyed by Realm, member and generation. The receipt binds the original operation, generation,
stable reservation, outcome and publication transaction. `authority.readTransition(client, transition)` returns
`RealmMembershipProof | null` only for this exact committed source. A closed or unrelated generation cannot publish;
a queued old writer encounters the already committed proof slot and refuses. Raw native receipt replay retains its
original digest and result.

`cancel(transition, key)` is an exact mechanical compensation command. It serializes against publication and returns
its committed publication if publication won; otherwise it commits immutable cancellation. An existing live member
is never erased to manufacture terminal absence. Ordinary `terminalize` and terminal inverse release keep their
existing authoritative rules. Cancellation consumption retains the inverse; compensation must separately commit
ordinary absence-only terminalization before terminal release. When supplied its exact generation, ordinary
terminalization also records its cancellation proof in that same transaction. The shared Accounts workflow releases
the source checkout before consuming proof on the account anchor. Publication retains the membership and inverse.

The deployment-only `certifyLegacy(transition, key)` requires adopted stable provenance under the stopped-old-writer
barrier. It certifies an exact native live or terminal source receipt, not a missing source. The normal Accounts host
registers its bounded, persisted coordinator; see [Access's transition protocol](../access/README.md#realm-transition-coordination-and-deletion-entry).
Both migrations are required before new writers start. New-generation source proofs name the full native receipt
primary key. Legacy certification instead has only its old source transaction identity; Core currently lacks a
bounded lookup for that identity. Legacy reconciliation must not be deployed until the Core owner supplies that
lookup. Transition migrations do not alter Core receipt machinery. Source proofs remain physical-custody obligations
pending real erasure producers; this protocol supplies deletion entry, not participant completion.

Cost: one active Realm lock, current membership/ban/authorization probes, one generation proof and exact receipt
binding per publication/cancellation; constant rows/statements/output with logarithmic index blocks. The native
64/512/4096 growth series in `test/access/growth-realm-membership-transition.test.ts` includes the shared workflow,
Access consumers, source proofs, transaction controls and DBOS work.

## Participation on the Space home

The Space home keeps Realm membership separate from following the Space. Public self-join and direct,
owner-selected add-member use the existing membership commands and their `202 { workflowId }` acceptance.
Protected Realms do not offer self-join; an owner admits an account through `POST /v1/realms/{realmId}/members`.
Resource roles do not create membership or a My Realms entry.

After an accepted self join or leave, the web interface refreshes `GET /v1/realms/{realmId}/members/me` and
`GET /v1/realms/{realmId}/participation` at most four times per refresh. Acceptance alone never means that the
membership changed. An unsettled or unavailable result keeps a pending state with a manual read retry; that
retry does not resend a command. A denied or hidden read is not an empty membership. Settlement invalidates
My Realms and the carrying Space's independent follow read. No workflow-status endpoint is introduced.

After a closed join, Check membership makes one current membership/admission read; only a successful read releases the closed intent, and joining still requires a separate click. Failed reads keep recovery retryable; current pending membership uses the existing bounded settlement cycle.

The follow control uses only `GET/PUT/DELETE /v1/follows/{spaceId}` through the shared Library interface.
Leave never unfollows, and an explicit unfollow remains authoritative when a later native join workflow applies
its implied Space follow. There is no Realm follow. A native leave denial remains a denial; the interface does
not transfer ownership or introduce a separate holder authority.

## My Realms current inventory

`GET /v1/me/realms` (`account.realms`) retains the account inverse, page20, scan-page20,
raw80 budget and account/operation/partition-epoch cursor. A raw key is consumed only after its
Realm-home confirmation succeeds. Selection snapshots release before native Realm observations;
no account transaction covers another home's calls. The final observation compares the exact
reservation, membership publication transaction and interval, Realm revision/lifecycle and partition epoch.
A changed selected source returns `transaction_retry_exhausted`; the client retries the same cursor.
Registration and legacy-cut completeness use Accounts' `requireMembershipInverseReady`, including
empty pages, rather than treating an empty inverse as readiness.

Decision: omit concealed memberships after bounded selection, consistent with the ordinary own-membership
read; never refill the disclosed page or retain its previously readable name or presentation.

Each disclosed item retains `realmId`, `name`, `role: member` and adds a closed `current` projection:
description, optional avatar/banner, Realm destination, separate carrying Space identity, current membership
start and independently checked participation. Realm entry uses `readRealm` with its real resource eligibility.
Presentation uses `readCommunityPresentations`, grouped by native partition, including that owner's source and
optional media checks. An optional absent image is `none`; an unavailable optional producer is `unavailable`.
Operational errors fail the page and preserve the caller's continuation. No cached description or image fallback
is permitted. No count, rank, join, follow, owner or administrator status is inferred.

`createRealmViewerObservation(deps: Pick<OwnRealmsDependencies, 'pool' | 'access' | 'clock'>)`
is exported from `own-realms-viewer.ts`. Its returned async function takes
`{ actor: Actor, realmId: string, deadline: number, selected?: OwnRealmMembership }` and returns
`null` for concealment or `{ current, finish() }`. `current` carries the actual Realm, native
Realm/Space revision/lifecycle/partition source references, selected reservation/publication/interval,
ordinary readability, participation and action advice. `finish()` re-prepares native Access and returns
those actual final values, or null for concealment; changed readable source, episode or advice throws
`transaction_retry_exhausted`. Comparison values and the original selection are captured privately.
The first advice round must still match the locating read's original Realm head; a concurrent
revision cannot refresh that witness. `finish()` performs a second complete ordinary `readRealm`
before the final source round, returning null on concealment and refusing a changed readable head.
An assembler must finish after its dependent observations and serialize the final values. This is a
released observation protocol, not an atomic cross-home snapshot or a command reservation.

The mounted closed DTO remains `ownRealmsResponseSchema` in `schemas.ts`, with reusable
`realmViewerActionSchema` and `realmViewerActionsSchema`. `current.viewer.membership` includes the
native reservation and publication transaction, so a rejoin is a distinct episode. `current.actions`
is current advice with `enter`, `manage`, and `leave`: available method/path/body/expectedStatus,
prohibited reason, or a specific unavailable reason. Management requires native `realm:manage`,
ordinary Realm and carrying Space reads and writable native governance. Leave checks the mounted
writer's actual `realm:join` action on the exact Realm and selected current membership. Direct native
ownership data only selects the command invariant; it never supplies permission. No presentation join
literal, Account role prefix, follow or Collection authority is consumed.

Decision: report `unavailable: last_explicit_holder` for a sole current owner; retain DELETE advice for a permitted owner and the SERIALIZABLE command guard.

Protocol examples (IDs stand for exact native returned IDs): a member has available enter and DELETE
membership advice, prohibited manage, and its reservation/publication pair; an authorized owner member
has available GET settings advice and the specific unavailable leave variant. An empty inventory is
`{ items: [], next: null }`; concealed selected rows are omitted without refill. Failed dependencies
remain failed requests, never an empty inventory. Revocation returns the native authentication/Access
failure or conceals the entry; readable source or episode change returns the retry problem and retains
the caller's original cursor. Optional image unavailability remains independent of supported actions.

Realm Home installs this factory through its existing reader. Publisher445 receives the closed mounted schema and
source handoff for the existing Web receiver; official installed output remains a separate prerequisite.

### Cost

- **Touches:** Let R be consumed inverse candidates, F fetched candidates (including the optional unconsumed
  lookahead), S selected memberships and H represented native partitions. Accounts performs initial/final readiness
  and partition checks plus at most four released scan transactions. Inverse traversal uses the physical
  `(route, account_id, kind = realm, group_id > after)` prefix and full-key ordering. Every confirmation uses
  `(route, realm_id, account_id)` with `upper_inf(valid)` before the exact Realm head and revision joins. There
  are R selection and S final membership observations, each with its own partition/control round. Hydration adds two complete ordinary Realm reads, two viewer source rounds and two
  independently timed participation checks per initially readable selected item. Each source round prepares/evaluates ordinary
  Realm read, plain manage, plain join (leave), and carrying Space read on native resources, with one
  released REPEATABLE READ transaction, authoritative time, partition read, Realm head, exact lifecycle
  binding, exact membership episode and, when leave is authorized, five native direct-role key probes. For an
  explicit owner with leave authority, the initial and final rounds also run the one-row holder observation at that
  same T and retain the current owner's transaction ID as its exact source witness.
  A denied manage skips host evaluation; a non-member skips ownership probes. Preparation is outside
  the source checkout, including every native Access actor/account/client/delegator/consent dependency. Each home composes
  one native presentation batch: two Realm/Space/membership/ban/Access snapshots, two native count reads per
  visible Realm, exact rules hydration and up to two media sources per Realm. Discarded count/rules still cost work.
  Nested Access prepares, account/session checks, container bindings, native membership proofs, ban checks and
  optional media/currentness are charged to their producers, including denied, empty, changed and retry attempts.
- **Bound:** F <= 80, R <= F, S <= 20, H <= S. Account selection/finalization has at most six transactions,
  twelve readiness/partition data statements, four inverse statements and twelve BEGIN/COMMIT controls:
  28 local statements in total. Confirmation has at most
  100 released snapshots, 100 partition reads, 100 full-key membership/head statements and 200 controls; each
  statement addresses at most one open interval, head and exact revision. Each of R+S confirmations
  contributes four statements, including its two transaction controls, up to 400 in total. Failed attempts repeat these terms,
  never increase F to fill disclosure. Viewer hydration adds at most 40 owner holder statements for S <= 20,
  one initial and one final statement per selected owner with leave authority. Each target is a current exact-key
  lookup through `resource_role_grant_point_lookup`; the other-holder probe uses the current-only
  `realm_owner_continuity` GiST predicate (`valid @> T` and `upper_inf(valid)`), not a LIMIT-only claim. Each
  result materializes one row and a 36-byte source transaction ID. Presentation and Access retain their native
  admitted bounds; this is not a fitted ceiling on their physical work. Realm producers admit 1024 title and 4096 summary code points: at most
  4096/16384 UTF-8 source bytes, 6144/24576 JSON string-content bytes with JSON.stringify escaping, and 4096/16384
  bytes of UTF-16 character storage, before object overhead and each retained copy. Twenty items therefore admit
  409600 source bytes or 614400 JSON text bytes for these two fields alone. UUIDs add 36 ASCII bytes per occurrence;
  dates and enum punctuation are fixed. Image summaries admit two slots and twelve variants per slot. The existing ordinary media
  producer guards thumbhash at 32 raw bytes before base64 encoding (44 ASCII bytes) and accepts
  only a seven-byte hexadecimal average color; invalid optional metadata is null. This is the
  shared settings producer, not another My Realms media producer. Variant fields retain that
  producer's descriptor admission bounds; credit is null and performs no credit-account lookup.
  Optional rules and media still have separate source snapshots and intermediate copies. Their full wire/bind,
  retained-memory, executor/control/fence, warm/cold release and runner terms remain unproved; do not substitute the
  output size or a LIMIT for those bounds. Viewer hydration adds at most 40 source transactions and 80 BEGIN/COMMIT controls,
  40 time reads, 40 partition reads, 40 Realm head reads, 40 Realm/Space bindings, 40 membership statements
  and 200 direct-role probes, plus at most 40 owner holder statements. Each source binding materializes at most one Realm, one Space and no
  publication (subject is null); role probes materialize at most five rows per round and each owner holder result
  carries one exact source transaction ID. Two source records,
  two membership records, two bounded advice records and one private source/episode copy are retained
  per handle, in addition to the native presentation's materialized and retained bytes. The owner source ID is
  retained in the initial and final private records and in one serialized source comparison, but never enters the
  mounted DTO. Source references
  contain only fixed UUIDs, integer placement and decimal lifecycle versions; advice paths are bounded
  by one UUID and fixed operation text. Each item serializes three advice variants and one selected
  reservation/publication pair. Permission preparation/evaluation retains the native producer's physical
  row and byte terms, rather than replacing them with these output caps. No authority pool is held across
  presentation, participation or a foreign read. This engine creates no new command or runner work; completed
  membership transitions retain all work in their native producers.
- **Growth check:** The existing inventory suite retains native page20/21, stale inverse, leave, account cursor
  rejection and growth cases. `own-realms-current.test.ts` adds the installed client, current title/description,
  empty and incomplete-cut recovery, separate Realm/Space identity, actual leave/rejoin and removed-host disclosure.
  Complete three-scale 256/1024/4096 coverage of independent histories, sparse/raw80, provisional/stale/retry,
  image replacement, final credential/authority races and all participating pools/runner phases remains in the
  continuation. No growth pass or complete nested physical bound is asserted by this partial delivery.

## Account erasure

The account-partition `party_locator` projects the committing ban, membership-operation and curator-verdict
events. The migration backfills existing records. Each locator names the source's exact owner-partition key;
source rows remain authoritative. Each locator effect locks the account's `community.erasure_fence` row in the
same transaction as its locator write. A pre-close locator is visible to later pages; a post-close effect writes no
locator, records an Access late item, minimizes its source and resolves the late item after that source commit. The
community participant closes the fence before paging. Each locator effect adds one locked point read, or one insert
for an account's first locator; closing the fence is one statement. Erasure runs as the platform under the committed
community erasure obligation, without restoring an initiator or holding a connection or transaction across
partitions.

`eraseAccountCommunityRecordsPage` reads at most 50 locator keys and applies these dispositions:

- Delete bans against the erased account: its identity can never return or be reused. Access owns its denials.
- Set the actor of bans issued by the account to null, preserving the ban. Empty reasons immediately when the ban
  began at least 183 days before the account's erasure T. More recent reasons are the single retention exception:
  store `community.realm_ban`, field `reason`, purpose complaint handling under Regulation (EU) 2022/2065,
  Article 20, expiry each ban's start plus 183 days. `reasonsKeptUntil` reports the latest expiry on a page;
  the participant folds it across pages.
- For terminal membership workflows, null every operation field naming the account and erase client, scopes,
  requested-by and authentication/delegation details. Read the workflow's current DBOS status using its committed
  creation id, and use `TERMINAL_WORKFLOW_STATUSES` from `work/retention.ts`. Known non-terminal workflows remain
  pending, with their operation and locator unchanged.
- A membership operation with no workflow history is pending until it is strictly older than the one-hour
  `MEMBERSHIP_OPERATION_ENQUEUE_GRACE_MS`. Evaluate this grace at each page's authoritative processing time,
  so a later page can finish pending work while the account's erasure T remains fixed.
- Set curator verdict actors to null, preserving their verdicts.

The creating request commits the membership operation and enqueues its workflow before answering. Its request
is bounded by `DEFAULT_REQUEST_DEADLINE_MS`, far below one hour. Workflow retention deletes only terminal
workflows, at least seven days after completion. A row without history past the grace therefore either finished
long ago or was never enqueued. A later enqueue can only come from an idempotent retry of the creating command
or a ban resuming removal with its durable key. `loadOperation` refuses operations whose account or actor fields
are null, so authorization fails closed before any reservation.

Handled locator rows are deleted except `ban_actor`, which stays until the reason expiry purge handles it.
`purgeAccountBanReasonsPage` seeks at most 50 `ban_actor` keys due at or before `asOf`, ordered by `due_at`.
It empties each reason at that ban's own expiry, leaves the ban in place, removes the locator and reports the
earliest remaining expiry as `nextDueAt`.

The tombstone consumer closes the account's locator fence before paging memberships, archived revisions,
community records and notices, then waits for Rating's own tombstone purge. It rechecks any pending phase and the
rating completion status after a durable ten-minute delay. Before acknowledgement it probes the member and
revision locators, party locators, inbox notices, seen marker and unresolved late-item frontier. It allows only
`ban_actor` locators whose reason is covered by the one retention exception. An account with no located community
rows and no prior vote is acknowledged as `community: none`; otherwise it is `community: erased`. Replayed
tombstones resume the same account-and-phase workflow IDs and the acknowledgement is idempotent. Late locator
effects after fence closure minimize their source and resolve their own late item; the consumer repeats its proof
until that work is visible as resolved.

The participant retains only ban reasons from the last 183 days, for complaints by the banned person. The single
exception is `community.realm_ban.reason`, with purpose “Ban reasons kept for complaints by the banned person,
open six months after each ban” and the latest retained ban's own expiry. Each ban reason is emptied at its own
183-day expiry; the ban row and Access denial remain. An acknowledgement records only this participant's outcome
and exception. It does not imply that the account-wide erasure is complete while other participants or the global
effects frontier remain pending.

Memberships are closed and erased. Archived revision text is erased; current revisions and creator IDs remain under
item 5 of `docs/deletion.md`. Bans against the account are deleted. The account is removed from bans it issued,
membership operations and curator verdicts. The recent ban reason above is the only Community retention exception.

### Community account-erasure phases and cost

| Phase                             | Touches and bound                                                                                                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fence close                       | One locked account-key read and one fence update in the account's partition. Each locator effect adds one locked account-key read, or one first-account insert.                                                                           |
| Memberships                       | The membership producer's bounded page plus one account-partition progress-row read and update. Total work is linear in this account's Realm membership data.                                                                             |
| Archived revisions                | At most 50 account-partition revision locator keys per page, owner-partition archive clears, and one account-partition locator cleanup and progress update. Total work is linear in the account's archived revisions.                     |
| Community records                 | At most 50 account-partition party locator keys per page and one source point update or delete per key; membership operations add one operation-key read and one DBOS status read. Growth stays independent of unrelated Realms' records. |
| Notices                           | The notice producer's bounded inbox page plus one account-partition progress-row read and update. Total work is linear in this account's notices and seen state.                                                                          |
| Rating wait                       | The rating completion read uses constant indexed probes; no rating rows are copied or purged by Community.                                                                                                                                |
| Locator proof and acknowledgement | Constant locator existence probes, one account-partition progress update and one Access acknowledgement command.                                                                                                                          |
| Ban-reason expiry                 | At most 50 due `ban_actor` locator keys per page, one owner-partition reason clear per key, then locator removal and one earliest-expiry indexed seek. Total work is linear in this account's retained reasons.                           |

Each workflow step commits one bounded command per partition and releases its connection before crossing partitions or
waiting. Progress is keyed by the account in its home partition. Total work is linear in that account's own
community, rating and notice data; no step scans unrelated Realms or account histories.

## Realm home shelf

The Space and Realm home adopts the reach-every-item and curate-existing-subject slices from
[the community design](../../../../docs/research/content-realms-spaces-design.md). Boards and publications retain
separate native cursors and explicit Load more actions, with fixed windows of 20 boards and 12 publications.
An empty window with a continuation is not an empty directory. Continuation denial, dependency failure and expired
cursors have distinct visible states; only an explicit reload restarts a list. Cursors retain their original
credential mode and native viewer binding. The existing bounded subject-summary reads are reused without an
additional publication-head read per card.

A transient read failure retains the admitted window and cursor. Retry repeats the failed request, including a
first-page refresh when the retained window is exhausted; only its successful response replaces that window.
Denial clears the old disclosure, and Realm or session retirement hides it. Supplied board descriptions are retained
on every page from the bounded list response, without per-board reads.

Curation uses `POST /v1/realms/{realmId}/publications` with `{subjectId}`, or the existing `:withdraw` and `:reject`
commands. Native `realm:publish` and subject readability authorize each command, including receipt replay.
Membership, `realm:manage`, ownership elsewhere and Context editorial authority never substitute for that check.
Loaded publication IDs supply current-head CAS; returned decision heads permit an explicit republish during the
visit. An uncertain reply retains the exact action, subject, expected head and request key for retry. A native
409/412 reads that subject's currently adopted head once and requires an explicit decision before retry with a new
key. A withdrawn, rejected or unreadable head is not exposed by the existing point read; the interface offers a
truthful reload state instead of inventing a head or silently overwriting another curator's decision.

A confirmed decision updates the same subject on this Realm shelf. It never changes Global identity, ownership,
facts or Context grants. Subject links retain their canonical Global destination and explain that fallback until
the actual [Semantic Realm-page binding](../../../../docs/subject-pages.md#realm-context) is delivered. A Realm query
parameter or a raw Context override is not a substitute for that binding.

## Following Space destinations

Commerce's native FULL follow producer calls Community's bounded Space target batch for the selected Space UUIDs.
One page selects at most 100 current Space heads and their exact revisions in one routed batch. Addressed rows resolve
all exact active address claims in one released address-anchor batch, then the final viewer-action transaction
rechecks the Space head, lifecycle version and address. A non-null address without its exact active claim is stale
and never falls back to a Realm. With a null address, the batch may select the current active Realm carried by that
Space; the final transaction rechecks both exact heads, both lifecycle versions and the carried host before returning
Realm actions. A fallback row checks `community.space` and `community.realm` together in that transaction, so Space
read authority is still required for the followed target. The existing Community viewer-action resources supply
only currently admitted operations for the selected destination. Missing, inaccessible, changed and unsupported
targets produce explicit unavailable destination and action values. Following does not grant Realm membership or
permission.

For a page of `P <= 100` rows, `D` rows have non-null addresses and `R` rows use a Realm fallback. Assembly reads one
Space/head batch, at most one active-claim batch, and at most two viewer-action batches of at most 100 references;
each Realm fallback contributes its Space and Realm reference to the same batch. Each batch retains the mounted
resource/action catalogue limits, authority preparation, gate lookup, final repeatable-read transaction, response
serialization and cleanup. Thus nested Community work is bounded by the page, not by one network or database
authority request per row. Existing Subject and Collection FULL readers remain unchanged.

## Sitemap feeds

`GET /v1/sitemap/realms` returns `{ id, lastModified, canonicalDestination }`. A live, PUBLIC,
independently anonymous-readable Realm owns its carried-home family in this feed. Its host Space must
also be live and independently anonymous-readable. When that Space's current head address has an exact
active native claim bound to that Space, the closed destination is
`{ kind: 'space', spaceId, address }`. When the otherwise eligible host has no head address, it is
`{ kind: 'realm', realmId }`. A non-null head address with a missing, pending, reserved or foreign claim
is incomplete or stale and suppresses the family; it never becomes a Realm fallback. Denial, removal,
missing heads and failed dependencies also never become fallback or change a Context pointer.

`GET /v1/sitemap/spaces` retains `{ id, address, lastModified }` and emits only independently
anonymous-readable, live addressed Spaces with an exact active address claim and an empty native carried
Realm slot. Any occupied slot suppresses this entry, including protected, unreadable and removed Realms.
Thus a public carried Realm and its host appear exactly once, in the Realm feed. The unique same-home
slot and exact current lifecycle/heads establish ownership; clients do not infer it from request flags.

Both are public server-to-server feeds evaluated as an anonymous reader, even when a staff bearer is
present. Community owns closed item/response schemas; ordinary Board sitemap items are unchanged. The
route response types expose the handler's tagged destination to generated API/client contracts. Web's
existing sitemap consumer owns locale/domain/path construction from this native destination; the kernel
supplies no URL. Both feeds use keyset cursors and
may return fewer items than requested when candidates are skipped. Pages may contain up to 1,000
items, an exception to the shared list maximum of 100. Their positions use the shared opaque list cursor contract in
[`../tokens/list-cursor.ts`](../tokens/list-cursor.ts), bound to the feed route, anonymous viewer and empty query.
`lastModified` is the current Space head revision time for standalone Spaces; a Realm family uses the
latest of its Realm head, host Space head (including address changes), and newest board source time.
No history walk or observation timestamp supplies modification time. Realm and Space items come in
strictly increasing native source `(route, id)` order; destination choice never changes item identity
or cursor position. Each page examines at most `4 * limit` candidates without refilling. Suppressed
candidates advance the signed source cursor, so sparse or empty pages can still have `next`.

Each candidate has a fixed bounded same-home Realm/Space/head/slot neighborhood and anonymous Access
checks before and at final disclosure. Address validation uses one independently anchored exact claim
lookup, released before the final home read. That read rechecks native lifecycle, slot, public visibility,
and unchanged source/host head versions after the address lookup. No cross-home connection is held,
no cross-home join or per-item HTTP request occurs, and no memberships, threads, descendants or history
are scanned. Derived cost is `O(limit log R)` for `R = N + U*t + M` with a fixed statement shape per
candidate kind. Existing growth suites remain post-integration evidence with their original bounds.
Their addressed positive fixtures install actual `community.space_address_claim` rows: the normalized
head address at its SHA-256-derived route, in `active` state, bound to the exact Space ID. Revision
address text alone grants no eligibility. HTTP walking checks the union of both feeds so each carried
public family occurs once while standalone Spaces remain present and denied or removed chains stay absent.

## Addressed community setup

The served `/realms/new` setup entry launches a Space home through the ordinary Space creation,
address, Realm creation/settings, board-scheme and first-board commands. The Space home links to
setup only after a private current viewer-action read permits a relevant operation; the personal
Realms page also exposes the creation entry. The existing home regions remain separate.

Setup resolves an existing readable Context by its ID and existing `skos:ConceptScheme` and
`skos:Concept` subjects by their IDs. It shows their returned labels before selection. Realm
creation grants neither Context nor Global authority and creates no membership. Scheme membership,
participation and all command authority remain current server checks, never client certificates.

Each step uses its own command key and returned IDs. Space address, Realm settings and scheme
writes use the returned revision as `If-Match`. An uncertain response retains the entire original
command and key for replay. A definite conflict offers an explicit current-head refresh while
retaining created identities and entered values for review before the next command. A saved
address links to the actual Space home; a returned first-board ID links to that board. Setup does
not define role removal or succession policy.

The setup snapshot performs at most a Space point read, its readable carried Realm point read,
and one viewer-action batch of at most two resources. Each selection is one existing point read;
there is no catalogue, grant, membership or descendant scan and no per-card request fanout.

## Cost

| Operation                                                    | Touches                                                                                                                                                                                                                                                                                                                                                  | Bound                                                                                                                                                                                                          | Growth check                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approve Realm claim source/state                             | One current Realm/head lock, one exact routed request lock, one native owner-role point read and two conditional updates in the same Realm command; Accounts separately owns bounded authorization/grant/receipt/history work.                                                                                                                           | Constant rows and statements; indexed seeks in Realm, request and native grant indexes; no requester, member or history enumeration.                                                                           | Focused source identity, rollback, real approval and replay cases in `test/community/realm-orphan-continuity.test.ts`; physical growth proof remains deferred.                                                                                                                                                                                      |
| Apply Realm erasure continuity                               | Native constructor preparation on the released account root; one Realm/head lock including removed lifecycle, the Accounts-owned exact applied-result read and one conditional Realm update retaining the original episode.                                                                                                                              | Constant Content rows and statements per Realm; no membership, grant, account-progress or history scan. Accounts owns its bounded candidate/frontier preparation.                                              | Original-root, native segment rollback and stable-orphan retry cases in `test/community/realm-orphan-continuity.test.ts`; `test/community/growth-realm-erasure-continuity.test.ts`: “Realm erasure continuity stays bounded at 256, 1024 and 4096 unrelated rows and retained revisions”; default membership producer integration remains deferred. |
| Create Space                                                 | Global admission and authorization; one Space insert, first revision insert, creation receipt and fixed native grant initialization in the Space partition.                                                                                                                                                                                              | Constant rows and statements; logarithmic blocks in partition and Space population.                                                                                                                            | `test/community/growth-space.test.ts`: “Space ${operation} stays bounded at 256, 1024 and 4096 Spaces and their revisions”.                                                                                                                                                                                                                         |
| Update Space                                                 | Space authorization and exact head read; one revision insert and head compare-and-set, with receipt in the Space partition.                                                                                                                                                                                                                              | Constant rows and statements; logarithmic blocks in partition and revision population.                                                                                                                         | `test/community/growth-space.test.ts`: “Space ${operation} stays bounded at 256, 1024 and 4096 Spaces and their revisions”.                                                                                                                                                                                                                         |
| Read Space with its carried Realm                            | Space read and authorization; exact head read, one carried-Realm slot lookup, and at most one Realm head read with its ordinary read authorization.                                                                                                                                                                                                      | Constant rows and statements; logarithmic blocks in the Space and Realm indexes.                                                                                                                               | `test/community/growth-space.test.ts`: “Space ${operation} stays bounded at 256, 1024 and 4096 Spaces and their revisions”.                                                                                                                                                                                                                         |
| Public Space eligibility                                     | One prepared Space point read and one current Space/head verification at Access's authoritative time.                                                                                                                                                                                                                                                    | Constant rows and statements; logarithmic blocks in the Space indexes.                                                                                                                                         | `test/community/growth-space-address.test.ts`: “address claim, change and resolve stay bounded as addresses, Spaces and handles grow”.                                                                                                                                                                                                              |
| Claim or change Space address                                | Routed handle point read; pending claim write; Space head read, revision insert and compare-and-set; address activation and, on change, reservation of the old claim. Each phase is a single-partition command.                                                                                                                                          | Constant rows and statements per step; logarithmic blocks in address, Space and handle indexes.                                                                                                                | `test/community/growth-space-address.test.ts`: “address claim, change and resolve stay bounded as addresses, Spaces and handles grow”.                                                                                                                                                                                                              |
| Resolve Space address                                        | Active address point read followed by the Space's normal read authorization and exact head read.                                                                                                                                                                                                                                                         | Constant rows and statements; logarithmic blocks in address and Space indexes.                                                                                                                                 | `test/community/growth-space-address.test.ts`: “address claim, change and resolve stay bounded as addresses, Spaces and handles grow”.                                                                                                                                                                                                              |
| Create Realm                                                 | Shared admission for Global, host Space and Context checks; exact host and slot reads; prepared Context evidence and verification; Realm identity, first revision, receipt and fixed grant initialization in the host partition.                                                                                                                         | Constant rows and statements; logarithmic blocks in the host partition, plus bounded Access checks.                                                                                                            | `test/community/growth-realm.test.ts`: “Realm ${operation} stays bounded across growth scales ${scales.join(', ')}”.                                                                                                                                                                                                                                |
| Update Realm                                                 | Realm authorization and exact head read; supplied Context adds one prepared evidence read and point verification; one revision insert and head compare-and-set.                                                                                                                                                                                          | Constant rows and statements; logarithmic blocks in the Realm partition, plus bounded Access checks.                                                                                                           | `test/community/growth-realm.test.ts`: “Realm ${operation} stays bounded across growth scales ${scales.join(', ')}”.                                                                                                                                                                                                                                |
| Read Realm                                                   | Exact Realm head read during public eligibility; protected reads also evaluate the native `realm:read` grant.                                                                                                                                                                                                                                            | Constant domain rows and statements; logarithmic blocks, plus bounded Access checks for protected reads.                                                                                                       | `test/community/growth-realm.test.ts`: “Realm ${operation} stays bounded across growth scales ${scales.join(', ')}”.                                                                                                                                                                                                                                |
| Publish, withdraw or reject a publication                    | Admission and Realm authorization; exact subject-slot and current-head reads; one append-only publication record and slot/head change in the Realm partition, with receipt.                                                                                                                                                                              | Constant rows and statements per command; logarithmic blocks in Realm and subject indexes.                                                                                                                     | `test/community/growth-publication.test.ts`: “publication writes and pages stay within their bound across growth scales ${scales.join(', ')}”.                                                                                                                                                                                                      |
| Read or list publications                                    | Read one subject's current publication slot/history or keyset-page a fixed limit of Realm publications, with the corresponding exact Realm and subject reads.                                                                                                                                                                                            | Constant rows for a point read; linear rows in page limit for a list; logarithmic blocks in the relevant indexes.                                                                                              | `test/community/growth-publication.test.ts`: “publication writes and pages stay within their bound across growth scales ${scales.join(', ')}”.                                                                                                                                                                                                      |
| Set or read board scheme                                     | Admission for Realm management and subject eligibility; Realm head and Semantic subject/type point reads; setting appends one revision and compare-and-sets the head, while reading uses the head seek.                                                                                                                                                  | Constant rows and statements; logarithmic blocks in Realm and subject indexes, plus bounded Access checks.                                                                                                     | `test/community/board-scheme.test.ts`: `Realm board scheme set and read`.                                                                                                                                                                                                                                                                           |
| Publish membership, read terminal or change, or prove a role | Publish reads the Realm and opens or closes one membership interval, with at most one terminal insert. Terminal/change reads use one primary-key point read; role proof uses two membership index seeks and the Realm existence point.                                                                                                                   | Constant rows and statements per operation; logarithmic blocks in Realm membership indexes, plus bounded Access.                                                                                               | `test/community/growth-membership.test.ts`: “publish, terminal reads and role proofs stay within their bound as Realms and members grow”.                                                                                                                                                                                                           |
| Read current Realm membership                                | One unique `realm_member_open` index point read filtered at T; closed history does not widen the lookup.                                                                                                                                                                                                                                                 | One row and statement; logarithmic blocks in the Realm's membership history, including closed intervals.                                                                                                       | `test/community/growth-membership-history.test.ts`: “current membership is one index point read as the same account and Realm accumulate closed intervals”.                                                                                                                                                                                         |
| List own Realms                                              | Bounded account inverse, released Realm confirmation, current read/presentation hydration and final episode checks; see My Realms current inventory.                                                                                                                                                                                                     | Raw80/selected20; nested owner work and remaining growth obligations are listed in that subsection.                                                                                                            | `test/community/own-realms.test.ts`, `test/community/own-realms-current.test.ts`.                                                                                                                                                                                                                                                                   |
| List Realm and Space sitemap pages                           | Keyset-read at most four candidates per requested item (limit at most 1,000); fixed same-home current Realm/Space/head/slot and board seeks, independently prepared anonymous Access before and at disclosure, one separately released exact active-address claim lookup, and final unchanged-head/lifecycle/slot validation. No refill or history scan. | Linear rows in page limit with at most four times the limit candidates; logarithmic indexed seeks in source, head, slot, board and address indexes; fixed statements per candidate kind.                       | `test/community/growth-sitemap.test.ts`: “Realm sitemap page stays within its bound as listed items grow”; “Space sitemap page stays within its bound as listed items grow”; “Realm sitemap page stays within its bound as protected Realms grow”; “Space sitemap page stays within its bound as protected Realms grow”.                            |
| Check Realm participation or ensure its member grant         | Participation checks `realm:participate`, the independent `realm:read` eligibility and one exact Realm head at shared T. Grant ensure reads the exact Realm head and idempotently inserts the member-group grant in the command.                                                                                                                         | Constant rows and statements; logarithmic blocks, plus bounded Access membership proof.                                                                                                                        | `test/community/participation.test.ts`: “Realm participation stays bounded as Realms, members and grants grow”.                                                                                                                                                                                                                                     |
| Join a Realm                                                 | Acceptance command reads the Realm and current-ban key, inserts one operation and receipt; reserve and publish workflow steps restore the initiator; follow is one point upsert on the member account partition. Publication rechecks the ban.                                                                                                           | Constant rows and statements per step; logarithmic blocks, plus bounded Access and initiator restoration; independent of member history.                                                                       | `test/community/growth-join.test.ts`: “Join a Realm has constant rows and statements as Realms and its members grow”.                                                                                                                                                                                                                               |
| Leave a Realm                                                | Acceptance command reads the Realm and current-ban key and inserts one operation and receipt; reserve, publish and release steps restore the initiator. No follow is written or removed.                                                                                                                                                                 | Constant rows and statements per step; logarithmic blocks, plus bounded Access and initiator restoration; independent of member history.                                                                       | `test/community/growth-join.test.ts`: “Leave a Realm has constant rows and statements as Realms and its members grow”.                                                                                                                                                                                                                              |
| Add a Realm member                                           | Acceptance command reads the Realm and current-ban key, inserts one operation and receipt; workflow reserves and publishes with initiator restoration, ensures the protected member grant, and upserts the member's follow point.                                                                                                                        | Constant rows and statements per step; logarithmic blocks, plus bounded Access and initiator restoration; independent of member history.                                                                       | `test/community/growth-join.test.ts`: “Add a Realm member has constant rows and statements as Realms and its members grow”.                                                                                                                                                                                                                         |
| Read Realm votes                                             | One primary-key read of `community.realm` per requested Realm, with one statement per partition.                                                                                                                                                                                                                                                         | Linear rows and statements in the number of requested Realms; logarithmic blocks per Realm.                                                                                                                    | `test/community/realm-votes.test.ts`: `Read Realm votes`.                                                                                                                                                                                                                                                                                           |
| Ban, unban or list current bans                              | Ban opens the Realm ban record and two identity denials, checks the owner/moderator grant keys and probes current membership; an existing member also gets a removal operation/workflow. Unban closes the record and denials. Listing keyset-reads at most L current bans plus one lookahead row.                                                        | Ban and unban have constant rows and statements; listing has linear rows in L and constant statements. Logarithmic blocks in Realm and ban indexes, plus bounded Access and removal workflow where applicable. | `test/community/growth-ban.test.ts`: `Realm ban, unban and list`.                                                                                                                                                                                                                                                                                   |

A is bounded Access admission and permission evaluation. Each `runCommand` phase is a single-partition transaction. Fixed request, page and change limits are inputs; no operation above depends on scanning unrelated history. Bounds describe database rows, statements and indexed blocks, not wall-clock latency or engine posting-list work.

### Realm member page

Decision: Realm member pages use a public Accounts name or the fixed `Member` fallback, and keep the route discoverable like native ban routes while `realm:manage` gates every roster read. The `public` exposure label is route metadata; it does not make the response public data.

Decision: Protected-role advice reads at most 100 current Access grants per role; when a target may lie beyond that prefix, ban advice is uncertain and the native ban command remains authoritative.

Decision: Each disclosed row and exact selected result carries a stable viewer-scoped HMAC episode token bound to the Realm, Account, partition epoch, and original reservation/publication transaction. A selected absence has its own token; native transaction identifiers stay private.

A ready page includes the current Realm title, its 20-row page bound, and the authenticated viewer's Account ID with a
stable HMAC authority binding scoped to the Realm, viewer and partition epoch. The authority binding is emitted only
after the final `realm:manage` check; it identifies the page observation and does not authorize commands. Preparing
pages return no viewer binding.

`GET /v1/realms/{realmId}/members` takes a raw frontier of at most 20 open membership keys in Realm-local account-ID order, then applies effective time to those bounded keys. Future-start rows are omitted but advance the raw cursor. The signed cursor binds Realm, viewer, page size and partition epoch; sparse or concealed identities remain rows and never move the continuation. `accountId` optionally inspects one exact Account independently of that page. It is deduplicated with current page IDs for bounded Accounts identity hydration and does not affect the cursor.

The exact selected Account identity is observed before Realm source selection. Page identities are read after source selection and again after action hydration. The Realm source confirms every current open interval against its immutable published transition proof and exact committed command receipt, then checks terminal evidence. A missing, provisional or inconsistent selected member produces `preparing` with the same cursor. The source and complete public identity observations are checked again after identity, ban and role hydration. The final Realm and management authority are rechecked before private roster data is returned. Current ban facts use exact Realm ban keys. Ban advice requires a separate current `realm:ban` check and the bounded Access role projection; a target beyond an incomplete role prefix receives uncertain advice. Identities contain only the public ID, kind, state, handle and display name; deleted identities retain the native tombstone shape. A private or missing display name uses `Member`. Add-member advice targets the existing accepted-202 command, and ban/unban advice names their native outcomes. Removal and role revision advice say no mounted method is available.

#### Cost

- **Touches:** The mounted read performs two Realm reads, two current `realm:manage` checks, one partition epoch read, one raw open-key page with one lookahead, and at most 21 exact membership/proof/receipt/terminal checks. The final membership observation repeats at most 21 exact checks. Accounts reads the selected ID once before source selection when requested, then two deduplicated batches of at most 21 IDs, at most 43 identity-home queries total. The separate `realm:ban` authority is checked twice; when allowed, one exact ban statement covers at most 21 targets and two Access current-role page statements return at most 101 rows each. Serialization is capped at 600,000 UTF-8 bytes. Retry repeats these bounds at the same cursor.
- **Bound:** Raw output is at most 20 current members plus one selected Account; the cursor advances by the last raw open key, including a future-start key omitted from output. `realm_member_open` bounds the raw page and lookahead, with effective-time membership checked against each bounded open key; `realm_membership_proof_published_current` seeks the exact route, Realm, Account and publication transaction before receipt residuals, and terminal/current-ban checks use exact Community keys. Protected-role advice includes two role pages of at most 101 rows each, so it can observe 202 directory rows and perform 202 grant probes; an absent target beyond an incomplete prefix yields uncertain advice. Each page identity batch has at most 21 IDs routed to at most 21 homes; the selected pre-read has at most one ID, for 43 identity-home queries total. Names retain the owner limit of 4,096 UTF-16 units. The HMAC episode token binds only the observation and returns no native reservation or transaction identifier. Nested Access checks use their existing bounded actor, session, membership and grant prefixes; the whole serialized page remains capped at 600,000 UTF-8 bytes.
- **Growth check:** `test/community/growth-member-page.test.ts` fixes the selected member, page size, and represented identity homes while the native growth fixture scales unrelated Realms and Accounts and the test grows that member's closed interval, proof, terminal, ban, role, and grant history through 256, 1,024, and 4,096. It captures the real request and checks for the Realm open-key, published-proof, exact ban/role/grant, and Account primary-key plans. Integration acceptance still owns empty, denied, provisional, stale, and retry episodes across every participating pool; skipped fixture or host setup is not a growth pass.

## Public Realm discussion discovery

Community owns Popular and Trending. Their adopted definition is public discussion starts in the previous 30 and
1 complete UTC days respectively, ordered count descending then Realm ID ascending, omitting zero. Trending means
recent volume. Membership, unique people, votes, views and population normalization are not inputs. Later public
cards expose no counts and use null avatars/initials: there is no Realm/Space avatar-selection authority, and an
owner's photo is not a substitute. The aggregate and public route are separate, pending delivery.

The delivered source is Content's native `realm-discovery.changed.v1` catalogue entry and per-thread contribution.
`prepareRealmDiscoverySource` in `discovery-source.ts` verifies explicit public Realm state and independent anonymous
`realm:read` and host `space:read` at the originating command T. Access evidence and exact routed anchor reads finish
before the thread command opens its home. Realm `discovery_epoch` changes durably with visibility/state/host changes;
metadata-only head edits retain it. A return from protected visibility starts a new epoch. An original private
creation can never acquire qualification on replay, publication or delayed delivery. Epoch initialization does not
scan old content or infer historical publicity. The source's original epoch never changes.

The exact source read/apply preparation contract is exported by Content's `discovery.ts` as `DiscoverySourceFact`,
`readDiscoverySource` and `prepareDiscoverySourceApply`, with `DiscoveryDelta` defined by the closed native schema.
It supplies source version/state, not current rank eligibility. The aggregate must independently validate the current
Realm/Space binding and epoch; original-public evidence alone cannot authorize current disclosure.

Content's `discovery-mutation.ts` now supplies the outer native preparation/fence/acknowledgement/effect/outcome
phases for point deletion/takedown, the existing bounded author-erasure page, post restoration and appeal reversal.
`DiscoveryOperationReference` is exactly `(route, intent, generation)`; `readDiscoveryOperation` and
`readDiscoveryOutcome` read the committed source preparation and guarded native outcome. `commitDiscoveryFence`
accepts only that reference and reads its actual preparation before entering Realm home. `projectDiscoveryOutcome`
reads actual terminal source evidence, assigns absolute versioned contribution or board state and resolves just its
exact fence. It accepts no success assertion. Outbox envelopes are verified by the registered Content effect.

`readRealmDiscoveryGate(client, realmId)` supplies `{realm_epoch, generation, settled}` for one exact routed key.
`readRealmDiscoveryChanges(pool, {realmId, afterGeneration, limit, deadline})` is the additive internal consumer
interface. Its exported `RealmDiscoveryChangeValue` is the closed union of thread absolute `DiscoverySourceFact`,
board `{boardId, sourceVersion, published}`, epoch, and gate `{settled}` records. Each
`RealmDiscoveryCommittedChange` contains `realmId`, `realmEpoch`, decimal `generation` and `previousGeneration`,
the actual native executor `transactionId`, and `value`. `RealmDiscoveryChangePage` contains `changes`, the consistent
native `head` gate (or null for an absent Realm), and `next`. Generation frontiers are internal decimal strings,
never public cursors. Limits are integers 1–50. Invalid input throws. The reader checks native partition ownership
and deadline, then reads at most that many committed records in ascending generation and the head in one released
repeatable-read home snapshot. `next` is the last returned generation only while more committed work exists;
otherwise null. Missing log work below the head is unavailable, never invented empty success. Partition moves,
fencing, transport failures and deadlines remain native errors. This mechanical read supplies no person permission.

The append-only `realm_discovery_change` log is keyed `(route, realm_id, generation)` and has no expiry or pruning.
New Realm generations start at zero. Every actual mirrored thread/board change, exact fence install/resolution and
epoch transition appends a record in its original Realm command and advances the Realm generation by exactly one,
with the preceding committed generation recorded explicitly. Multiple records in a command have consecutive
predecessors and the same executor transaction id. Epoch transitions never reset this frontier. Repeated versions,
authorized replay and repeated fence operations append nothing. All producer commands lock the native Realm row
before mirror/fence writes. Deferred native SQL triggers append after the executor callback supplies its actual
transaction id; failure rolls back the original mutation too. A fact plus exact gate resolution commits atomically.
The native changed event is only a Realm/epoch wake hint. Committed log reads are the evidence.

The forward migration neither scans old threads nor invents historical log records or predecessors. A pre-log
Realm whose generation already advanced without retained log evidence stays unavailable on that missing range;
consumers must never guess a baseline from its mirrored rows. New deployment activity uses the zero-based log.

The consumer must read this genuine log through its real pool, require its local `appliedGeneration` to equal each
record's `previousGeneration`, enforce original/current epoch rules and native source-version deduplication, and
assign absolute states. Repeated old records are no-effect; gaps or conflicting predecessors remain unavailable
and retry the native read. It preserves its exact checked input across that released read and its own home write.
A step consumes at most 50 records. Epoch events reset eligibility without scanning sources. A board changes only
its eligibility and at most 31 buckets; thread caches retain original identity/day/absolute contribution even while
board eligibility is false. Old-epoch cleanup and expiry are independently bounded; neither log records nor timers
confer permission. No sourceVersion is a generation, and no raw delta change is a count to sum.

Pending or mismatched generations are unavailable. The later consumer must apply native facts to its bounded
buckets before advancing its generation; disclosure requires equality with the current settled native gate,
matching epoch, current rollover and independent current anonymous Realm/Space/lifecycle/publication checks before
and at final disclosure. Mirrored thread/board facts contain no person identity, bodies or public count. The
aggregate never calls source abort, changes source phases or resolves fences. Aggregate and public API ownership
remain separate from this producer.

Same-home container lifecycle writers are covered by database guards in the forward discovery migration:
Realm visibility/state/host changes advance its epoch and discovery generation atomically; Space state changes
advance the epoch/generation of its one exact native Realm slot through `(route, space_id)`. Metadata edits retain
them. Every same-home lifecycle command must call the delivered `bindRealmDiscoveryCommand(tx)` in its native
command body, before commit, so the deferred epoch log uses that executor's transaction id. Existing Realm/Space
commands do this; lifecycle writers delivered separately must consume this hook. An unbound epoch writer fails
closed and cannot commit an unlogged state change. `readRealmDiscoveryEpoch(tx, realmId)` is the exported same-home binding read and rejects another partition.
The container lifecycle owner must retain the Context pointer and original Space binding, use these ordinary native
state writers, and check lifecycle/publication before and at final disclosure. No new container-lifecycle files are
changed here, and no removed-container Global fallback is introduced. Readable orphan resources remain distinct
from removed resources. A restored container starts a new epoch; old contributions do not revive.

Preparation, fences and outcome acknowledgements each release their connection before the next home. Source
application and ABORTED recovery compete on the same source operation row, so an aborted generation cannot later
apply and an applied winner cannot clear as abort. Terminal fence tombstones survive delayed installation. Only
terminal unprojected source operations are recovered, 50 indexed due keys per partition step in the existing native collection
step. Unknown/live source outcomes remain pending; there is no timeout-based fence clearance or new scheduler.

Source qualification, epoch changes and source invalidation touch exact routed keys with constant rows/statements
plus bounded native Access work. Later aggregation must use at most 31 day-bucket keys per affected board, durable
bounded pages for multi-board changes, and O(changes log R) rank maintenance. Existing growth evidence remains for
integration. Public aggregate/endpoint delivery is still a separate consumer task.

## Container removal and binding fences

`removeContainer` and `restoreContainer` use the ordinary command executor, fresh action/scopes and direct native
resource-role facts from Access's installed `resourceRoleHeld` port, before receipt replay. Space removal requires
`space:manage` and its current direct owner role. Realm removal requires `moderation:takedown` and its current direct
owner or moderator role. Restoration requires the exact native `space:restore` or `realm:restore` action; management
or takedown permission never substitutes for it. No administrator role is installed. Native role data never supplies an Access allow decision.
Removal requires a nonblank reason of at most 1024 characters. The identity retains its head, classification Context
and publication pointers, recording authoritative removal time, remover and native role. Each transition increments
a decimal-string lifecycle version; both the expected head and lifecycle version must match. Restoration includes
the exact 30-day boundary, requires the original remover with a current native role or a current higher role
(Realm owner above moderator; another equal owner is never higher), or current platform restoration authority.
The platform branch independently validates the Global Context and evaluates that same exact restore action through
the installed Access formula at each fresh command T, releasing it before target checkout. A target owner grant,
remover identity, Global management permission or absent role is never platform proof. Every attempt rechecks the
target action and direct role before receipt replay. Restoration independently checks the live stored Context's availability and `context:read` before
checking out the target. It never creates, deletes, grants or transfers a Context. Post erasure/author undo is unchanged.

HTTP delivers `GET /v1/spaces/{spaceId}/lifecycle` and `GET /v1/realms/{realmId}/lifecycle` to the same native actors.
The closed `{container}` response contains `kind`, `id`, `state`, `headRevisionId`, `version`, `removedAt`,
`removerRole`, `reason`, `mayRemove` and `mayRestore`. Ordinary denied/missing reads remain 404.
`POST` to each resource's `/removal` accepts `{expectedVersion, reason}`; `/restoration` accepts `{expectedVersion}`.
Both require `If-Match` (the quoted head revision) and `Idempotency-Key`, and return
`{container:{kind,id,state,headRevisionId,version}}` with the command's ordinary session component.
These responses contain no removed title, summary, Context content or publication material.

A removed Space also hides its carried Realm through direct Realm reads, participation and publication eligibility.
A removed Realm or host never selects a Global fallback. Ordinary Realm eligibility binds preparation to the current
Realm/Space heads and lifecycle versions and repeats that anchor at final validation, rejecting a remove/restore cycle
while a reader is in flight. Space viewer reads repeat their own anchor after the separately authorized carried Realm read.
Publication point/page reads release their source snapshot, then check current publication-head keys and the retained
lifecycle/binding anchor immediately before disclosure; a stale preparation returns unavailable.

Sitemap final source reads bind both lifecycle versions as well as the exact heads and carried slot, so a
remove/restore cycle after the last Access check suppresses that in-flight entry. A fresh feed read recomputes
current anonymous eligibility; restoring a protected Realm or its host cannot publish that family or turn the
occupied host into a standalone Space. Lifecycle transitions never rewrite generic Search Source entries.

`ContainerBindingSchema`, `ContainerBinding`, `readContainerBinding(client,{realmId,subjectId?,at})` and
`revalidateContainerBinding(client,expected,at)` are the delivered Semantic data port. Its closed version-1 shape is
`{schemaVersion:1,realmId,spaceId,contextId,realmHead,spaceHead,realmVersion,spaceVersion,subjectId,publicationId}`.
Versions are decimal strings; the optional subject becomes null on the wire. A subject uses its one exact active
publication-head key; absent/withdrawn publication yields null. Missing/removed Realm or Space returns null.
Consumers must separately authorize the current container and live Context on released source anchors, retain these
facts, and revalidate immediately before disclosure; null, false or a changed publication is unavailable, never Global
fallback or empty success. The facts convey no permission or ownership. Community owns this producer; Semantic owns
its source/page call sites and their integration remains separate.

Cost: one identity/head/lifecycle key, at most two direct native role keys, one host key and optionally one exact
publication key, all in the target home. Context preparation is independently anchored and released before checkout.
Lifecycle commands bind the existing same-home discovery epoch triggers to the executor's actual transaction.
No membership, history, descendant or graph scan is used. Four closed lifecycle events are registered. Removal events
feed the existing account-party locator; account erasure clears the current remover and reason through one exact
container key, including late-source replay, without deleting the tombstone or binding fence.

Authority seams: Space installs only owner above standing; Realm installs owner above moderator above member/standing.
Space has no moderator, administrator or higher local owner rank. Accounts owns the additive restore actions in its
platform governance/closed Global reach catalogue and matching existing role bindings (Realm moderator included).
Until that producer is integrated, a missing action or role binding remains denied; these routes do not grant it or
report restoration success. The independent platform check is implemented, without a provisional permission adapter.
Accounts also remains the sole last-holder/succession producer; this module does not implement an ownership store,
the Accounts claim command, `readRealmOwnershipRoles`, or any Access succession, grant or transfer producer. Community
only owns the locked source/state application ports described above. Existing orphan claim requests
and their expiry do not confer restoration or acquisition authority.

## Realm presentation

Realm revisions own the closed `presentation` reference object:
`{ avatarMediaId: UUID|null, bannerMediaId: UUID|null, rules: {postId: UUID, revisionId: UUID}|null }`.
Creation defaults every slot to null. Ordinary Realm PATCH omission preserves the object; a supplied object
requires all three keys and rejects unknown keys. Null clears an individual slot. The existing `expectedHead`
CAS, idempotency digest and current `realm:manage` admission, including replay, apply. Board-scheme revisions
also preserve presentation. There is no separate settings store, endpoint, role or Context authority.

Only Realm managers select references. A rules reference selects an exact published native revision of a post
in a board of this Realm. Content prepares its real actor, ancestry, board, Realm, revision and partition evidence
before Realm checkout on every live command attempt. The selected Text document must occupy at most 65,536
canonical UTF-8 bytes, with its native SPDX licence and SHA-256 digest. It remains in native Content storage;
Realm JSON stores only the two identities. Adoption never changes the original author's or editor's permissions,
post head or version; a later edit does not change the pin. Native disclosure repeats on every presentation read.
Hidden/erased rules yield `none`; source failures yield `unavailable` without any retained body.

Media selection invokes Content's `claimRealmPresentationMedia(tx, {realmId, author, avatarMediaId,
bannerMediaId})` after the revision append and head CAS, inside the same settings transaction. The installed
native media producer binds its own actual command time and exact actor/authorization to the newly written head;
it owns same-Realm matching-purpose permanent claims and current download authority. Unclaimable references
roll back the settings command with uniform 409 `media_unavailable`. No media pipeline, Space assets or board
overrides are implemented here.

Content's [community presentation contract](../content/README.md#community-presentation) owns the shared DTO and
reader. `GET /v1/spaces/{id}` adds `community` beside its existing `space` representation, reusing that exact reader
for a currently readable carried Realm. Space-only homes retain their own native title/summary and null community.
Membership, setup and publication remain separate regions. The final Space head and carried-Realm binding must
still match. The independent `contextId` pointer is preserved; it grants no editorial permission.

`readRealmHomePresentation({pool, access, clock?}, realmId, {actor, deadline})` in
`realm-home-presentation.ts` composes that same native reader for exactly one Realm. The public
`GET /v1/realms/:realmId/presentation` returns the closed `{community: CommunityPresentation}` envelope under
ordinary `realm:read` and independent host `space:read`. Public anonymous and authorized protected readers use
the same source protocol; no management or independent Context grant is required or conferred. Missing, denied,
removed or changed Realm/Space bindings yield the same 404. Required source failures yield typed 503 problems;
optional source failures keep the native unavailable/unknown states and never reuse a cached positive value.

Accounts owns `member-count.ts` and its `RealmMemberCount = Readonly<{count:number, version:string}>` export.
`readRealmMemberCount(client: AccessClient, {realmId, at: AuthoritativeTime})` returns that native current result
or null when unknown. Content binds this original module at the reader's existing before/final Realm anchors;
it neither initializes nor maintains counts. The native source below supplies only covered current results.
Source errors and null remain unknown, never zero; a changed final count/version is withheld without retry.
This registration grants no membership,
role admission, removal or creator authority.

### Cost: Realm home presentation read

- Touches: one full routed Realm key and its one host Space key, their exact heads, lifecycle and placement
  anchors, native Access decisions, at most one current self-membership interval and two protected-ban identities.
- Bound: one invocation of `readCommunityPresentations` with one Realm and two fixed Realm/Space REPEATABLE READ
  rounds, with one native member-count point helper per round. At most one exact rules pin uses its original two
  native source rounds (at most 33 post keys per ancestry chain and 65,536 canonical bytes per document).
  At most two selected media keys use the original native image before/final protocol, with at most twelve
  derivatives per image. Each row-kind batch has constant statements and logarithmic indexed work; no scan,
  refill, recount or extra source round is added.
- Growth check: later reuse `test/community/growth-realm.test.ts` and the Content rules/media growth harnesses.
  Focused source and privacy outcomes live in `test/community/home-presentation.test.ts`; compiler typing alone
  establishes no native or physical cost proof.

### Cost: presentation settings and rules adoption

- Touches: fixed Realm authority/head/CAS, at most two media claims and one exact prepared Content source;
  one immutable revision, receipt and event. Rules authoring uses ordinary Content commands.
- Bound: O(changes log R), fixed before/final source anchors, one selected post plus at most 32 ancestors,
  at most 65,536 canonical bytes; no revision walk, recount or retry scan.
- Growth check: later reuse `test/community/growth-realm.test.ts` and `test/content/growth-threads.test.ts`;
  focused native outcomes live in `test/community/presentation.test.ts`. Type checking proves no native cost outcome.

### Realm rules authoring

Decision: new rules explicitly select the existing native `LicenseRef-rezics-terms`; Content attributes the post to the
signed-in account, and edits retain the stored licence through the native revision command.

`GET /v1/realms/:realmId/rulesAuthoring` is a private, no-store `realm:manage` preparation. It composes the current
settings/policy reader, the exact native Content revision reader, the existing 20-board Realm page, and native
`thread:create`/`post:revise` advice. Advice is current page evidence only; Content and Realm commands repeat their own
authorization and currentness checks. The page keeps none, available, erased, concealed and unavailable references
distinct. It returns no historical body unless the exact published Content reader currently admits it. Its final exact
Content observation follows board preparation and the second settings read, so late advice work cannot keep an earlier
body authorized. New Content publication and Realm presentation update remain separate acknowledged effects; only their exact acknowledged
revision is offered to the existing settings writer.

- Touches: two complete Realm settings/policy reads, including each reader's two selected rules and optional media
  references; one final exact rules authoring observation with native `post:revise` advice and the selected revision's
  thread/media metadata; one 20-item Realm board page;
  and at most one existing board action-evidence read per returned board. Each nested reader retains its own Access,
  Accounts, Realm, Content and partition checks.
- Bound: fixed work at a 20-board page, 33 posts per ancestry chain, two exact-source disclosure rounds, and 65,536
  canonical document bytes. The settings composition may retain up to five bounded copies of the exact selected body
  across its two selected reads and the authoring observation; response bytes remain fixed by the page and document
  limits. There is no board refill, revision-history walk or cross-home transaction.
- Growth check: `test/community/rules-authoring-journey.test.ts` varies unrelated Realm rows, Realm revisions,
  same-post Content revisions, selected media history and Realm authority history at 256/1024/4096 while checking
  fixed statement, row and response bounds. Installed publication-preparation and downstream action execution remain
  owned by their native commands.

## Current native Realm member count

`readRealmMemberCount(client, { realmId, at })` in `member-count.ts` returns only
`{ count, version }` from the supplied current Realm-home snapshot at live authoritative T. It does not authorize
reading a Realm or disclose account identities, coverage reasons or an endpoint. The header consumer performs its
ordinary current Realm/privacy checks before and at final disclosure and enriches its existing DTO.
The count is actual `realm_member` rows with `role = 'member'`, independent of explicit owners, grants, follows and
visitors. An initialized fresh Realm has zero at version `0`. Missing controls, partial initialization, missing removal
coverage and unsupported/not-yet-reached temporal frontiers return null (unknown). Home, SQL and deadline failures
propagate; they are never unknown or a fabricated zero. Keys must be full native routed Realm identifiers; counts
must be safe nonnegative integers and versions canonical nonnegative native bigint strings.

Row triggers cover every actual insert/update/delete, including physical account erasure, historical cleanup and
reconciliation. They lock the same source control before changes and update its version, count and temporal horizon
in the original source transaction. A replay/no-op/refusal changes nothing. A real close removes one contribution;
a same-T deletion follows the actual row deletion; a later rejoin adds one. Account tombstones, inverse/terminal
facts, Access role loss and pending erasure statuses never decrement. The existing membership engine remains the sole
transition, reservation and causal-proof owner, with its original receipts, grants and outbox atomicity. There is no
new erasure participant or account-bearing journal. Uncovered TRUNCATE is refused. Source positions are numeric
metadata on existing membership rows; Realm progress stores only numeric positions and resource keys. Deleting a
source row erases its position too, with no new account locator/custody inventory.

The forward migration adds a nullable source position without rewriting old membership history. Default community
work uses the existing maintenance queue and native commands, redriving durable outstanding controls every ten
minutes. A finite deployment Realm frontier is enumerated fifty raw Realm keys per segment. New Realm creation
and the first actual source write install their own controls. Legacy open rows receive positions fifty raw current
keys per segment through the indexed unkeyed source path; closed histories remain untouched. Only after that
installation completes under the source lock is a finite numeric cut captured. Seeding reads fifty raw open source
keys per segment before deriving contributions. It never counts a Realm on request or mistakes filtered EOF for
completion. During installation writers advance the source version but coverage stays unknown. During seeding,
changes to visited or post-cut keys apply once; unvisited cut keys are read in their actual current state later.
No seed can overwrite a live delta, clear pending work or reset the source version. All progress is native and
restartable; DBOS retains partition locators and continuation only, and each segment releases its home connection.
Each upkeep workflow runs at most fifty native segments before enqueueing its partition locator on the same
maintenance queue, bounding durable workflow history independently of the size of the source.

Native open SQL creates an immediate open-ended interval at its injected command T. Close SQL writes the actual
end at its command T (or deletes the same-T row); it does not schedule a future transition. The read horizon is at
least the maximum start of seeded/opened rows and the end of any actual close. Legacy finite intervals contribute
no open count, and an exact indexed maximum end establishes the earliest valid horizon. Until T reaches that
horizon the result stays unknown, even if elapsed worker readiness says otherwise. Explicit infinite unsupported
endpoints stay unknown. Thus future domain times cannot expose a stale aggregate; no historical request scan or
timer-based inferred membership change is needed. The existing erasure membership consumer's unavailable state
remains pending; only real source-row removal, whenever committed by its owner, affects this aggregate.

### Cost

| Operation                             | Touches                                                                                                               | Bound                                                                                                                                                                                                     | Growth check                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Read native Realm member count        | The native partition ownership key and exact `(route, realm_id)` source control in the caller's home snapshot.        | Two point rows/statements; logarithmic indexed blocks, independent of members and history.                                                                                                                | Later existing native growth harness; focused outcomes in `test/community/member-count.test.ts`.            |
| Maintain count with native membership | The exact source control and actual changed source row; first installation probes indexed open/unkeyed/end endpoints. | Constant work per actual row change; logarithmic indexed blocks. No account journal or separate command.                                                                                                  | Existing membership/transition harness at integration; no allowance changes.                                |
| Initialize existing counts            | Fifty raw Realm inventory keys, or fifty raw unkeyed/open source keys from one control and its finite cut.            | Fixed fifty inputs per segment; indexed keysets, finite native progress and one home per command. Closed history is never paged. Total work follows installed current keys and subsequent source changes. | Later existing native growth harness; restart/live-change outcome in `test/community/member-count.test.ts`. |

## Pending Realm claim review

Decision: `GET /v1/realms/{realmId}/claimRequests` keeps exact selection in the optional `inspectRequestId` query, outside cursor binding; it returns a safe current public claimant label/link and the mounted approval command, while exact terminal readback contains no claimant history.

`GET /v1/realms/:realmId/claimRequests` exposes the native `RealmClaimReviewPage` from
`realm-claim-review.ts`: `{claimRequests:[{realmId,requestId,claimantAccountId,state:'pending',orphanedAt,
claimEligibleAt,requestedAt}],next:string|null}`. This public-mounted operational read requires ordinary current
`realm:approve_claim` directly on Global with the actual actor, before Realm source checkout and again at final
disclosure. Realm management, moderator standing and Global reach do not substitute for that action. Denied,
unrelated and missing sources use the same `not_found` policy. No member, profile, email, body, Realm text, count
or authority is returned. Accounts' existing approval command remains the sole grant/approval producer; this read
never locks a claim for approval, changes state or grants ownership.

Only an active, currently orphaned Realm whose original 720-hour deadline has arrived is available. Pending
requests must match that exact orphan episode and have been requested between its original eligibility instant
and current authoritative time. Released initial and final snapshots retain the exact native head, lifecycle,
public-source epoch, original orphan deadline and request identity. Restore, approval, re-orphaning, removal or
changed source binding before final disclosure withholds the old source. Access is freshly prepared outside source
checkout and evaluated again in the final snapshot; revoked platform permission cannot disclose the page.

Limit is 1–100 (default 20); at most `min(limit,20)` pending keys are examined, including ineligible rows. One
partial-index seek orders by request ID within `(route,realm,orphanedAt)`; there is no refill, count, history walk
or all-Realm discovery. The signed native cursor binds the viewer/client/delegator, Realm, normalized limit,
partition epoch, original orphan episode, lifecycle/public-source epochs and last examined request ID. A full
examined page may return continuation even when its successor is empty. The selected dependency interface has no
key-ring port, so the native signer uses a process-lifetime random key; a process restart requires restarting the
listing. Invalid/expired tokens use `invalid_cursor`; a changed available source epoch uses `stale_cursor`.

| Operation                 | Touches                                                                                                                                                                             | Bound                                                                                                                                                                                                  | Growth check                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List pending Realm claims | Two ordinary exact Global Access evaluations; initial/final native Realm/head and partition point reads; one pending episode index seek and at most 20 exact request revalidations. | At most `min(limit,20)` examined candidates and final full-key reads; fixed snapshots/statements plus bounded Access; logarithmic index seeks independent of unrelated Realms and historical episodes. | Focused `test/community/realm-claim-review.test.ts` asserts the candidate cap and exact pending index shape. Native growth execution is deferred to integration. |

Client contract decision: export the review operation and its query and response types from the installed client as aliases of the mounted Kernel route, preserving one closed wire contract for consumers.

### Cost: composed Realm claim review

- Touches: two authoritative-time reads and two exact Global `realm:approve_claim` preparations/checks; initial authorization uses one Global partition/context snapshot, then one Realm partition, source/head read and pending index seek. Final disclosure reads the Realm partition/source again, revalidates at most 20 exact `(route, realm_id, request_id)` rows and repeats Global partition/context authorization. Optional `inspectRequestId` adds one exact Realm/head plus request point read to each source snapshot, bound by route, Realm and request key; no history query is used. Public claimant identity uses the existing Accounts `readPublicIdentities` method in two rounds: up to 20 deduplicated page IDs per round, grouped by each ID's real route, plus one separate exact-selection ID when outside the page. At most 21 account keys are examined per round across at most 21 home statements. The optional presentation reader runs twice outside Realm checkout; each invocation keeps its existing two Realm/Space snapshots, native Access decisions, one member-count point read per snapshot, at most one exact rules pin and at most two selected media keys. All snapshots and routed identity calls release their checkouts before the next Access or presentation preparation.
- Bound: pending selection examines at most `min(limit,20)` indexed candidates and at most 20 final exact request rows; an exact inspection adds at most one request row per source round and never changes the signed cursor binding or last-examined key. Each Accounts round performs no more than 21 exact account-primary-key probes and returns no more rows than requested IDs; page/selection output carries at most 21 labels of at most 4,096 characters each (at most 16,384 UTF-8 bytes per label), one Realm name of 1,024 characters and one description of 4,096 characters. The public payload is below 400 KiB before fixed IDs, timestamps and cursor, with the operational candidates limited to 20. The presentation reader's existing rules document remains capped at 65,536 canonical bytes and its selected media remains limited to two keys per invocation with at most twelve derivatives each. No account-wide, membership, grant or history reads are added.
- Growth check: `test/community/realm-claim-review.test.ts` covers the mounted public DTO, pending and approved exact readback, and cursor invariance; `test/community/growth-realm-claim-review.test.ts` retains the native page-prefix check. The Accounts `test/access/growth-public-identity-read.test.ts` owns the independent routed-ID prefix at 1/8/64 identities. The connected review journey at native growth 256/1024/4096 and nested runner/pool capture remains part of the deferred integration acceptance; this worker did not run acceptance checks.

### Cost: own claim status context

- Touches: the existing own-status reader performs one locating snapshot and two admitted Realm/Space snapshots, preparing and evaluating `realm:read`, `realm:participate` and `space:read` on released anchors in each round. It reads the same current continuity and at most one exact request row in each admitted snapshot; `currentRealm` and `requestAdvice` are derived from those observations and add no SQL, history, grant or account reads.
- Bound: constant snapshots, statements and request rows, with logarithmic indexed work plus the existing bounded Access evaluations. The added closed response has fixed state/action fields and at most three ISO timestamps; `available` is advisory and the mounted request command rechecks its own authority and source.
- Growth check: `test/community/realm-claim-status.test.ts` covers the own pending/approved receipt, current versus old episode, null versus denied and the added current-context/advice fields. Existing physical and three-scale status measurement remains deferred to integration.

## Report target adapters

`communityReportTargetFacts(client, {kind: 'space' | 'realm', id})` returns an internal current-head
fingerprint or null using only the native route. `communityReportReadCheck(deps, target, context)`
prepares the ordinary Space/Realm read action with `spaceReadEligibility` or `realmReadEligibility`.
Content owns report evidence, receipts and disposition; these adapters grant no moderation action.
Decision: exact report inspection authority and ordinary current target readership are both required;
Global catalogue queue membership does not disclose protected Realm or removed-host facts.

### Cost: report target facts

- Touches: one Space identity and exact head, or one Realm identity/exact head and its same-route
  Space identity/exact head. The owning statements are `report-target-space.sql` and `report-target-realm.sql`.
- Bound: one statement; two or four unique table keys and fixed materialization/join/projection work;
  less than 1 KiB of witness data. No body, history, grant or membership range is selected.
- Growth check: native creation, replay and concealment are exercised by Content's
  `test/content/report-community-http.test.ts`; strict three-scale plan verification is deferred.

### Cost: report read eligibility preparation

- Touches: the installed Access preparation plus existing Space current-head eligibility or
  Realm binding eligibility, later verified on the caller's released source snapshot.
- Bound: Space adds two unique keys/seven finite plan rows at prepare and verify. Realm preparation
  adds its two-key/seven-row binding; verification adds three keys/nine rows for Realm read, two
  keys/seven rows for binding, and at most two current-ban keys/six rows. Add ordinary Access
  actor/principal/grant work separately, as derived by `eligibility-access-work.ts`.
- Growth check: Content's native report outcome suite uses real Access; independent grant,
  membership-history and report-population measurements remain continuation work.

### Operation: readRealmSettingsPage

`GET /v1/realms/:realmId/settings` (`realm.settings`, `realm:manage`) prepares the existing
Realm commands. It requires current ordinary Realm disclosure, host disclosure and management;
public readership or owner labels alone grant nothing. Required dependency failure withholds the
response. Source/head, lifecycle, partition or host changes during composition withhold the whole
response. Governance read-only state disables the advisory operations. Every command still owns
admission, preconditions, reauthorization before replay and writes.

The response is `{snapshot,host,operations}`. `snapshot` structurally extends Web's existing
`RealmAppearanceSnapshot`; `head` and the ETag are the actual Realm revision used by If-Match.
It also includes summary, visibility, ownership/governance state, current votes and board scheme.
The host identifies its current Space title and head. Rules summaries use Web's existing first-line
160-character title and remaining 800-character summary, alongside the exact pinned canonical
native body, SPDX licence and SHA256. A later post head never replaces that revision.

Decision: keep Web's existing optional interface: selected concealed references have `state:"none"`
and `value:null`, with their selected IDs retained only in `presentation`; dependency failures use
`state:"unavailable"`, and unset references also use `none`.

For example, `snapshot.rules` is `{state:"available",value:{postId,revisionId,title,summary,body,
licence,sha256}}` when disclosed, `{state:"none",value:null}` when concealed, and
`{state:"unavailable",value:null}` on optional source failure. Avatar/banner reuse Content's exact
`RealmPresentationImage`, without transport keys, credentials, signed URLs or private provenance.
Only the two selected image keys and one selected rules pin are resolved. No candidate inventory,
media claim, receipt, idempotency key or successful-write evidence is created by GET.

Two current owner reads of the selected references precede the final freshly prepared Access/source
round; changed optional facts become concealed. Foreign preparation happens on released source
connections. This composes rechecked native observations, without an atomic cross-home guarantee.
The response is private and not stored. Request identity and Access's current session provenance
remain the mounted HTTP/Access owners' responsibility; Web keeps its existing caller lifetime.

Decision: if the current account, session epoch or identity binding changes during composition, the
whole page is withheld even when the earlier management grant remains. Optional selected-content
changes continue to use the existing concealed or unavailable variants.

`operations.update` names PATCH `/v1/realms/:realmId`, `boardScheme` names PUT
`/v1/realms/:realmId/boardScheme`, and `reserveMedia` names POST `/v1/realms/:realmId/media`.
Their header/precondition and selection requirements are advisory current command facts. Existing
PATCH omission semantics are unchanged: omitting presentation preserves it; supplying it requires
its complete strict object. Omitting Context, votes and board scheme preserves them too. Rules
preparation and media claim remain internal to the existing update command. There is no settings
writer, asset picker or upload/lifecycle engine here.

#### Cost

- **Touches:** `readRealm` first prepares ordinary Access and reads the selected current Realm.
  Each of two source rounds prepares fresh management, Realm and host Access outside checkout,
  then opens one read-only repeatable-read transaction, mints one read time, reads one partition,
  checks those three permissions, reads the exact Realm head, exact host head and existing
  lifecycle binding, and commits (or rolls back and releases on failure). Two selected rounds call
  Content's `readRealmPresentationImages` for at most two same-route keys and
  `readExactPublishedRules` for at most one pin; each owner reader includes its own source/final
  checks and Access preparation. All Community, Access, Auth and Content participating pools and
  registered runner phases belong to this operation, including cold evidence release and denial.
- **Outer source accounting:** adopt the nested-cost correction: seven fresh single-resource
  Access preparations include the initial locator and three checks in each source round. Each
  source round has seven local statements (BEGIN, time, partition, settings, Space, binding,
  COMMIT), so the pair contributes fourteen statements including four transaction controls.
  With `P_i = 2 + d_i + k_i + V_i` the actual preparation cost and `Q_i` its formula evaluation,
  the complete available outer source expression is
  `28 + b_locator + b_initial + b_final + sum(i=0..6, P_i + Q_i)`.
  The 28 includes fourteen local statements, ten source-round eligibility statements and four
  locator statements. Protected-ban terms are each zero or one. This expression excludes the
  selected owner calls and mounted authentication; it is not a measured ceiling. Preparation
  callbacks, inverse membership and assignments retain their own physical row costs.
- **Selected media:** charge both complete invocations. For each, `m<=2` selected distinct IDs
  and `a<=m` usable initial objects give four snapshots and `18+m+a` local statements. Including
  locator time and domain eligibility, the available expression is
  `27+m+2a+b_locator+b_final+sum(3+a actual preparation/evaluation costs)`.
  Across both calls, initial/final/eligibility acquisitions total at most twelve exact media
  queries, each including up to twelve variant slots. Empty selection dispatches none. All
  source/eligibility/final proofs, raw private transport fields and parsed/signature/result
  copies remain charged. There is no object-body fetch.

  Decision: ordinary shared Realm-media acquisition nulls historical thumbhashes over 32 bytes
  and colors outside the seven-byte hexadecimal format before materializing descriptors; the
  image remains available with a null placeholder. Valid native metadata, including historical
  uppercase hexadecimal colors, remains usable. This repairs the common producer used by
  settings and My Realms; the work-only projection and cover-only constraint prove no ordinary
  acquisition bound. No writer, schema snapshot or descriptor grant changes.

  The native image transformer writes the placeholder and at most twelve width-ladder variants
  through `finish-image.sql`. Ordinary acquisition now returns at most 44 ASCII base64 bytes
  and seven color bytes per object. The remaining variable descriptor fields are schema-bounded:
  variant format is four bytes, MIME type ten, digest 64, width four decimal digits, positive
  int32 height ten, positive int64 byteCount nineteen, and the derived key is at most 48 ASCII
  bytes (`m/` + UUID + `/` + format + `-` + width). For seven fields, PostgreSQL JSONB's keys,
  quotes, colons, spaces, commas and braces add 86 bytes; quoted string values add 134 and the
  three numeric values add 33. Each raw variant is at most 253 bytes and the twelve-element
  array at most `2 + 12*253 + 11*2 = 3060` bytes. UUIDs, booleans, enumerated purpose/state,
  timestamp, nonnegative int64 security revision, digest and constrained float4 focal coordinates
  are finite native scalars. Credit is always null here; no rights/provenance document is read.
  These are acquisition field ceilings, not a whole-operation memory or serialization ceiling.

- **Selected rules:** each of the two complete owner calls prepares one batched decisions object
  (`E=1+d+i+o+r<=5` SQL per invocation, with producer costs still charged), then takes two
  source/body snapshots. A complete snapshot has `H+8+e+B` local statements, `H<=33` ancestor
  batches, optional extra partition `e<=1`, optional protected-ban batch `B<=1`, and four formulas.
  Four snapshots therefore execute sixteen formulas, while only the two final payloads are
  parsed, canonicalized and hashed. The SQL raw-body guard gives four acquisitions of at most
  65536 bytes, or 262144 cumulative raw bytes; this is not peak retained memory. Initial/final
  rows, ancestry/container/revision signatures, parsed documents, canonical strings, documentText,
  split/join intermediates and final JSON encoding must be charged separately. Postparse
  canonical limits and title/summary code-unit slices do not bound earlier acquisition or UTF-8.
- **Remaining composition:** retain full Realm/Space/binding/home comparisons, including
  discarded fields, repeated vote-map copies and temporary JSON strings. Source title/summary
  limits are code-point bounds; UTF-8 expansion is at most four bytes per code point and JSON
  escaping at most six. Space address admission calls `normalizeHandle` through
  `space-address.ts`: the lowercased claim pattern in `access/handle-policy.ts` admits
  3..64 ASCII characters. An admitted non-null address therefore acquires at most 64 UTF-8
  bytes and serializes to at most 66 JSON bytes including quotes; null serializes to four.
  This is a native writer invariant, not a database constraint. The address remains charged
  in full host comparisons even though the final host omits it. GET has authentication in its actual Auth/identity and Access
  pools, no declared rate counter and no worker. `releaseOperationalTime` has zero SQL. Failure,
  rollback, withheld and cold-release work is charged where dispatched; a caller retry pays a
  complete new attempt. Complete statement/transaction, examined-row, retained-copy and
  serialization ceilings require the native callee and physical-prefix composition below;
  no total ceiling is inferred from output size or observed runs.

- **Whole available statement composition:** let `j=1,2` index complete media calls,
  `t=1..4` complete rules snapshots, and `F_t` the sum of that snapshot's four
  actual formula costs. The complete expression is
  `S_auth + 114 + sum_j(m_j+2*a_j+b_locator_j+b_final_j)
  - b_locator+b_initial+b_final + sum_t(H_t+e_t+B_t+F_t)
  - sum_outer(P_i+Q_i) + sum_media(P_i+Q_i) + E_1+E_2`.
    Here 114 is `28+2*27+4*8`; the seven outer preparations, up to ten media
    preparations and two batched rules preparations are separate. The fixed local
    and eligibility terms are at most 273 before those preparations, formulas and
    authentication; this is a source coefficient, not a total measured ceiling.
    The complete two-image/two-rules path has fourteen read-only snapshots and
    twenty-eight controls: two/four outer, eight/sixteen media and four/eight rules
    snapshots/controls respectively. Locator and preparation statements and any
    authentication transactions remain additional. Empty image or rules selection
    removes its dispatched owner calls; it does not remove outer proofs. Denial,
    optional failure and rollback charge their executed prefixes; an explicit caller
    retry adds both complete attempts, including authentication.

- **Direct source physical keys:** `realm-read.sql` and `space-read.sql` materialize
  one routed active identity before joining its exact revision. The revision PKs
  are `(route,revision_id)`; the owner ID equality is either an additional indexed
  condition in the three-column unique index or a residual equality on that one
  exact row. The selected Realm also checks its exact active host. `LIMIT 1` is
  not the bound. Native growth inspects those actual source plans for both route
  and revision equality in `Index Cond`; its examined-row/block accounting remains
  separate from output cardinality. This does not bound foreign Access, rules or
  media residual joins, which still need their own native prefix composition.

- **Complete source-derived statement and transaction bound:** the registered
  `GET /v1/realms/:realmId/settings` operation is `realm.settings` and runs through
  `createKernel`'s mounted `communityRoutes` path into `readRealmSettingsPage`.
  It adds no worker or rate-counter query; `releaseOperationalTime` has zero SQL.
  Let `P_o` be each of the seven outer preparations, `P_m` each actual media
  preparation, and `E_1,E_2` the complete batched rules preparations. Let `Q` and
  `F` retain the actual formula counts already defined above. For one verified
  token, `S_auth = 1 + d_auth + w`, with one exact identity-account lookup,
  optional delegated assignment `d_auth<=1`, and at most one Auth signing-key
  read per JWKS fetch `w<=2`. The actual compact bearer size is `T_auth` UTF-8
  bytes; the authentication-work declaration charges `T_auth + 2*8192` bytes
  for verification and bounded JWKS responses. The complete available path is
  the additive composition of the retained component equations:

  ```text
  C_get = S_auth
        + (28 + b_locator + b_initial + b_final + Σ_outer(P_o + Q_o))
        + Σ_(j=1..2)(27 + m_j + 2*a_j + b_locator_j + b_final_j
                      + Σ_media_j(P_m + Q_m))
        + Σ_(t=1..4)(H_t + 8 + e_t + B_t + F_t)
        + E_1 + E_2
  ```

  This is the unflattened source ceiling, not a sampled total. It preserves the
  fixed local/eligibility coefficient of at most 273 while keeping every outer,
  media and rules preparation, formula, auth statement and variable ban term
  explicit. The SQL-only statement ceiling `N_sql` is this expression with
  `Q_o`, `Q_m` and `F_t` omitted; they are formula evaluations, not statements.
  The successful
  two-image/two-rules path opens at most fourteen
  read-only snapshots and runs at most twenty-eight transaction controls; each
  opened snapshot ends in one COMMIT or one ROLLBACK. Failed/withheld paths pay
  the dispatched prefix and replace a reached COMMIT with ROLLBACK. Cold
  connection release adds no SQL. A caller retry adds the whole expression and
  a fresh authentication path. Outside those snapshots, every preparation and
  identity/JWKS SQL statement is a separate pool statement; the transaction
  ceiling is therefore fourteen snapshot transactions plus the exact statement
  counts `S_auth + Σ_outer P_o + Σ_media P_m + E_1 + E_2` for those autocommit
  paths. Formula evaluations add no SQL transaction.

- **Identity, Access and physical candidate ceilings:** one bearer verification
  dispatches at most two JWKS fetches; each response is read with an 8192-byte
  cap and at most three signing keys. The Auth/identity path reads the signing
  generation/key rows, performs one exact account lookup and performs one extra
  assignment lookup only for a delegated `requested_by` identity. Those executed
  statements and response bytes are in `S_auth` and the Auth capture, not in the
  kernel transaction count. The admitted token claims additionally cap account
  subject at 36 characters, `client_id` at 1024 code units, scope at 66,047
  ASCII bytes/512 scopes of at most 128 bytes each, `amr` at 100 ASCII strings
  of at most 128 bytes, and delegated identity to its exact request pattern.
  There is no shorter fixed HTTP bearer cap in this reader; request and JOSE
  byte costs therefore retain the admitted `T_auth` term rather than inventing
  a constant. Each `P_i = 2 + d_i + k_i + V_i` keeps the two base
  reads, optional assignment (`d_i<=1`), at most two inverse-membership probes
  (`k_i<=2`) and role-reader probes (`V_i`) visible. Each of at most two accounts
  contributes no more than `MEMBERSHIP_LIMIT=1000` inverse memberships; role
  proofs are made only for those returned exact group IDs. Consequently
  `V_i<=2*MEMBERSHIP_LIMIT=2000` exact group/action probes and, at two matching
  role-grant candidates per group, at most 4000 role-grant candidates per
  preparation (68,000 across the maximum seventeen outer/media preparations).
  Direct identity and
  resource-grant reads use the routed resource/subject/action key, role grants
  use the corresponding exact group/action key, and denials use the exact
  resource/subject/action/time predicate. The new authority-history population
  proves that old, non-overlapping grant intervals do not turn this exact current
  decision into a relation scan. The Access result cap and SQL `LIMIT` are not
  treated as examined-row bounds: physical plans must retain the indexed key
  prefix, and native execution measures heap/index blocks separately.

  Direct Community lookup has at most one selected Realm identity, one exact
  current Realm revision, one selected host identity, one exact host revision,
  and the exact binding/home rows projected by the two source rounds. The
  existing source-prefix assertion proves only the routed exact Community
  revision condition. The source eligibility producers have nine Realm, seven
  Space and seven binding projection nodes; protected-ban work receives at
  most two facts and expands to `2*n+2<=6` exact candidates. Each point lookup
  is charged for its index probe and residual owner/host equality even when it
  returns no row. For rules, each of four snapshots follows at most 33
  ancestry posts, with exact route/post and route/revision lookups for the
  selected thread, board, Realm, pin and body. The maximum ancestry population
  is therefore `4*33=132` post candidates across the two full rules calls; each
  successful selected call takes two snapshots and four formulas. The body
  guard admits at most one exact body row per snapshot. Residual owner/post and
  container checks remain charged after indexed key lookup, and absent matches
  still incur their index probes.

  For media, the two full calls make at most twelve exact `(route,media_id)`
  acquisitions total. Each acquisition joins at most twelve unique variant
  slots, so at most 12 media rows and 144 variant rows enter the two-call source
  composition. This uses the exact route/media and `(route,media_id,format,width)`
  keys; the variant JSON array is bounded at 3060 bytes per acquisition. The
  object-body path is never dispatched. Neither this fact nor output `LIMIT`
  substitutes for the captured plan and block bound: the native media-history,
  authority-history, rules-history and direct Community populations are
  independent, and their result is reported only by the controller's native
  three-scale execution.

- **Acquisition, retained-copy and response serialization ceilings:** source
  signatures retain the complete Realm, Space, binding and home projections
  used by `settings-page.ts`, including fields discarded from the final page,
  and serialize both initial/final signatures. The source-copy ceiling is
  `C_locator + 2*C_source_round + 2*C_source_signature`, where each round
  includes every projected Realm/Space/binding/home field and its exact SQL
  result, not merely fields exposed in JSON. Realm and Space each admit a title
  of at most 1024 code points and summary of at most 4096. Each pair therefore
  acquires at most 20,480 UTF-8 bytes and occupies at most 30,724 bytes in JSON,
  including quotes and worst-case escaping. The locator plus two source rounds
  acquire at most five such pairs (102,400 UTF-8 bytes); the two full source
  signatures serialize four pairs (122,896 JSON bytes), in addition to all
  fixed fields and keys in their full projections. The final Realm+host page
  serializes two pairs (61,448 JSON bytes). For a non-null admitted Space
  address, the two source rounds acquire at most `2*64=128` UTF-8 bytes and
  stringify at most `2*66=132` JSON bytes including quotes; null is four JSON
  bytes. These repeated address copies occur in discarded host signatures and
  are included in `C_source_round` and `C_source_signature`.

  Each of the twelve possible media acquisitions retains its full finite scalar
  projection plus a variant array of at most 3060 UTF-8 bytes. The already
  documented per-variant maximum covers every raw field: four-byte format,
  ten-byte MIME type, 64-byte digest, four-digit width, ten-digit height,
  nineteen-digit byte count, and a 48-byte key. Across all acquisitions, raw
  variant JSON is at most `12*3060=36,720` bytes. Descriptor transformation
  additionally retains at most two selected images in the page, each with at
  most twelve variants, 44 base64 thumbhash bytes, seven color bytes, finite
  UUID/enum/timestamp/revision/digest/focal-coordinate fields, and its own
  serialization. Raw JSON, parsed variant values, first/final signatures,
  transformed descriptors and final page JSON are separate copies in the peak
  expression; the 36,720-byte acquisition total is not itself the peak.

  Across four rules snapshots, raw body acquisition is at most
  `4*65,536=262,144` UTF-8 bytes. Only the two selected final payloads are
  validated and hashed. For each, the retained-copy accounting separately
  includes the bounded raw body, up-to-33-row ancestry/container/revision
  signature, parsed document, canonical JSON (at most 65,536 bytes),
  `documentText`, split-line payload, joined text and hash input. The raw body
  is capped in SQL before transfer; each text/canonical form is capped by the
  document contract, and `split("\n")` has at most 65,537 entries for a
  65,536-byte text. The symbolic peak is
  `C_locator + 2*C_source_round + 2*C_source_signature + C_media_peak
  - 4*C_rules_signature + 4*65,536
  - 2*(C_parsed_document + C_canonical + C_documentText + C_split_payload
  - C_joined_text + C_hash_input) + J_settings`. `C_rules_signature`is one
    complete maximum signature: 33 post rows plus the selected thread, board,
    Realm, pin/revision and their discarded signature fields.`C_media_peak`
    includes all 12 exact acquisitions, their complete scalar projections,
    36,720 raw variant-JSON bytes, parsed variant values, first/final media
    signatures and the two transformed descriptors. Every term is bounded from
    the source schema/producer maxima above, not measured samples. The sum
    deliberately charges simultaneous initial/final copies rather than assuming
    early reclamation; it bounds application byte copies and source rows, not
    runtime allocator metadata.

  The response contains one selected rules document, no more than two image
  descriptors, finite operation/UUID/vote fields, and Realm plus host titles
  and summaries. Its UTF-8 JSON ceiling is
  `J_settings = J_fixed_schema + 65,536 + 2*J_image_descriptor`, where
  `J_fixed_schema<=96 KiB` includes the title/summary bounds above, rules title
  and summary limits, fixed identifiers and object keys, at most seven UUID
  vote entries, finite operation descriptions and all delimiters. Each
  `J_image_descriptor<=8 KiB` includes the maximum twelve serialized variants,
  finite top-level descriptor fields and bounded thumbhash/color fields. Thus
  the complete response JSON is at most `96 KiB + 65,536 + 16 KiB = 180,224`
  UTF-8 bytes (under 192 KiB), including worst-case six-byte escaping and final
  encoding. This source ceiling is independent of measured response samples.
  The UTF-8 application request additionally includes the admitted `T_auth`
  bearer bytes and bounded route/headers; the request/response and JWKS byte
  counters remain independently captured by the mounted growth test.

Decision: Web's `settings.get` type is delivered only by the shared complete-input publication; the mounted Content route uses the ordinary Realm-media producer, returns the current head as its quoted ETag, and requires the quoted current head in command If-Match.

Decision: mounted settings growth reuses the existing dual-database capture combiner;
caller retry retains both Auth captures and both complete Kernel requests before growth
comparison. No separately measured media operation stands in for either selected call.

- **Growth check:** existing `growth-realm-presentation-settings` proves the update command,
  not this GET. `realm-settings-page.test.ts` connects native creation, empty/read-only effects,
  exact pinned and concealed rules, host removal, CAS updates/readback, omission, account switching,
  management revocation, optional rules failure/recovery and source/authority changes during composition.
  `realm-settings-page-media.test.ts` covers sparse image selection and read-only effects;
  `realm-settings-page-media-rules.test.ts` connects avatar, banner and an exact rules pin together,
  then withdraws one selected image. `realm-settings-page-lifecycle.test.ts` covers protected access,
  orphan read-only state, erased selected rules and suspension during composition. Controller-owned
  `realm-settings-page-growth.test.ts` adds mounted available, empty, denied, revoked,
  optional-unavailable, caller-retry, deadline and final-authority-withheld branches against independent
  unrelated Realm, selected Realm revision, selected rules revision, selected-media history
  and authority history populations at
  256/1024/4096. Available branches compose two actual selected images with the exact rules
  pin; the rules-unavailable branch retains both images, and the unrelated-Realm available
  branch walks the maximum 33-row rules ancestry. Each request constructs fresh native
  Access/JWKS state, captures Kernel and Auth separately, checks read-only effects and
  aggregates before growth comparison. The available branch checks seven outer preparations,
  up to ten media preparations, two batched rules preparations and sixteen rules formulas.
  Controller-owned native execution and the complete three-scale result remain deferred;
  these source equations and focused cases establish no measured pass.

### Search Space entry presentation

`space-discovery-entry.ts` composes the existing anonymous `spaceDiscoveryRound` with current
Space/Realm viewer-action resources, exact active address claims and native Realm presentation media.
A carried Realm supplies the identity and avatar; a standalone Space supplies its own identity and no
Realm avatar. No selected avatar, withheld selected media and unavailable media stay distinct. An
occupied unreadable or removed Realm slot suppresses the Space; it cannot become standalone. An
address replacement invalidates an old row. Index hints never supply presentation or destinations.

Entry destinations use `following-space-contract` identities, while carried Realm entry takes the
actual Realm home route even when its Space has an address. Readable resources alone do not permit
entry: current mounted `realm.home` or `space.get` operations supply entry advice. `realm.join`
supplies separate admission advice, without asserting membership or joining. The native Realm page
continues to own rules acknowledgement and membership. Library owns Space follows.

Decision: Search consumes Library’s published bounded follow-discovery adapter with exact native
Space source hashes and a final snapshot check; unavailable native observations stay unavailable.
It never substitutes Realm following or introduces another generic adapter or writer.

Every observation reads at most 100 exact Space keys, grouped by native partition, and at most one
carried Realm per Space. The existing owner round uses full-key Space/head and occupied-slot seeks
(each `LIMIT 1`), full-key carried Realm/head seeks (`LIMIT 1`) and current source gates. Active
address claims use batched exact address/native-route seeks, with one claim key per address. Action
resources contain at most 2S references, split into at most two 100-resource batches; the native
viewer-action producer retains its 64-action/256-operation binding limits per resource. Up to R
selected Realm avatars use the existing native media producer (one selected media identity, at most
12 variants); no Community checkout survives Access, Library or media preparation. An owner round
after preparation discards changed bindings. Search repeats the complete observation at final
disclosure, including current action and media bindings. This adds four bounded owner rounds for
S ≤ 100 and R ≤ S, rather than any per-card HTTP detail reads or unrestricted scans.
