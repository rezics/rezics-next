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
release is failed preparation for this composed shelf. A genuinely empty raw window needs no Semantic read.
Shelf exhaustion never certifies the complete Realm population. The existing Web reader still issues per-cover
Subject calls until its owner binds this mounted transport; this shelf alone is not the complete Realm-home journey.

### Cost

- **Touches:** One publication raw seek of at most13 heads, up to12 initial exact head/disclosure reads, and one
  released container observation; finalization prepares fresh native Realm/Subject Access checks, reads up to12
  exact heads and rechecks the original container. Semantic deduplicates selected identities, groups each native
  batch by home, and uses its existing maximum three representative-plan attempts. Each attempt resolves the active
  release, exact Subject/current labels, image/original-language slots, representative-edition selection, native
  media references and source fences. Preparation executes before snapshots. Final Semantic equality reads native
  metadata for only participating homes and rechecks admitted Subject/edition disclosure. All these operations use
  the supplied Kernel pool, including Access preparation/verification and partition dispatch; there is no HTTP or
  additional membership, ban, member-count, board or presentation reader in this shelf. Native executor/Access
  retries retain their own controls and the original deadline. Empty selection skips Semantic; denial conceals;
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

Decision: expose tuple-fence readiness only after Search registers an explicit source generation/cut and publishes an
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

- Touches: Two exact owner rounds cover at most 100 requested Spaces, two grouped current-fence reads cover at most 5,000 tuples, and two capability observations scan the fixed install/counter summaries.
- Bound: Each owner contributes at most 50 tuples; each source-fence statement carries at most 100. In the worst spread, each fence round reads at most 5,000 tuple identities across at most 4,096 tuple homes, with one anchor per home; total selected owner/reference/fence rows stay below 20,200, before fixed transaction and index overhead.
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
current records ordered by account ID, with an opaque cursor bound to the Realm,
viewer, limit and partition epoch. A record's `actor` is null once the moderator's account is erased. Denials stay on the Realm; content writes must check
Realm participation directly, and public reads remain open.

The Space home exposes Realm ban management through these native endpoints. Its personal current-ban list
is also the current `realm:ban` authority check, independent of membership or cached role labels. Each page
requests 20 records and keeps the native continuation; unavailable or denied reads never become empty lists.
The ban response's non-null `workflowId` means removal was queued, not completed. The list supplies no removal
completion status, so refreshing it cannot prove settlement. Unban permits later admission under the Realm's
ordinary rules without restoring membership or changing follows; existing removal work may still be pending.
A role-conflict response asks for genuine owner/moderator role removal before another ban attempt.

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
| List own Realms                                              | Keyset-read at most 80 caller-route inverse rows, then confirm each candidate with one current `realm_member` primary-key read.                                                                                                                                                                                                                          | At most 160 rows and a constant number of statements; logarithmic blocks in the inverse and membership indexes.                                                                                                | `test/community/own-realms.test.ts`: “own Realm pages use confirmed memberships, signed cursors and bounded inverse scans”.                                                                                                                                                                                                                         |
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

`GET /v1/realms/{realmId}/members` selects at most 20 raw current membership keys in Realm-local account-ID order. The signed cursor binds Realm, viewer, page size and partition epoch; sparse or concealed identities remain rows and never move the continuation. `accountId` optionally inspects one exact Account independently of that page. It is deduplicated with page IDs for bounded Accounts identity hydration and does not affect the cursor.

The Realm source confirms every selected open interval against its immutable published transition proof and the exact committed command receipt, then checks terminal evidence. A missing, provisional or inconsistent selected member produces `preparing` with the same cursor. The final Realm, management authority, membership anchors and Accounts identity anchors are rechecked before returning private roster data. Current ban facts use exact Realm ban keys. Ban advice requires a separate current `realm:ban` check and the bounded Access role projection; a target beyond an incomplete role prefix receives uncertain advice. Identities contain only the public ID, kind, state, handle and display name; deleted identities retain the native tombstone shape. A private or missing display name uses `Member`. Add-member advice targets the existing accepted-202 command, and ban/unban advice names their native outcomes. Removal and role revision advice say no mounted method is available.

#### Cost

- **Touches:** The mounted read performs two existing Realm reads and two current `realm:manage` checks, one partition epoch read, one raw key page, and at most 21 exact membership/proof/receipt/terminal checks. The final membership observation repeats at most 21 exact checks. Accounts receives two deduplicated batches of at most 21 IDs, at most 42 identity-home queries total. The separate `realm:ban` authority is checked twice; when allowed, one exact ban statement covers at most 21 targets and two Access current-role page statements return at most 101 rows each. Serialization is capped at 600,000 UTF-8 bytes. Retry repeats these bounds at the same cursor.
- **Bound:** Raw output is at most 20 members plus one selected Account. The existing `realm_member_open` prefix bounds page keys and `hasMore`; the added `realm_membership_proof_published_current` key bounds committed proof lookup independent of one member's transition history; terminal and current ban checks use exact Community keys, while protected-role advice reads the existing bounded Access current-role projection. Each role page returns at most 100 rows plus one lookahead; an absent target in an incomplete page yields uncertain ban advice. Each Accounts ID batch has at most 21 deduplicated IDs, routed to at most 21 actual homes, with at most 21 ID-prefix queries per batch and 42 across both identity observations. Each public name is limited to its owner contract's 4,096 UTF-16 units and the whole serialized page is byte-capped. Nested Access permission reads use their existing bounded actor, session, membership and grant prefixes. This is a fixed request and statement bound across all participating homes, not an aggregate or member count.
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
