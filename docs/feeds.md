# Home and Following feeds

`GET /v1/feedItems` returns one mixed page. `stream` is `home` (default) or `following`,
`limit` is 1–20 (default 20), and `cursor` is an opaque continuation. `Accept-Language`
selects native summary languages. The response is `{feedItems,next,asOf,sources}`.
The exported closed `FeedItemSchema` and `FeedPageSchema` define the client-inferred wire.

Optional singular `kind` is the exact native kind ID, for example
`GET /v1/feedItems?stream=home&limit=20&kind=schema%3ABook`. Omission retains all kinds.
The native `kind.in` literal grammar permits a nonempty string of at most 256 UTF-8
bytes without control characters; IDs are neither trimmed nor case folded. Empty,
malformed, oversized or repeated `kind` parameters return RFC 9457 validation problems.
No arbitrary JSON filter is accepted. Exact Space and Context parameters follow the
Home dimension contract below.

Selection applies to the freshly disclosed primary `FeedItem.key.kind` across all
three sources. A thread about a Book remains kind `thread`, a reply remains `post`,
and a Collection containing Books remains `collection`. An attached Subject or follow
reason does not change the primary kind or grant disclosure. Following and Continue
retain all their original current owner, body, parent, container and erasure checks.
Discovery receives `filter: {kind: {in: [kind]}}` through the existing
`DiscoverySearch(principal, MixedDiscoveryRequest, DiscoveryReadContext)` provider
with `representation: 'discovery-v1'`. Native release/input refusal, including
`unsupported_query` (422), is returned as its actual problem rather than an unavailable
lane or an all-kind fallback. Genuine dependency/preparation failures retain their
existing source states.

The existing native choice source is `POST /v1/subjects:search` with
`{representation:'discovery-v1',kindPage:{limit:8}}`. Its response includes
`kinds:{values:[{id,labels,icon,count?}],next}` with at most eight native choices.
Continue metadata with `kindPage:{limit:8,cursor:kinds.next}` and the same request
bindings; this continuation is metadata-only. This source does not claim choice text
search. There is no separate Content choice directory or all-kind enumeration.

Each item has a stable native `id`, `source`, canonical `key`, nullable `occurredAt`,
currently disclosed native `summary`, and typed `destination`. Destinations contain IDs
and titles, never external URLs. A post preserves both `threadId` and `postId` for the
consumer's canonical thread route and post fragment. Continue also carries the original
native Continue subject, state and session. Thread/post summaries use native current
read fields. Their optional `author` carries only the currently disclosed Accounts display name, handle and avatar;
optional `excerpt` contains native document plain text, with whitespace collapsed, capped at 160 Unicode code points
and cut before a grapheme would cross the cap. Empty or withheld bodies omit the excerpt; missing identities omit
the author, with no identifier fallback. No row ratings are added. Collection summaries contain its current ID, title and description.

Anonymous home invokes only the existing public DiscoverySearch producer. Following and
Continue are `not_requested`. Authenticated responses are `private, no-store`; session
preparation belongs to the consumer. Current actor-home lifecycle and credential floor,
`follow:list`, and the personal Library gate admit Following. Home additionally requires
`library_entry:list`, `progress_session:list`, the personal Library gate with the original
Library action, and the reading-progress gate. Discovery independently admits the Search
gate. Refusal and closed gates remain RFC 9457 problems. Admission is never converted
into an empty or unavailable lane.

The existing `KernelDependencies.discovery` supplies DiscoverySearch unchanged, including
its owner hydration, final disclosure and selected ordering. The feed does not create a
second Search factory. Discovery's default is native name order, not recent activity or
a personalized recommendation. Continue calls the existing owner reader with `limit:6`
and `view:'FULL'`, its native Access, pool, route key, tokens and optional Search service.
A missing canonical owner Source remains preparing/unavailable. No state/session is
manufactured. Every requested source independently reports `ready`, `preparing` or
`unavailable`; only ready empty means known empty. One failed source leaves the others
usable. Raw dependency errors, reason counts and hidden references are not returned.

## Page positions and cost

The merge is deterministic round-robin in Continue, Following, discovery order, with
the next turn persisted. Each lane preserves its native order. Following uses descending
`(occurred_at,activity_id)`. Canonical object deduplication prefers Continue, then Following,
then discovery for this page. Duplicate and rejected candidates consume their source
positions. No all-follow, all-kind or partition scan runs in a request; no profile lookup
is performed per row; Following resolves at most F distinct disclosed authors in one Accounts summary batch.

One bounded mixed round fetches Continue's six, discovery width
`max(1,floor((P-6)/2))`, and Following width `max(1,P-6-discoveryWidth)`.
Following alone reads P; anonymous home gives discovery P. The feed reserves the actual
native owners' raw-work upper bounds: discovery `6D+3`, Continue 39 and inbox F. At P=20
the mixed candidate bound is 91, anonymous 123, Following 20; all are below B=160. There is no
additional refill round. `feed.ts` records the producer constants and derives this ceiling.
The author batch adds at most F identities (F≤20, below Accounts’ 100-key batch cap), each with at most
one avatar and one verified-agent Subject, retaining the native initial/final Account and handle checks.
This adds no feed candidates and no per-row reads. The composed candidate-plus-author-key ceiling (including those two optional references per identity) is
112 for mixed Home, 123 anonymous and 80 Following, still within 160. Original owner readers retain their maximum three native
continuation rounds and stricter native operation budgets. Owner point probes and
batched semantic summary/reference reads are bounded by these candidates; merge work
is O(B log B), and native indexed owner probes are O(B log R).

Space-selected Following adds initial/final native Space and Realm reads (four keys)
and at most F distinct current board reads, cached only for this request. It adds no
feed candidates or refill. The conservative candidate/author/Space key reservation is
123 for mixed Home and 104 for Following at P=20, below B=160. The native board and
Space readers retain their own container, presentation and final disclosure work.

Discovery/inbox pages wider than one fit completely in the response budget. Small pages
may partially consume Continue's native six: the cursor retains the original owner
cursor, the last examined native activity key and the page's key fingerprint. The next
read rehydrates that same native page and resumes after that key. A changed owner page
requires a stale-cursor restart instead of skipping data or caching private progress.
Sparse pages, including empty pages with `next`, are valid. Kind rejections consume
the original raw budget and advance actual examined source positions before merge,
deduplication and output. No refill or additional candidate read runs for a selection.
The server never derives a frontier from visible output count.

The composite cursor binds the exact viewer/credential authority inputs, stream, page
size, languages, exact optional kind, format, fixed boundary, next turn and source positions.
A cursor from all kinds or one selected kind cannot replay under another selection.
Omitting kind preserves the existing cursor query semantics. Bounded parts
use the existing native encrypted list-cursor envelopes with a common authenticated
digest and part/count bindings. Total cursor size is capped at 32 KiB and expires after
15 minutes. Following's initial keyset boundary is fixed by that page sequence.
Native discovery membership/freshness remains owned by its retained cursor. `asOf` is
the private page boundary or anonymous discovery's native freshness timestamp.

## Activity, delivery and current authority

The default Content registration adds committed thread/review/reply creation, Realm
subject adoption, and currently public Collection listing/member/update effects to the
same shared effects runtime. A catalogue-valid event must match its exact outbox event,
partition, epoch, position and actual event index. Subject references retain the native
maximum of 128. Realm content additionally carries its actual Space. Activities contain
only source/target/object locators and time, never bodies, titles, grants or permission
flags. Semantic publication locators retain Realm and publication IDs so a withdrawal
or replacement cannot revive an old event. Collection events never feed public discovery.

`createFeedActivityStore({pool,clock?,tokens})` exports
`pageTargetActivity(target,{cursor?,limit?},deadline)` returning `{activities,next}`, and
`applyFollowingActivity({accountId,reasonTarget,activity},deadline)`. Limits are 1–128.
The additive `tokens` dependency is the actual composition's native ring, not a new
environment secret. Internal inventory/inbox cursors use native sealing; durable work
positions have no HTTP-session expiry. Their current retention and source identity are
still rechecked. The HTTP composite cursor supplies the viewer/session lifetime.

`createFollowActivitySource({pool,clock?,tokens,workClient,activityStore})` exports
`pageRecipients(target,{cursor?,limit?},deadline)` returning `{recipients:[{accountId}],next}`,
and `checkCurrentFollowSupport(actor,{targets},deadline)` returning
`[{target,status:'following'|'not_following'|'unavailable'}]`, with at most three targets.
Subject, Collection and Space are supported. Recipient keysets advance on examined
inverse candidates, including stale/ineligible accounts. The indexed positive inverse
and its current terminal/epoch/readiness are candidate support only. Every positive
disclosure independently reads current actor-home follows, explicit negatives, lifecycle
and identity. Redirected support is positive only with a complete bounded native witness;
unknown or oversized support is unavailable. No truncated authority page grants access.
The native identity reader accepts 100 originals; an alias witness exceeding that bound
is unavailable rather than truncated. A recipient cursor whose current terminal/epoch
changed restarts its bounded inverse walk; idempotent inbox writes absorb repeated candidates.

Each fanout step reads at most 128 inverse candidates, releases the source home, and
delivers to one viewer home per transaction. Work is O(targets × recipients) overall,
O(128 log R) per step. Inventory commit and durable fanout enqueue both precede effect
success. Idempotent source-derived IDs make retries safe. Library registers follow-change
backfill beside its existing work. Before reading recent inventory it delivers the
existing native follow-count replacement and confirms candidate coverage, closing the
race between new-follow backfill and concurrent activity fanout. Backfill delivers at
most 2000 references from the same 30-day inventory. It examines at most 2048 references
in sixteen resumable pages of 128; the final page delivers only the remaining allowance.
The inventory key remains the followed native original reason, including after a redirect;
the inverse destination is resolved independently and never substitutes that inventory key.

Following is a candidate inbox. Before returning each item, the feed checks genuine
current follow support, calls the original native current owner read, checks current
references/container chain, and checks follow support again. Thread keys are grouped
by the existing native disclosure executor's backend/container
snapshots rather than individually probing every thread. Reply reads retain their exact
native thread/post anchor. Thread/opening post/reply, board/Realm/Space, publication head,
Collection visibility, and owner body/reference
authorization remain with their original readers. Removed, erased, hidden or revoked
objects are omitted according to that current authority. No projection supplies an allow.
One retained reference supplies one checked reason; multiple reasons deduplicate by
canonical object and no reason count or hidden target is exposed.

## Retention and recovery

Each viewer retains only the newest 2000 references and only the last 30 days, whichever
is stricter. Delivery serializes per viewer and trims the overflow immediately; reads
always apply the age cutoff. The default hourly retention schedule uses the existing
shared schedule provisioner and bounded indexed deletion of 128 inventory and 128 inbox
rows per step, with durable partition/segment continuations. Target inventory is also
age bounded. No request performs cleanup or archive backfill. Destinations lead to the
owner's full history.

The existing Content account-erasure authored phase drains at most 128 of that account's
own private inbox rows before advancing. Terminal lifecycle fencing prevents delayed
deliveries from recreating them. These rows contribute only to Content's existing
outcome; they never acknowledge foreign or Library erasure. Worker steps retry through
the existing runtime and resume after failure. Owner/source movement or unavailable
identity remains unavailable until native recovery; it is never declared empty.

The default-composition regression is `services/kernel/test/content/feed.test.ts`, using
real server/worker, discovery, canonical owner work, native follow changes and disclosure.
Module schema dumps are derived by the controller through the normal supported path.

## Home dimensions

Native kind selection is delivered. Space membership of the existing Following inbox is implemented;
complete native/API and browser acceptance remains with the controller.
Following threads/replies use their currently disclosed board's native Space; adopted
Subjects use the current publication and that Space's current Realm slot. A stale follow
reason cannot establish membership. Collections have no native Space membership; contained
Subjects do not change their primary identity. Initial and final selected Space authority,
head and Realm slot must agree, including on empty pages. Kind, Space and available question
selections apply as a literal conjunction to the same primary candidate in the mixed stream.
Discovery and Continue Space selection still depend on Search's original retained Source
and scoped journey; a point read alone does not establish their population membership.

Decision: Space-selected Home keeps native Following usable and reports Discovery/Continue
unavailable until their original selected-population producers are ready.

Home accepts exact `spaceId` and `ratingQuestionId` request selections. Space selection
uses the existing Following order and examined positions, including sparse continuation;
Discovery and Continue are omitted as unavailable before reading unselected candidates.
An unknown or unreadable selected Space returns `not_found`. Question selection still
returns `dependency_unavailable` before enumeration until its original population producer
is composed; point review witnesses do not activate it. Failed source lanes
remain omitted; only a ready lane with a native frontier enables Next, while Retry may
retry a failed lane. The available default sources remain catalogue/Account discovery,
recent Following and Continue. Public Board/Realm/discussion/Collection discovery and
Discovery/Continue Space membership and Context membership remain pending their original producers.

Home Space choice reads retain the resolved Space identity on point-read failure so a failed
revalidation disables that selection; platform closure remains distinct from access denial.

## Native review question witnesses

Content's [native witness reader](../services/kernel/src/content/README.md#review-backed-question-witnesses)
checks exact primary/review pairs against current question authority, opening citations and disclosure.
Private vote changes preserve published citations. Opening edits and retirement affect the next witness
read. These point reads supply no population coverage and do not activate candidate selection.

Rating-question Context has an adopted meaning and a feed request surface; native
candidate eligibility integration remains undelivered. It selects one exact native rating-question
identity. A Subject qualifies when at least one live currently readable review of that
exact Subject has a currently readable opening revision whose immutable citation names
the selected question. A review thread requires its own current opening citation and a
readable reviewed Subject; a reply/post requires that qualifying review thread and its
own current disclosure. Catalogue Agents follow Subject membership. Native Accounts,
Collections and ordinary discussions have no membership in this version. A Subject's
Space witness and question-review witness may be different threads; membership does not
claim that the cited review was posted in the selected Space.

Private votes, aggregates, question applicability/grain, editorial Contexts and Realm
populations are not membership witnesses. The separate future request-only `ratingQuestion.id`
predicate shape remains uninstalled; it is not a stored-reference predicate, permission or rating threshold.
Before exposing a Context selector, finish current native witnesses and lifecycle/Source
coverage, definitions:read before enumeration, bounded real question choices with signed
keysets and current metadata, signed selection/revision binding and the default feed
composition. Preserve native candidate/frontier bounds and unavailable responses; no
browser filter, downloaded-first-page directory or selectable placeholder supplies these
dependencies. Kind and actual Space delivery need not wait for Context. The full dimensions
outcome remains incomplete.
