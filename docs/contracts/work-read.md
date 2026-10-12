# Work read sessions

A read fences the units that determine its returned page. A write to another
Work, another rating target, or another avatar does not move that read. A change
to a selected head, publication, Structure, displayed media row, or admission
proof either replays a safe read or produces its typed moved, missing or
unavailable outcome. Dataset write sequence is diagnostic position, not a
session-wide consistency token.

Fuseki requests are separate transactions ([Jena remote transaction semantics](https://jena.apache.org/documentation/rdfconnection/#remote-transactions)). The session records each bounded
query's row token and each registered owner dependency when first consumed,
then compares those dependencies before returning. Repeated reads of the same
dependency must agree within an attempt. Empty selected relations are recorded
too, so a newly created selected row cannot escape the fence. Dependencies from
nested sessions belong to the enclosing attempt and must close before delivery.

Admission scans can inspect more candidates than the page returns. The session's
selection reader repeats that bounded admission operation and registers only the
returned rows and whether a continuation exists. Candidate-only descriptive
heads, payloads and summaries are excluded; an edit to them that leaves the
selected page and continuation unchanged does not replay. Every selection probe
still closes its authority and recovery checks. The returned rows retain their
head tokens, and subsequent displayed hydration registers its own dependencies.

## Position and continuation

`sourcePosition` is the position at which the successful attempt **started**.
It is not the final dataset position and does not promise a dataset snapshot.
A replay opens a new position; the returned value belongs to that successful
attempt. An unrelated write may advance the dataset while the page keeps its
opening `sourcePosition`.
Selected-unit search sessions read that opening position afresh on each attempt;
they do not reuse the enclosing matching snapshot's cached position after replay.

Continuation cursors bind to that opening position, the owner's selection and
ordering, and any supplied dependency token. Removing the session-wide end
comparison does not relax cursor admission: a cursor without a local dependency
token or an explicitly retained basis still expires when its graph position
changes. Local cursors bind to their selected collection/head token; retained
cursors bind to immutable owner rows, expiry and the recovery epoch. A cursor
never grants disclosure or authority.

## Fence ownership

| Consumed unit | Fence |
| --- | --- |
| Bounded selected graph rows, including absence | Canonical row token for the exact query and its bounded result. This includes selected membership/order relations when they determine a page. |
| Work and MainVersion | Work head, MainVersion identity/head, metadata head, semantic types and public candidate state from the joined basis query. |
| Structured publication | Exact selected publication decision, source, Structure revision, generation and immutable root registered as an owner dependency. |
| Language selection | Eligible `(language, selection)` heads of the selected MainVersion, including absence, registered as an owner dependency. |
| Work contents and list previews | MainVersion-to-Structure mapping and selected composition header/head; immutable pages must match that header. List cards retain their explicit Structure-head recheck. |
| Summary labels, redirect chain and projection parts | Local graph dependency token and selected summary values, including every resolved part/redirect needed for delivery. |
| Avatar/cover | Selected media rows or delivered summary descriptors, plus the media owner recovery epoch. An unrelated media write sequence is excluded. Current asset disclosure is checked again. |
| Serial statistics | Selected Work statistics and their child/body/occurrence disclosure, registered with the session. Global relay lag does not erase another Work's available statistics. |
| Realm membership | Recorded current membership proof, checked again for the same principal, acting subject and Realm. |
| Source author attribution | Selected source binding tuples and selected author-name rows, including absence; source owner rechecks these before delivery. |
| Ratings, follows, progress and retained inventories | Their selected owner revision, observation/materialization fence or retained generation; graph row tokens cover graph identities referenced by those rows. |
| Admission | Active principal, current Access/recovery admission, restricted Work/semantic/Context grants, disclosure, erasure and Rights checks required by the consuming capability. These checks remain mandatory on each attempt. |

The tokens cover relationships as well as individually displayed units. A Work
basis binds its selected MainVersion. Its publication dependency binds the
admitted Structure revision/root to that MainVersion; a current Structure head
cannot substitute for that published root. A contents page binds the
MainVersion-to-Structure relation and current composition header, then reads
immutable pages for that header. A metadata/edition page binds the Work metadata
head, selected edition collection revision and exact edition payload revision.
These fences reject combinations assembled across a selected-unit mutation.

Serial materialization records the selected MainVersion and Structure revision,
plus each chapter's body revision, publication and eligibility. Delivery qualifies
that basis against the current selected Structure and chapter tuples, and proves
native body coverage at the retained batch's graph position. An older checkpoint
can qualify an unchanged Work; it cannot qualify a newer Structure or chapter
publication. The retained checkpoint is looked up after reading Access, so a
concurrently advanced projection is not compared with an earlier global relay
head. Existing aggregates without this basis are replayed into a qualified
generation by the bounded serial worker.

A dependency read performed directly through an owner client bypasses
`session.query`. Its consumer must register the observed selected value and a
reread closure, or retain the owner's explicit end check. A flag saying the
session is fenced does not justify skipping a direct-owner Structure check.

The target resolver's combined control/identity query keeps its dataset position
columns for admission diagnostics, but its selected row fence excludes only
`sequence`. Epoch, exact target revisions, types and redirects remain fenced.
Target summaries and reading-boundary disclosure summaries register their local
graph dependencies, selected summary values and media owner epoch with the Work
session. The graph-only target adapter retains its own position envelope;
moving inventories retain their previous generation comparisons. These owner
adapter changes keep a resource page's admission path under the same selected
unit rule as its delivered header.
Consumers of `targetSummaries` must not compare its local graph dependency hash
with `epoch:sequence` when `session.fencesSelectedUnits` is true. The registered
summary dependency owns that check; independent adapters keep their position
comparison. Resource-list and progress disclosure adapters likewise register
their directly consumed local summaries instead of comparing dataset sequence.
Reading-boundary admission consumes availability, type and disclosure rather
than names or avatars. It registers that admission outcome only; the traversal
separately registers its selected Work, Structure and occurrence rows. Editing an
unused label or avatar does not change this admission result.

The Work rating adapter rereads only its selected Context/MainVersion aggregate,
including the reader's selected slot for mine scope. Its dependency token keeps
all aggregate fields and the source recovery epoch, excluding only the aggregate
result's dataset `sourcePosition.sequence`. Sealed inventory, graph evidence and
the inventory owner's recovery check still qualify each aggregate read. An
unrelated rating target or Work edit cannot invalidate that selected aggregate;
a changed aggregate or unavailable owner moves or refuses the read. Explicit
moving inventories retain their prior sequence admission.
`searchPageRatings` uses the same selected aggregate/absence fence for ordinary
Author and card pages; native exact search additionally retains its matching cut.

Exact phrase/search matching includes absence, rank and the complete matching
relation. Those invariants currently lack a scoped matching-owner token, so
`withSearchGraphSnapshot` retains its dataset comparison only in `matching-cut`
mode, including its cached card facts. Typeahead uses `selected-units` mode:
candidate identities, matched fields, Work heads/types, summaries and selected
source names share one session dependency set. Its final fence reopens the exact
bounded native prefix traversal with fresh cursors, comparing entries, rejection
state and continuation presence, including an empty traversal.
Each native prefix capture already binds its graph witnesses and index reader
under the native publication monitor. The final traversal is bounded by the
same page sizes and visit count as the first, within the shared request budget.
A global native commit generation or writer epoch can advance without changing that relation;
those counters do not move selected hydration. Native process identity, index
generation and uncertainty/recovery admission remain mandatory. Cursor movement
during the initial multi-batch native traversal still belongs to that matching
owner's narrow cut. Exact phrase matching retains its global mutation-epoch fence.
Authenticated typeahead also rereads its presentation filter, including author
facts, memberships and mute selection. Author hydration relaxes dataset sequence
only inside the same registered client's selected-unit snapshot and lineage;
exact matching cuts and independent callers retain their sequence qualification.

## Caller inventory

Paths in the table are relative to `services/main/src`. Each row names the
callers sharing a fence responsibility; a query token covers the bounded
selection, not the entire repository or the entire dataset.

| Callers | Units consumed and responsible fences |
| --- | --- |
| `routes/work-reads.ts`, `routes/work-metadata.ts`; `modules/work/read-header.ts`, `modules/work/metadata-read.ts` | Work/MainVersion basis, selected publication/language heads, metadata/classifications/editions/adoptions and referenced summaries. Basis, owner-dependency, selected relation and summary/media fences; local header/edition cursors retain their dependency token. |
| `routes/entity-pages.ts`; `modules/entity-page/read.ts` | Target/base/types, own summary, Work header, merged-origin inventory, projection frames/statements/relations and optional rating count. Target/boundary rechecks, local direct-summary/media dependencies, selected graph rows and rating owner fence. |
| `routes/work-contents.ts`, `routes/composition-reads.ts`, `routes/compositions.ts`, `routes/collection-grain.ts`, `routes/collections.ts` | Work basis, MainVersion-to-Structure relation, selected composition header and immutable occurrence/content pages. Graph mapping, composition dependency/head, publication/body and admission fences. Mutation preflight reads are not replayed as commands. |
| `routes/projections.ts`, `routes/realizations.ts`, `routes/resource-relations.ts`, `routes/releases.ts`, `routes/posts.ts`, `routes/post-identification.ts`; `modules/post/identification.ts`, `modules/target/resolve.ts` | Selected semantic target, exact release/realization/occurrence/Post revision, frame and relation inventories, placements and referenced summaries. Selected row tokens, exact immutable revisions, reading boundary and capability authority. The independent `targetRead` adapter has its own envelope. |
| `routes/hub.ts`, `routes/recipes.ts`, `routes/package-mods.ts` | Selected structured Work and domain payload, publication root, referenced resources. Work/publication/Structure and payload dependencies, summaries and Rights/admission. |
| `routes/work-stats.ts`, `routes/work-activity.ts`, `routes/ratings.ts`, `routes/rating-contexts.ts`, `routes/rating-populations.ts`, `routes/rating-rollups.ts`, `routes/reviews.ts`, `routes/suitability.ts` | Selected Work/target/context, rating or activity inventory and selected materialization/disclosure. Graph target/selection tokens and the rating/activity/assessment owner's observation/revision fence. Command admission callbacks have one attempt. |
| `routes/profiles.ts`, `routes/authors.ts`, `routes/concepts.ts` | Selected Agent/handle, external author binding, Concept and bounded contributions/Works/credits. Query/summary/media tokens, source binding/name fences and capability admission. |
| `routes/discovery.ts`, `routes/rankings.ts`, `routes/onboarding-interests.ts` | Selected discovery/ranking generation and ordered page, Concept choices and referenced public Work/Realm cards. Owner generation/selection and row tokens, summary/media/source fences; local ranking basis has its own continuation token. |
| `routes/feed.ts`, `routes/follows.ts`, `routes/continue.ts`; `modules/continue/read.ts`, `modules/feed/read.ts`, `modules/feed/new-since.ts`, `modules/feed/trending.ts`, `modules/onboarding/suggestions.ts` | Selected personal/follow revisions, feed sources, actor/Work cards, publication/chapter pointers, classification filters and list Structure previews. Owner revisions, selected query/summary/media/source dependencies, explicit list Structure fence and child-session dependencies. Public adapters retain reader disclosure without bearer authority. |
| `routes/memberships.ts` | Selected joined-Space membership/follow inventory and current Realm names. Explicit `movingGraph` mode; owner inventory revision/order and membership/name rechecks determine delivery. |
| `routes/also-enjoyed.ts`; `modules/also-enjoyed/read.ts`, `modules/also-enjoyed/store.ts` | Source Work classifications/credits, retained candidate identities, selected discovery generation and candidate cards. Explicit moving-graph reads retain their stale behavior; retained candidate/author identity and selected summary/admission fences remain. Builders and commands do not replay. |
| `routes/zone-modules.ts`, `routes/realm-reads.ts`, `routes/realm-directory.ts`; `modules/realm-reads/public-decision-index.ts` | Selected Realm/Space/Zone publication, decision/adoption/classification inventory, module Work/chapter/reply/list cards. Joined graph tokens, selected owner heads, Realm proof, summaries/media and child-session classification fences. |
| `routes/realm-replies.ts`, `routes/realm-reply-threads.ts`, `routes/realm-submissions.ts` | Selected Realm, thread/reply/submission heads, membership/order relations, exact bodies and referenced targets. Reply/thread owner must register the dependencies described below; Access, content and Realm admission remain owner checks. |
| `routes/query.ts`, `routes/saved-filters.ts`; `modules/query/template-read.ts` | Selected template revision/parameters, semantic selection, collection membership and returned resource page. Local-basis row/owner tokens and membership recheck. Read-only template POST can replay; arbitrary mutation POST cannot. |
| `routes/library.ts`, `routes/library-copies.ts`, `routes/library-imports.ts`, `routes/library-export.ts`; `modules/library/stats.ts` | Selected library owner revision/copies/shelves, party/release identity, progress and Work cards. Library retained revision and current authority plus selected graph/summary/owner tokens. Export explicitly uses `movingGraph`/`retainedBasis`; imports and command preflight callbacks are not replayed. |
| `routes/progress.ts`, `routes/progress-summaries.ts`, `routes/reading-positions.ts`, `routes/sessions.ts`; `modules/progress/completion-plan.ts` | Selected subject progress/completion/session rows, Work/Structure/occurrence/content basis and referenced cards. Owner revision and exact selected graph/Structure/body dependencies plus current disclosure. |
| `routes/studio.ts`, `routes/management-reads.ts`, `routes/notifications.ts`; `modules/catalogue-intake/search.ts`, `modules/editorial-review/store.ts`, `modules/identity-merge/runtime.ts`, `modules/public-report/owners.ts` | Selected draft/review/catalogue/merge/report target and referenced Works or exact evidence revisions. Selected query/summary/owner dependencies and current operation authority. Evidence or mutation callbacks have one attempt. |
| `modules/search/result-cards.ts`, `modules/search/typeahead.ts`; `routes/search.ts` | Matching-owner result cut, selected Work/MainVersion cards, credit/name fields, serial/rating previews and covers. Matching/selected graph read dependencies, current card/summary/media/source fences and text-owner instance/recovery checks. Hydration preserves the matching owner's opening `sourcePosition`; a dataset sequence check cannot certify only the selected cards. |
| `routes/health.ts`; `modules/feed/refresh.ts`, `modules/discovery/refresh.ts`, `modules/discovery/management.ts`, `modules/realm-directory/worker.ts`, `modules/notification-producers/saved-views.ts` | Owner health/build generation, selected bounded source inventory and notification eligibility. Owner checkpoints and selected dependencies; internal builders/commands are single-attempt. Explicit moving-graph builds preserve their own stale policy. |
| `modules/address/resolution.ts` | Selected address holder, Realm landing or Post placement, Book summary and alias head. Selected graph/summary/placement and admission fences; alias registry heads remain the address owner's responsibility. |
| `modules/zone/route.ts`; `routes/zones.ts` | Zone route resolution retains its semantic reader and separate Work authority. Selected publication, mount/member queries, Structure headers, aliases, summaries/media and serial sessions close under the Zone's own budget and attempt telemetry. Published navigation fences the retained revision, excluding unshown draft heads. Presentation callbacks still require their narrow cut described below. |
| `modules/export/readers.ts`, `modules/reading-position/read.ts`; `routes/resources.ts` | Independently managed target, reading-position and summary envelopes, including manually constructed sessions. Their owners close their own selected Structure/publication/summary and authority fences; changes to `workRead` alone do not replace those envelopes. |

`publicWorkRead` delegates to the same session envelope. Nested sessions are
created in `also-enjoyed/read`, `continue/read`, `feed/read`, `feed/new-since`,
`feed/trending`, `onboarding/suggestions`, `realm-reads/public-decision-index`
and `notification-producers/saved-views`. Their distinct selection and principal
must survive, while their consumed dependencies participate in the enclosing
attempt's final fence. Independent sessions in `zone/route`,
`reading-position/read` and `export/readers` need their owning envelope to close
the fence; construction alone does not perform it.

Zone routes retain their own 2048-call, 8 MiB, ten-second envelope and the same
measured-cost retry rule. They do not substitute Work OAuth scope for semantic
read authority. A `/presentation` callback also reads module, campaign-art and
theme owners outside its route dependency set. Its narrowly scoped presentation
cut remains until those consumers register their mutable inputs; removing that
cut alone would permit mixed callback output.

Explicit `localBasis` callers select a dependency-based continuation basis;
ordinary reads still fence selected dependencies without changing their cursor
contract. Explicit `movingGraph` callers retain their owner-defined stale
semantics and one-attempt envelope. A dataset comparison retained for an
independent owner is not evidence that an ordinary session needs one.

## Replay bound and outcomes

The envelope shares one deadline and graph call/byte budget across attempts,
including any enclosing read budget. Eligible first-page GETs and read-only
templates can replay; retained continuations replay only when their owner
explicitly permits it. Mutation callbacks, internal builders, ordinary
continuations and moving-graph callbacks do not gain replay permission.

The maximum is six attempts within 160 graph calls, 4 MiB and ten seconds, with
bounded backoff. After movement, another attempt starts only when both remaining
calls and remaining bytes cover the previous attempt's measured cost. Otherwise
the read immediately returns typed unavailable with movement as its cause.
Exhausting the retry count also returns typed unavailable. This preserves the
reason for failure instead of concealing movement behind a later budget error.
An enclosing search retry envelope preserves that terminal unavailable outcome;
it cannot convert it back into movement and restart the exhausted Work envelope.
The request profile records one `main.work_read.attempt` span per started
attempt; `session.attemptCount` and Fuseki call diagnostics carry its one-based
ordinal. One ordinary successful
attempt means zero replays. Unrelated writes do not increase that count or the
number of graph calls.

Invalid and expired cursors, denied authority, hidden/missing resources,
unavailable owners, erasure and Rights failures retain their capability's typed
outcomes. A failed attempt still closes its authority checks before replay;
retrying never postpones a revocation or recovery hold until a later attempt.

## Thread and reply consumers

The reply/thread owner registers the selected thread head, each returned reply
head, parent/Realm bindings, deletion state, and the membership/order relation
that selected the bounded page, including an empty page. It pins immutable body
revisions to those heads and registers any mutable content-owner dependency.
Returned attachments, avatars and referenced resource summaries register their
selected media rows/epoch and summary dependencies. Current Realm membership,
Access, disclosure, erasure and Rights are checked again at delivery.

A reply that belongs to another thread is outside this fence. A mutation to the
returned thread, a returned reply, or its page-selection/order relation moves
the read. Thread/reply callbacks use the session's dependency registration and
retry budget; they do not add a second dataset-sequence consistency mechanism.
