# Mixed home at the upper bound: current evidence and proposed direction

Research date: 2026-10-31. This is independent research, not an adopted product contract.
The separate deep home report was not read before writing this report.

## Result and scope boundary

REZICS should eventually have one mixed stream whose units can connect a subject, a discussion or review, a
Collection and a community. Its advantage should be that discovery leads directly to understanding, saving,
resuming and discussing the same object across media. Replacing four catalogue rows with 200,000 rows would
destroy that advantage. A feed must select a bounded set of candidates before presentation; kinds, Spaces and
rating Contexts are selection dimensions, not instructions to render a section for every member.

That future home is **not the current first-public contract**. [Scope](../scope.md) explicitly defers both
Feeds and Recommendations/rankings. Its Feeds row says home contains Continue and catalogue rows, not a
following feed; the rankings row allows curated Collections and search sorted by public rating aggregate.
The inspected home largely implements that narrower composition. Calling it a completed Reddit/X-style home
would be wrong; calling its lack of a following feed an implementation regression would also be wrong.
The discrepancy is between the desired product and the adopted scope. It needs an explicit scope decision
before a mixed activity feed is briefed.

The immediate corrections do not depend on adopting feeds: remove the tagline, apply the settled portrait
default consistently, make the shared search shell work, keep useful native Continue separate from public
discovery, and stop presenting recordings or dependency-injected modules as proof of default runtime assembly.
There are also less visible upper-bound gaps: the current release admits only 1,024 types, home type naming
loads a whole release, and mixed discovery still does vocabulary-wide work despite returning paged kind choices.
Simply raising the release ceiling to 200,000 would expose these costs rather than satisfy the requirement.

## Baseline, method and limits

The inspected worktree was on the assigned worker branch, at dev revision
`6d3f767467c85dbb9d3bb561d12af784407bd92c`. Historical references were old REZICS revision
`95167ceab7173dc1c5fb0ee70568c5c95f1dba8d` in `/home/edge/projects/rezics/rezics`, and this repository's
`legacy-final`, `1ac6ed6e0668f04e30025c41e59ceaf3bdee5061`. Historical source was read, not merged or ported.
The two historical repositories' root licences are AGPL-3.0; their implementations are behavioural evidence,
not a recommendation to copy source into the rebuilt stack.

The authority was `.temp/goal/web/research-20261031.md`, including its backend addendum. Inputs included
[feature design](../development/feature-design.md), [architecture](../architecture.md), [scope](../scope.md),
[system inventory](system-inventory.md), and the applicable `design-status-accounts.md`,
`design-status-content.md`, `design-status-search.md`, `design-status-commerce.md`, `design-status-semantic.md`,
`design-status-performance.md`, `design-status-imports.md` and `design-status-web.md` reports. Owner evidence
came from the web, composition, presentation, community, library, rating, search and Zones source/READMEs.
Status reports are leads, not substitutes for checking code: several describe gaps that the inspected code
has since partly filled.

This was desk analysis. No stack, compiler, acceptance test, native browser campaign or backend measurement
was run. Test source was sampled; no result below means “executed and passing.” Public documentation was
browsed on 2026-10-31. Product documentation can establish a published behaviour, not prove an account's
current personalized experience. No authenticated competitor sessions were available.

Supplied images were actually inspected:

| Local evidence                                                        | What it establishes                                                                                    | Limitation                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `.temp/goal/web/refs/maintainer-20261031/reddit-search-panel.png`     | Recent/trending search suggestions and community destinations in a desktop search panel                | Supplied image, not a newly captured session; date, account and CSS viewport unknown                   |
| `.temp/goal/web/refs/maintainer-20261031/rezics-filter-panel-bug.png` | Filter controls visibly escape their panel over the content list                                       | The 678×615 image is evidence of a delivered symptom, not proof that this exact revision reproduces it |
| `.temp/goal/web/refs/maintainer-20261031/goodreads-subject-top.webp`  | Cover, identity, rating, shelf action and folded description precede deep material                     | Image dimensions are not a verified viewport; current deployment/version unknown                       |
| `.temp/goal/web/refs/maintainer-20261031/goodreads-subject-full.webp` | Friends, community rating distribution, reviews, lists and discussions have distinct information roles | Subject-page evidence, not evidence of Goodreads' home-ranking algorithm                               |
| `.temp/goal/supermanager/refs/mobile-home-reference.jpg`              | A phone mixed stream with compact search and bottom navigation                                         | Supplied reference, no executable interaction evidence                                                 |
| `.temp/goal/supermanager/refs/mobile-search-open-reference.jpg`       | Search takes over the phone screen with back navigation and suggestions                                | Same limitation; not a 390 CSS-pixel acceptance capture                                                |

No new screenshot sweep was made. The exhaustive Pages/Patterns campaign belongs to the completeness audit.
Relevant current story IDs are `pages-discovery-home--signed-in` and `pages-discovery-home--signed-out`
(`apps/web/src/stories/home.stories.tsx`). They are source references here, not live visual passes.

## Current backend-to-interface matrix

“Implemented” below means inspected executable source exists. “Exposed” distinguishes a mounted endpoint or
consumer from a useful, ready default deployment. “Test evidence” identifies the kind of evidence, not a pass.

| Capability                           | Specified/designed                                               | Backend implemented                                                                                                                         | API exposed / default assembly                                                                               | Interface exposed                                                                  | Test evidence and remaining gap                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Public home composition              | Continue plus catalogue rows, feeds deferred                     | Presentation reads and bounded composition dispatch                                                                                         | Native `pages.$read.post`                                                                                    | Heading, private slot, four TypeLists                                              | Home recording/heading/card tests; no mixed-feed outcome follows from them                                                             |
| Return to active work                | Library/Continue contract                                        | `library/continue-reads.ts`, `continue-query.ts`: account fences, canonical source, bounded rounds, final rechecks                          | Mounted `GET /v1/libraryContinue`, `library_continue.list`; usefulness still depends on source readiness     | Native adapter with six-item limit; ready, empty, preparing and unavailable states | Kernel Continue read/HTTP/user-case files and web adapter/journey files exist; not executed here                                       |
| Native following activity feed       | Explicitly deferred, no current feed owner                       | Follow edges and counts are not an activity pipeline                                                                                        | No equivalent current home-feed route identified in the inspected route/consumer chain                       | No Following mixed stream on `/`                                                   | Legacy tests and a mixed search test cannot establish this capability                                                                  |
| Mixed catalogue discovery            | Search discovery contract, separate from social feed             | `search/discovery-service.ts` and mixed owner hydration exist                                                                               | `subjects:search` accepts `discovery-v1`; optional handler absent from inspected default server construction | Search request builder and discovery consumers exist                               | Mixed-discovery, registry, consumer, generation and user-case files exist; default useful native binding remains a separate obligation |
| 200,000-kind catalogue               | Settled design stress case; not current release capacity         | `packages/definitions/src/portable.ts` caps types at 1,024 and release bytes at 4 MiB; discovery registers every released type plus account | Current validation/registry rejects a release beyond its cap                                                 | Bounded eight-kind metadata output does not make vocabulary-wide execution bounded | Source evidence of the ceiling and loops, not a measured 200,000-kind deployment                                                       |
| Discover communities                 | Realm discovery contract                                         | Current disclosure-aware popularity/trending projection and bounded candidate work                                                          | `GET /v1/realms/discovery`                                                                                   | Realm discovery/search surfaces, not a mixed home feed                             | Community native/source tests and web discovery tests exist; no execution claim                                                        |
| Follow subjects, Collections, Spaces | Attention edges; not membership or access                        | Native personal follow operations and count health/fences                                                                                   | Mounted follows and private outgoing/target count routes in `library/personal-routes.ts`                     | Follow controls and private count page source exist                                | Native count outcome/growth and web private-count tests exist; not notification or activity delivery proof                             |
| Subject community sections           | Global/selected Realm discussion and review reads                | Composition registry has real ThreadList/ReviewList read callbacks                                                                          | Presentation reads support Realm selectors and node continuation                                             | Configurable subject/community sections                                            | Historical status report claiming these callbacks absent is stale; this does not make them a home feed                                 |
| Curated rankings                     | Allowed curated Collections/public rating sort                   | Collection and rating/search owner code                                                                                                     | Existing owner reads, subject to grants/readiness                                                            | TypeLists and Collection/search destinations                                       | A ranked Collection is not evidence of personalized cross-kind ranking                                                                 |
| Static Zone site                     | In first scope                                                   | Source-free page path                                                                                                                       | Configured static routes                                                                                     | Configured Zone presentation                                                       | Static runtime test source exists; no new run                                                                                          |
| Source-dependent Zone                | Behind platform grants in scope                                  | `zones/page-runtime.ts`, `membership.ts` assemble source admission, shared work and retained continuation                                   | Real implementation branches exist, but required ports/readiness and public admission must hold              | No basis for claiming every public Zone has live merged sources                    | Source and continuation tests are evidence of components, not permission to open the deferred capability                               |
| Library/Collection-scoped filtering  | Generic owner contracts; some scopes gated                       | Collection source and search scope engines exist                                                                                            | Scope-specific admission and source readiness still apply                                                    | Scope-bearing search/filter consumers exist                                        | A working illustrative filter does not prove million-item native useful search across all scopes                                       |
| Covers across kinds                  | Settled: portrait default for every kind, preserve landscape art | Shared cover model and release-driven presentation                                                                                          | Cover summaries/definition data are consumable                                                               | Current fallback still differs by family                                           | Card uniformity tests protect consistency within a fixture, not the all-kind portrait decision                                         |

### Concrete read chains and useful distinctions

`apps/web/src/routes/index.tsx` loads a public page and separately enables private Continue only after session,
personal-read and exposure/operation admission are ready. `apps/web/src/features/pages/home-queries.ts` calls
`loadRoutePage` and marks the private server function `private, no-store`. Public HTML must never acquire a
private library result through a shared query key or cache. This separation is a good starting boundary.

`packages/composition/profiles/platform.json` currently configures the home as a Heading, personal slot, then
books, anime, visual novels and recipes. Each TypeList asks for 12 subjects sorted by collections. Thus the
configured initial lists request at most 48 subject slots. Anime uses `schema:TVSeries` and `schema:Movie`;
those types alone do not mean animation. Adding another vertical should be definition/presentation work,
but a classification must actually express the vertical rather than rename all television and film.

`apps/web/src/features/pages/type-list-query.ts` sends node continuation back to native page reads. The
renderer hides 204 sections and exposes retry for genuine errors. This is a catalogue section protocol;
its existence does not imply unseen events, following eligibility, a feed cursor or cross-kind relevance.

Continue has a real native adapter despite the unavailable home story. `apps/web/src/library/continue-adapter.ts`
uses the generated `libraryContinue.get` client with `CONTINUE_LIMIT = 6`, FULL summaries, authorization,
no-store and strict response validation. It does not make one progress HTTP request per returned card.
`services/kernel/src/library/continue-query.ts` has three bounded candidate rounds, canonical source
observations, metered identity resolution and final selected-fact/source checks. A nonempty source can still
be unavailable when the common source cannot be proven ready. Native adapter presence and useful deployment
are separate claims; neither “all fake” nor “already proven native” accurately describes this chain.

Mixed discovery has a similar distinction. `services/kernel/src/search/http/routes.ts` accepts
`representation: 'discovery-v1'`, and `apps/web/src/search/search-request.ts` actually requests it.
`services/kernel/src/search/discovery-service.ts` contains owner hydration and final source checking.
However, `services/kernel/src/server.ts` constructs `createSearchService` and passes no `discovery` handler
to `createKernel`; the route's missing-handler result is `503 index_not_ready`. Injected test assembly is
not evidence that the default server can serve a useful mixed page. The public-filter source is also
dependency/readiness sensitive; its current implementation must not be dismissed as an entirely empty stub.

`services/kernel/src/library/personal-routes.ts` now mounts private outgoing and target follow counts.
`follow-count-reads.ts` requires current access, healthy projections and a bootstrapped target row, with checks
before and after the read. Missing/unknown is not zero. Accounts/commerce status prose saying counts are not
HTTP-exposed is stale at this revision. Counts remain private and do not authorize disclosure of follower
identities, publication of collection activity, membership, or delivery of followed-item events.

Realm discovery counts eligible discussion starts over the previous 30 completed UTC days for popular and
the previous completed day for trending (`services/kernel/src/community/README.md` and discovery source).
It does not count every view, reply, review, member or vote. It examines at most `min(limit, 20)` ranked
candidates per response, with sparse continuation rather than unlimited refill. It is a bounded community
directory primitive, not a ready-made personalized item-ranking system.

## Defects and the causes that let them through

The causes below are deductions from source and test boundaries, not claims about individuals or undocumented
history. Each correction belongs in an owning contract before implementation beyond settled decisions.

| Finding / defect class                                            | Exact evidence                                                                                                                                                                                                                               | Cause indicated by evidence                                                                                                                                           | User impact                                                                                                                                                                                             | Owner seam and correction                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1: Product outcome replaced by fixture shape                     | `platform.json` home Heading and four TypeLists; `apps/web/tests/home-heading.test.ts` expects the six-node shape and localized home heading                                                                                                 | The test asserts the composition chosen by implementation rather than the user's discovery/return job                                                                 | Tagline is preserved; four arbitrary verticals appear to define the whole product                                                                                                                       | Web + composition: remove tagline under settled authority, preserve an accessible page name, test useful outcomes instead of treating a fixed row census as product acceptance                                                                                               |
| H2: Vocabulary-wide cold work on a bounded page                   | `home-queries.ts` calls `nameSubjectTypes`; `apps/web/src/subject/definitions.ts` loads an entire immutable release and normalizes `Object.entries(value.types)`                                                                             | Small response sizes were mistaken for small dependency work; immutable caching hides the cold path                                                                   | A 48-item page pays O(K) release work, currently capped at 1,024 types/4 MiB; raising that ceiling alone makes the cold dependency grow with all kinds. Retained release maps have no explicit eviction | Definitions + web: provide a bounded requested-key display projection or server-supplied released labels; bound cached release generations/bytes; preserve digest/locale semantics                                                                                           |
| H3: Module completeness confused with runtime completeness        | Optional discovery route and native discovery implementation versus default `server.ts` without its handler                                                                                                                                  | Unit assembly can inject a dependency that the production composition root omits                                                                                      | A polished mixed search/home consumer can hit unavailable instead of useful results                                                                                                                     | Search + kernel composition + web: trace a real default-runtime useful page and lifecycle readiness before exposing the surface; never synthesize an empty success                                                                                                           |
| H4: Deferred scope presented as completed ambition                | `docs/scope.md` Feeds/Recommendations rows versus the requested Reddit/X home                                                                                                                                                                | The public scope and product ambition are not represented as separate delivery milestones                                                                             | Users cannot follow activity through home despite working follow buttons                                                                                                                                | Scope owner + future feed owner: explicitly adopt a later mixed-feed slice or retain honest catalogue home wording; do not silently assign a missing ranking backend to web                                                                                                  |
| H5: Defaults remain family-specific                               | `packages/ui/src/components/cover-model.ts` uses music/other 1:1, recipe 4:3 and person 3:4 alongside work/game 5:7; release presentation can override                                                                                       | Existing variety is protected without a cross-kind default assertion                                                                                                  | Mixed cards lack a stable default rhythm; new/unknown kinds get square defaults                                                                                                                         | UI + definitions + presentation: one portrait default for every kind; keep per-image landscape containment, released override semantics made consistent with the settled default                                                                                             |
| H6: Shell interaction not accepted across its hosts               | Supplied filter overflow image; `search/header-search/header-search.tsx` has outer background, expanded card/popover backgrounds and a focus-within ring                                                                                     | Component-level states and full-shell stories do not demonstrate alignment, containment and interaction on every host                                                 | Search looks split or escapes its panel, obscuring the list it should refine                                                                                                                            | Shared shell/search + host pages: one centred field, scope chip and Filters at its end, phone full-screen panel; verify focus and panel geometry together on home, Collection and Space/Zone                                                                                 |
| H7: Evidence labels obscure the missing layer                     | Home story says Continue awaits native binding while a native HTTP adapter exists; that label can still describe missing source readiness. Separately, design-status-search says read callbacks are absent though registry now contains them | Adapter, owner source, default runtime and executed evidence are not consistently distinguished in status                                                             | Managers may commission duplicate work or mistake source existence for completed journeys                                                                                                               | Owning modules + web: name the exact unready layer with revisioned evidence; show ready, preparing and unavailable stories separately; do not rename a genuinely unavailable story as ready                                                                                  |
| H8: Context multiplicity treated as display multiplicity          | Legacy-final `work-page/ratings.tsx` maps all other question contexts; current upper-bound requirement forbids one block per Context                                                                                                         | Ordinary-size fixtures do not exercise the choice cardinality                                                                                                         | Twenty or hundreds of populations/questions become a wall rather than a useful rating                                                                                                                   | Rating + presentation: explicit selected population/question, bounded summary, searchable paged picker; never average all memberships into one purported consensus                                                                                                           |
| H9: Test quantity hides outcome gaps                              | Home heading/card/recording sources described below; kernel home test still expects SearchBox while current JSON has personal slot                                                                                                           | Snapshots and local contracts can be internally tidy but stale or irrelevant to the adopted user job                                                                  | Large suites coexist with unfinished delivery and contradictory status                                                                                                                                  | Web + presentation + owning API: map each accepted journey to source, real API wiring and visual/interaction evidence; keep recordings but stop counting them as native proof                                                                                                |
| H10: A release-size ceiling substitutes for a scalable kind query | `definitions/src/portable.ts`, `definitions/src/index.ts`; `search/discovery-registry.ts`, `discovery-service.ts`, `discovery-filter.ts`, `discovery-current.ts`                                                                             | Whole-release registry operations are tolerable under the launch cap; output pagination was not carried through metadata, query construction and current-hit dispatch | 200,000 types are not currently admissible; merely lifting the cap adds request-wide hashing/sorting, huge kind terms and per-kind candidate filtering                                                  | Definitions + search: adopt a scalable versioned vocabulary/index contract; precompute release metadata/digests, page ordered kind keys, dispatch by kinds actually present, and preserve registered-producer eligibility without sending the full vocabulary on every query |

For H6, source does not establish computed centring or reproduce the screenshot. The blue ring is not inherently
an accessibility defect: removing all visible focus would create one. Correct the settled visual treatment while
retaining a clear keyboard focus indicator. The exact current CSS cause needs the shared-shell audit, not an
invented diagnosis from an undated bitmap. Existing phone full-screen code is partial implementation, not evidence
that the requested interaction is wholly absent.

### What the sampled tests protect

`apps/web/tests/home-story.test.ts` uses a recorded kernel fetch; it can detect broken rendering/link routing
against that payload. `home-recording-freshness.test.ts` protects recording/profile consistency and unchanged
non-home recordings. These are useful compatibility checks, not proof that an eligible private work appears
through the current default backend.

`apps/web/tests/home-cards.test.ts` uses a fake kernel/constructed entries and sessions. Its 390, 700 and 1280
width cases and consistent card sizing protect a layout subset. They do not prove portrait defaults for arbitrary
kinds, useful default discovery wiring, 300-Space navigation, disclosure changes or a bounded cold release load.
The older per-item progress request accounting in fixture-based home tests must not be attributed to the newer
single native Continue endpoint.

`services/kernel/test/presentation/platform-home.test.ts` expects Heading followed by SearchBox, whereas the
inspected profile starts Heading followed by personalSlot. That is a source-level inconsistency, not an observed
test failure in this attempt. `home-heading.test.ts` also locks the current heading and fixed row structure.
This research neither edits existing acceptance/frozen files nor runs them. The integration owner should reconcile
stale assertions with the adopted contract rather than weaken a failing acceptance condition.

Positive test files also exist: `services/kernel/test/library/continue-http.test.ts`, `continue-read.test.ts`,
`continue-user-cases.test.ts`; `apps/web/tests/continue-adapter.test.ts`, `continue-runtime.test.ts`,
`library-continue-journey.test.ts`; `services/kernel/test/search/mixed-discovery.test.ts`,
`discovery-consumer.test.ts`, `discovery-generation.test.ts`, `cross-surface-discovery.test.ts` and
`discovery-user-cases.test.ts`. Their existence prevents an “untested backend” generalization. It does not
establish their full coverage or executed status. This sample cannot evaluate the repository's entire test volume.

## What both old homes actually did

### Old REZICS: one mixed feed, with bounded context summaries and incomplete selection

At `/home/edge/projects/rezics/rezics`, `apps/web/features/explore/home.tsx` renders one `ApiFeedList` in a
58rem content region. URL state carries sort, content, language, Realms and tags. It has no marketing tagline.
`apps/web/features/content-feed/data/api-feed-list.tsx` requests pages of 20 and flattens/deduplicates loaded
pages. This is a much closer product starting point than the current four catalogue sections, but it is not
an implementation to port wholesale.

The same client asks for only 50 Realm and 50 tag choices; no continuation beyond that prefix is shown in that
control chain. A reader in 300 Spaces cannot reliably choose the omitted ones there. Loaded feed pages accumulate;
the inspected accumulation has no retained-page bound. This is a long-session memory risk, not a measured leak
or proof that every nested renderer is unvirtualized.

`services/main/src/services/api/feed/schema.ts` caps page size at 50, context summaries at eight and attribution
summaries at eight. Its feed-content kinds are a closed set of owner/event shapes, not the whole kind vocabulary.
`services/main/src/services/api/feed/index.ts` builds context eligibility from a lateral latest-32 placement
window before selecting at most eight visible context summaries. That bounds work but can miss a relevant older
placement outside the 32-record window. A capped summary is legitimate only when it is not presented as exhaustive
membership or the complete basis of ranking. The UI must say there are more contexts and offer the owner picker.

The same backend's search selection/ranking path works on candidates and admitted scopes before hydration;
it is not a loop fetching one complete feed for every followed Realm. `continuation.ts` distinguishes a bounded
candidate window from genuine exhaustion. `apps/web/features/content-feed/model/feed-rating.ts` selects a preferred
population with Global fallback; it does not average every Realm rating. Preserve that semantic distinction.
These facts support a single candidate pipeline, but do not prove every historical physical query bound.

### Legacy-final rezics-next: stronger mixed event semantics, some limits already repaired

Read with `git show legacy-final:<path>`; paths here refer to that tag, not current dev:

| Source path                                       | Behaviour observed                                                                                                                       | Upper-bound consequence                                                                                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/features/home/home-page.tsx`            | One `HomePostsFeedList`, Continue strip, feed controls and rail                                                                          | The final tag does **not** render one home stream per Realm; do not reproduce that historical criticism as a literal description of this snapshot                                                              |
| `apps/web/features/home/server.ts`                | Loads followed Realms/Zones, presence of any follow, feed preferences, anonymous/personal query, six Continue items and rail data        | Every auxiliary owner read contributes to page cost; a bounded main feed does not make an unlimited rail cheap                                                                                                 |
| `apps/web/features/home/tabs.tsx`                 | Fits visible concept tabs, then offers More/topics picker                                                                                | A real existing mitigation; not evidence of thousands of tabs rendered at once                                                                                                                                 |
| `apps/web/features/feed/controls.tsx`             | Maps supplied Realm choices; selected Realm labels use `.find` over choices                                                              | With all R choices and S selections, label work is O(SR) and option rendering O(R); with a prefix, missing choices become a discoverability problem. Upstream completeness must be checked rather than assumed |
| `apps/web/features/work-page/scope-bar.tsx`       | Top four Realm populations plus selected exception; paged Other communities picker                                                       | The final tag already partly fixes the “20 Realms” selector failure. This is the right distinction between a summary and complete paged access                                                                 |
| `apps/web/features/work-page/ratings.tsx`         | `contexts.map` renders links for every other question Context                                                                            | Still O(C) visible controls; question Contexts are distinct from Realm populations. Many questions can overflow even when the Realm selector is bounded                                                        |
| `apps/web/features/home/rail.tsx`                 | Maps supplied moderated communities; suggestions are sliced to three                                                                     | A capped suggestions list is good; no local cap is shown for all moderated entries. Do not infer upstream cardinality from a small story                                                                       |
| `apps/web/features/feed/card.tsx`, `post-row.tsx` | Work, addition, contribution, adoption/decision, discussion/reply, Collection and review events; compact actor/reason/attachment/actions | Native mixed units are possible without one card template per catalogue kind; spoilers and action semantics still need owner rules                                                                             |
| `services/main/src/modules/feed/read.ts`          | Candidate read, hydration and current-disclosure fences; revision-sensitive spoilers                                                     | Ranked locators are not permission to disclose a stale hydrated object                                                                                                                                         |

The maintainer's per-Realm/context concern is therefore valid as a **defect class**, but the exact final tag has
both repairs and remaining enumeration sites. A new design must not regress its top-four-plus-picker behaviour,
nor preserve the uncapped question-context links merely because a final-tag fixture looks reasonable.

`services/main/src/modules/feed/cost-contract.ts` declares anonymous home 24 PostgreSQL/8 Fuseki statements
and signed-in home 30/8, Best K=256, New/Top P+1, membership M≤8 and at most two tag groups. Following is a stored
inventory, not a request-time enumeration of all follows. Trending's five items examine at most 80 candidates.
The same file separately allows Continue 110/30 and suggestions 60/25; those optional pieces cannot be hidden
inside the main-feed number. These are historical declared ceilings, **not measurements or proven current
budgets**. The file explicitly leaves physical-row/graph/backup evidence obligations. The current PostgreSQL,
OpenSearch and durable-work stack needs its own owner ledger, not these numbers copied into a new claim.

## Product survey: 21 references, with access limits

All URLs below are primary product/help pages inspected or attempted on 2026-10-31. “Public page” means the
public document/page was readable, not that a personalized home was exercised. Proprietary product documents
and supplied screenshots were used as reference evidence; no reusable source licence is assumed for them.
Blocked entries are survey gaps and contribute no fabricated capability claims.

| Product and primary evidence                                                                                                                              | Relevant pattern / action or empty-state lesson                                                                                       | Evidence limit and implication for REZICS                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. [Reddit home recommendations](https://support.reddithelp.com/hc/en-us/articles/4402284777364-What-are-home-feed-recommendations)                       | Community/activity signals, recommendation explanations and an opt-out make discovery legible                                         | Help document, updated 2026-10-05, plus supplied search image; not an inspected ranking implementation. Community membership must not require one section per community         |
| 2. [X timelines](https://help.x.com/en/using-x/x-timeline)                                                                                                | For You and Following express different intentions; followed accounts, Topics and recommendations can coexist                         | Published behaviour, account session unavailable. The label Following needs a precise eligibility/order promise                                                                 |
| 3. [Bluesky introduction](https://bsky.social/about/blog/09-04-2024-welcome) and [starter packs](https://bsky.social/about/blog/06-26-2024-starter-packs) | Chronological Following, Discover and chosen custom feeds; packs package up to 150 accounts and three feeds                           | Official historical explanations, supplemented by source below. Discovery choices can be opt-in rather than silently following everything in a package                          |
| 4. [Mastodon network navigation](https://docs.joinmastodon.org/user/network/)                                                                             | Lists and known-public timelines provide distinct scopes; the network view is not the complete fediverse                              | Official user documentation, source below. State the universe a feed actually knows; a sampled index must not claim exhaustive discovery                                        |
| 5. [YouTube recommendations](https://support.google.com/youtube/answer/16089387?hl=en)                                                                    | History, feedback and satisfaction matter; with history off, home can emphasize search/navigation instead of invented personalization | Help evidence. Cold start and privacy choices need a useful honest state, not fake recommended cards                                                                            |
| 6. [Steam discovery update](https://store.steampowered.com/about/newstore) and [store destinations](https://store.steampowered.com/sitemap)               | Discovery queue, wishlist, follow/ignore and curators connect exploration to later action                                             | The update is historical (2014); sitemap establishes destinations, not today's algorithm/layout. Games discovery needs release/platform and action context, not only ratings    |
| 7. [The StoryGraph](https://thestorygraph.com/)                                                                                                           | Mood/pace discovery, tags/lists, reading progress, DNF and buddy/club reading address reading intent                                  | Public product claims, not an authenticated workflow. A books home needs progress and preference specificity beyond a bestseller row                                            |
| 8. [Bangumi](https://bangumi.tv/) and [calendar](https://bgm.tv/calendar)                                                                                 | Media navigation, subject-linked community activity and weekday airing information share a catalogue                                  | Public pages; homepage showed version r771. No inference about personalized ranking. Timeliness and episode context are central to anime                                        |
| 9. [Douban](https://www.douban.com/)                                                                                                                      | Books/film/music connect reviews, lists/tags and groups rather than treating catalogue and community as separate products             | Public root only; authenticated home and detailed book pages not established. Preserve subjects as shared discussion anchors                                                    |
| 10. [Letterboxd](https://letterboxd.com/about/what-is-letterboxd/)                                                                                        | Diary, watchlist, reviews, lists, tags and friends' activity form a coherent film loop                                                | Official overview, not a tested subscriber session. Separate a private diary write from an intentionally public review/activity                                                 |
| 11. [Spotify taste profile](https://support.spotify.com/us/article/your-taste-profile/)                                                                   | People can inspect/edit taste signals that affect Home, with delayed effects rather than absolute bans                                | The described feature is a limited beta for eligible Premium adults/mobile languages; do not imply universal availability. Explain soft feedback versus hard exclusions         |
| 12. [Netflix recommendations](https://help.netflix.com/en/node/100639/)                                                                                   | Selection, row order and item order are ranked; metadata/interaction and similar tastes support cold start                            | Official explanation, not code or measurements. Rows can work for a small editorial vocabulary, not 200,000 semantic kinds                                                      |
| 13. [TikTok recommendations](https://support.tiktok.com/en/using-tiktok/exploring-videos/how-tiktok-recommends-content)                                   | Following can itself be ranked; recommendation eligibility differs from availability; feedback/filter controls exist                  | Published explanation. Do not assume every product means reverse chronology by Following, or that readable means recommendable                                                  |
| 14. [Pinterest home](https://help.pinterest.com/en/article/explore-the-home-feed) and [tuning](https://help.pinterest.com/en/article/tune-your-home-feed) | Boards, interests and activity connect collected objects to discovery, with controls over recommendation inputs                       | Help evidence; board tabs/features vary. A Collection can guide discovery without making every private save public                                                              |
| 15. [GitHub personal dashboard](https://docs.github.com/en/account-and-profile/get-started/personal-dashboard-quickstart)                                 | Return-to-work and followed-network activity serve different jobs, with activity filters                                              | Documented dashboard/feed includes preview behaviour. Continue should remain a separate personal utility rather than being diluted into a public engagement rank                |
| 16. [Qidian](https://www.qidian.com/)                                                                                                                     | Official indexed material exposes classification, rankings and new-book destinations                                                  | Direct page had no useful readable body; indexed evidence only. No claim about its signed-in bookshelf or current recommendation UI                                             |
| 17. [Goodreads](https://www.goodreads.com/) and supplied subject images                                                                                   | Cover/identity, shelf action, friends/community reviews and folded detail support a reading decision                                  | Live root hit verification; images are undated subject pages. No current home-algorithm claim. The images still establish the supplied information-hierarchy target             |
| 18. [AniList](https://anilist.co/) / [official docs](https://docs.anilist.co/)                                                                            | Relevant anime catalogue/tracking comparator                                                                                          | Access returned 403. No current home or API capability inferred from inaccessible material                                                                                      |
| 19. [MyAnimeList](https://myanimelist.net/) / [API reference](https://myanimelist.net/apiconfig/references/api/v2)                                        | Relevant anime vertical comparator                                                                                                    | Site/reference retrieval failed; no observation of personal feeds, seasonal filters or progress UX is claimed                                                                   |
| 20. [VNDB API](https://api.vndb.org/kana)                                                                                                                 | Explicit fields, bounded pages and VN/release/platform/language/tag distinctions illustrate vertical precision                        | Public home was robots-blocked; API documentation was readable. API evidence is not UI evidence; optional counts have separate cost. Data licensing is distinct from API access |
| 21. [Bilibili](https://www.bilibili.com/)                                                                                                                 | Relevant Chinese video/community comparator                                                                                           | Public route reached unsupported-browser behaviour. No personalized-feed or moderation claim is invented; authenticated/current UI research remains a gap                       |

### Patterns shared, and genuine disagreements

Most usable references separate immediate return tasks from discovery, make some interest/scope choices explicit,
and attach concrete next actions to items. Collection/list/board concepts are powerful because they preserve an
intention across visits. Community context helps discovery, but none of the usable evidence justifies a section
for every followed community or a rating block for every possible population.

The products disagree about order and eligibility. Bluesky's documented chronological Following differs from
TikTok's ranked Following; Netflix's rows optimize a catalogue, while Reddit/X-style streams can mix events.
Steam's queue is a finite deliberate session rather than endless social scroll. REZICS should name these modes
explicitly instead of promising that one ambiguous “Home” will satisfy all of them.

Do not import every competitor action as an owner-specific backend. Reading mood, airing schedule, platform,
language, edition and content type are definition/data requirements where the existing generic graph can express
them. Current publication eligibility, resumable source preparation, activity delivery, private-to-public consent
and feedback lifecycle may require shared capability work. A missing property/index is not repaired by a new card.

## Open-source and standards evidence

Reference repositories were reused in the main checkout's `.reference/`, read as untrusted data, and never
installed, built or executed. Their reused locations and this topic are recorded in `.reference/INDEX.md`.

| Project, revision, licence                                                                                                                                                                                                   | Exact inspected source                                                                                        | Pattern to adopt conceptually, with limits                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Mastodon](https://github.com/mastodon/mastodon/tree/f943e0583be804bb062e5c9a4f8e65e2a05e5346), `f943e0583be804bb062e5c9a4f8e65e2a05e5346`, AGPL-3.0 (`LICENSE`); local `.reference/follow-counts/mastodon`                  | `app/lib/feed_manager.rb`; `app/services/fan_out_on_write_service.rb`; `app/models/feed.rb`                   | Feed manager retains at most 800 entries and follow merge uses a bounded recent subset; fanout iterates recipients in batches and queues insertion. Batching bounds a step, not total O(followers) work. A retained window is not an exhaustive archive                  |
| [atproto](https://github.com/bluesky-social/atproto/tree/6ed6fe39dded20f1e8995042135fba83b31d7b26), `6ed6fe39dded20f1e8995042135fba83b31d7b26`, MIT OR Apache-2.0 (`LICENSE.txt`); local `.reference/viewer-actions/atproto` | `packages/bsky/lexicons/app/bsky/feed/getFeedSkeleton.json`; `packages/bsky/src/api/app/bsky/feed/getFeed.ts` | Skeleton returns ordered references, with limit 1–100/default 50; app view hydrates and applies viewer blocks/mutes. Code deliberately avoids refill that could advance generator state and skip future items. This is evidence against naive “keep fetching until full” |

Mastodon illustrates precomputed attention inventory; atproto illustrates separation of selection from current
presentation/disclosure. They are complementary, not interchangeable engines. REZICS can implement analogous
derived projections using its existing PostgreSQL and durable-work abstractions; this research proposes neither
a Redis dependency nor a federation/custom-feed service. Definitions and source owners retain authority.

[WAI-ARIA's feed pattern](https://www.w3.org/WAI/ARIA/apg/patterns/feed/) explains the focus/assistive-technology
contract for dynamically loaded articles, positions, loading and keyboard navigation. Do not add `role=feed`
merely because a list scrolls. Start with semantic articles/list structure and an explicit More control if the
full focus/position/loading contract is not implemented. Loading must not leave `aria-busy` permanently true.
This is W3C documentation, not an imported UI implementation.

[RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2) distinguishes `private` from `no-store`:
private excludes shared-cache storage, while no-store prohibits storage of the response. Keep personalized
Continue/feed/preparation responses on the appropriate private no-store path rather than trusting a public page
flag to prevent leaks. RFC material is under IETF Trust document terms; no normative text or code is copied here.

## Recommended experience, conditional on scope adoption

### Signed out and signed in

Signed out, show one public discovery surface with useful subjects and intentionally public community/Collection
material, clear object identity and visible next actions. Show the currently selected language/content scope.
Do not label generic popular content “for you.” A sign-in invitation should explain saving/following/resuming
after demonstrating value; it should not masquerade as a result or block browsing. If native discovery is not
ready, the truthful first-scope fallback is admitted catalogue/curated content with a recoverable unavailable
section, not a fabricated mixed stream.

Signed in, place a compact Continue utility above discovery when useful, with at most six items and a route to
the complete library. Its absence should distinguish genuinely empty from preparing/unavailable without a wall
of repeated alerts. A future Discover/Following choice can then separate broad exploration from deliberate
attention. Following eligibility/order must be adopted before labels are implemented; reverse chronology with
stable tie-breaks is the simplest recommended initial promise, rather than an undisclosed engagement model.

For 300 Spaces, show the selected Space plus a fixed small set of recent/pinned shortcuts (proposal: two), then
More leading to a searchable paged chooser. No 300-tab strip, preloaded menus of all Spaces or 300 home queries.
Membership and following are different; switching a scope does not join/follow it. A Space carries a Realm or
Zone home, not independent permission to read everything referenced there. Global home, Realm community and
Zone editorial home share primitives but retain different admission and provenance rules.

For 200,000 kinds, show a generic mixed stream and searchable kind selection. Suggested facets should be a
bounded top page plus selected values, not a full vocabulary download. New kinds fall back to a usable subject
card with released labels and portrait cover; they do not require TypeScript changes or their own home row.
Do not use a “books/anime/games/other” backend enum as a new catalogue ontology.

### Mixed units and actions

Use a small number of structural presentation families: subject discovery; discussion/review with attached
subject; intentionally published Collection/update; community/editorial announcement. These are generic product
activities, not 200,000 media-kind renderers. Each unit needs an immutable source locator, canonical target,
current owner disclosure evidence, readable reason, timestamp and applicable action permissions.

One subject may have several public events. Coalesce repeated appearances in a bounded session window while
preserving a route to the original discussion/review; do not collapse distinct reviewers into an invented
consensus. Show one selected/primary community context, with a paged “other communities” route. An attached
rating names its population and question; never display twenty community scores to make a single card “complete.”

Keep actions truthful: save to library, add to Collection, follow subject/Space/Collection, resume, review and
reply are different commands. Following is attention, not library ownership or community membership. A private
library save/progress update is not automatically a public post. No automatic collection-item event is allowed
to reveal a private title, hidden relation or removal through its reason, count or ordering.

Portrait is the shared default frame for every kind, including unknown kinds. Current `coverFit` already uses
containment when an image differs sufficiently from its frame, preserving landscape art rather than cropping
it to a sliver. Keep that behaviour, a neutral intentional backdrop, explicit alt/decorative treatment and stable
reserved dimensions. Do not force source images into portrait crops or infer aspect ratio from a media label.

### Ranking inputs and controls

Start with explainable owner-supplied signals, not a custom recommendation platform: explicit follows/scope,
released semantic interests/language, recency, public curated Collection membership, admitted public rating
aggregate, and bounded diversity/repetition rules. Continue uses private progress for its owner-only task;
that is not permission to train or publish community recommendations from private activity.

Use “because you follow this Space/Collection” only after both the edge and visible reason target are current.
Subjects linked through withheld properties must not affect visible inclusion/exclusion/order/counts in ways
that disclose the property. An item's readable status and its eligibility for recommendation are separate.
Prefer public, adequately supported aggregates over raw sparse community scores; do not compare unrelated
rating questions or add all Context scores into one number. Any evidence threshold belongs to the rating owner.

Offer hard mute/block and scoped content exclusions independently of soft “less like this” feedback. Explain
delayed soft changes and allow undo/reset. Do not promise “never show” for a soft rank adjustment. Ranking
versions, feedback retention, deletion and appeals must be explicit; no new behavioural collection is implied
by this proposal. An initial version can work from explicit preferences and existing public facts.

## Upper-bound cost: what is bounded now and what must be designed

These are source-derived counts and proposed ceilings, not measured latency, memory or throughput claims.

| Quantity                          | Naive failure                                                                                                             | Current evidence / recommended bound                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 300 Spaces                        | One 20-item request each produces 6,000 candidate slots and 300 owner admissions before selection                         | One selected scope or derived attention inventory; fixed lane count, paged Space lookup, batch current access                                                                                      |
| 200,000 kinds                     | Twelve items per kind means 2.4 million slots and 200,000 list queries                                                    | Current home has four lists/48 slots, not this loop; current release permits only 1,024 types. A scalable vocabulary contract must replace whole-release hot-path work before the ceiling can grow |
| Thousands of follows              | Enumerate follows and open a source cursor for each on every request                                                      | Indexed viewer attention inventory or a fixed set of prepared projections; follow mutation/backfill runs as bounded durable work                                                                   |
| Twenty cards with 300 populations | Up to 6,000 rating lookups/blocks if every population is attached                                                         | One selected population with batch summaries and a separate paged population picker                                                                                                                |
| Million-item Collection           | Download/sort all items or repeatedly rescan rejected members to fill 20 cards                                            | Owner source cursor, indexed anchors and retained bounded preparation; explicit sparse/progress result when ready evidence is missing                                                              |
| Long scroll                       | Retain every page/card and replay all reads after a mutation                                                              | Bounded client page retention with restored scroll/focus and resumable cursor; archive/navigation route for older history                                                                          |
| Release changes                   | Normalize all K types on a cold request and retain whole releases across digests; this grows if the current cap is raised | Requested-key metadata path, versioned cache with byte/generation eviction, no vocabulary enumeration in the home hot path                                                                         |

Current composition caps are useful but insufficient physical proof: `packages/composition/src/reads.ts` sets
16 read descriptors and 128 output-cost slots; presentation also bounds document structure and dispatch
concurrency. Four lists of twelve fit comfortably, and Continue is a separate private operation. Those limits
do not bound OpenSearch examined candidates, PostgreSQL rows, hidden-item rejection, definition bytes or all
dependent owner work. Do not multiply a 128-slot budget by each node or each retry.

### The 200,000-kind requirement is not satisfied by the present registry

`packages/definitions/src/portable.ts` sets `RELEASE_LIMITS.types = 1024`, properties 4,096, Contexts 256 and
release size 4 MiB. `packages/definitions/src/index.ts` enforces these limits, and
`services/kernel/src/search/discovery-registry.ts` rejects a catalogue over the type ceiling. Its catalogue
kind registrations are released types plus the reserved account kind. Thus a 200,000-catalogue-kind scenario
is currently beyond admission, not an already-supported case hidden by a small fixture.

The useful eight-kind response limit in `discovery-request.ts` does not solve execution growth:

- `discovery-service.ts` hashes metadata/domains for every registry entry on each execution, then sorts and
  filters all entries to obtain the next kind page: O(K) serialization and O(K log K) sort work.
- `discovery-filter.ts` constructs a `terms.kind` array from every registered kind even for the mixed
  population; base-type expansion also walks the registry. At 200,000 types plus account, a straightforward
  ceiling increase would produce 200,001 terms. [OpenSearch's current terms documentation](https://docs.opensearch.org/latest/query-dsl/term/terms/)
  specifies a default maximum of 65,536 terms. This is a conditional engine-admission failure under defaults,
  not an observed request failure or a claim that deployed settings were inspected.
- `discovery-current.ts` batches native subject reads, which is good, but then iterates all registry entries
  and filters the semantic candidates for each kind. The local CPU work is O(K×B) in the worst case even though
  native hydration is shared. With K=200,000 and B=200, that loop can make about 40 million kind comparisons.

Precompute immutable registry digests and ordered metadata at publication; retrieve a bounded key range rather
than sorting K entries for each eight-choice page. Group current candidates by their actual kind and use direct
registry lookup. Registered-producer eligibility must remain authoritative: replacing a vocabulary terms array
needs a generation-bound producer/index contract, not an unrestricted match-all. Do not merely raise limits or
split one vocabulary-wide terms query into several equally unbounded hot-path queries. These are owner design
changes needed to meet the settled stress case, not a request to reopen the upper-bound requirement.

Source-dependent Zones already illustrate a shared ledger rather than unlimited per-source pages.
`services/kernel/src/zones/membership.ts` combines collection work, structural keys and ordered work: its
candidate ceiling is at most 816 with ordered sources, including a structural allowance of 256; the ledger
also limits ordered native points/rows to 6,784/14,080 and statement/engine work. Per ordered slot it uses
`min(600, 6*size+3)`, within the root allowance. `zones/README.md` bounds configuration to 32 sources and retained
work to 32 keyed slots per Zone/viewer, with a byte cap and expiring opaque continuation. This is not permission
to enumerate a million-item source or proof that a public dynamic Zone is enabled.

The current `zones/page-runtime.ts` really admits sources, creates membership and retained page work, probes
direct membership and returns genuine preparation progress. `search/scope-source.ts` also has a real native
ordered-prefix branch. Older claims that these files only declare dependencies or always throw are stale.
Conversely, their implementation branches do not erase missing readiness/default-port proof or scope grants.

### Proposed future per-request ledger

For design discussion, use P=20 returned mixed units and B=160 raw candidates **shared across the request**.
Four source lanes could initially receive forty each; unused quota may move between lanes without increasing B.
All continuation rounds, visibility rejections and duplicates consume this same quota. At most three rounds
may occur; that does not mean three independent budgets of 160. Candidate ordering is O(B log B), independent
of 300 Spaces, 200,000 kinds, or the total number of follows.

Hydrate only selected candidates plus a bounded lookahead, then recheck selected owner facts and disclosure.
At most three visible reason targets per raw candidate would permit at most 480 reason-key examinations, not
an unbounded follow scan. These numbers are a proposed starting envelope, not a proven adequate recall target
or adopted replacement for existing owner budgets. A sparse legitimate page must retain a continuation or
explicit preparation state; an arbitrary retry loop must not pretend to have exhausted the source.

The future owner's cost contract must charge every raw candidate, dedup key, reason lookup, membership/access
check, physical row, statement per database, search request, retry, response byte and retained byte. Batched reads
must obey architecture's full-key `(route,id)` reads and one statement per row kind per database, with a
repeatable-read snapshot per database; no cross-partition join is introduced. Batch size does not eliminate
database fanout. A read admitting arbitrary destination databases needs an explicit bound before this design
can claim a statement ceiling. Response P alone is never that ceiling.

Candidate stores should be derived indexes of existing owner locators and public publication facts, not a second
authority for content, ratings, follows or permissions. For followed activity, prepare a viewer attention
inventory with indexed sequence/cursor access. For broad discovery, maintain bounded public/cohort candidate
projections. Merge a fixed number of these sources, then apply current access. Use existing durable jobs for
fanout/backfill; do not build a separate all-purpose graph/ranking service for this slice.

Write amplification is a real trade-off. An event with F eligible recipients costs O(F) deliveries in total;
proposed chunks of 128 bound a job step, not total cost. Very high-fanout publishers may need a fixed overflow
read lane rather than copying every event to every viewer. That exception must still cap request lanes and
provide a watermark/lag contract. It cannot become “enumerate all high-fanout follows.” Historical availability
must be stated: a capped recent inbox is not a promise of an exhaustive lifetime Following archive.

### Lifecycle, disclosure and retention obligations

Bind cursors to viewer/scope, filters, ranking version and source generation, with opaque bounded expiring
positions. Keep a stable session order and a separate “new items” affordance rather than reshuffling cards
under the pointer. Follow/unfollow, mute/block, visibility reduction, source deletion, Realm access changes,
Collection publication/removal and subject merges must invalidate eligibility immediately at read time;
derived cleanup/backfill can progress asynchronously. Stale eligibility must fail closed without revealing why
a private object disappeared.

Do not publish private inbox membership, exact private follow counts or progress in a public cache, reason or
analytics record. Preparation endpoints and tokens must be bound to their viewer and inputs. Retained jobs
need slot/byte/TTL caps, resumable watermarks, idempotent writes, orphan cleanup and account erasure handling.
A union of Collections needs bounded dedup and permission checks across every mounted source, including shared
subjects, withheld tags and deleted source owners. Source readiness is not optional data replaced by fake zero.

## Special homes: what Spaces and Zones must supply

A vertical home should beat a strong vertical product on a named task, not by exposing more configuration.
Use Space as the stable address, Realm for community participation/publication, and Zone for a configured
editorial/read composition. Neither a Zone mount nor following a Space grants rights to the underlying sources.
The first scope permits source-free static Zone routes; the following source-dependent outcomes require their
existing grants/readiness or a later adopted slice.

| Vertical / benchmark task                                                                                                | What its home must supply                                                                                                                                                                     | Existing configuration versus missing capability / scope boundary                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Books: choose the next readable edition and return to an actual read; compare StoryGraph, Goodreads, Douban, Qidian      | Work/edition/language identity, length/mood/tag intent, edition availability provenance, active progress, trusted reviews/Collections, series order and deliberate reading queue              | Definitions and owner projections should express edition/language/length, not a books-only engine. Continue and Collections are existing primitives. Mood data, sparse useful scoped filtering, edition-aware availability and public social delivery must be proven individually |
| Anime: know what can be watched next without spoilers; compare Bangumi and the incompletely accessible anime comparators | Series/season/episode relations, airing timezone and uncertainty, region/language availability provenance, progress-aware spoiler boundary, episode discussion and seasonal curation          | Graph definitions/configuration can express structure and schedule; authoritative data, freshness/indexes and progress-relative disclosure need owner contracts. `TVSeries`/`Movie` alone is not an anime filter. Do not claim inaccessible AniList/MAL features were observed    |
| Games/visual novels: choose a compatible release and resume the intended version; compare Steam and VNDB                 | Work versus edition/release, platform/language/compatibility, public content warnings, credible reviews, curated discovery, owned-copy versus wishlist distinction, release-specific progress | Definition-driven release/platform metadata and generic copies/progress/Collections should do the work. Store synchronization, verified ownership, prices or availability are not implied by a saved copy or purchase slot; integrations remain separately scoped                 |

Across these homes, show a small coherent first screen: return task if applicable, timely/curated discovery and
a subject-linked community entry. Put deep metadata, all editions/releases, all rating populations and long
review/discussion inventories behind their proper detail route, tab or expansion. The Goodreads images support
this hierarchy; they do not justify copying its full page into a home card.

A Zone configuration needs a released presentation profile, admitted source locators, selected/default scope,
bounded module sizes, editorial provenance and a readable unavailable/preparing policy. It consumes the same
Collection/search/content/rating/progress owner ports as other surfaces. A Realm-backed Space supplies community
identity, eligible publication/discussion and moderation context; a Zone-backed Space supplies the editorial
composition. Neither should implement a second books, anime or games permission, progress or ranking engine.

To exceed vertical products, a books home can connect a novel, its adaptation, a themed public Collection and
a reader community without losing edition/progress identity. An anime home can join a season schedule to
spoiler-safe episode discussion and source works. A games home can connect compatible releases, reading/play
progress and curated community knowledge across media. These are shared graph strengths only if identity,
permissions, freshness and useful navigation survive the join. A larger wall of error sections is not breadth.

Unknown or unlicensed external availability must be labelled, not converted into a “Watch/Buy now” guarantee.
Partial/unknown dates must not become fabricated midnight release times. Unknown progress must not silently
admit spoilers. Private reading/game libraries must not determine public friend-activity cards without deliberate
publication. Editorial modules need owner, freshness and expiry; abandoned curation must not claim “trending.”

## Acceptance to adopt later, and a coherent delivery order

The research contract adds no implementation tests. The following are proposed future user outcomes, with
API and interface evidence kept separate; they are not claims that a pending campaign has passed:

1. A signed-out reader gets useful admitted public discovery with no private library requests or private fields.
   A signed-in reader can resume an actual active item; empty, preparing and unavailable are distinguishable.
2. A reader in 300 Spaces with thousands of follows can choose an omitted Space through a paged search and
   browse one coherent stream without 300 source calls, tabs or per-card population lists.
3. A newly released kind among 200,000 displays a usable name/portrait card without a vocabulary-sized hot-path
   download or a new backend kind case. A landscape cover is preserved inside that default frame.
4. With a million-item Collection and sparse matches behind rejected candidates, the reader gets useful results
   or explicit resumable preparation. Hidden tags do not leak through inclusion, exclusion, order or counts.
   Rejected work, retries and continuation rounds stay within one owner ledger.
5. After a followed source becomes private or a mute/access reduction occurs, no card, reason, count, cursor
   replay or cached response discloses it. Multiple events for a merged subject do not duplicate or lose identity.
6. New items do not steal scroll/focus; load-more works by keyboard and assistive technology. Home, Collection,
   library and Space/Zone use the same scoped header contract and preserve selected scope across navigation.
7. The same scoped data/filter scenarios work across curated Collections, Everything/state Collections and
   admitted mounted Zones, including absent/threshold properties and unlisted/private visibility. Success on
   one hand-built home fixture is insufficient. Specifically, light novels tagged harem, books over 1,000,000
   words and both together must use shared semantics; exactly 1,000,000 and missing word counts do not match
   “over.” The properties, trusted source and index must exist before a books home promises these filters.

Use API-native owner scenarios first, then recorded responses for deterministic page states, then real browser
interaction/visual evidence at the established 390 and 1280 widths. Recorded/fake data must remain labelled;
an unavailable story is valuable failure evidence but not the ready-state proof. Existing acceptance/frozen
tests must remain intact; additional adopted outcomes need additional tests and explicit contract reconciliation.

Sizes below describe review/coordination scale, not measured effort or a delivery promise: small is one owner
and roughly 1–3 focused changes; medium is several coupled changes with native outcomes; large includes durable
state/lifecycle and multiple owners. No feeds are activated by this report.

| Priority / coherent slice                                              | Size and owner                                                      | Order/dependencies                                                                                                                                                                            | Completion evidence required                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0: reconcile scope and evidence                                       | Small; scope owner + web/search/library                             | First: distinguish current catalogue home, partial native implementations and future mixed activity                                                                                           | Revisioned matrix and adopted scope/owner decision; stale labels corrected without declaring native success                                          |
| P0: repair settled shared presentation                                 | Medium; web/UI/definitions                                          | No feed dependency; tagline, all-kind portrait defaults, landscape containment, shared header/scope/panel                                                                                     | Cross-surface real interaction/visual evidence, including an unknown kind and overflow cases; keyboard focus retained                                |
| P0: make current return/discovery path truthful and bounded            | Medium; library/search/definitions + runtime composition            | Reuse current Continue adapter; default native discovery readiness and bounded metadata are separate prerequisites. Scalable vocabulary design must precede any 200,000-type ceiling increase | Useful native cases plus empty/preparing/revocation cases; cold metadata, kind-query and physical-work bounds, not just 48 outputs                   |
| P1: a complete first-scope catalogue/curation home                     | Medium; web + composition + admitted source owners                  | Uses only permitted source reads and genuinely available curated Collections; no social-feed claim                                                                                            | Signed-out/in journeys, sensible section absence, one shell, useful native data, no fake ratings or unavailable wall                                 |
| P1: adopt and implement mixed activity delivery if promoted into scope | Large; newly named feed owner + accounts/content/library/search/web | Needs publication/eligibility rules, cursor/cost/lifecycle design, source ports and scope adoption before UI                                                                                  | Bounded candidate inventory, fanout/backfill/erasure, default-runtime ready cases and private disclosure negatives at upper bounds                   |
| P2: one special home end to end                                        | Medium/large by data gaps; Realm/Zone + graph/source owners         | Start with one vertical and complete one task, then vary definitions/configuration; source-dependent Zone remains gated until ready                                                           | Book edition/read or anime next-episode or game-compatible-release task, with provenance/progress/spoiler negatives; then cross-vertical reuse proof |
| P3: richer personalization                                             | Large; only after explicit signal/value evidence                    | Initial explicit controls and public ranking must work first                                                                                                                                  | User-controlled signals, deletion/retention, interpretable reasons and measured benefit; no custom ML platform assumed                               |

### Decisions and honest remaining questions

The only immediate maintainer-level product choice identified here is scope: (A) retain the first-public
catalogue/Continue home and explicitly schedule mixed social discovery later, or (B) adopt a minimal mixed-feed
slice now, naming an owner and accepting its source/lifecycle work. Recommendation: complete the settled shared
repairs and useful native return/catalogue path first, while adopting a separately costed mixed-feed contract;
do not relabel four rows as the requested mixed home or expand a web-only brief to hide a backend project.

No further decision is requested about portrait defaults, removing taglines, upper-bound design or header search;
they are already settled. The numerical feed envelope, initial chronological Following, structural card families
and projection strategy are recommendations for owner adoption, not new authority created by this report.

Ambiguities were resolved as follows: “mixed” means native cross-object discovery/activity, not merely different
subject types in rows; “300 Spaces” is a selection/cost case, not a requirement to display all 300; rating
question Contexts and Realm populations were kept distinct; current code outranks stale audit prose; a mounted
optional API and a ready default runtime remain separate; supplied screenshots establish symptoms, not current
revision reproduction. The scope text deferring user-saved queries and newer commerce status describing adopted
private query authoring also need owner synchronization, but neither opens a public following feed.

## Handoff and evidence limits

This report completes the assigned research artifact, not the paused Goal or a product acceptance campaign.
All quantitative current claims above are declarations/static derivations; future budgets require owner physical
cost evidence. Competitor access gaps are explicit. No whole-repository test-quality conclusion, backend timing,
current live deployment verdict or exhaustive visual inventory is inferred from this sample.

Only this report is a tracked change. Outside the declared report path, the authorized authority/reference-image
copies under this worktree's `.temp/goal/...` supplied missing research inputs, and the main checkout's ignored
`.reference/INDEX.md` records the two reused clones for this topic. No product source, test, frozen file or main
checkout tracked file was changed. Original acceptance/native/browser verification remains deferred under the
execution policy; a documentation-only report requires no workspace type check.
