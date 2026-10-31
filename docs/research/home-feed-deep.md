# A mixed home at the upper bound

Research date: 2026-10-31. This is independent evidence and a proposed design, not an adopted product contract.
No sibling home investigation was read. The Goal remains paused. No application or reference project was run;
no runtime backend measurements, tests, compilers, gates or acceptance campaigns were performed for this report.

## Recommendation

Make Home one stream of useful, attributable objects and community activity, with a small private Continue region.
Subjects of any released kind, discussions, reviews, public Collections and Space discovery belong in that stream.
A book or game is an actionable catalogue subject, not a post-shaped substitute. A Collection is a saved, ordered
selection with its own identity, not twelve unrelated cards. A Space is a destination; its Realm supplies community
and its Zone supplies a configured site. Membership, following and permission remain different things.

Do not implement one section per kind, followed source, Space or rating context. At 300 Spaces and 200,000 kinds,
navigation must select a scope and candidate production must select a bounded set before rendering. Vertical homes
use the same engines with different released definitions, sources and presentation. They need complete reading,
watching or playing journeys; an empty Zone slot or an alphabetic catalogue row is not a competitive vertical home.

Start with a curated, mixed public stream and native Continue, then deliver a chronological Following stream with
explicit coverage and preparation semantics. Add recommendations only when their qualified inputs, feedback and
publication lifecycle exist. Neither a new ML service nor a universal retained-query framework is a prerequisite.
The smallest coherent delivery still needs backend work: current Home cannot acquire community/Collection feed
candidates by rearranging its four subject searches.

There is an explicit scope boundary. [Scope](../scope.md) defers feeds, gives them no owner and prescribes Continue
plus catalogue rows; [the Web Goal](../goals/web.md) prohibits silently making recommendations requirements.
The new direction therefore needs an owning-document amendment before implementation briefs. Removing the tagline,
using portrait defaults and obeying the existing search decision do not depend on that amendment. This report
recommends a minimum mixed-home amendment, rather than treating today's documented deferral as a hidden API defect.

## Evidence basis and limits

The inspected current source is `dev` and the worktree base at
`6d3f767467c85dbb9d3bb561d12af784407bd92c`, dated 2026-10-31. This is the current development source, not a main-only
inventory. Old REZICS was read at `/home/edge/projects/rezics/rezics`, commit
`95167ceab7173dc1c5fb0ee70568c5c95f1dba8d` (2026-09-22). Old rezics-next was read with `git show legacy-final:<path>`;
the tag resolves to commit `1dab49f2622ca3773908d096300ab687fdc71c2d` (2026-10-25). These are three distinct systems.
Both REZICS repositories carry AGPL-3.0 licence text. No legacy implementation was copied or executed.

Inputs read include the complete staged `.temp/goal/web/research-20261031.md`, including its backend addendum;
[feature design](../development/feature-design.md), [architecture](../architecture.md), [scope](../scope.md),
[Goal definitions](../goals/README.md), [Web ownership](../goals/web.md), the system inventory, and applicable
`design-status-web`, `design-status-search`, `design-status-semantic`, `design-status-accounts`,
`design-status-content`, `design-status-commerce` and `design-status-performance` evidence. Relevant owner seams
are Presentation, Composition, Search, Zones, Community, Content, Library and shared UI. Source wins over inventories.

The [system inventory](system-inventory.md) records an earlier revision, `bbe32d4057080b5fe701fc9824e28de8ce71b031`.
Its historical descriptions are not current exposure proof. Likewise, a design-status gap can have acquired source
since the report was written. The matrices below state the narrower fact established by the inspected code.
“Test present” means that a named test or story was inspected, not that it ran or passed here. No native cost,
privacy, freshness, browser or physical-storage receipt is claimed.

### Visual evidence actually inspected

These supplied artifacts were opened with `view_image`; they were not newly captured from the current application.
Their original browser viewport, account state, capture revision and browser version were not supplied. Raster
dimensions and a phone-shaped image do not establish CSS viewport dimensions. No existing publisher was changed.

| Artifact under the worktree                                           | Observation relevant to Home                                                                           | Limitation                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `.temp/goal/supermanager/refs/mobile-home-reference.jpg`              | Reddit phone home has a single mixed column, clear provenance, media, actions and compact navigation.  | Product screenshot; no native REZICS comparison or accessibility execution.                       |
| `.temp/goal/supermanager/refs/mobile-search-open-reference.jpg`       | Search occupies a phone screen with back control and recent/trending/community suggestions.            | Reference for the settled search interaction; no new search design decision.                      |
| `.temp/goal/web/refs/maintainer-20261031/reddit-search-panel.png`     | One field opens a bounded desktop search panel.                                                        | Captured product/version unknown.                                                                 |
| `.temp/goal/web/refs/maintainer-20261031/rezics-filter-panel-bug.png` | Filter controls visibly overflow the narrow panel into the results.                                    | Evidence of that capture's layout failure; not proof that today's header reproduces it.           |
| `.temp/goal/web/refs/maintainer-20261031/goodreads-subject-top.webp`  | Cover, shelf action, rating, compact metadata and a bounded editions preview make the work actionable. | Subject-page reference, not an observed Goodreads home.                                           |
| `.temp/goal/web/refs/maintainer-20261031/goodreads-subject-full.webp` | Reading actions coexist with reviews, related books, lists and bounded exits; secondary text folds.    | The supplied full-page image is small; no claim about fine text or authenticated personalization. |

No exhaustive public Storybook sweep was started. That campaign belongs to the completeness audit. Local story IDs
below identify source examples, not captured live artifacts. Proposed review widths are 390 and 1280 CSS pixels;
neither width was executed here. No screenshots or bulky inventories are committed with this report.

## What current development actually supplies

### The route and its data

[`apps/web/src/routes/index.tsx`](../../apps/web/src/routes/index.tsx) loads the public route composition once and
marks it reusable through `publicCache`. The private Continue query waits for a signed-in browser session and
admitted `library_continue.list` and `progress_session.list` operations. This public/private separation is valuable.
[`home-queries.ts`](../../apps/web/src/features/pages/home-queries.ts) loads `POST /v1/pages:read` through the common
route loader; its separate personal server function sets `Cache-Control: private, no-store`. Type naming operates
on returned subjects, not the entire kind catalogue. Preserve these boundaries in a replacement home.

The actual home document is
[`packages/composition/profiles/platform.json`](../../packages/composition/profiles/platform.json), `routes[/]`:
one heading containing the rejected marketing sentence, the personal Slot, and Books, Anime, Visual novels and
Recipes TypeLists. Each has `sort: collections` and `limit: 12`. This is at most 48 subject result slots, not a mixed
activity feed. It contains no home `SearchBox` node; the shared header is the relevant search surface.
[`apps/web/src/kernel/recorded/home-page.json`](../../apps/web/src/kernel/recorded/home-page.json) records that shape
with 2026-10-30 reads. It is historical example data, not evidence of current backend availability or permission.

The distinction matters: `sort: collections` orders subject search; it does not return Collection identities or
Collection update events. The recording also repeats a subject ID within the book results. That is a fixture/data
quality symptom to investigate at its producer, not evidence that a live backend always duplicates subjects.

[`services/kernel/src/presentation/README.md`](../../services/kernel/src/presentation/README.md) still describes a
home SearchBox, as does `services/kernel/test/presentation/platform-home.test.ts`. The shipped document lacks it.
The test's desired first nodes are Heading/SearchBox; the actual nodes are Heading/Slot. This is a source-level
contradiction, not a claimed executed failure. The same test explicitly protects a popular list per vertical;
passing an updated version of that oracle would still not establish the requested mixed product.

### The shared header on Home

There is real shared search implementation; it is inaccurate to describe scoped search as wholly absent from UI.
The exact files under `apps/web/src/search/header-search/` are `header-search.tsx`, `shell-search.tsx`,
`filter-region.tsx`, `authority.ts` and `suggestions.ts`. They provide one shell owner, a scope chip, a
route-registered filter action and bounded suggestions. An unavailable `searchAction` prevents scoped submission;
the global suggestion loader explicitly rejects scopes. A chip is therefore a presentation of an admitted route,
not evidence that every scope has backend search.

The actual `apps/web/src/shell/shell.tsx` header places NavigationToggle and Logo before a `flex-1` search container
with `md:ms-6` and `md:max-w-[40rem]`, then puts variable controls after `ms-auto`. This does not establish centring
on the viewport or content axis: the middle depends on asymmetric sibling widths. That is a source-supported cause
for off-centre layouts, not a measured pixel offset at 1280. It needs a shared centred layout, not a Home override.

In `header-search.tsx`, the composer uses `focus-within:ring-2 focus-within:ring-ring`, changes to `bg-card` when
expanded and to `md:bg-popover` on desktop, while the form uses `bg-background`. Filters renders only inside the
expanded branch, in a second row beside Submit, rather than at the input's right end. These are concrete source
mismatches with the settled interaction. Exact blue hue and visible contrast depend on theme/runtime; they were
not measured here. Old `styles.css` overrides target `data-slot=input-group`, not this new composer, so they are
not proof that its ring/surfaces are normalized. Keep an accessible keyboard focus indication while correcting the
duplicated visual treatment; removing all focus feedback would not satisfy the settled design accessibly.

The phone full-screen form, named dialog and back control are implemented in the same component. Their source
presence is separate from an executed phone review. Preserve that implementation and the honest scope boundary;
the shared Search/Web owner should repair alignment, field-end Filters and surface tokens across all consumers.

### Capability matrix

“Partial” and “closed” below are deliberate. An operation can be mounted yet depend on unavailable preparation,
or be gated out of the first public scope. An existing source factory is not a ready user journey.

| Capability                                                   | Specified / designed                                                                | Backend implemented                                                                                                 | API exposed                                                                                         | Interface exposed                                                                                        | Tested evidence and limit                                                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public catalogue Home                                        | Explicit current first scope; four vertical rows                                    | Presentation route and subject-search aggregate exist                                                               | `POST /v1/pages:read` with route `/`                                                                | Real route consumes aggregate; stories use recordings/fakes                                              | `platform-home.test.ts`; home story checks do not assess mixed content. No execution here.                                                                                     |
| Private Continue                                             | Library state/session union; private browser boundary                               | `library/continue-reads.ts`, `continue-query.ts`, owner source and FULL hydration exist; dependencies can refuse    | `GET /v1/libraryContinue`, BASIC/FULL, cursor, authenticated scopes and gates                       | Real typed adapter in `apps/web/src/library/continue-adapter.ts`; home distinguishes unknown/unavailable | `test/library/continue-{http,read,user-cases}.test.ts` exist; home SignedIn deliberately asserts unavailable pending native binding. Neither proves a successful current home. |
| Follow subjects, Collections and Spaces                      | Follow edges are in scope, independently of membership                              | `library/follows.ts`, `follow-store-page.sql`: account-owned rows and paged seek                                    | `GET /v1/follows`, `PUT`/`DELETE /v1/follows/:targetId`                                             | Library Following destination; Home does not consume a following activity source                         | Follow/storage tests exist; no mixed-home ranking or thousands-follow request proof follows from them.                                                                         |
| One mixed Following timeline                                 | Explicitly deferred; no current owner                                               | No Home-consumed unified event candidate/ranking pipeline found in the traced route                                 | No mixed-home timeline operation in that path                                                       | Absent from current Home                                                                                 | No current Home oracle for this journey. Legacy `/v1/feed` is a different service.                                                                                             |
| Mixed public discovery                                       | Common discovery abstractions exist; not a Home feed contract                       | Search contains discovery sources; community has public Realm discovery                                             | Subject search and `GET /v1/realms/discovery` are distinct operations                               | Search discovery and Realm discovery surfaces exist; Home still uses subject-only rows                   | Search mixed-discovery tests do not establish a mixed activity Home or its native exposure.                                                                                    |
| Public Realm discovery                                       | Bounded popular/trending discovery with qualified original starts                   | `community/discovery-*` producer/consumer and rank seek implemented                                                 | `GET /v1/realms/discovery`, limit 1–100; examines at most `min(limit,20)` candidates, no refill     | `apps/web/src/community/realm-discovery/*` and search section                                            | `community/discovery-native.test.ts` exists; README explicitly leaves runtime/physical/growth integration evidence open.                                                       |
| Discussion/review objects                                    | Content owns boards, threads, posts and disclosure                                  | Native originals, reads and lifecycle implemented                                                                   | Board/thread/post APIs; Global directory `GET /v1/boards` is not a cross-board activity stream      | Native thread/board routes; not Home candidates                                                          | Content tests protect owners; no inference that Home exposes all owner features.                                                                                               |
| Curated Collection preview and membership                    | In scope, with optional covers and shared filtering                                 | Collection presentation/source/member code exists; retained/built-in composition has readiness gaps                 | Collection/member operations exist, with closed or preparing paths                                  | Collection pages exist; Home emits no Collection cards                                                   | Web design-status records incomplete whole Collection journey; illustrative cover patterns are not native producer receipts.                                                   |
| Space identity and Realm association                         | In scope; Realm is community carried by Space                                       | `community/space.ts`, current disclosure and derived `realmId`                                                      | Space read/address routes expose current permitted association                                      | Space navigation exists; no 300-Space Home selector proven                                               | Owner tests exist; no upper-bound home navigation evidence.                                                                                                                    |
| Static Zone site                                             | In first public scope when source-free                                              | `zones/page-runtime.ts`, composition admission and static paths                                                     | `zone.read_page` / `POST /v1/zones/:id:readPage`, subject to grants                                 | `apps/web/src/zones/zone-read.ts` calls native client                                                    | Static/typed/runtime tests exist; no runtime execution here.                                                                                                                   |
| Zone saved scope, mounted Collection union and ordered lists | Designed, but closed behind platform grants in first scope                          | Substantial membership/union/page-work code exists; native retained preparation still explicitly refuses some paths | Mounted contract distinguishes 200, 202 and 503; exposure depends on grants and sources             | Adapter follows bounded continuations, then renders preparing/unavailable                                | `zones/*` contract/growth tests exist. Their existence is not an open, working books/anime/games site.                                                                         |
| Personalized recommendations and cross-kind scores           | Deferred; qualified inputs/consent not adopted for Home                             | No current Home ranking producer found                                                                              | No Home recommendation endpoint in traced code                                                      | No real “because you…” Home behavior                                                                     | No current end-to-end recommendation evidence; stories cannot supply the missing producer.                                                                                     |
| Shared Home search                                           | Settled centred single field, scoped route and field-end Filters; phone full-screen | Header is a consumer; owner routes must enforce scope                                                               | Global suggestions are native calls; scoped suggestions require a separately supplied native loader | Real `HeaderSearch`; alignment, second-row Filters and ring/surfaces still diverge                       | Source and supplied reference inspection only; no executed header/phone or complete scope acceptance claim.                                                                    |
| Portrait defaults for every kind                             | Settled instruction                                                                 | Shared Cover preserves mismatched art; list fallback still has landscape/square type defaults                       | Presentation annotations can specify geometry                                                       | CoverList consumes those annotations/fallbacks, including landscape TV/movie defaults                    | Cover/list stories/tests exist; they do not establish compliance with the new all-kind default.                                                                                |

Exact caveats behind the matrix:

- Continue is more than a stub: `continue-routes.ts` checks both client scopes and gates; `continue-reads.ts` checks
  current account state in read-only REPEATABLE READ snapshots; `continue-query.ts` binds source/version and hydrates
  FULL summaries. Native absence can be a complete empty union. Nonempty sources need the common owner runtime.
  The story's unavailable case must not erase that implementation, nor be reported as successful native exposure.
- `services/kernel/src/search/scope-source.ts`, `prepare`, explicitly rejects retained native-order work lacking a
  matching immutable work definition. Its members-preparation branch runs compatibility/currentness checks then
  throws `dependency_unavailable`. Its `orderedPrefix` also contains real bounded evaluation logic. Thus the Zones
  README's blanket statement that ordered prepare/prefix only validate then refuse is too broad for current source;
  the retained composition seam remains a concrete gap. Do not claim all Search or all Zone reads are absent.
- `services/kernel/src/zones/page-runtime.ts` prepares native membership for search/member descriptors before aggregate
  output. `apps/web/src/zones/zone-read.ts` uses the real `$readPage.post`, recognizes 202/503, and bounds automatic
  continuation attempts to four. Configuration starter files do not bypass that preparation or grant access.
- `packages/definitions/presentation/{book,anime,game}/zone.json` supply inert starters. Anime's opening list selects
  `schema:Movie` and `schema:TVSeries`; a title does not prove animation membership. A deployed vertical needs its
  adopted saved scope/definition, not a broad type alias. Games' alphabetic `schema:VideoGame` list lacks release,
  platform and personal state semantics. Neither starter is proof of a competitive or source-ready home.

The exact current Home story IDs are `pages-discovery-home--signed-in` and `pages-discovery-home--signed-out`
(`apps/web/src/stories/home.stories.tsx`). The first asserts an unavailable alert and a Continue destination; the
second asserts absence of the private region. `library-continue-native-binding.stories.tsx` also constructs a
`NativeContinuePage` object and passes it through the real adapter: useful typed presentation evidence, still
illustrative data rather than an actual API recording. Neither story title nor generated transport type upgrades
that object to a served native journey. No live artifact for these IDs was captured by this investigation.

### Why delivery diverged

The old first-scope decision deliberately removed feeds. Presentation encoded that decision in a fixed catalogue
document, and an existing test explicitly specifies that document's per-vertical shape. Later interface breadth,
recordings and owner tests did not add a mixed candidate contract. The no-tagline and portrait instructions are
cross-surface decisions, but old profile text and type geometry remain independent configuration authorities.

That causal account is grounded in source and written scope. It does not establish who reviewed a change, why a
particular execution was skipped, or that hundreds of thousands of test lines are worthless. The narrower failure
is oracle selection: absence/unavailable and component shape can be protected while a useful mixed-home journey
has no owner, producer or acceptance scenario. Quantity of tests cannot fill a missing product requirement.

## Both legacy homes: useful behavior and actual limits

### Old REZICS

At `95167ce…`, `apps/web/features/explore/home.tsx` is a centred client home using URL state and one
`ApiFeedList`. `apps/web/features/content-feed/data/api-feed-list.tsx` calls a real `postApiFeedQuery` infinite query,
default limit 20, with language preferences, sort and filters. It deduplicates loaded items by ID and gives feed
cards subject/post actions. `components/feed-item-card.tsx` and `components/feed-card.tsx` present provenance,
attributions, Realm contexts, reaction counts and an appropriately selected rating. This is a useful mixed-stream
behavior reference; it is not evidence that the rebuilt kernel exposes the same endpoint or semantics.

| Exact old path                                                                  | Limit failure or qualification                                                                                                                                      | Consequence for the new design                                                                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/features/content-feed/data/api-feed-list.tsx`                         | Realm and tag choices request only `limit: 50`; no corresponding choice-list continuation in that control.                                                          | With 300 Spaces/Realms, a relevant choice can be absent. Use searchable cursor-backed source pickers.                                                       |
| `apps/web/features/content-feed/routing/feed-search-params.ts` and the API list | Content kinds use `SimpleFeedContentKindValues`, not a released, searchable 200,000-kind registry.                                                                  | Preserve generic result rendering; do not turn a current closed selector into a universal type catalogue.                                                   |
| `apps/web/features/content-feed/components/feed-list.tsx`                       | `state.items.map` renders all accumulated items; the query flattens/deduplicates all loaded pages. No bounded DOM window in these files.                            | After 1,000 pages at 20, processing/rendered items can reach 20,000. A request limit alone does not bound session memory/DOM.                               |
| `services/main/src/services/api/feed/schema.ts`                                 | `MaximumFeedRealmContextsPerItem = 8` and attribution cap 8 are explicit.                                                                                           | Bounded preview is useful; eight is not all contexts and needs an explicit complete destination.                                                            |
| `services/main/src/services/api/feed/index.ts`, `getFeedRealmContextsByUnitIds` | Membership first seeks 32 recent active memberships, then filters public Realms and returns at most 8. Requested primary context is prioritized within that window. | A primary Realm older than the 32-key window can be missed; eight cannot represent 300. Do not label the preview exhaustive or an absence as no membership. |
| Same API file, candidate coverage helper                                        | `limit + 1` probes distinguish bounded from exhaustive coverage; there are bounded source clauses as well as joins and ranking.                                     | Useful honesty, but no desk claim that every SQL plan is physically bounded at every graph degree. No old runtime measurement was performed.                |

The old card's `toFeedRealmContexts` maps the returned bounded contexts, and `FeedCard` uses a compact context list.
The upper-bound defect is therefore partly truncated discovery, not an assertion that it fetches every Realm on
every card. Preserve identity deduplication and provenance while fixing explicit completeness and source selection.

### Legacy-final rezics-next

At `1dab49f…`, `apps/web/features/home/home-page.tsx` also renders one `FeedList`, not one main feed block per
Realm. `features/home/server.ts` reads a single `readFeedPage`, chooses Following for a person with follows and All
for a new person, reads Continue at limit 6, and streams independent rail regions. `followsAnything` requests one
follow, rather than enumerating the user's inventory. `features/feed/types.ts` derives transport from the real
Main `/v1/feed` routes and preserves closed/stale/budget/unavailable failures. These are valuable design references.

The authority's warning about per-Realm/context rendering must be localized precisely. The retained final snapshot
already improved the main stream; its rating-context and topic controls still expose the problematic pattern.
It would be inaccurate to describe its whole home as 300 independently fetched Realm feeds.

| Exact `legacy-final:` path                                                       | Observed upper-bound problem or useful constraint                                                                                                                                                                                           | Correction                                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/features/work-page/ratings.tsx`, `RatingsRegion` around `contexts.map` | All returned context links are placed in a wrapping row. Twenty contexts already create a large selector; hundreds scale with response cardinality. One selected summary does not bound its context navigation.                             | Show one selected question/population/scope and use a searched, paged context picker. Never equate different scales.                              |
| `apps/web/features/home/tabs.tsx`, hidden gauge and `MoreTopics`                 | Visible topic tabs are fitted and More is paged, which is better than all tabs. However, `followed.map` still creates hidden measurement nodes for every accumulated topic; More keeps loaded pages.                                        | Fixed pinned subset and bounded picker results, without an invisible inventory-sized measurement tree.                                            |
| `apps/web/features/home/server.ts`, `readTrending`                               | At most two results per Realm is a diversity policy, not a total bound by itself; the separate backend contract does impose total limits. This UI resolves Realm labels against the loaded follows page; a missing page entry becomes null. | Give every returned card its own permitted minimal provenance, with an independent total candidate/result budget.                                 |
| `apps/web/features/shell/communities-read.ts`                                    | Follow lists are paged; official Zones use limit 6 plus bounded Realm lookups.                                                                                                                                                              | Preserve paging; do not reconstruct all 5,000 follows to render the first home page.                                                              |
| `services/main/src/modules/feed/ranking.ts`                                      | Best ranks a bounded pool of 256 by Realm percentile; diversity is 3 per 10; net verified-person votes and 24-hour decay are declared.                                                                                                      | Bounded compute is useful, but a one-item Realm cohort gets percentile 1. It is not a globally calibrated quality estimate.                       |
| Same ranking file                                                                | A thin Following/Best view may admit recommendations when followed count is below 3.                                                                                                                                                        | In the new proposal Following stays exact; offer explicit Discover rather than silently changing the selected relationship promise.               |
| `services/main/src/modules/feed/cost-contract.ts`                                | Comments declare anonymous 24 PostgreSQL/8 Fuseki and signed-in 30/8 request budgets; Continue has a much larger 110/30 budget. Qualified physical/native gaps are also recorded.                                                           | Count actual producer, disclosure and hydration work. Commented query counts are neither current measurements nor proof of bounded examined rows. |
| `apps/web/features/official-zone-stories/catalogue-zone.tsx` and `*.stories.tsx` | Helpers construct fixed Zone/work contexts; `catalogueWork` sets a book kind.                                                                                                                                                               | Illustrative vertical output cannot establish real mixed-kind Zone candidates, a native library action or current disclosure.                     |

With 300 candidate Realms and a pool of 256, it is impossible to guarantee even one candidate from each Realm in
that pool. This is an arithmetic recall limit, not a reason to render 300 sections. State that Home is selected
activity; provide complete paged source destinations. Increasing the pool to the full follow graph merely moves
the failure to request cost. The old APIs, IDs, graph model and fixed budgets are not contracts to port wholesale.

## Primary product survey

All links below were consulted on 2026-10-31. “Documentation” means official product description, not a logged-in
observation. “Public” means the readable public page, not a measured or authenticated client. Product documents and
screenshots are copyrighted under their publishers' terms unless stated otherwise; no reusable source licence is
assumed. The source-code licences and revisions are separately recorded below. Historical documents are dated
and establish patterns, not the exact present experiment assignment or ranking weights.

| Product / primary evidence                                                                                                                                                                              | Observed or documented capability                                                                                                                         | Implication and evidence limit                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reddit — [recommendation explanation](https://support.reddithelp.com/hc/en-us/articles/23511859482388-Reddit-s-Approach-to-Content-Recommendations), updated 2026-10-28                                 | Separate candidate generation, filtering, prediction and diversity; subscriptions plus recommendations, reasons and controls; signed-out differs.         | Community identity and user control survive a single stream. Official explanation plus supplied phone capture; no authenticated audit.            |
| X — [timeline help](https://help.x.com/en/using-x/x-timeline)                                                                                                                                           | For You mixes followed accounts/topics with recommendations; Following contains followed accounts; last view is remembered.                               | A stable relationship view can coexist with discovery. Documentation does not disclose complete weights or costs.                                 |
| Bluesky — [starter packs](https://bsky.social/about/blog/06-26-2024-starter-packs), 2024-06-26, and pinned source below                                                                                 | Curated people/feed bundles provide onboarding; timeline separates skeleton selection and hydration.                                                      | Collections/Spaces can offer an explicit starting selection. This does not imply REZICS needs external feed services.                             |
| Mastodon — [network guide](https://docs.joinmastodon.org/user/network/) and source below                                                                                                                | Following, lists and discovery have distinct roles; stored feed insertion and trimming exist.                                                             | A useful home does not require predictive ML. Federation and Redis are not requirements to copy.                                                  |
| Discourse — [new-user guide](https://meta.discourse.org/t/understanding-discourse-for-new-users/96331)                                                                                                  | One Latest topic list, category/tag filters, time-window Top, unread state and return to last read position.                                              | Community breadth needs scope/filter and recovery, not one panel per category. Site configuration varies.                                         |
| GitHub — [personal dashboard](https://docs.github.com/en/account-and-profile/reference/personal-dashboard)                                                                                              | A bounded recent-activity region is separate from followed-user/repository events. New feed/dashboard are marked public preview.                          | Mix event families while preserving why an item appears. Preview behavior is not a stable universal layout guarantee.                             |
| YouTube — [recommendation help](https://support.google.com/youtube/answer/16089387?hl=en)                                                                                                               | Home, Up Next and destination pages use different contexts; homepage relies mainly on history; history-off users can browse through search/subscriptions. | A cold start or opted-out state need not fabricate personalization. Do not copy watch-time optimization for books.                                |
| TikTok — [first-party explanation](https://newsroom.tiktok.com/how-tiktok-recommends-videos-foryou?lang=en-AU), 2020-06-18                                                                              | Explicit starting interests, generic fallback, negative feedback, diversity and recommendation eligibility distinct from mere publication.                | Separate candidate suitability from readability. Historical account; current support page yielded no readable body.                               |
| Instagram / Facebook — [Meta ranking explanation](https://about.fb.com/news/2023/06/how-ai-ranks-content-on-facebook-and-instagram/), 2023-06                                                           | Multiple systems rank connected and unconnected content, with explanations and feedback controls.                                                         | Avoid one universal engagement score across every surface. This is shared official evidence for both products, not two independent audits.        |
| Pinterest — [refine recommendations](https://help.pinterest.com/en/article/tune-your-home-feed)                                                                                                         | Saves/searches/browsing influence recommendations; people can turn activity influence off.                                                                | Saving an item and consenting to taste inference need distinct controls. No logged-in settings execution.                                         |
| Spotify — [taste-profile exclusions](https://support.spotify.com/sg-en/article/exclude-playlists-or-tracks-from-your-taste-profile/)                                                                    | Excluding an item from taste influence is separate from hiding it.                                                                                        | Listening/reading for work or a shared account must not permanently define interests. This documents a control, not all current Home behavior.    |
| Goodreads — supplied top/full subject captures and [official product entry](https://www.goodreads.com/)                                                                                                 | Captures show portrait identity, shelf actions, ratings/reviews and lists with exits.                                                                     | Use actionable books and social context as the baseline. The live entry/about pages presented script/bot barriers; no home-personalization claim. |
| The StoryGraph — [recommendation changelog](https://roadmap.thestorygraph.com/changelog/revamped-recommendations), 2023-12-21, and [preference form](https://app.thestorygraph.com/reading_preferences) | Preference input and a personalized bookstore presentation organize recommendation reasons.                                                               | Useful explicit cold start without a giant kind list. Official historical design; not a live signed-in session.                                   |
| Douban Books — [public home](https://book.douban.com/)                                                                                                                                                  | New books, editorial/review material and subject-oriented discovery coexist.                                                                              | A book destination can combine catalogue and community with human curation. Public page only; personalized algorithm not inferred.                |
| BookWyrm — [official site](https://joinbookwyrm.com/) and pinned feed source below                                                                                                                      | Social reading combines book-related activity, streams/type controls and reading state.                                                                   | A book can participate directly in a social feed. Restricted source licence; implementation is read-only evidence.                                |
| Letterboxd — [product explanation](https://letterboxd.com/about/what-is-letterboxd/)                                                                                                                    | Diary, ratings/reviews, watchlist, lists and following form one film-oriented product.                                                                    | Personal consumption history differs from public commentary. Official features, not an authenticated recommendation inspection.                   |
| Bangumi — [public home](https://bgm.tv/) and [calendar](https://bgm.tv/calendar)                                                                                                                        | Cross-media catalogue/community and a dated anime schedule support discovery beyond a generic popularity wall.                                            | A good anime home needs time/episode context. Public views only; no personal timeline or exact ranking reconstruction.                            |
| AniList — [official API reference](https://docs.anilist.co/reference/) and [airing schedule](https://docs.anilist.co/reference/object/airingschedule)                                                   | Schedule has media, episode and airing time; the documentation only aims to guarantee future airing data.                                                 | Requires a typed schedule source and freshness semantics. Main site returned 403; API schema is not proof of exposed home UI.                     |
| Steam — [current visibility documentation](https://partner.steamgames.com/doc/marketing/visibility?l=english), [wishlist help](https://help.steampowered.com/en/faqs/view/0CAD-3B4D-B874-A065)          | Tags/preferences, release pools and recommendation destinations differ from wishlist notification and privacy behavior.                                   | Separate follow, save, platform eligibility and acquisition. Official current docs; no authenticated storefront audit.                            |
| TapTap — [public chart](https://www.taptap.cn/top/index.php)                                                                                                                                            | The indexed chart exposes game scores and release/testing labels.                                                                                         | Release state matters in games. Main site returned an encrypted challenge; chart evidence cannot establish personal recommendation design.        |
| Bilibili — [official recommendation disclosure](https://www.bilibili.com/blackboard/activity-gPIvOmhxbh.html)                                                                                           | The primary disclosure URL was located, but returned no readable page text in this session.                                                               | An access-limited comparison, not evidence for invented ranking signals, phone layout or current controls.                                        |
| MyAnimeList — [official API documentation](https://myanimelist.net/apiconfig/references/api/v2)                                                                                                         | Main site/API documentation could not be retrieved by the research tool.                                                                                  | Named vertical comparison remains limited. No third-party mirror was substituted for primary evidence.                                            |

There are twenty substantive product comparisons before the two explicitly access-limited rows, counting the
Meta row as one comparative source rather than claiming independent evidence for two products. Stronger signed-in
visual claims about blocked sites would require a later bounded observation; they are unnecessary to this design.

### Patterns shared, and meaningful disagreements

The recurring pattern is a small number of recognizable viewing modes; candidate selection before presentation;
explanations/provenance; independent save/follow/history actions; and vertical destinations with domain-specific
facts. New users receive curated or explicit-interest discovery, rather than an invented preference vector.
Social/book products demonstrate that a subject, a review and a list can be first-class neighboring feed objects.

The sources disagree on the default relationship promise. Reddit mixes discovery into subscription content; X
offers a separate Following view; Mastodon and Discourse show that chronological/activity-driven views can be useful.
YouTube can intentionally withhold a personalized home when history is off. Therefore the evidence does not require
one opaque “Best” score or a blank cold start. Recommend Discover plus exact Following, with explicit fallback.

Vertical evidence also rejects a universal quality score: reading preferences, airing schedules, platform/release
eligibility and personal progress answer different questions. Steam's visibility documentation specifically warns
against assuming raw store-page traffic or ordinary review score directly drives recommendation visibility.
Importing those supposed signals as obvious best practice would misread the primary source.

### Source implementations examined, with licences

Reference clones were reused from the allowed main-checkout `.reference/` directory; no clone was installed, built
or run. Reuse entries were appended to `.reference/INDEX.md`. All recommendations concern patterns implemented in
the existing REZICS stack; none recommends copying source files or long passages.

| Project, local root and pinned revision                                                                | Exact source / licence / primary URL                                                                                                                                                                                                                                                                                                               | Relevant implementation and limits                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mastodon, `.reference/follow-counts/mastodon`, `f943e0583be804bb062e5c9a4f8e65e2a05e5346`              | `app/lib/feed_manager.rb`, `app/services/fan_out_on_write_service.rb`, `app/models/home_feed.rb`; AGPL-3.0, `LICENSE`; [source](https://github.com/mastodon/mastodon/blob/f943e0583be804bb062e5c9a4f8e65e2a05e5346/app/lib/feed_manager.rb)                                                                                                        | Stored feed maximum 800; merge takes at most one quarter of that; inactive accounts regenerate asynchronously. Fanout iterates follower batches and queues insertion. Per-step bounds do not make total fanout independent of audience.                           |
| AT Protocol / Bluesky, `.reference/viewer-actions/atproto`, `6ed6fe39dded20f1e8995042135fba83b31d7b26` | `packages/bsky/src/api/app/bsky/feed/getTimeline.ts`; `packages/bsky/lexicons/app/bsky/feed/getFeedSkeleton.json`; MIT OR Apache-2.0, `LICENSE.txt`, `LICENSE-MIT.txt`, `LICENSE-APACHE.txt`; [source](https://github.com/bluesky-social/atproto/blob/6ed6fe39dded20f1e8995042135fba83b31d7b26/packages/bsky/src/api/app/bsky/feed/getTimeline.ts) | Select IDs/CIDs, hydrate, remove blocks/mutes, present. The skeleton lexicon limits requests to 100. Timeline refill has an explicit terminal boundary. This is separation of concerns, not proof of every dataplane scan cost.                                   |
| BookWyrm, `.reference/shelves/bookwyrm`, `fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4`                    | `bookwyrm/views/feed.py`; Anti-Capitalist Software License 1.4, `LICENSE.md`; [source](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/views/feed.py)                                                                                                                                           | Authenticated stream, status-type preference, paginated activities and author prefetch restricted to displayed books. Pagination alone is not proof of examined-row bounds. Licence is restricted/source-available, not treated as permissive or OSI open source. |

The shared lesson is a bounded candidate reference layer followed by current presentation and disclosure, with
work outside the request where required. The projects disagree on storage and distribution; they do not justify
adopting Redis, federation, a separate graph database, external generators or their exact retention limits here.

## Proposed product design

All numbers in this section are proposed planning bounds, not adopted limits or measured performance. They make
the upper-bound review falsifiable. Owners must adopt compatible complete-operation ledgers before implementation.

### Personas and first screen

| Reader                                        | First useful screen                                                                                                  | Scope and fallback                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Signed out                                    | Public mixed Discover: a curated subject, discussion/review, Collection and occasional Space invitation as available | No private state, inferred membership or fake personal reasons; search/browse remain useful if the public deck is empty.     |
| Signed in, no follows/history                 | Same public stream plus an optional compact starting-selection action                                                | Choose a few interests/Spaces/Collections, skip onboarding, or search directly; no forced survey or auto-joining a Realm.    |
| Signed in, established                        | Last chosen Discover or Following view; up to six genuine Continue items in a separate region                        | Personal response is private/no-store. Following never silently fills with unfollowed sources.                               |
| Follows 5,000 targets / belongs to 300 Spaces | Exactly the same stream geometry, small pinned source subset, searchable scope picker                                | No first-paint loop over subscriptions, memberships or all kind definitions. Membership alone does not subscribe.            |
| Private-only or quiet follows                 | Honest no-recent-items/coverage state, with an explicit Discover destination                                         | A preparing or unavailable source is never a successful empty feed; denied and inaccessible objects reveal no labels/counts. |
| Returning after months                        | Public discovery immediately; private inbox preparing if reconstruction is needed                                    | Offer a bounded recent horizon and complete source destinations; do not replay the whole archive synchronously.              |

At 1280 wide use one central reading column and, only when useful, a small independent rail. At 390 wide the same
ordered stream fills the content width; the rail becomes a destination, not another sequence of duplicated cards.
One centred header field contains the scope chip and Filters shortcut at its right end. On phones search opens
the settled full-screen panel. Home does not add a second field or an always-expanded filter builder.

Use Discover and Following as stable modes after scope adoption. Show a handful of explicitly pinned scopes
(proposed five maximum); “More” opens search with cursor-backed results (proposed 20 at once). Kind selection
searches released definitions and fetches labels only for shown results. It never downloads 200,000 choices or
mounts hidden measurement nodes for them. A selected Space/Collection is carried in the header and route, with a
clear reset; missing/denied scope never broadens to Global results.

### One stream, several semantic families

The finite renderer families below are distinct from the unbounded semantic kind registry. New released subject
kinds use the generic subject card and released facts without a new hardcoded Home component or tab.

| Family                              | Minimal card and genuine action                                                                                                 | Deduplication and context                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Subject discovery                   | Portrait cover, title, released kind label, one factual line, open/save/progress action when admitted                           | Canonical subject identity. Preserve a selected edition/release as a secondary fact; do not flatten editions into unrelated recommendations.     |
| Discussion / review                 | Author, one readable source Space/Realm, bounded text, subject reference, time, reply/open; review question/scale when relevant | Original thread/review identity. Multiple placements become one reason summary, not duplicated posts or summed scores.                           |
| Collection                          | Collection title, owner, bounded cover selection, purpose and open/follow/save as separately admitted                           | Collection identity/revision; preview at most four images. Never enumerate its million items for a card or compute a count from private members. |
| Space discovery                     | Permitted identity, brief factual purpose, representative public source and visit/follow                                        | Space identity, with optional current Realm/Zone destinations. Join, follow and visit remain separate.                                           |
| Public progress / publication event | Only an explicitly published native event, author and subject, bounded excerpt                                                  | Private library entry/session is never made public by a follow or Home display. Defer if no real publication producer exists.                    |

Portrait is the default for every subject kind, including anime and games. Preserve a landscape image with
`object-fit: contain` in the portrait frame using the existing placeholder colour; do not crop away titles or
stretch pixels. Reserve dimensions before load, offer the original image viewer and preserve credits/suitability.
Post media retains its intrinsic content aspect; a media attachment is not a catalogue cover. Collection collages
must respect the same safe image summaries. The settled instruction specifies portrait, not a particular numeric
ratio; reuse the shared portrait token rather than inventing a separate Home ratio.

Show one primary provenance and one selected rating context. Additional contexts belong behind a searched, paged
picker; proposed preview cap two, never twenty inline buttons. Always label question, scale and population together.
A 4/5 Global book rating cannot be added to a Realm's 8/10 game score or substituted for post approval. Source
cards and their destination pages must use the same context/address rules and current semantic identity.

## Candidate selection, ranking and explicit costs

### Avoid the expensive assumptions first

| Assumption to reject                                                  | Desk calculation at the required bound                                                                                | Smaller design                                                                                             |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Add a home row for every kind                                         | 200,000 × 12 = 2.4 million result slots before headers/images; current composition admits only 16 reads and 128 slots | One mixed candidate source and generic subject renderer; searchable kind scopes.                           |
| Add one feed block for every Space                                    | 300 × 12 = 3,600 slots; independent calls also multiply permission/currentness work                                   | Select a scope or merge preselected event references; fixed page size.                                     |
| Query every follow on every request                                   | At 5,000 follows, even one point request each is 5,000 calls; ten candidate keys each creates a 50,000-key merge      | Materialize a private recent inbox asynchronously, with visible preparation/coverage.                      |
| Use `WHERE source IN(all_follows) ORDER BY score LIMIT 20` as a bound | Twenty returned rows does not bound follow lookup, joins, candidate scans, sort or authorization                      | Indexed source selection with explicit examined-key and native owner budgets.                              |
| Materialize every viewer × Space × kind preference cell               | 300 × 200,000 = 60 million possible cells for one viewer before any history                                           | Sparse explicit interests and bounded event references; no full cross-product.                             |
| Pull all Collection members to choose a cover or detect membership    | One million rows for one card or search request is already a failure                                                  | Stored current safe presentation and exact indexed Source membership; readiness if preparation is missing. |
| “Fanout-on-write makes reads constant, so total cost is solved”       | One event with one million subscribers still needs up to one million deliveries; many events multiply it              | Resumable bounded batches, active-viewer retention, backpressure and honest total-work accounting.         |

PostgreSQL documents that a matching B-tree can satisfy ordered limited retrieval while an explicit sort may need
all input rows. That supports indexed seek design, not a claim that every filter plus LIMIT is cheap.
([PostgreSQL 18, index ordering](https://www.postgresql.org/docs/current/indexes-ordering.html), read 2026-10-31.)
Search pagination also needs a stable ordering/snapshot policy: OpenSearch recommends PIT with `search_after` for
consistent deep pagination. Reuse the existing owner Search cursor where applicable; do not keep a PIT per followed
source or leak its internal token into public URLs. ([OpenSearch pagination](https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/).)

### Stage A: the least costly useful mixed public home

For the initial amendment, use editorially selected public Collections/subjects/discussions/Spaces in one bounded
deck. Store source references, rank/order and a small publication manifest; owners remain the authority for bodies,
eligibility and deletion. Publishing a selection uses ordinary authorized API writes. Do not create a parallel
content database, a universal preference graph or an ML dependency for this slice.

Select at most four shared coarse decks per request, by explicit locale/scope and a declared fallback chain.
Do not create one deck per semantic kind or all combinations of user attributes. Each deck has at most 2,000
recent references. A page takes at most 128 reference candidates total, emits at most 20 cards, and returns the
last examined position even when many candidates fail disclosure. These numbers are candidate budgets, not a
promise of 20 survivors. Sparse pages with a continuation are legitimate; an unavailable owner is distinguishable.

Keep the deck order stable for a published generation. Renew it as an ordinary bounded publication, not by
recomputing all popularity counts during reads. A private continuation cannot borrow public shared caching;
anonymous output may be cached only under the existing current-disclosure policy, not an invented permission TTL.
The initial deck is curated discovery, accurately labelled, not “personalized for you.”

### Stage B: Following without enumerating follows on the request

Use one derived recent event inbox on the viewer's account route, ordered by event time and stable ID. Proposed
retention is at most 2,000 references or 30 days, whichever is smaller. Each entry holds a source locator and a
bounded reason/relationship reference; it contains no copied private body or authoritative permission result.
It is a disposable index of current owners, not a new source of truth for follows or publication.

Qualified owner events reach that inbox through existing durable delivery/ordinary routed work. A reverse
subscription index may support delivery, but it is private derived state: membership must never become public
follower counts or a grant. Follow changes, publication changes and deletion all need replayable versioned events.
The worker must have narrowly defined native capabilities; do not bypass owner commands or write cross-partition
joins. The feed owner and these event ports are new work, not capabilities inferred from `GET /v1/follows`.

Process at most 100 recipient locators per fanout step and resume by an indexed last key. Total work for an event
with F recipients is O(F) deliveries plus indexes/retries, not O(1). Deduplicate on viewer/source-event identity;
coalesce repeated source updates. Apply account activity/retention policy without losing the explicit coverage
promise. A high-volume publisher can overwhelm even a tiny per-step queue; deployment needs admission, backlog
age and retention-aware skipping, with no claim of complete archival delivery.

Do not add a celebrity-source pull hybrid by default: a hybrid adds a second completeness/merge protocol. First
use capped recent inboxes with resumable delivery. If real scale later justifies a hybrid, specify the maximum
number of shared source streams per request, retention, recall and migration before shipping it. A hundred pull
sources disguised as one SQL query still has a hundred-source cost. Mastodon demonstrates bounded stored windows
and asynchronous regeneration; it does not prove those exact choices are optimal here.

New follow backfill and inactive-reader reconstruction are bounded jobs, never a first-home loop. For 5,000
follows and a proposal of ten recent events per source, the total is up to 50,000 source keys plus disclosure/work,
split into at most 100 source locators per step and a separately bounded event allowance. There is no constant
total-cost promise. Show preparing/coverage until the chosen recent horizon is ready. Prioritize new live events
so slow backfill does not starve freshness. Complete archives remain in the followed source's own paged route.

### Read budget and storage ledger to adopt

| Operation / quantity        | Proposed bound and accounting                                                                                   | Honest limitation                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public page candidates      | At most four indexed ranges, 128 examined references in total, 20 returned cards                                | Each range must share the total ledger; four × 128 is not the intended bound.                                                                      |
| Following page candidates   | One account-route indexed seek, at most 128 reference candidates, 20 cards                                      | Work must not grow with 5,000 follows or 300 memberships. Stale entries can yield a sparse page.                                                   |
| Native hydration/disclosure | Group full source keys by owner/partition and row kind; at most 128 selected references, fixed concurrency four | Each owner/Access path needs a compatible examined-row/point/byte/deadline budget. API-count alone is insufficient; fail/preparing when exhausted. |
| Source shapes               | Bounded card DTO; proposed 4 KiB/card and 128 KiB response envelope, excluding separate image bytes             | Large post bodies require native bounded excerpts. Do not fetch a 10 MiB body and truncate only after transfer.                                    |
| Kind facts                  | Only types/facts needed by the returned page; proposed four key facts/card                                      | No full 200,000-kind release traversal on first paint. Existing released metadata remains authority.                                               |
| Collection previews         | At most four already-selected image summaries; one Collection identity/current revision                         | No random sampling, COUNT over all members or expanding a million-item mount in Home.                                                              |
| Navigation                  | Five pinned entries and 20 picker results/page                                                                  | Complete inventory through cursor/search; avoid first-page-only selection.                                                                         |
| Client memory               | Initially ordinary paged Load more; if auto-loading, proposed three rendered 20-card pages with restoration     | Removing a focused article is forbidden. A finite DOM window needs keyboard/back-navigation design, not just CSS hiding.                           |
| Inbox storage               | At most 2,000 reference records per retained viewer; byte cap and expiry also required                          | At illustrative 160 bytes/reference, payload alone is 320,000 bytes/viewer, 320 GB for one million viewers, before indexes/MVCC/replicas.          |
| Follow/reverse indexes      | O(active follow edges), not bounded by inbox length                                                             | One million accounts × 5,000 follows is five billion edges. This relationship lower bound cannot be made constant by a feed algorithm.             |
| Ranked continuation         | Existing sealed viewer/query/version/expiry cursor, proposed at most 4 KiB; fixed small deck positions          | No 5,000-source cursor vector; no unbounded returned-ID set. A fixed generation/inbox order is preferable to a new persisted rank session.         |
| Cleanup                     | Indexed expiry/delivery/tombstone batches, proposed 100 references/step with durable resume                     | Total retained storage also needs active-viewer admission and global quotas. Per-viewer caps alone do not bound total accounts or jobs.            |

These are desk payload calculations, not native database sizes or latency measurements. B-tree seek is logarithmic
in its stored index, plus the fixed examined budget. Permissions, partition placement, native owner reads, physical
blocks and source recovery still need complete-operation evidence after adoption. Never promise a 20-query cap
while permitting unbounded work inside one query. An owner returning unknown readiness must not be coerced into
a card, a “not followed” answer, or a successful empty result.

Existing Zone page-work needs the same total-storage scrutiny: `services/kernel/src/zones/README.md` documents 32
keyed slots per Zone/viewer at 1 MiB each, up to 32 MiB per pair. Multiplying that ceiling by 300 Zones is 9,600 MiB
(9.375 GiB) for one viewer if all pairs fill. That is a worst-case product calculation, not observed allocation.
Do not instantiate page-work for all 300 destinations at Home, or add a parallel retained feed-preparation store
without an aggregate byte/expiry/admission policy. Static source-free pages should remain cheap static pages.

### Ranking inputs and what they mean

| Input                                                 | Available meaning / owner                                                                                   | Recommendation and exclusion                                                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit follows and selected scope                   | Library/Accounts relationship truth; Space selection is explicit                                            | Candidate eligibility/reason, not universal quality. Being a member never implies following every activity.                                                      |
| Published time and source version                     | Owner event/source metadata                                                                                 | Following chronological tuple; stable tie ID. A metadata edit must not repeatedly bump the same item to the top.                                                 |
| Editorial placement                                   | Public curated Collection/deck authority                                                                    | Initial Discover order, labelled as selection. No fabricated social proof.                                                                                       |
| Public discussion activity                            | Community discovery already qualifies original starts in 1-day/30-day buckets                               | Reuse only its defined purpose. It is not a general post engagement/rating/active-member score.                                                                  |
| Global standard subject rating                        | Content owns same-question/population privacy threshold and Bayesian prior; scope allows public rating sort | Use only a native safe exposed aggregate for an explicitly selected rating order. Never derive raw private Realm averages or compare unlike scales.              |
| Votes/replies/saves/completions                       | Different owner events with different semantics and exposure                                                | Candidate-local features only after a qualified producer exists. Save is not endorsement; reply count is not quality; private progress is not public popularity. |
| Negative feedback and blocks                          | Viewer-owned explicit settings / current disclosure                                                         | Blocks and scope exclusion are hard filters. “Less like this” differs from unfollow, hide once and excluding taste influence.                                    |
| Reading/watching/playing history                      | Private library/session data with deliberate purpose and consent                                            | Continue first. Defer inference until opt-out/retention/source deletion and truthful explanations are designed.                                                  |
| Locale, suitability, spoilers and platform preference | Explicit viewer/source constraints                                                                          | Filter or declared fallback; do not silently infer location or expose hidden artwork. Platform preference is not ownership/entitlement.                          |

Initial Following is `(eventTime, stableId)` with deduplication, not rank by mixed ratings. Initial Discover is
published deck order with modest declared source diversity, for example at most three cards from one source in
ten, applied inside the fixed pool. Relax that soft cap only for an explicitly selected single source. Following
must not drop events merely to manufacture diversity. Never guarantee all kinds or all 300 Spaces on one page.

A later ranked Discover can use bounded candidate-local freshness, safe engagement and explicit affinity, with
versioned policy and explanations. Avoid per-Realm percentile normalization as universal calibration: singleton
cohorts rank maximally and cohort composition changes the number. Avoid a user × 200,000-kind embedding requirement
before evidence warrants it. No weights, ML model, per-user retraining or novel scoring engine are required for
the first coherent slice; those choices remain deferred research/implementation decisions after product adoption.

## Permission, freshness and lifecycle

1. Public candidates and public order derive only from qualified public evidence. A private Realm's popularity,
   membership, counts, IDs or existence must not influence a shared anonymous deck. Filtering a private card at the
   end cannot repair a ranking/count side channel caused earlier.
2. Candidate locators authorize nothing. Hydration uses each source's current identity, placement, disclosure,
   moderation and ancestor rules. Recheck at the owner's final disclosure point; no copied grant snapshot or Home
   permission TTL. Follow/unfollow and block changes invalidate private query state immediately under native policy.
3. Keep public route HTML/JSON-LD/cache keys separate from personalized responses, cursors, Continue and private
   reasons. Login/logout and account switching clear viewer-scoped query caches. A private source cannot become
   public merely because an anonymous deck entry or URL exists.
4. Use owner commit/source positions and a visible projection watermark, not a claimed “live” label. Delivery
   failures preserve typed preparing/unavailable outcomes. Cursor policy states whether a new generation requires
   restart; offer new items above the stable reading position rather than reshuffling focused cards.
5. Deleted/unpublished/moved/merged sources need tombstone or replacement events, current read suppression and
   bounded index cleanup. Restore rereads current eligibility and emits a newer source version; stale jobs cannot
   resurrect a withdrawn item. Source bodies and legal-hold state stay with owners, not an evidence archive in Home.
6. Private inbox/deck records and reverse follow indexes require account-erasure, unfollow, inactive expiry and
   bounded purge acknowledgements. Content deletion and removal of derived locators are different steps; do not
   promise total physical erasure from a CSS-hidden card or a logical tombstone alone.
7. Optional images or a rail can degrade locally to a safe placeholder/omission. Failure of the principal candidate
   source is one actionable home state, not six repeated “could not be loaded” panels. Partial output must never
   claim completeness, suppress a permission failure as empty, or automatically broaden a scoped query.

This follows the current owner seams rather than adding a second authorization coordinator. Existing Content
reads, for example, recheck board and thread chain eligibility; Space's `realmId` is derived for the current viewer
and can change without the Space head ETag changing. A Home cache keyed only by that head would be insufficient.
The feed owner must consume those facts rather than infer Realm permission from a visible Space.

## Books, anime and games through Space / Zone

“Better than the best vertical product” should mean complete tasks and useful cross-domain connections, not a
claim of superior recommendations from an empty data set. A special home needs an actual Space address, configured
Zone pages, admitted current sources, shared search and genuine downstream actions. Realm discussions remain a
neighboring destination even if a Zone is removed; a Zone theme does not create membership or catalogue authority.

| Destination / benchmark                        | What a useful special home supplies                                                                                                                                                    | Classification and required owner seam                                                                                                                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Books; Goodreads, StoryGraph, Douban, BookWyrm | Resume reading; discover by author/genre/preferences; selected lists and reviews; distinguish work, edition, translation and series; save or start a real session                      | Labels/order/layout are Zone configuration. Complete work/edition relations, Collection source, native Continue and safe review aggregates are shared Semantic/Library/Content capabilities. Advanced inferred recommendations remain deferred.                   |
| Anime; Bangumi, AniList                        | Current season and upcoming episodes with timezone and freshness; continue the right series/season/episode; spoiler-safe community discussion; alternate releases/languages            | Catalogue predicates and display are released definitions. Indexed time-window Source and structure/progress are generic missing/incomplete seams, not hardcoded anime tables in Web. Streaming-rights availability is an explicit later scope if not contracted. |
| Games; Steam, TapTap                           | Discover games/releases/add-ons by platform and release state; continue planned/playing state; curated lists and community reviews; distinguish version/edition and compatible release | Platform/release/relationship facts belong in definitions; eligible Source and native library actions are common engines. Offers/entitlement remain Commerce; store ownership, price alerts or installation cannot be invented from a save.                       |
| Cross-media advantage                          | Book → adaptation → anime → game links, one library and one stable source/context model; follow a subject and its permitted community without duplicate accounts                       | Generic relations, canonical identity, provenance and contextual actions are the real advantage. Do not promise complete links if catalogue data or relation paging is absent.                                                                                    |

Example coherent tasks: from a book recommendation, choose a translation, save that edition, begin reading and
return through Continue; from this week's anime schedule, open an episode without spoilers and update the correct
progress session; from a game Collection, filter a compatible release, save it, read reviews in a labelled context
and enter the real purchase flow only if an admitted offer exists. Each crosses current owner seams. Merely
rendering a different title/colour and a `TypeList(sort: name)` completes none of them.

A Zone supplies a bounded configured sequence (proposed three principal regions), scope and destination links;
it does not fetch one section for every subkind or every mounted Collection. A million-item Collection needs the
same exact membership and paged search semantics when mounted, searched, previewed or opened directly. A home
preview of four items is illustrative selection, never the membership universe. If a mount is preparing, explain
that region once and keep static navigation useful without substituting global catalogue results.

## Accessibility and consistency across surfaces

Use semantic lists/articles and real anchors, clear headings and a visible Load more control first. If automatic
loading is later adopted, the [W3C APG feed pattern](https://www.w3.org/WAI/ARIA/apg/patterns/feed/) describes a real
keyboard/assistive-technology contract: focus, loading state, article positions and removal must cooperate. Adding
`role=feed` alone is not compliance. Do not remove a focused card during windowing or steal focus when new items
arrive; offer a new-items control and restore scroll/card focus on back navigation.

The phone search panel needs a named dialog, Escape/back, focus return, keyboard-safe height and bounded scrolling.
Filters may overflow vertically within their panel, never horizontally over results. Long multilingual source
names, zoom, RTL, reduced motion and withheld artwork must remain usable. Colour alone cannot distinguish a
selected scope, review population, unavailable region or followed state. Image placeholders reserve space and
have meaningful alternatives without repeating a nearby title unnecessarily.

| Abstraction             | Surfaces that must agree                                                   | Shared behavior                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope search            | Home, Library, Collection, Space/Realm, Zone and subject-related lists     | Same scope chip, Filters entry, current Source semantics and typed failures; private scope cannot silently become Global. Agent identity lookup is not account discovery. |
| Subject/Collection card | Home, search, Collection browse, Library, related items and vertical homes | Portrait default, whole-image preservation, safe cover summary, canonical address and same native save/follow action.                                                     |
| Rating context          | Feed review, subject main preview, rating detail and Realm view            | One selected labelled scale/population/question; bounded searched context navigation and matching disclosure.                                                             |
| Personal state          | Home Continue, Library, Zone progress and subject action                   | Same session/entry authority, independent holding/state/session semantics and invalidation after a real write.                                                            |
| Source lifecycle        | Home candidate, scoped search, opened object, metadata/share card          | Current removal/privacy/merge behavior; no stale personalized material in public SSR or JSON-LD.                                                                          |

## Findings and proposed class corrections

Causes below identify the observable mechanism that permits the defect, not an unobserved review history.

| Finding / defect class                                                        | Exact evidence                                                                                                                                         | Cause that lets it through                                                               | User impact / owner seam / correction                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Catalogue substituted for mixed Home — product/contract gap                   | `docs/scope.md`, Web Goal and `platform.json` route `/`                                                                                                | A deferred capability has no owner; a fixed-row oracle protects the older scope          | No mixed social/catalogue discovery. Manager adopts minimum scope and owner; Web + Presentation + candidate owners deliver one real path.                                                              |
| Marketing text survives — decision/configuration drift                        | `platform.json` home heading and recorded home JSON                                                                                                    | Rejected copy remains in shipped configuration/recording                                 | Wasted first-screen space and explicit decision violation. Presentation owns profile correction; Web updates only adopted-source recordings afterward.                                                 |
| Per-kind expansion fails — cardinality/design defect                          | Four hardcoded home TypeLists; composition limits 16/128                                                                                               | A small launch list is treated as an extensibility strategy                              | New kinds disappear or create an enormous home. Replace expansion with generic family rendering and searched released kinds.                                                                           |
| Useful Continue not demonstrated — integration/exposure gap                   | Native `continue-*` implementation; SignedIn home story asserts unavailable                                                                            | Owner implementation and an accepted error story are treated as a completed user journey | A reader cannot be shown returning to real progress. Library/Source binding + Web need a successful native home scenario as well as errors.                                                            |
| Geometry conflicts with settled defaults — shared-presentation drift          | `packages/ui/src/components/list-presentation-model.ts` fallback maps TV/movie/anime release to landscape and music to square; `CoverList` consumes it | Multiple old per-type defaults override shared desired geometry                          | Anime and other cards have inconsistent hierarchy. Shared UI/definitions revise the default policy across surfaces, preserving per-image landscape support.                                            |
| Selector truncation or hidden inventory growth — cardinality failure          | Old REZICS API list limit 50; legacy-final `tabs.tsx` gauge maps every loaded follow; `ratings.tsx` maps contexts                                      | Visible overflow treatment is mistaken for bounded data/DOM                              | Missing sources, expensive layout and context clutter at 20/300/5,000. Use fixed pins and paged searchable pickers, not CSS hiding.                                                                    |
| Candidate limit mistaken for end-to-end cost — cost-contract gap              | Legacy `cost-contract.ts`; current composition 128 slots; owner Source ledgers                                                                         | Output/query counts omit scans, fanout, hydration and retained bytes                     | Latency/storage grows outside the visible budget. Adopt complete operation and total retained-work bounds before ranked following.                                                                     |
| Configuration mistaken for native vertical delivery — evidence-class error    | Definition Zone starters, old `catalogue-zone.tsx`, current gated runtime and retained prepare refusal                                                 | Fixture/configuration renders independently from a functioning source                    | Attractive demo cannot complete edition/episode/release task. Semantic/Library/Search/Content supply one native source/action journey before widening vertical claims.                                 |
| Documentation and oracle drift — evidence integrity defect                    | Presentation README/test expects SearchBox absent from current profile; Zones README understates real `orderedPrefix` code                             | Descriptions and test intent are not tied to an inspected revision/outcome               | Managers misclassify implemented vs absent capabilities. Correct owner inventories and scenarios after adoption; do not weaken existing acceptance to hide a mismatch.                                 |
| Private influence can leak through public ordering — disclosure design hazard | Current public/personal split is correct; no mixed producer yet exists                                                                                 | A future unified score could combine private library/Realm facts before final filtering  | Anonymous ordering/count side channels. Candidate owner uses public-qualified decks; private affinity and reasons stay viewer-bound. This is a proposed hazard to prevent, not a found current breach. |
| Retained work can multiply by destinations — storage design hazard            | Zone README 32 × 1 MiB slots per viewer/Zone                                                                                                           | Local caps do not constrain total active pairs/expiry/admission                          | Up to 9.375 GiB ceiling across 300 pairs before other storage. Semantic owns global retained-byte policy; Home never prepares all destinations. No observed storage measurement.                       |
| Unavailable oracle replaces usefulness — coverage gap                         | Home SignedIn checks alert/link and SignedOut checks no Continue                                                                                       | These assertions are valid local behaviors but omit the successful mixed task            | More tests can pass without a useful home. Add outcome scenarios and label fixtures/native receipts separately; preserve useful failure tests.                                                         |

## Prioritized coherent slices for adoption

Sizes are planning ranges in focused engineer-days, including owner coordination and future outcome evidence,
not delivery promises or permission to resume the paused Goal. They exclude broad recommendation training and
the unrelated exhaustive public screenshot campaign. Keep current independent writers' ownership intact.

| Order / slice                                              | Size                                     | Dependency and complete outcome                                                                                                                      | Boundary                                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 0. Amend the Home contract and capability ownership        | 1–2                                      | Adopt minimum mixed scope, exact Following promise, source families, candidate/deletion ports, bounds and named owner; reconcile Web Goal            | Research becomes authority only in the owning document. No implicit recommendation mandate.                           |
| 1. Remove obsolete copy and align shared card/search rules | 2–4                                      | Existing settled decisions; one portrait policy, safe landscape containment and one header scope/Filters behavior across Home and consumers          | Shared UI/Presentation/Search owners; coordinate existing search/cover work, no duplicate redesign.                   |
| 2. Native mixed public Discover                            | 5–8                                      | Slice 0; bounded curated reference deck, owner hydration/disclosure, one native card of each admitted family, sparse/empty/unavailable/cursor states | Full useful signed-out path and public SSR privacy. Missing family producer remains absent, never faked.              |
| 3. Native personal continuation on the same Home           | 3–6                                      | Existing Library/Source preparation integration; successful FULL Continue plus save/start/update/return; account switch and private cache isolation  | Can proceed alongside 2 when owner binding is ready. No private state enters the public deck.                         |
| 4. Exact recent Following                                  | 8–15                                     | Follow/publication event ports, private reverse index/inbox, resumable delivery/backfill/cleanup, fixed coverage horizon and controls                | The largest new capability. A real 5,000-follow source model and denied/deleted cases precede recommendation ranking. |
| 5. One book Space/Zone end to end                          | 5–8                                      | Ready Zone Source + Collections + slice 3; work/edition/translation → save/session → Continue, scoped search and review context                      | Configuration plus missing generic engines, not a separate book backend.                                              |
| 6. Anime and games using the same seams                    | 5–10 each                                | Anime indexed schedule/time source; games platform/release/add-on facts; corresponding progress/Collection actions                                   | Reuse engine paths. Streaming/installation/third-party ownership stay explicit later scope.                           |
| 7. Ranked Discover and richer feedback                     | 5–10 for a simple policy; ML unestimated | Safe signals, explicit exclusions/consent, source freshness, versioned cursor/rank policy and native cost evidence                                   | Optional after useful baseline; do not block slices 2–6 on an unproven rank architecture.                             |

Suggested order is 0 → 1/2/3 → 4/5 → 6 → 7, with dependencies respected rather than simultaneous edits to one seam.
Do not implement a retained rank-session service, a new federated engine and all vertical recommendation systems
as a prerequisite for showing a mixed curated page. Conversely, do not call the public deck a completed following
feed: its source and relationship contract are different.

### Outcome scenarios the next contract should name

These are proposed acceptance cases, not tests written or executed in this research task. Existing frozen tests
remain untouched. The owning manager must resolve existing contradictory oracles in the authorized adoption path.

| Scenario                                   | Observable requirement and evidence needed                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Signed-out mixed page                      | Actual owner/API subjects, discussion/review, Collection and Space cards where admitted; no private canary in HTML, JSON-LD, response or ordering; fixture story separately labelled.      |
| New reader / personalization off           | Skip onboarding, browse curated content, select an interest, undo it; no invented “because you read” explanation or forced follows.                                                        |
| 300 Spaces / 200,000 kinds / 5,000 follows | Same first-screen layout and bounded candidate/definition calls; an item outside the first picker page is selectable; no all-inventory DOM or request work.                                |
| Million-item Collection                    | Safe bounded cover preview, exact scoped member outside the first preview, real cursor continuation, and no full-member scan disguised as filtering.                                       |
| Private Continue                           | Create genuine state/session, update progress elsewhere, return and resume; distinguish unprofiled/empty/preparing/unavailable; logout/account switch removes cached state.                |
| Following correctness                      | Follow/unfollow without joining/leaving; no unfollowed recommendations; deduplicate multiple reasons; quiet history and backfill coverage are explicit.                                    |
| Twenty or hundreds of rating contexts      | One labelled selected summary; search to a later context; no wrapped wall, unlike-scale arithmetic or unauthorized population disclosure.                                                  |
| Mid-page lifecycle change                  | Private/removal/ban/merge/restore between candidate and hydration; current owner decision wins, no broadening, no stale media/count/reason leak; cleanup eventually acknowledged.          |
| Sparse and failing dependencies            | Candidate budget ends with 0–19 survivors and valid continuation; owner failure is typed; no unbounded refill or false successful empty.                                                   |
| Cross-surface and accessible return        | Same object/action/portrait behavior in Home/search/Collection/Zone; keyboard/focus/back restore at 390/1280, zoom/RTL, withheld media and slow/offline image state.                       |
| Cost and retained lifecycle                | Real examined references, owner/Access reads, bytes, partition work, fanout steps, total edges and expiry at the adopted bounds; later physical evidence kept separate from desk formulas. |

## Decisions and handoff

Settled choices are not reopened: upper-bound design, portrait defaults with landscape support, no marketing
taglines, centred single header field, scope chip, Filters at the field end and phone full-screen search.
Routine details resolved here are a finite family renderer over unbounded semantic kinds, one selected context,
complete source destinations, curated cold start, exact Following and chronological-first delivery. Numeric
planning limits and sizes above remain recommendations for the owner contract, not newly imposed rules.

Only the scope/product tradeoff needs maintainer adoption: (a) retain the documented catalogue-only first scope,
(b) add minimum mixed public discovery plus exact recent Following in staged slices, or (c) require a full ranked
personalized feed before first scope. Recommend (b), with a named feed capability owner and explicit recent-horizon
promise. It fulfills the stated home direction while allowing useful delivery before complex ranking. Candidate
budgets, concurrency, schema placement and cleanup scheduling are engineering choices within that promise.

The report changes no product authority, code, acceptance test or frozen file. The only write outside its declared
report path is the permitted ignored reference registry, `/home/edge/projects/rezics/rezics-next/.reference/INDEX.md`,
to record the three reused source clones; staged authority/images are temporary worktree evidence. No main checkout
product file was written. Verification remains desk/source/visual-reference analysis only; original acceptance,
native/browser/physical proof and integration checks are deferred under the current execution policy.
