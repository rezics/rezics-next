# Home and Following feeds

`GET /v1/feedItems` returns one mixed page. `stream` is `home` (default) or `following`,
`limit` is 1–20 (default 20), and `cursor` is an opaque continuation. `Accept-Language`
selects native summary languages. The response is `{feedItems,next,asOf,sources}`.
The exported closed `FeedItemSchema` and `FeedPageSchema` define the client-inferred wire.

## Public discovery variants

The [adopted second scope](research/content-second-scope-plan.md#adopted-decisions) includes public
Collection, review and Space cards in this same discovery lane. Search owns the mixed key/summary union,
population, ranking, current owner hydration and final eligibility; Commerce owns selected-public-output
Collection eligibility, and Content owns review and Space populations. Feed composition consumes those native
summaries without point-read enrichment, private membership or Collection query contents as fallback data.
Following Collection activity retains its existing meaning and does not establish discovery eligibility.

The installed `FeedItemSchema` admits public discovery Subject and Account rows, plus Following thread, post and
Collection rows. It has no public discovery Collection, review or Space variants. The Web reader keeps named
Collection and Space seams for the eventual owner union, and renders the existing disclosed Following Collection
and review rows through the shared ContentItem adapter. Home states visibly that public Collection, review and Space
discovery is unavailable; it does not turn their absence into an empty result or hydrate them with point reads.
Search/Content activation remains pending those producers; no successful empty variant or feed-local index
substitutes for them. Unknown or mismatched summaries make discovery unavailable instead of becoming fallback
Account cards.
`feed-discovery.ts` dispatches exhaustively on Search's summary discriminator and requires the exact owner,
kind and summary identity. A rejected mapping retains the incoming lane position for retry. Search-omitted
removed or unauthorized candidates retain Search's native examined frontier, including empty pages with `next`.

Web continues to receive, for example, `{source:'discovery', key:{owner:'semantic',kind:'schema:Book',route:0,id},
summary:subjectSummary, destination:{kind:'subject',id,title:null}, occurredAt:null,
id:'discovery:semantic:'+id}` or the corresponding `accounts/account` key, Account summary and
`{kind:'account',id,title}` destination. The continuation must publish exact new closed schemas and examples
for Collection, review-thread and Space destinations together with their mappings and native producer wiring.
It must retain exact kind/selection cursor binding, `6D+3` discovery work, B=160 and one bounded mixed round.

## Selection and native summaries

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

The mounted page cap is 20 rows; the native kind picker returns at most eight choices per metadata page, and the
existing rating-question directory returns at most 20. Space restoration uses one current Space point read. The
wire has no aggregate disclosed-summary byte cap, and its Following Collection description has no `maxLength`;
public Collection/review/Space summary caps remain producer-owned and unavailable until those variants are mounted.
Response row counts do not establish native indexed scan work.

Web Back/Forward and owner-destination return keep a versioned descriptor in the current same-origin Home
history entry. It contains only the stream, exact selector IDs and current opaque request frontier; it has no feed
rows, private summaries or credentials, and selection is never added to the URL. The Web reader validates the
descriptor's version, origin, localized Home path, selector grammar and 32,768-character cursor bound before
restoring it. A frontier above that bound is omitted and returns as explicit restart with the same selectors.
Space and rating-question identities are revalidated through their existing point readers. A changed or expired
native frontier shows explicit restart, which keeps the same selectors and removes the cursor. Selection
replacement retires the current page and pending request before reading; session/viewer remounts cannot reuse the
previous private page body. Following is restored only while the current viewer is signed in.
Decision: Home return state is a bounded same-origin history descriptor, never URL filters or retained feed bodies.

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
or replacement cannot revive an old event. Following Collection events remain activity only; the adopted
public Collection discovery variant uses Search's independently eligible public metadata source.

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

Native kind and Space selection are delivered across Discovery, Continue and the existing Following inbox.
Following threads/replies use their currently disclosed board's native Space; adopted
Subjects use the current publication and that Space's current Realm slot. A stale follow
reason cannot establish membership. Collections have no native Space membership; contained
Subjects do not change their primary identity. Initial and final selected Space authority,
head and Realm slot must agree, including on empty pages. Kind, Space and available question
selections apply as a literal conjunction to the same primary candidate in the mixed stream.
Discovery retains the original public catalogue journey and intersects each bounded native
candidate window with current Space membership before choosing the page, preserving the
catalogue's name order and its existing `6D+3` work ceiling. Continue applies the owner
eligible-progress population, then the same current Space membership and exact kind before
choosing its six rows; its existing 39-key work ceiling and examined-key cursor remain in force.
Accounts and Collections are outside Space membership. Both lane cursors bind the selected
Space observation and kind so a continuation cannot broaden or silently change its selection.

The native structural input is now `openSpaceSubjectPopulation` in
`content/feed-subject-scope.ts`: the complete current adopted publication-head population
of the selected Space's current Realm, with indexed Subject keysets and an unconsumed
lookahead. Its retained observation binds the Space head, Realm head, partition epoch,
Realm disclosure epoch and native publication generation. Publication-head writes advance
that generation in their own transaction. Prefix and terminal reads revalidate the
observation and current Space authority, including empty and Realm-less populations.
Unrelated Realm growth neither advances that observation nor enters its prefix.
Decision: retain structural membership separately from public catalogue and eligible-progress
coverage. Discovery intersects its retained public catalogue and Continue intersects its eligible
owner progress population with this scope before selecting a page. This input alone does not
establish Subject disclosure, public Search freshness or owner progress readiness.

Home accepts exact `spaceId` and `ratingQuestionId` request selections. Space selection
uses the existing Following order and examined positions, including sparse continuation;
Discovery and Continue intersect their original complete populations before page selection.
An unknown or unreadable selected Space returns `not_found`. Question selection still
returns `dependency_unavailable` before enumeration until its original population producer
is composed; point review witnesses do not activate it. Failed source lanes
remain omitted; only a ready lane with a native frontier enables Next, while Retry may
retry a failed lane. The available default sources remain catalogue/Account discovery,
recent Following and Continue. Adopted public Collection/review/Space discovery awaits the native producers
above. Public Board/Realm/discussion discovery and Context membership remain outside those delivered sources.

Home Space choice reads retain the resolved Space identity on point-read failure so a failed
revalidation disables that selection; platform closure remains distinct from access denial.

Home Next retains the current page while one same-selection request is pending; concurrent callers share
its completion. The replacement page focuses and scrolls to the existing results boundary on desktop and
phone. Decision: changing any selection or refreshing the head cancels a pending Next's focus intent.

## Content reaction summaries

Only selected, currently disclosed Content thread/post cards receive `summary.reactionTarget` and `summary.reactions`.
The target uses the installed command spelling: `{targetKind:'thread',targetId:<thread id>}` for a thread and
`{targetKind:'post',targetId:<post id>}` for a post. The feed verifies target, key and destination identities before
projecting; an ambiguous identity makes Following unavailable rather than redirecting a reaction to a parent.
Counts come from `withReactionCounts` and use all seven native `REACTION_KINDS`. Sparse `reactions` is the native
positive-count map; `{}` is a successful empty map. `reactionsAsOf` is an optional page field with the helper's oldest
count-row watermark, not feed `asOf`. A successful read with no count rows returns `reactionsAsOf:null`; it does not
claim a converged source. The count source remains unavailable if the batch fails.

The exported feed types are `FeedReactionTarget = { targetKind: 'thread' | 'post'; targetId: string }`,
`FeedReactionCounts = Partial<Record<ViewerReactionKind, number>>`, and
`FeedContentSummary` adds optional `reactionTarget`, `reactions`, and `viewerReaction: ViewerReactionKind | null`.
`FeedPage.reactionsAsOf` is `ReactionCountFreshness | null` when present. The generated closed schema accepts only the
installed seven reaction kinds, positive sparse counts, a current native target and the native freshness fields.

An authenticated request also gets `summary.viewerReaction`, including explicit `null` after a successful slot read.
Anonymous requests omit this private field. It is read in one batch for the current actor and is never cached across
requests. `GET /v1/feedItems?stream=following&limit=20&kind=thread` can return:

```json
{
  "feedItems": [
    {
      "id": "feed-event-id",
      "source": "following",
      "key": { "owner": "content", "kind": "thread", "route": 12, "id": "00000000-0000-7000-8000-000c00000000" },
      "occurredAt": null,
      "summary": {
        "id": "00000000-0000-7000-8000-000c00000000",
        "kind": "discussion",
        "title": "A disclosed thread",
        "createdAt": "2026-11-03T10:00:00.000Z",
        "reactionTarget": { "targetKind": "thread", "targetId": "00000000-0000-7000-8000-000c00000000" },
        "reactions": { "like": 3 },
        "viewerReaction": null
      },
      "destination": { "kind": "thread", "id": "00000000-0000-7000-8000-000c00000000", "title": "A disclosed thread" }
    }
  ],
  "next": null,
  "asOf": "2026-11-03T10:01:00.000Z",
  "reactionsAsOf": { "epoch": 4, "position": "812" },
  "sources": { "discovery": "not_requested", "following": "ready", "continue": "not_requested" }
}
```

When either native batch fails, the response marks Following unavailable (or retains the native `preparing` state),
omits all Following items, and does not advance its input frontier; repeating the same request retries that page. It
never returns a partial count/slot summary. Existing admission refusals remain their native problem response.
Decision: keep reaction-summary failure lane-local and retryable by withholding the whole Following page, so mixed
source positions cannot skip a content card or expose partial viewer state.

### Cost: Content reaction summaries

Let `P` be emitted rows (at most 20), `T` the distinct eligible Content target IDs among those rows, `H` the represented
target partitions, `B` the existing raw candidate reservation (160), and `K=7` the installed `REACTION_KINDS` count.
The merge and existing selection keep their original `B` meaning and candidate/author/Space reservation (123 for mixed
Home and 104 for Following at `P=20`); reaction projection adds no candidate, refill, identity, Space or authority read.
`T≤P≤20`; the existing helper cap remains 100 and targets are deduplicated before calling it.

`withReactionCounts` groups those IDs by their actual route partition and runs one `reaction-count-page.sql` statement
per represented partition, so there are at most `H≤T` count statements. Each requested `(route,target_id)` performs an
ordered `reaction_total` primary-key seek on `(route,target_id,kind)` and reads at most `K` kind rows: at most `T×K`
physical count rows and `O(T×K)` result memory, independent of total reaction history. The SQL uses an unnested finite
target array and does not scan other partitions. A successful empty result has zero rows and null `reactionsAsOf`;
freshness is the minimum stored `(source_epoch,source_position)` among rows actually read and adds no statement.

For an account actor with `T>0`, `withViewerReactions` runs one current account-home statement, with one
`reaction` primary-key seek on `(route,actor_account_id,target_id)` per target and at most `T` physical slot rows.
Anonymous actors run no viewer statement and receive no viewer field. The projector uses `H` count-pool checkouts plus
one viewer checkout when authenticated, no transaction-control
statements, and linear map/serialization work bounded by `T×K`; no SQL, checkout or result memory grows with global
reaction rows. A dependency failure discards the page's Content summaries as described above.

The added call chain is the feed-local projector, `withReactionCounts` → one connection/query per represented target
partition, then (for an account) `withViewerReactions` → one connection/query on the current actor home. It performs no
new Access preparation or final authority check; existing Following support, Content disclosure and selected Space
revalidation still run for the entire output before return. The native reaction command, relay and source watermark
remain their existing authorities.

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
