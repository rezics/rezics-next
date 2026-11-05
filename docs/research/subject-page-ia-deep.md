# Subject pages: reading hierarchy, ratings, and purchase entry

Research date: 2026-10-31. Inspected development revision: `6d3f767467c85dbb9d3bb561d12af784407bd92c` (`dev` and this worker's starting revision).
This is independent research, not an adopted design, implementation delivery, or acceptance result.
The current sibling subject, home, and architecture investigations were not consulted while authoring it.

The recommendation is a short, useful overview backed by complete destination views: identify the subject, decide whether it interests you, see a trustworthy rating, take a personal action, and find the relevant edition or offer.
Keep the generic profile and graph engine; change the reading hierarchy and the boundaries between independently failing sections.
Do not equate a complete data renderer, a populated fixture, or an available endpoint with a finished subject experience.

The backend is substantially further along than the criticised rating and purchase examples suggest.
Global native ratings, private own votes, bounded Realm aggregate reads, a population cursor, and a native subject-offer adapter exist.
The current public subject rating loader nevertheless supplies no Realm memberships, the renderer has no scalable population chooser, and the purchase slot example demonstrates placement rather than a buying journey.
These are different defects and require different evidence to close.

## Evidence and limits

The authority is the complete `.temp/goal/web/research-20261031.md`, including its backend addendum.
The repository inputs were `docs/development/README.md`, `docs/development/feature-design.md`, its linked Goal definitions, `docs/architecture.md`, `docs/scope.md`, `docs/subject-pages.md`, the applicable owner READMEs, `docs/research/system-inventory.md`, and the applicable web, content, commerce, semantic, and search design-status reports.
Inventory and status documents were treated as leads; the implementation findings below refer to current development source.
Historical receipts in owner documents do not establish passing evidence for this revision.

The product comparisons use primary product pages, official help/API documentation, the supplied screenshots, and three existing reference clones.
All web sources were consulted on 2026-10-31; a retrieval date does not establish a page's publication date or that every region/account sees the same interface.
Text extraction establishes exposed labels and data, not exact visual order, default visibility of hidden dialogs, keyboard behaviour, or a completed transaction.
Commercial pages remain their owners' copyrighted material; no assets or passages are proposed for copying.

Evidence classes used here:

| Class                       | What it establishes                                        | What it does not establish                                               |
| --------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| Supplied visual             | Visible hierarchy in the actual image                      | Current live behaviour, unknown original CSS viewport, backend wiring    |
| Bounded browser observation | A particular public story at a recorded viewport and phase | Native API acceptance, all routes, all devices, passing story assertions |
| Primary page/help           | A product's published content or documented behaviour      | Every interaction or a pixel-level comparison                            |
| Source inspection           | Implemented branches, limits, contracts, and test bodies   | Executed passing evidence or measured latency                            |
| Recorded/fake story         | A state can be illustrated under that story's providers    | Current native persistence, access enforcement, or lifecycle completion  |

No stacks, installations, builds, backend measurements, acceptance campaigns, or tests were run for this report.
The permitted public observation was bounded to the subject topic; the existing completeness audit's valid rating captures were reused.
No existing publisher or capture was changed.

### Images actually inspected

All paths below are ignored research artifacts, not proposed Git additions.

| Image                                                                 | Actual raster size | Observation and limitation                                                                                                                          |
| --------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.temp/goal/web/refs/maintainer-20261031/goodreads-subject-top.webp`  | 2000 × 1383        | Expanded book details, including the explicit “Fewer details” control; this is not the collapsed default.                                           |
| `.temp/goal/web/refs/maintainer-20261031/goodreads-subject-full.webp` | 662 × 2000         | Compressed whole-page reference showing the larger hierarchy and folded summary/details; raster width is not evidence of a 662 CSS-pixel viewport.  |
| `.temp/goal/web/refs/maintainer-20261031/reddit-search-panel.png`     | 596 × 983          | Search field and bounded suggestions form one interaction region.                                                                                   |
| `.temp/goal/web/refs/maintainer-20261031/rezics-filter-panel-bug.png` | 678 × 615          | A narrow containing panel allows much wider filter content to overflow; this is a shared containment defect, not a reason to redesign subject tabs. |
| `.temp/goal/supermanager/refs/mobile-home-reference.jpg`              | 922 × 2048         | Phone shell and search reference.                                                                                                                   |
| `.temp/goal/supermanager/refs/mobile-search-open-reference.jpg`       | 922 × 2048         | Full-screen search, back navigation, history, and suggestions; not a small desktop popover on a phone.                                              |

The cover, search, and tagline choices are settled instructions, not questions reopened here.
Every kind gets a portrait default slot; landscape art stays intact within that slot.
The shell must retain one centred search field, a scope chip and Filters at its right end, and the full-screen phone search interaction.

### Current public subject, rating, and purchase observations

Own observations used Chrome `156.0.8078.47`, English, light theme, at 1280 × 900 and 390 × 844 CSS pixels.
These are width observations, not touch-device emulation.
Artifacts are under `.temp/goal/web/research-shots/subject-page-ia-deep/`; `browser.json` and each capture's JSON record the URL, timestamp, DOM text, viewport, and Storybook phase.
The reused audit's `reused-audit/build.json` identifies publisher commit `b29a80a0aad38c008125fb032f5fe1af96bd6164`, Storybook `11.0.0-alpha.8`, built at 08:32:54 UTC.
That is not the inspected development revision; a fresh publisher-version request was inaccessible, so the later own captures are not asserted to be the same build.

| Story / artifact stem                                                    | Evidence                                                          | Finding                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages-subjects-subject--signed-out--390`                                | Own capture, 14:26:19 UTC; `afterEach`, three stable observations | Settled subject story: identity and four view links, then About, three separate unavailable relation/credit sections, ratings, reviews, discussion, and explanation links. The repeated generic failure wall is visible here.                                          |
| `pages-subjects-subject--signed-out--1280`                               | Own capture; still `playing`, skeleton visible                    | Excluded from finished-layout conclusions. A screenshot taken before the story settles is not a desktop completeness result.                                                                                                                                           |
| `reused-audit/patterns-subjects-subject-rating--ready--1280` and `--390` | Reused audit captures, 14:13:41/43 UTC; three stable frames       | The ready example shows 8.4 out of 10, Global, 1,203 ratings, a 21-value numerical distribution, implementation explanations, a Reviews link, and an illustrative Kokoro result. The story's play function opens the distribution: expansion is not its default state. |
| `patterns-subjects-purchase-entry-slot--empty--1280` and `--390`         | Own captures, still `preparing`, blank/spinner                    | No settled purchase-page conclusion. The earlier audit's blank purchase captures also had no stable result. They cannot prove either a working empty state or the maintainer's historical error wall.                                                                  |

The 390 subject observation records a 402-pixel document scroll width; this is a narrow overflow symptom requiring isolation, not a measured WCAG conformance verdict.
The fixed bottom navigation appears at the original viewport's lower edge in a full-page screenshot; its position within that raster is not itself a navigation defect.
The signed-out subject story is backed by recorded/fake story infrastructure, not evidence of a live native subject request.
The valid mobile observation corroborates the failure-wall class; the purchase slot's source explains why its narrow assertions would not detect that class.

## What both Goodreads images actually teach

The two images are complementary states of the same reading strategy, not two different proposals for putting everything above the fold.
The top image expands bibliography and editions; the full-page image shows why those controls exist.
The current [Goodreads book page](https://www.goodreads.com/book/show/223902996-glorious-exploits) and [editions destination](https://www.goodreads.com/work/editions/148386875-glorious-exploits) provide independent current primary references, but scores and offer prices are time-dependent.

| Reading job                  | Collapsed whole-page reference                                                                | Expanded top reference                                                    | REZICS implication                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Recognise the work           | Portrait cover, title, creator, headline rating/count                                         | Same identity remains visible                                             | Stable identity before editorial machinery.                                                   |
| Act personally               | Want to Read, own stars, purchase access beside cover                                         | Same controls                                                             | A rating is both information and an action; distinguish personal state from public aggregate. |
| Understand the premise       | Synopsis excerpt with Show more                                                               | Longer synopsis                                                           | Fold prose without requiring a different page merely to finish reading.                       |
| Explore classification       | Compact genre chips and more                                                                  | Expanded genre area remains bounded                                       | Progressive disclosure, not every tag or statement inline.                                    |
| Verify this manifestation    | Book details and editions disclosure                                                          | Pages/format/date, awards, original title, setting, identifiers, language | Summary facts and full bibliography have different prominence.                                |
| Choose another manifestation | Entry to details/editions                                                                     | Small cover rail and Show all 33 editions                                 | A preview is not the complete editions catalogue.                                             |
| Evaluate reception           | Author/recommendations, then Ratings & Reviews; friends/following and community subsections   | Not all visible in the cropped top image                                  | The main page can introduce reception without rendering every review.                         |
| Read deeply                  | Histogram, review search/filter, finite review excerpts, more reviews, discussion/lists later | Outside the top crop                                                      | Destination views and local folds serve different depths.                                     |

The full image has a long page, but it is not a dump of all available records.
Its useful lessons are adjacency of identity and action, separate work/edition meaning, repeated finite previews, and explicit expansion controls.
Its exact sidebar width, retailer, five-star convention, and social ranking are not requirements for REZICS.
Empty friends/following content is a small local invitation, not an error replacing the rest of the page.
The reference also does not justify a recommender dependency: feeds are deferred in `docs/scope.md`.

## Twenty-product comparison

This survey counts twenty products, with BookWyrm as an additional source-level comparison.
It does not count an inaccessible page as an inspected interface.
“Not verified” below is an evidence limitation, not a claim that the feature is absent.
Primary-source excerpts were read in their original language; no translation service or conversion script was used.

| Product and primary evidence                                                                                                                                                                                                                                 | Main page, deeper views, and useful action                                                                                                                                               | Transferable lesson / limitation                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Goodreads** — supplied images; [book](https://www.goodreads.com/book/show/223902996-glorious-exploits), [editions](https://www.goodreads.com/work/editions/148386875-glorious-exploits)                                                                 | Identity/actions, folded synopsis and bibliography, edition preview, reception later. Editions have format/language/sort and finite pages.                                               | Separate work, selected edition, personal rating, and retailer offer. Do not read the expanded screenshot as the default.                                                                                                        |
| **2. StoryGraph** — [official product feature page](https://www.thestorygraph.com/?lang=en)                                                                                                                                                                  | Documents mood/pace, content warnings, half/quarter-star ratings, owned/DNF tracking, and private journal/custom organisation.                                                           | Reading suitability and personal state are distinct from average score. A current individual book page's tab/fold arrangement was not verified.                                                                                  |
| **3. Douban Books** — [an electronic edition of The Three-Body Problem](https://book.douban.com/subject/35092665/)                                                                                                                                           | Bibliographic identity, rating histogram, own actions and purchase access; synopsis/creator information, series/recommendations, short comments and long reviews with excerpts.          | High information density still separates summary from long reviews and other editions. A listed purchase reference does not prove current stock or licence.                                                                      |
| **4. Bangumi** — [Cowboy Bebop](https://bangumi.tv/subject/253), [reviews](https://bangumi.tv/subject/253/reviews)                                                                                                                                           | Score/rank and tags, synopsis, cast/staff, episode-related material and community destinations.                                                                                          | Useful vertical emphasis can come from profile ordering and graph relations. The server's compact DTO is independent evidence of bounded summary projection, not proof of every client fold.                                     |
| **5. AniList** — [Cowboy Bebop](https://anilist.co/anime/1/Cowboy-Bebop)                                                                                                                                                                                     | Official indexed page exposes format, episodes/status, season, aggregate measures, relations, character/staff previews, tags, distributions and reviews.                                 | Separate statistical meanings and preview relation groups. Indexed text was available while a direct variant returned 403; pixel order and default expansion were not verified.                                                  |
| **6. MyAnimeList** — [title](https://myanimelist.net/anime/1/Cowboy_Bebop), [statistics](https://myanimelist.net/anime/1/Cowboy_Bebop/stats), [official API reference](https://myanimelist.net/apiconfig/references/api/v2)                                  | Access was unavailable in this attempt.                                                                                                                                                  | Included explicitly as requested, but no invented current layout, rating formula, or mobile behaviour. It contributes no vote to the shared-pattern conclusions.                                                                 |
| **7. VNDB** — [title](https://vndb.org/v17), [official Kana API](https://api.vndb.org/kana)                                                                                                                                                                  | Title access was robots-blocked. The API documents VN identity and release relations, rating/vote fields, languages and platforms.                                                       | Work versus release and score-scale labels matter. An API schema cannot establish the title page's tabs or folds; its rating scale must not be silently relabelled REZICS 0–10.                                                  |
| **8. IMDb** — [official ratings FAQ](https://help.imdb.com/article/imdb/track-movies-tv/faq-for-imdb-ratings/G67Y87TFYYP6TWAV)                                                                                                                               | Documents one replaceable 1–10 vote, weighted headline rating and breakdown, with delayed updates; critic information has a separate meaning.                                            | Explain personal save versus public publication. The title page was blocked, so no exact current fold or where-to-watch placement claim.                                                                                         |
| **9. Letterboxd** — [The Matrix](https://letterboxd.com/film/the-matrix/)                                                                                                                                                                                    | Identity/synopsis, cast/crew/details/genres/releases, cast expansion, trailer and Where to Watch; reception and personal logging are distinct.                                           | One compact action surface can open richer details. Page text also describes rating/review audience choices whose privacy does not automatically hide diary/watch activity; hidden form text is not proof of default visibility. |
| **10. Trakt** — [official summer 2026 product update](https://forums.trakt.tv/t/trakt-product-update-summer-2026-edition/123790)                                                                                                                             | Describes expanded Where to Watch, external rating breakdowns, and richer reviewer statistics with product-tier limits.                                                                  | Availability and imported scores are separate products with provenance. Direct title access failed; do not carry an old rating-scale or page-layout assumption forward.                                                          |
| **11. Steam** — [Portal 2](https://store.steampowered.com/app/620/Portal_2/)                                                                                                                                                                                 | Title/media, creator/date, recent versus broader review cohorts, tags and language disclosure; base game, extra product and bundle purchase choices; About and requirements deeper down. | Purchase options need version/contents clarity, not just a Buy label. Cohort and timeframe belong next to a score. Regional price and eligibility were not transaction-tested.                                                   |
| **12. Discogs** — [Collection guide, updated 2026-06-03](https://support.discogs.com/hc/en-us/articles/360007331534-How-Does-The-Collection-Feature-Work), [database glossary](https://support.discogs.com/hc/en-us/articles/360004017694-Database-Glossary) | Official help distinguishes a particular release/pressing from its master grouping and asks users to choose the correct release before adding it.                                        | Edition identity changes what ownership means. A master-page request was blocked; this is documented behaviour, not a visual marketplace audit.                                                                                  |
| **13. Spotify** — [official credits help](https://support.spotify.com/na-en/article/ai-credits/), [staff explanation of credits entry](https://community.spotify.com/forum/en/discussion/5634257/add-producer-songwriter-and-musicians-to-songs)             | Credits are a secondary action from track menus/Now Playing; the newer AI-credit documentation describes an optional, mobile beta disclosure.                                            | Put detailed credits behind a clear entry; missing optional data is not affirmative evidence of absence. The album page was a JavaScript shell here; no album rating-system claim follows.                                       |
| **14. Apple Books** — [Pride and Prejudice](https://books.apple.com/us/book/pride-and-prejudice/id395534643)                                                                                                                                                 | Title/author/cover and rating/count, audiobook alternative, publisher description, compact publication/file facts, review previews and more books.                                       | Format choice and factual details can remain discoverable without dominating reception. The extracted page did not establish an actual Get/price/app-handoff transaction.                                                        |
| **15. Qidian** — [official book-list entry](https://book.qidian.com/booklist/detail/652808/), [requested title](https://book.qidian.com/info/1010868264/)                                                                                                    | The indexed official list entry exposes author, genre, completion state, synopsis/latest chapter, bookshelf and trial-reading actions. Desktop/mobile title requests were unavailable.   | Serial status and read/continue actions deserve a profile, not a universal bookstore layout. Paid-chapter checkout, current title tabs and exact folds were not verified.                                                        |
| **16. Bilibili** — [official series page](https://www.bilibili.com/bangumi/media/md28223055/)                                                                                                                                                                | Series identity, completion/episode count, following/rating, premium viewing language, and Work Details/Long Reviews/Short Reviews destinations.                                         | Consumption, following and reviewing have separate states. No player entitlement or paid licence was exercised.                                                                                                                  |
| **17. Open Library** — [pinned edition view source](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/type/edition/view.html)                                                               | Template composes work rating, selected edition and lending/buying access, read-more description, key facts, editions table and later detailed bibliography.                             | Model work/edition explicitly and preserve a short reading path. Source inspection is not live viewport or lending-availability evidence.                                                                                        |
| **18. Amazon Books** — [Pride and Prejudice product page](https://www.amazon.com/dp/0141439513)                                                                                                                                                              | Official HTML contains format choices, a description expander, compact edition facts with a full-details entry, purchase-related controls, and later product details/customer reviews.   | Summary facts and full product detail are different layers. Text includes hidden/popover content; no exact first-fold or price promise is made.                                                                                  |
| **19. Netflix** — [Dark](https://www.netflix.com/title/80100172)                                                                                                                                                                                             | Public identity, synopsis/creators, trailer, season/episode selection, More Details and related titles, with a membership CTA.                                                           | The appropriate primary action depends on capability and session. No numeric public average was observed; this does not establish an absence of internal ratings.                                                                |
| **20. YouTube** — [official description guidance](https://support.google.com/youtube/answer/12948449?hl=en)                                                                                                                                                  | Documentation explicitly separates first visible description lines from Show More on desktop and more on mobile; descriptions support chapters, links and credits.                       | A fold has a clear content boundary and an accessible expansion action. Direct watch-page layout was not verified in this attempt.                                                                                               |

Across the accessible references, five patterns recur: short identity plus action, a readable summary with expansion, small relation/edition previews, deeper destinations, and scores labelled by their actual meaning.
Commercial interfaces disagree on density and social emphasis; media services prioritise play/continue, catalogues often prioritise tracking, and shops prioritise the selected purchasable manifestation.
They do not establish one universal section order or one universal rating scale.
The recommendation therefore transfers these interaction patterns into REZICS profiles and owner APIs, not product-specific page code or retail vocabulary.

### Source-level cross-checks and licences

Reference repositories were reused under `/home/edge/projects/rezics/rezics-next/.reference/`, read as untrusted data, and never installed, built, or run.
The topic's three lines were added to that directory's ignored `INDEX.md`, as required by the research contract.
No source file or long source passage is proposed for copying.

| Reference, revision, licence                                                                             | Exact inspected files                                                                                                    | Relevant pattern and limit                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open Library; `37e446827465be2febad416de1bc18753b66997d`; AGPL-3.0, `LICENSE`                            | `partitioned-sitemap-feeds/openlibrary/openlibrary/templates/type/edition/view.html`                                     | Work/selected-edition context, lending actions, separate mobile/desktop navigation, read-more description, edition table, details and contents expansion. Template composition does not prove request cost is bounded. |
| Bangumi server; `1997713eafc51487cbea705b37011442f35539fa`; AGPL-3.0-only, source SPDX and `LICENSE.txt` | `shelves/bangumi-server/web/res/subject.go`; `openapi/components/user_subject_collection.yaml`                           | Full versus slim subject projection; slim summary truncation and first ten tags; collection privacy is explicit data. DTO fields alone do not prove privacy enforcement or a particular web layout.                    |
| BookWyrm; `fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4`; Anti-Capitalist Software License 1.4, `LICENSE.md` | `shelves/bookwyrm/bookwyrm/templates/book/book.html`; `templates/book/sections/description.html`; `views/books/books.py` | Cover/shelving, shortened description, editions entry, review pagination, and viewer-aware review/list selection. Restricted-source licence, not OSI open source; use as design evidence only.                         |

Pinned public sources: [Bangumi response](https://github.com/bangumi/server/blob/1997713eafc51487cbea705b37011442f35539fa/web/res/subject.go), [Bangumi collection schema](https://github.com/bangumi/server/blob/1997713eafc51487cbea705b37011442f35539fa/openapi/components/user_subject_collection.yaml), [BookWyrm template](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/templates/book/book.html), [BookWyrm view](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/bookwyrm/views/books/books.py), [BookWyrm licence](https://github.com/bookwyrm-social/bookwyrm/blob/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4/LICENSE.md).

## Legacy comparison without importing its architecture

Old REZICS was read at `/home/edge/projects/rezics/rezics`, revision `95167ceab7173dc1c5fb0ee70568c5c95f1dba8d`.
Old rezics-next was read with `git show legacy-final:<path>`, tag revision `1ac6ed6e0668f04e30025c41e59ceaf3bdee5061`.
Both repositories identify AGPL-3.0 licensing; these are behavioural references only.

| Actual source                                                                                                  | Useful behaviour                                                                                                     | Failure at the required bounds                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old REZICS `apps/web/features/units/unit-detail.tsx`                                                           | Identity/cover/action grouping, overview/reference entry, version access                                             | Hardcoded video/audio paths and an inline versions map do not generalise to 200,000 kinds or many manifestations; long summary remains long. Its `contentRating` is suitability classification, not an opinion aggregate. |
| Old REZICS `apps/web/features/entities/pages/entity-detail-page.tsx`, `components/entity-resource-details.tsx` | Shared resource page plus profile, tags, sources and related material                                                | A useful common frame, but not evidence of a complete subject rating/purchase model.                                                                                                                                      |
| Old REZICS `apps/web/features/catalog/catalog-resource-page.tsx`                                               | Names and identifiers page in batches of 50; explicit editorial/history destinations and private favourite hydration | Hardcoded resource-owner families grow with product verticals; extensive editorial metadata has excessive reading prominence. Paging bounds rows, not total subject-page density.                                         |
| `legacy-final:apps/web/features/work-page/ratings.tsx`                                                         | Visual distribution, count/mean, separate own-rating control                                                         | `contexts.map(...)` creates one question-context chip per supplied context. Twenty or hundreds remain a layout problem even though each individual aggregate is small.                                                    |
| `legacy-final:apps/web/features/work-page/scope-bar.tsx`                                                       | Global/Mine controls, up to four ranked Realm chips plus the selected Realm, async picker                            | This tagged version already bounds visible Realm chips. It is inaccurate to say this file renders all 300 Realms. The question-context mapping is a separate problem.                                                     |
| `legacy-final:apps/web/features/work-page/read.ts`                                                             | Population discovery and selected-scope rating read                                                                  | A first page of 20 populations cannot establish a globally ranked top set across 300. A bounded chooser still needs correct continuation and labels.                                                                      |
| `legacy-final:apps/web/features/work-page/expandable.tsx`                                                      | Resize-aware Show more/less with `aria-expanded` and controlled region                                               | The fold changes layout, not the cost of fetching or constructing the full body already in the DOM.                                                                                                                       |
| `legacy-final:apps/web/features/work-page/work-tabs.tsx`, `hub-sections.tsx`                                   | Scope-preserving navigation, small discussion preview, About/facts separation                                        | A desktop navigation file does not establish mobile completeness; collapsed facts can still have eager backend work.                                                                                                      |

The earlier design contains useful interaction ideas, especially the bounded Realm chooser and expansion control.
Neither its hardcoded page families nor its context-chip map should become the new architecture.
No legacy implementation was copied, and no claim is made that its existing behaviour passes current disclosure or scale contracts.

## Recommended reading architecture

Use one generic page engine with a finite reading hierarchy and profile-selected relation groups.
Kinds select a presentation profile; they do not each add a tab, block, API, or hardcoded component family.
The current finite view vocabulary can remain a ceiling, not a demand to display fourteen tabs on every subject.
The architecture should also survive a person belonging to 300 Spaces, following thousands of people, or owning a million Collection items without adding corresponding page sections.

### Overview versus destination views

The proposed counts below are recommendations for adoption, not claims about current contracts or measured optimal values.
Existing `docs/subject-pages.md` generally caps list previews at twelve; tighter overview counts can be chosen within that cap.
Every preview must have a complete destination or clearly explain why one is not applicable.

| Order | Overview content                                                                                                                                                   | Fold / destination                                                                   | Proposed visible budget                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | Portrait cover; preferred/original title; type; primary creators and release/status fact; useful public rating summary; one primary personal or consumption action | Secondary actions menu; optional offer chooser                                       | No repeated title/summary; wrap long names; omit truly unavailable optional facts. Avoid claiming the whole hero fits every phone viewport.                                          |
| 2     | About: synopsis and a few decision-relevant facts, genres/tags, necessary warnings                                                                                 | Show more for prose; Details for full sourced statements, identifiers and provenance | About five text lines or two short paragraphs initially; four to six key facts; three tag chips plus more. Keep warnings and rights notices available without misleading truncation. |
| 3     | Relevant parts/editions or serial continuation, then a few related subjects                                                                                        | Contents, Editions or Relations view, preserving current subject/Realm               | Six cards where useful, never more than the existing twelve-item preview cap. No fetching all editions to find six.                                                                  |
| 4     | Character/creator/credit previews selected by the profile                                                                                                          | Characters, Credits, Works or Appearances view                                       | Roughly four to six meaningful items per chosen group; avoid empty scaffolding for every possible relation.                                                                          |
| 5     | Reception: public score/count/population, own rating or sign-in, compact distribution entry                                                                        | Expand statistics; Reviews destination; population chooser                           | One selected population, one rating control, one summary. No Realm-by-Realm block series.                                                                                            |
| 6     | Short review/discussion previews with clear author and destination                                                                                                 | Reviews / Discussion, filtered and paged                                             | Two or three useful excerpts each as a starting design; do not stack duplicate “See all” and “More posts” actions for the same destination.                                          |
| 7     | Relevant lists and a concise source/cover credit                                                                                                                   | Lists / Collections, Details and source explanation                                  | Up to three list previews; retain required attribution in context, put the full bibliography in Details.                                                                             |

The hero's rating summary can link to the reception section without duplicating the whole distribution and vote form.
For a person, the profile emphasises works/credits; for a serial, parts and continue-reading matter; for an edition, its parent work and specific manifestation matter.
These are configuration differences within the engine, not a branch for every kind.
The same title/cover/score conventions must appear on search results, Collection items, relation cards and the subject page.

Destination views own complete lists, filtering, ordering, continuation and precise empty states.
Details owns the exhaustive fact/source presentation; hiding the entire current overview behind another tab would not fix a weak reading overview.
Show more owns the rest of the same passage; a view owns a different collection or task.
An edition preview owns discovery of alternative manifestations; an offer chooser owns current purchasable terms, which are not the same thing.

### Tabs, navigation, and the phone

`apps/web/src/features/pages/views.ts` and `view-tabs.tsx` already provide a fixed view order, hidden/closed view handling, horizontal navigation, active-item scrolling, and Realm-preserving links.
The current view set includes Overview, Editions, Contents, Characters, Appearances, Credits, Works, Relations, Posts, Reviews, Discussion, Lists, Collections and Details.
Only applicable destinations should appear; an omitted preview-driven tab must not invalidate its supported direct URL.
Do not manufacture a tab per property, Realm, question, kind, or publisher.

Prefer real route links with a current-page indication for route navigation.
If a surface instead implements in-page ARIA tabs, it needs the matching tab/panel relationships and keyboard model; visual tab styling alone does not establish that behaviour.
Automatic activation is appropriate only when the corresponding panel can be displayed without noticeable latency; a network-heavy destination should not fetch on every arrow-key movement. [WAI tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)

On phones, the overview becomes one reading column; small relation rails may scroll locally, while individual cards remain readable within the viewport.
Long tabs must remain discoverable, with the active view visible, without making the document itself wider.
The tab strip, compact header and bottom navigation must not obscure anchor targets, rating controls, retry links or focus.
The subject page uses the shared settled search interaction; it does not introduce a second local filter panel in the hero.

Use a semantic button or native disclosure for expansion, expose expanded state, and preserve a visible Show less action after expansion.
Enter and Space operate disclosure buttons. [WAI disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)
For a phone population/offer picker implemented as a modal, move focus into it, contain focus, support Escape, and return focus to the opener. [WAI modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
Aim for comfortably large primary controls; WCAG 2.2's AA target-size criterion is 24 × 24 CSS pixels with defined exceptions, not a universal 44-pixel requirement. [WAI target-size explanation](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
Check eventual delivery at 320 CSS pixels and zoom/reflow, not only the two story widths. [WAI reflow explanation](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)

## Unavailable sections without an error wall

The current renderer correctly avoids inventing relation data when a read fails.
Its failure composition is still a product defect: three identical local failures can displace the subject's useful content, as the settled phone observation shows.
“Hide every error” would be an equally poor correction because it would turn unknown into empty.

Introduce typed section results and a page-level presentation policy, preserving each owner's actual state.
The table is a proposed presentation contract; it must not be implemented by guessing from absent fields.

| Actual state                              | Overview treatment                                                                | Destination / action treatment                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Not applicable / closed                   | Omit section and navigation entry according to profile contract                   | Use the established closed-view routing; do not invent an error or empty collection.           |
| Successful empty                          | Omit an optional relation preview, or show a small useful contribution invitation | Explicit empty state and relevant action; Reviews/Discussion may invite participation.         |
| Below rating disclosure threshold         | “Not enough ratings” with the correct population and allowed count semantics      | No mean or histogram; never equate withheld with zero.                                         |
| Preparing, no positive data yet           | Small local preparation status                                                    | Retry/refresh only as supported; no fixed promise about completion time.                       |
| Preparing with positive offers            | Keep confirmed readable offers, plus preparation status                           | Continue/restart through the native cursor protocol.                                           |
| One optional read unavailable             | Compact unavailable row or a single shared optional-data notice                   | Targeted retry which preserves subject, view, locale and Realm; keep usable siblings.          |
| Several reads fail through one dependency | One grouped notice and per-destination recovery, not repeated large placeholders  | Explain which content remains unavailable without exposing backend internals.                  |
| Current access denied / subject withdrawn | Follow disclosure-safe absence/denial contract                                    | Do not reuse a previously readable cached representation.                                      |
| Core identity unavailable                 | One coherent page-level failure                                                   | A subject page without a trustworthy subject identity must not be padded with fixture content. |

The renderer needs a distinction between successful empty, temporarily unavailable, deliberately withheld and not applicable before it can make this policy reliable.
Deduplicate a shared dependency failure at the page boundary; retain retryable section state behind that summary.
Keep the unavailable notice small enough that successful About, reviews and discussion remain useful.
Do not retry all dependent reads automatically on focus, or generate an unbounded retry loop when the owner remains unavailable.

Exact source: `apps/web/src/features/pages/overview.tsx`, `Failed`, emits the same heading/message/retry block per failed node.
`data.tsx` joins the current plan's read identifiers against returned reads; missing/non-200 nodes become unavailable.
The purchase-slot story casts an older recorded page shape into the current type and renders the whole overview under a narrow pattern harness.
That creates a compatibility risk independent of whether commerce itself is empty; this report does not assert an unexecuted read-plan mismatch as the proven cause of the maintainer's historical screenshot.

## Ratings: meaning, scale, readiness, and cost

### Three axes that must not become one “Context” list

1. **Question:** what is being asked, including its scale and revision. A custom question is not another population of the standard question.
2. **Population:** whose eligible votes are aggregated: Global or a particular Realm. Realm membership does not create a separate own vote.
3. **Semantic Context:** which graph facts/profile interpretation the subject page is reading. Selecting it does not authorise relabelling Global figures as Realm figures.

The existing core vote identity is person + question + target.
The standard question stores integer units 0 through 20 and displays 0 through 10 in half-point increments.
Zero is a valid vote, clear removes the vote, and a missing vote is neither zero nor an error.
Custom scales need their own labels/conversion rather than a hardcoded star transform.
Source: `services/kernel/src/rating/README.md`, `votes.ts`, `schemas.ts`; web conversion and controls in `subject-ratings.ts`, `rating-control.tsx` and `rating-actions.ts`.

The public figure is the standard-question **Global mean**, labelled with scale and eligible count.
The Bayesian value used for order is not the displayed mean; imported external scores keep their own source, scale, date, licence and attribution.
Do not average VNDB, IMDb and REZICS numbers into a single unlabeled score.
The existing figure/source boundaries already support this separation; presentation should make it understandable without two permanent paragraphs about internal processing.
The currently supported imported provider is specifically `vndb`, not a general aggregation of all surveyed products.
`source-statistics.ts` validates that provider, and `source-statistic-upsert.sql` keeps one row per subject/source; aliases identify its source-fence tuple, not additional independent rating providers.
Within that supported write contract, the current list is at most one imported statistic per subject; adding providers would need a new explicit display and read bound.

### What is actually implemented

`services/kernel/src/rating/aggregate-read.ts` suppresses mean and histogram below the applicable threshold: five for work/release cases and ten for episode/character cases described by the owner contract.
It exposes freshness (`asOf`, `updating`) for aggregate reads; the prior has its own minimum-population rule of fifty.
These are disclosure/publication rules, not front-end estimates of statistical confidence.
The public figure endpoint exposes its own ready/insufficient/updating representation; it does not expose the aggregate's complete freshness object.
The aggregate implementation recognises exactly four question grains (`work`, `release`, `episode`, `character`) and rejects an unknown grain.
An extensible kind catalogue therefore does not imply arbitrary new rating-grain behaviour; any extension belongs to the question/rating owner rather than a new per-kind web branch.

`services/kernel/src/rating/routes.ts` exposes:

| Operation                 | Implemented boundary                                                                                              | Important limitation                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Public standard `/figure` | Global standard question only; readable-subject check, public revalidation/ETag behaviour                         | Not a Realm public figure or a promise of synchronous vote publication.                                                   |
| Aggregate `/ratings`      | One population or an array of at most 20; current Realm readability checks; suppressed statistics below threshold | Not an endpoint for all 300 populations, and not the public searchable figure contract.                                   |
| `/ratings/populations`    | Cursor page of 20 raw positive population candidates, readable Realm filtering, raw-key continuation              | May return fewer or no visible rows while still having `next`; no name search, Realm labels, or global top-score ranking. |
| Own vote GET/PUT/DELETE   | Authenticated, private own state, personal-library gate, idempotent mutation handling                             | Must not enter public SSR, a shared cache or an imported-score field.                                                     |

An unreadable requested Realm aggregate returns a neutral non-disclosing shape, rather than a protected histogram.
The population cursor binds the subject/question operation but is not itself viewer authorisation; current readability still matters on every page.
A cursor not bound to a viewer is therefore not, on its own, evidence of an access bypass.
Empty visible pages, raw continuation and timing can still create privacy questions about hidden population existence; that needs an explicit owner disclosure review, not an assertion that the route is already safe in every side channel.

The aggregate route performs checks before the reads; this inspection did not find a final revalidation equivalent to the commerce adapter's final disclosure/identity checks.
That is a static currentness-review gap, not a demonstrated race exploit.
Any correction belongs at the rating/Access owner seam and needs lifecycle evidence, not a UI-only promise.

### What the current web route does instead

`apps/web/src/features/pages/subject-ratings.ts` performs four public requests in parallel: question, public Global figure, selected aggregate set, and imported source statistics.
Its optional own-state path is separate; the actual public server loader in `subject-queries.ts` calls `readRatings(client, id, null)` with **no memberships**.
Consequently, real route code does not supply the three illustrative Realm rows present in `kernel/fake/ratings.ts`.
Even a future caller passing memberships would hit `memberships.slice(0, 3)`, an arbitrary omission rather than a 300-Realm interaction.

The web `Figure` type omits aggregate freshness and the view does not consume it; the assigned wire objects can still retain that field at runtime.
A required read failure collapses the whole rating result to `null`.
An imported-statistics failure can therefore remove a usable native public figure.
`subject-ratings-view.tsx` renders that as the generic failure block, uses `href="?"` for retry, and constructs a Reviews URL without preserving the selected Realm.
`overview.tsx` explicitly renders a rating failure when a Realm is selected; importantly, it does not silently relabel Global as Realm.
This is honest incompleteness, not delivered Realm ratings.

The ready story bypasses route loading with `ratingsFixtures` and `RatingsView`.
Its save/clear examples update local state; its play checks for two 8.4 labels and opens a disclosure.
The visible 21-bin grid is numerically readable but weak as a distribution: a user must parse 21 values to see its shape.
The example supplies neither an integrated selection journey nor evidence of native persistence/publication.

### A bounded population interaction

Keep Global as the initial public figure.
One labelled population control opens a searchable/paged chooser; the selected Realm replaces the aggregate in one stable reception panel.
At most a few pinned/recent choices can be conveniences, not a claim to enumerate membership.
Show the subject, question and population together in expanded statistics, with own vote distinguished from the displayed population result.
Use a small histogram with an accessible numerical alternative and textual count/threshold; do not encode vote meaning by colour alone.

Do not eagerly page through every population to populate a picker.
Use the existing twenty-candidate cursor for subject populations, with explicit Load more and sparse-page handling; make selected-aggregate reads on demand.
A Realm label/selection adapter still needs a bounded owner-supported resolution path: the current population API returns IDs/counts, not a searchable directory of Realm names.
Generic Realm discovery is not proof of a subject-specific rated-population search or globally ranked “top Realms.”
If a product slice needs that exact search, specify the bounded API gap before exposing a search field that cannot honour it.

| Case                  | Naive render                                         | Recommended visible/request shape                                          | Existing backend boundary                                                                                              |
| --------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 20 populations        | 20 panels × 21 bins = 420 values, plus controls      | One selected panel; one cursor page only when opened                       | Up to 20 requested aggregates, but no reason to request all for initial reading.                                       |
| 300 populations       | 6,300 bin values; 15 aggregate batches if all loaded | Same one panel; incremental 20-candidate pages, selected read on demand    | Raw pages can be sparse after disclosure filtering; do not automatically drain all fifteen pages.                      |
| 1,000 populations     | 21,000 values; 50 full batches                       | Same bounded working set, explicit continuation                            | No implemented all-populations name search or top-score materialisation is established.                                |
| Many custom questions | A question chip/panel for every Context              | One selected question, if that journey is adopted; otherwise standard only | Question reads exist; current public subject UI fixes the standard question and public figure remains Global standard. |

There is a separate upper-bound semantic limit: `services/kernel/src/rating/voter-realms.ts` sets `VOTER_REALM_CAP = 100`.
It counts the first hundred joined eligible Realm memberships and promotes an older waiting membership after a counted one is removed.
A person in 300 Realms therefore does not contribute their vote to all 300 under the current implementation.
This does **not** limit a subject to a hundred population aggregates: other voters can contribute to other Realms.
The UI must not imply that membership or selecting a Realm guarantees that this person's vote currently contributes there.
The kernel cap and promotion lifecycle are implemented; an explanatory/inspectable own-contribution surface was not established.

### Desk cost analysis, not runtime measurements

The source supports logical bounds, not a latency, row-visit, memory, network-byte or p95 claim.
Do not call a single HTTP route a single cheap database operation.

| Path                   | Source-supported bound                                                                                                                             | Remaining qualification                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| One aggregate          | Up to 16 aggregate components/shards in `aggregate-read.sql`, plus freshness handling                                                              | Question/readability and routing work are additional. No measured database plan is asserted.                                           |
| Aggregate array        | Maximum 20 populations; at most 320 aggregate shard positions before auxiliary work                                                                | Up to twenty Realm checks and concurrent reads still have cost. Prefer one selected population.                                        |
| Population page        | `aggregate-populations-page.sql` key-seeks positive candidates, `limit + 1` = 21 candidate probes; count projection for at most twenty populations | Hidden candidates can produce sparse visible output. This is not a scan of every vote or a constant-latency guarantee.                 |
| Membership propagation | Capped counted memberships plus resumable jobs/checkpoints                                                                                         | Joining/leaving can make aggregate publication lag; a UI refresh is not job completion.                                                |
| Public figure          | Question/publication point reads, separately maintained publication state                                                                          | Async drain/prior work is not forced into each subject request. Internal batch/drain caps do not bound all background completion time. |
| Imported statistic     | One currently supported `vndb` row per subject/source, with repeated tuple/current-subject checks                                                  | No arbitrary provider fan-out is implemented; lifecycle verification is additional work, not just the one row lookup.                  |
| Web rating section     | Four public calls today; private own-state call after session is known                                                                             | Failure coupling and unnecessary aggregate work should be reduced only without losing provenance/disclosure meaning.                   |

## Purchase: a useful entry, not an entitlement claim

A subject is not an offer, an edition is not an entitlement, and a currently listed offer is not a completed purchase.
The overview needs a concise route to available choices, with enough price/version context to make the action meaningful.
For a serial or a streaming title the primary action may be read/continue/watch; it must come from actual capability and access, not a generic Buy button.

### Exact readiness

The real app mounts `subjectPurchaseRegions` in `apps/web/src/routes/__root.tsx` through `AppShell`.
`features/pages/subject-slots.tsx` exposes the public owner region in the header and private region only after signed-in hydration; an absent owner is `null`.
This is real integration, not merely a story-only placeholder.

`apps/web/src/checkout/subject-offers.ts` calls the generated native subject-offers route with default limit 10, maximum 20, a strict DTO, explicit credential mode, locale/cursor handling and no anonymous retry after an authenticated refusal.
`subject-offers-region.tsx` keys browser queries by subject, locale, credential mode, viewer/session and cursor; it cancels/removes on unmount, uses zero garbage-collection time, no automatic retry, and no focus refetch.
The private path is no-store; an unavailable or denied result is not replaced with a fabricated offer.

`services/kernel/src/commerce/subject-offers.ts` does substantially more than return a directory row:

1. Checks the requested subject and resolves current terminal identity/epoch.
2. Reads a bounded raw offer page and its readiness state.
3. Confirms current creator/offer homes, offer Access, content edition and exact versioned terms for candidate rows.
4. Rechecks relevant identity/home/disclosure conditions, including the original subject, before returning.
5. Retains positive confirmed offers during preparation; signs continuation with subject/terminal identity and partition epoch, requiring restart on incompatible change.

The client requests ten raw candidates by default; the route allows at most twenty.
Each candidate can require several native-home/access/content operations, including repeat currentness checks; this is bounded fan-out, not one fixed-cost lookup.
Do not increase the raw cap merely because post-filter pages can be sparse.

The rendered region currently lists up to the returned page of offers, each with price/currency/tax and fixed-version terms, review-offer action and continuation controls.
Putting the whole page in the subject header can overwhelm identity and About even though the API is bounded.
`SubjectOwnedBenefitsRegion` only links to the user's entitlements: its own comment says a bounded owned-benefit batch is absent.
No “already owned”, free upgrade, current edition access, refund state, or checkout completion claim follows from that link.

### What the criticised examples prove

`apps/web/src/stories/patterns/subject-purchase-slot.stories.tsx` imports `kernel/recorded/subject-page.json` and casts it to `SubjectPageData`.
Its populated owner is literal “Owner-supplied purchase/benefit region” text; it proves neither an offer nor an entitlement.
Empty asserts absence of the slot and presence of the subject heading; Populated checks one region at the header; PrivatePending checks absence.
`stories/page.tsx`'s `PatternStory` supplies a narrow query/router/locale harness, not all current route rating/community loaders.
These assertions can succeed while unrelated sections in the full overview are unusable.

The separate `apps/web/src/stories/subject-purchase.stories.tsx` exercises the generated adapter through illustrative `kernel.local` offer fixtures.
That has more wiring value than literal owner text, but remains a fake transport, not native availability or transaction evidence.
The inability to settle the public empty-slot story in the bounded observation is recorded above; it was not replaced with an invented screenshot diagnosis.

### Recommended entry and lifecycle

Show one compact entry such as the actual number of currently presented choices, or a single confirmed offer's price/format and Review offer action.
Do not claim a total count that a raw bounded page cannot know, or “from” a cheapest price without a backend minimum guarantee.
Open a desktop panel/phone sheet for the bounded choices and their precise terms; retain a normal destination link for navigation and recovery.
Do not show a large empty purchase heading when no owner capability applies.
Distinguish ready-empty, preparing, unavailable, denied and cursor-restart; only confirmed positives get actionable offer links.

At offer review and purchase mutation, revalidate current terms/access using the existing owner journey.
An edition merge, delisting, changed partition, expired session or changed offer version can invalidate a previous chooser state.
Purchase receipts/retained legal terms and current entitlement are different lifecycle facts; neither can be inferred from a cached subject offer.
A refund/revocation must affect the owned-benefit surface through its owner, not by removing bibliographic subject identity.
The first subject slice can provide useful native offer access without promising a new owned-benefit batch or changing checkout semantics.

## Capability matrix: specification is not exposure or evidence

“Implemented” means the inspected code contains the path, not that it was executed here.
“API” distinguishes a native route from a web-only fixture or a client helper.
“Tested” below names test bodies/observations; **none is an executed passing receipt for this revision**.
Historical owner receipts and the existence of growth/native suites remain separate.

| Capability                                | Specified / designed                                  | Backend implemented                                                                | API exposed                                                                    | Interface exposed                                                                    | Test evidence and practical gap                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Generic subject composition               | One graph/profile engine; bounded plans               | `presentation` executes plans; semantic relations hydrate subjects                 | `POST /v1/pages:read`                                                          | Real subject route and generic renderer                                              | Page/data/order tests exist. Current mobile fixture still exposes multiple failures; no native whole-page result here.            |
| Overview / destination views              | Fixed views, bounded previews, independent full views | Profile and per-view plan paths                                                    | View in page-read request; interim full view also needs overview               | Tabs/links, cursors, conditional applicability                                       | `subject-views`, continuation and cost tests exist; stable count-only availability read remains an acknowledged gap.              |
| Synopsis/details folding                  | Separate Overview/Details intended                    | Content/facts available                                                            | Composition/document reads                                                     | Current `Summary` renders full prose; sources/details can dominate                   | Structural tests do not establish a long-content, expanded/collapsed reading journey.                                             |
| Standard Global public rating             | Mean/count/scale, not Bayesian order                  | Published figure and prior lifecycle                                               | Public standard Global `/figure`                                               | Real route and shared figure component                                               | Figure/native publication suites exist; ready story is fake. No current pass asserted.                                            |
| Global distribution                       | Threshold-controlled histogram                        | Sixteen-shard aggregate projection and freshness                                   | Aggregate `/ratings`                                                           | Numerical 21-bin disclosure                                                          | Ready play opens it and asserts labels; useful shape/a11y and native publication coherence are not established by that assertion. |
| Selected Realm aggregate                  | Readable population only; not public search figure    | Access-checked aggregates and thresholds                                           | One or at most twenty populations                                              | Actual public loader supplies none; Realm-selected overview shows unavailable        | Aggregate HTTP tests cover protected candidates; fake three-Realm rows do not close the interface gap.                            |
| Discover subject populations              | Cursor, no all-membership enumeration                 | Twenty raw positive candidates, readable filtering                                 | `/ratings/populations`                                                         | No scalable chooser on current subject                                               | HTTP test covers 21+ candidates/protected filtering; no 300-Realm name/search journey evidenced.                                  |
| Own vote                                  | Private, zero/save/clear/idempotency                  | Native vote writes and own read; contribution jobs                                 | Authenticated GET/PUT/DELETE                                                   | Hydrated control and recovery states                                                 | Control, adapter, native vote suites exist; local story state is not persistence evidence.                                        |
| Membership contribution                   | Capped/resumable propagation                          | First 100 counted memberships; leave promotion                                     | Aggregate/vote operations, not a demonstrated explanatory own-contribution API | Cap/promotion meaning not surfaced                                                   | `voter-realms.test.ts` includes 102 joins and promotion; no execution or user explanation established.                            |
| Imported scores                           | Separate provenance/scale/licence/date                | VNDB-only source statistic storage and identity/lifecycle fences                   | Source-statistics read                                                         | Real loader, but failure coupled to native rating; all supplied source rows rendered | Isolation/lifecycle tests exist. Fake VNDB attribution is illustrative, not an acquired data licence.                             |
| Review/discussion preview                 | Small, actual readable community content              | Content list/projected author/access paths                                         | Subject threads and bounded author batch                                       | Real preview/full views; legacy Global compatibility helper also exists              | Community/thread tests exist; no universal Realm board-creation or native authoring completion claim.                             |
| Subject offers                            | Current readable terms, sparse/preparing pagination   | Native bounded directory and repeated final checks                                 | Generated subject-offers route                                                 | Mounted real browser owner region                                                    | Native commerce and web transport tests exist; slot test is placement-only, commerce stories use fake transport.                  |
| Owned benefit summary                     | Owner-isolated private state                          | Individual entitlement journey exists; bounded subject-owned batch not established | No such batch established by the inspected region                              | Link to entitlements, not owned badge                                                | Do not count a private pending-slot test as ownership verification.                                                               |
| Portrait defaults, landscape preservation | Settled portrait default for every kind               | Media/cover metadata and fit supported                                             | Definition hints and image metadata                                            | Subject frame still accepts kind/family ratio; landscape containment supported       | Cover tests/stories exist; cross-surface default policy is not established by them.                                               |
| Typed optional failure composition        | Honest section failure; usable siblings               | Reads expose status, owner-specific states                                         | Mixed status/DTO paths                                                         | Generic block repeated per failed node; no shared failure budget                     | `subject-data-components` tests local recovery; no whole-page repeated-wall oracle identified.                                    |

### Backend and document contradictions that matter here

`packages/composition/README.md` records the finite generic view engine and the intended single count/availability read, but also says the latter is not delivered: overview previews currently decide tab availability.
Do not describe the desired count-only operation as implemented.
`services/kernel/src/presentation/README.md` still opens with an older profile description including More Statements in the main header/overview, while current composition documentation puts detailed statements in Details.
The correction is one authoritative current reading contract and matching examples, not another competing profile explanation.

`apps/web/README.md` contains “no own reads”/single-aggregate descriptions for subject rating work that no longer describe `readRatings`' four public calls and private hydration.
Some commerce binding-pending descriptions are also behind the now-mounted native adapter.
Conversely, an updated document saying “native adapter” cannot turn a fixture transport test into native product evidence.
These documentation/implementation disagreements are a release-evidence defect, not a reason to discard working backend code.

## Defect classes and owner corrections

Every finding below separates observed evidence from an inferred process cause.
The causes describe what the inspected checks/harness permit; they do not attribute motives or decisions to people.

### 1. Reading hierarchy is subordinate to renderer completeness

- **Class / evidence:** presentation hierarchy; `overview.tsx` `Summary` emits the full document/description, and Sources can render all supplied identifiers/URLs. The settled 390 subject puts repeated relation failures before useful reception/community content.
- **Cause that let it through:** tests such as `subject-overview-order.test.ts` protect node order and presence; that does not impose a prose preview budget or evaluate the composed reading path.
- **Impact:** long descriptions, technical labels and low-value metadata delay the decision a subject page should support; tabs become decoration if their full contents are already inline.
- **Owner seam / correction:** web subject renderer plus composition/profile owner; adopt a reading budget, separate same-passage folds from full-list views, and keep sourced provenance accessible in Details.

### 2. Honest local failures become an unusable page

- **Class / evidence:** failure composition; `overview.tsx` `Failed` repeats a full block per node. The settled phone story shows failures under “edition of”, “characters”, and a long contributor-property label.
- **Cause that let it through:** a local recovery test can approve each block independently; slot assertions inspect placement/heading only, without assessing useful content versus repeated failures.
- **Impact:** the page reads as a generic-error wall even while identity, ratings and community excerpts are usable; raw property language adds confusion.
- **Owner seam / correction:** page boundary and presentation owner; typed state plus dependency-aware grouped notices, human relation labels, targeted retries, and honest destination recovery. Do not replace failure with empty.

### 3. Fixture exposure is mistaken for Realm product readiness

- **Class / evidence:** integration/exposure gap; `subject-queries.ts` passes no memberships, `subject-ratings.ts` truncates supplied memberships to three, while `kernel/fake/ratings.ts` illustrates three Realm figures.
- **Cause that let it through:** the ready story injects rendered data and its play checks score text, not subject → population discovery → selection → current native aggregate.
- **Impact:** users cannot compare a selected readable Realm as the examples imply; arbitrary truncation fails at twenty and at 300.
- **Owner seam / correction:** web rating/query adapter with rating and Realm discovery owners; one bounded chooser, honest selected-population loading, and an explicit label/search contract where absent.

### 4. Contribution semantics are invisible at the membership upper bound

- **Class / evidence:** product semantics/lifecycle; `voter-realms.ts` caps counted memberships at 100 and promotes a waiting Realm after removal; `voter-realms.test.ts` names the 102-join case.
- **Cause that let it through:** a backend bound protects propagation cost but is not automatically an understandable person-facing rule; showing a Realm aggregate says nothing about whether this person's vote contributes.
- **Impact:** someone in 300 Realms can save one vote and reasonably misunderstand where it counts; a later leave can change contribution asynchronously.
- **Owner seam / correction:** rating owner first, web second; preserve the current cap until an owning contract changes, explain the rule and publication lag, and establish a bounded own-contribution disclosure if the adopted journey needs it.

### 5. Rating information exists but lacks a finished decision surface

- **Class / evidence:** interaction hierarchy/meaning; `subject-ratings-view.tsx` displays revision metadata, a numerical 21-bin grid, persistent implementation explanations, and imported rows; its local `Figure` type and view do not model/use aggregate freshness.
- **Cause that let it through:** asserting score text twice and that a disclosure opens does not judge statistical comprehension, own action, compactness or stale-state clarity.
- **Impact:** a ready example is technically populated but hard to scan; users may confuse saved vote, published mean, Bayesian ordering and source score.
- **Owner seam / correction:** shared rating presentation and rating owner; compact mean/scale/count/population, prominent own action, optional accessible chart/details, and source-specific provenance. Keep raw revision/internal ordering explanation out of the default reading hierarchy.

### 6. Independent rating dependencies fail as one unit

- **Class / evidence:** resilience and navigation context; `readRatings` returns `null` after required-read failure, including source statistics; `RatingsFailure` retries with `?`, and Reviews omits Realm context.
- **Cause that let it through:** a single nullable result collapses independent capabilities, while tests focus on complete success/failure shapes rather than a usable native figure with failed imported data.
- **Impact:** an external-score read can erase a valid REZICS mean; recovery can leave the selected population/context.
- **Owner seam / correction:** web rating adapter and URL helpers; preserve independent typed states and only render means from their own valid tuple, with context-preserving recovery links.

### 7. Purchase placement is stronger than its proof and weaker than its usable entry

- **Class / evidence:** proof scope and density; the slot story uses literal owner text and a recorded whole page. The real region exists but renders a page of detailed offer rows in the header; the private region only links to entitlements.
- **Cause that let it through:** slot-count assertions establish ownership/placement, while transport fixtures establish DTO handling; neither asks whether a reader can choose a specific current offer without losing the subject hierarchy.
- **Impact:** apparent purchase completion can mean only a placeholder; actual offers can overwhelm the header; an owned badge would be an unsupported claim.
- **Owner seam / correction:** commerce-owned region and subject frame; compact native entry, bounded choice surface, terms-aware handoff, and explicit absence of an owned summary until its owner supplies one.

### 8. Stale examples and mocks survive contract evolution

- **Class / evidence:** evidence drift; the purchase pattern force-casts a recorded page; `apps/web/tests/subject-ratings.test.ts` constructs an older client mock without the new question/figure methods and casts through `never`.
- **Cause that let it through:** casts bypass compile-time contract checking; examples and adapter tests can lag the loader, and no inspected assertion makes their data source a native proof.
- **Impact:** a story may appear populated without exercising current reads, or render generic failure after a read-plan change. The static mismatch suggests a test maintenance problem, not an asserted executed test failure.
- **Owner seam / correction:** story/test adapters and recording owner; preserve frozen recordings, add current typed adapters/scenarios, and label recorded, fake, real-adapter/fake-transport, and native evidence distinctly.

### 9. Currentness and privacy need end-to-end ownership

- **Class / evidence:** disclosure/lifecycle review gap; rating prechecks, raw-candidate population continuation, private vote hydration and the commerce adapter's repeated final checks have different guarantees.
- **Cause that let it through:** a successful access-filter example does not cover close/leave/merge races, cache reuse, cursor transfer, or metadata leakage; owner boundaries can be blurred by a shared UI state.
- **Impact:** stale visible labels/counts or private state could persist after permission/session changes; the inspection does not establish an exploitable leak.
- **Owner seam / correction:** rating, Access, identity and browser-query owners; current disclosure on new reads, viewer/session-scoped private caches, bounded lifecycle cases, and explicit sparse-page metadata policy. Do not apply commerce guarantees to ratings by analogy.

### 10. Cover policy differs by surface despite a settled default

- **Class / evidence:** cross-surface policy drift; `packages/ui/src/components/cover-model.ts` still maps music/other to square, recipes to 4:3, people to 3:4 and work/game to 5:7; subject framing accepts definition/frame ratio.
- **Cause that let it through:** image-fit tests can validate landscape preservation while type-family frame defaults remain inconsistent; list presentation and standalone Cover have different policy paths.
- **Impact:** a subject card and subject detail can disagree before any image-specific choice, undermining a stable catalogue grid. This does not claim that every anime subject currently uses a landscape default.
- **Owner seam / correction:** UI cover model, definition hints and subject frame owner; portrait default everywhere, explicit supported image/layout choices, containment of landscape art and preserved attribution. This is execution of a settled instruction, not a new design vote.

### 11. Shared shell defects can invalidate an otherwise narrow example

- **Class / evidence:** shared containment/responsiveness; the supplied filter image shows overflow; the phone subject observation records a document wider than its viewport.
- **Cause that let it through:** rendering the full shell in a page story adds obligations without proving centred search, scoped Filters or phone interaction; isolated subject assertions do not inspect that shared behaviour.
- **Impact:** users encounter broken search or clipped controls while trying to use the subject, even if its local data component passes.
- **Owner seam / correction:** shared shell/search/UI owner; exercise the real shell where navigation/search is part of the journey, use an honest narrow harness otherwise, and consume the already-settled search design. This report does not own a second search redesign.

### 12. Readiness documentation outlives the implementation it describes

- **Class / evidence:** authority/evidence drift; the presentation README's opening profile differs from the current composition description, while web rating and commerce prose lags the four-call loader and mounted offer adapter, as detailed above.
- **Cause that let it through:** delivery descriptions and historical receipts can remain in owner READMEs after adjacent routes/providers change; a document assertion has no automatic relationship to current interface exposure.
- **Impact:** a manager can plan nonexistent count-only reads, overlook implemented offer wiring, or count a fixture as native proof; subsequent slices inherit contradictory cost and readiness assumptions.
- **Owner seam / correction:** composition, presentation, web and commerce documentation owners; reconcile each topic into its one owning contract, distinguish historical receipts from current claims, and point examples at the actual current adapter without rewriting frozen evidence.

## Cross-surface, privacy, and lifecycle checklist for adoption

This section names design obligations and existing seams; it is not a claim that the following scenarios passed.

| Event / boundary                                | Required behaviour                                                                                                       | Inspected readiness / gap                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed out → signed in / session expiry         | Public figure stable; own vote and benefits appear only for the correct session; no private SSR/shared-cache payload     | Own state is separately hydrated and private; commerce query keys include viewer/session. Need composed recovery evidence, not fixture toggles. |
| Save, replace, clear, zero vote                 | Correct own state/idempotency; zero differs from clear; public publication may lag                                       | Native vote routes and web controls exist. Do not promise immediate aggregate recomputation.                                                    |
| Realm closes, viewer leaves, permission changes | New aggregate/population reads apply current disclosure; previous selection recovers without revealing protected details | Route checks exist; final-read race/currentness review and client invalidation are not established by the ready story.                          |
| Hundredth counted membership leaves             | Promotion and reaggregation may change the person's contribution                                                         | Resumable cap/promotion implementation exists; user explanation and current contribution visibility are gaps.                                   |
| Subject merge / alias / owner-home movement     | Canonical target, current readability and tuple identity remain coherent; stale cursors restart                          | Rating source-statistic lifecycle and commerce identity/epoch checks exist; cross-section composed evidence still needed.                       |
| Prior epoch or publication job pending          | Label unavailable/updating states honestly; do not present a different tuple's score as current                          | Native publication/prior machinery exists; aggregate freshness is currently unused by the web view.                                             |
| Imported source removed / licence changes       | Stop inappropriate display and retain accurate source/date/licence meaning                                               | Source lifecycle/isolation paths exist; a fake VNDB row is not a data permission.                                                               |
| Offer changes / delists / subject withdraws     | Chooser never authorises purchase by cache alone; review current terms/access; safe restart                              | Native adapter performs repeated currentness checks and fenced continuation; terms confirmation belongs to commerce.                            |
| Refund/revocation                               | Current owned benefit changes; retained receipt/legal terms remain their own authority                                   | Subject region has no bounded owned-benefit summary. Do not synthesise one from offers or edition identity.                                     |
| Deleted or moderated review                     | No stale excerpt bypasses current content visibility; author projection remains bounded                                  | Actual content list/Access seam exists. Public text excerpt is not a full review permission or moderation history disclosure.                   |

Privacy is field-specific: a private own vote, public aggregate, public review, private collection and public watched activity are not one switch.
Letterboxd's documented form text is a useful warning that hiding a rating need not hide diary/watch activity; REZICS must state its own semantics rather than borrowing the label “private.”
Protected Realm existence, below-threshold values, identities, cursor metadata and timing need their own disclosure treatment.
Do not export private Realm aggregates into the public search figure; `docs/scope.md` explicitly defers Realm-rating sorting and keeps the public index's standard Global figure boundary.

Accessibility also spans states: name the population picker, expose selected state, preserve keyboard focus after save/retry, announce a concise result, and retain input after recoverable failure.
Do not put an entire page of repeated failures in competing live regions.
Do not move focus merely because an asynchronous public aggregate updates.
Expanded text, chart alternatives, long creator names, missing images and translated labels must reflow without hiding the available actions.
Original language values and required credits should remain readable; truncation must not turn rights or eligibility into a false summary.

## Whole-page boundedness, beyond the rating widget

`packages/composition/README.md` and `services/kernel/src/presentation/README.md` describe at most sixteen read descriptors, 128 aggregate slots and execution concurrency four.
Those are plan bounds, not a bound on all subject-page network calls, SQL work, Access checks, bytes, private hydration or background publication.
The shared subject projection budget is at most fifteen extra subject-document fetches after the initial subject, but this is not permission to add arbitrary section-owned calls.
Immutable profile caching is different from caching current page authority or private state.

| Surface                                        | Existing logical limit / shape                                                                                     | Recommendation at required upper bounds                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Overview relations                             | Generic preview profiles, usually twelve items; finite chosen groups                                               | Do not enumerate all properties/kinds. Load only the bounded previews needed for overview and navigation.                             |
| Full view                                      | Current web flow needs the requested view plus interim overview for availability                                   | Preserve this honest cost until the count-only availability path exists; do not claim one aggregate request.                          |
| Semantic relations                             | Default 25, allowed 1–100; filtered raw scan `4L + 1`; type count sample capped at 1,000 with “at least” semantics | Respect continuation/approximate-count meaning; never fetch an entire graph to compute a tab label.                                   |
| Community previews                             | `subject-community.ts` uses five preview or twenty full rows and a bounded shared author read                      | Profile may show fewer; a smaller visible excerpt alone does not reduce owner work. Do not fetch all reviews then trim.               |
| Reactions                                      | Public aggregate plus private own-state path                                                                       | Keep separate from rating counts and private collection state.                                                                        |
| Rating                                         | Four current public calls plus optional private own read                                                           | Preserve truthful independent states; no per-Realm eager calls or all-page population drain.                                          |
| Offers                                         | One raw cursor page, requested ten/max twenty; per-row native confirmation                                         | Compact entry over the same bounded data; no all-offer price scan or invented total/minimum.                                          |
| Cover viewer                                   | Stable frame, explicit landscape fit, media/attribution path                                                       | Do not preload every edition's full-size art for a six-card preview.                                                                  |
| Million-item Collection / thousands of follows | Not inputs requiring enumeration for subject identity                                                              | Use a single owner-supported personal-state read where available, never preload a person's library/follow graph to decorate the page. |

No single total request/byte bound is asserted for every profile because current auxiliary reads vary by view and session.
Before adopting a slice, write its exact owner-call budget and response-shape bounds, including unavailable paths and selected-population changes.
Keep backend work, transmitted bytes, DOM size, visible rows and background propagation as separate budgets.
Neither hiding a section with CSS nor putting it in a disclosure bounds its backend query.

## What the existing tests protect, and what they miss

The evidence below comes from reading test bodies and story code; nothing in this section is a new run or a passing claim.
No frozen recording or existing acceptance test was changed for this research.

| Evidence                                                                                                                    | Real value                                                                                               | Limit relevant to this investigation                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/tests/subject-overview-order.test.ts`, `subject-hero.test.ts`, `subject-views.test.ts`                            | Node ordering, hero structure, view routing/applicability                                                | Presence/order is not a useful first reading screen, a fold, or no-error-wall guarantee.                                                    |
| `subject-data-components.test.ts`, `subject-view-error.test.ts`                                                             | Failed-section recovery and usable siblings                                                              | Local failure correctness can coexist with three repeated large errors in one page.                                                         |
| `subject-ratings.test.ts`                                                                                                   | Adapter conversions and attempted population bounds                                                      | Older client mock lacks current required reads; first-three expectation validates omission, not the 300-Realm journey. Static finding only. |
| `rating-control.test.ts`, `ratings-fixtures.test.ts`, ready story play                                                      | Zero/clear/control states and illustrative score labels                                                  | Local state/fake responses do not establish native saved vote, access changes or published figure.                                          |
| `apps/web/tests/subject-offers.test.ts`                                                                                     | Exact generated URL/limit, no-store/credential handling, preparing positives and refusal/error behaviour | It constructs transport responses; a “native” adapter description does not make it a native integration test.                               |
| `services/kernel/test/rating/aggregate-http.test.ts`                                                                        | Twenty-candidate continuation, protected-population filtering, neutral disclosure shapes                 | Does not establish labelled chooser behaviour at 300 or a globally ranked population list.                                                  |
| `services/kernel/test/rating/voter-realms.test.ts`                                                                          | Counted cap and leave/promotion semantics with more than 100 memberships                                 | Does not establish latency, user understanding, or all-300 contribution.                                                                    |
| `public-figure-http.test.ts`, `public-figure-native-publication-http.test.ts`, `prior-epoch.test.ts`, `segment-job.test.ts` | Native figure, asynchronous publication and lifecycle invariants                                         | Existence is not current execution; native suites need their supported environment later.                                                   |
| `source-statistic-lifecycle-http.test.ts`, `source-statistic-isolation-http.test.ts`                                        | Tuple/source isolation and lifecycle fences                                                              | A fake imported score in Storybook remains illustrative.                                                                                    |
| `services/kernel/test/commerce/subject-offers.test.ts`                                                                      | Native subject-offer correctness scenarios                                                               | Does not by itself establish a compact usable header, actual purchase completion or owned-benefit summary.                                  |

The common blind spot is composition: one test proves a contract, another a slot, another a fake happy state, while no inspected evidence establishes the complete reading-and-action journey under long content and partial failure.
The correction is not more snapshots of every small branch or a line-count target.
Retain security/lifecycle/transport tests, repair stale typed adapters outside frozen evidence, and add a small set of complete, discriminating journeys when implementation resumes.

Recommended future acceptance scenarios, to be owned and adopted later:

1. A long-synopsis subject with many editions/credits still has a readable overview; Show more/less and full-view navigation preserve context and keyboard focus.
2. An empty purchase owner and several unavailable optional relation reads do not produce repeated generic-error blocks; successful content remains usable and unknown is not labelled empty.
3. A real Global figure and own save/zero/clear remain coherent across delayed publication; failed imported statistics do not erase native ratings.
4. At 20 and 300 populations, one selected panel remains bounded; sparse pages, hidden Realms, missing labels, selection, close/leave and retry behave honestly without draining all pages.
5. A person beyond the 100 counted-membership cap is not told that their vote contributes everywhere; leave/promotion and updating states follow owner semantics.
6. A real native offer page handles positive preparation, refusal, changed terms, identity/cursor restart and session loss without anonymous fallback or an invented owned badge.
7. Phone/desktop, zoom, keyboard and missing/landscape covers preserve the same identity, score meaning and actions; the shared search matches its settled contract where used.

These are research recommendations, not newly written acceptance tests or permission to start a native campaign while the Goal is paused.

## Prioritised coherent slices

Sizes are relative implementation/review scope: S is one focused owner seam, M several coordinated surfaces, L a cross-owner contract and lifecycle slice.
They are not measured delivery estimates or permission to modify a closed risk area.
Each slice must update its owning contract before implementation if the recommendation changes current authority.

| Order / size                                 | Coherent result                                                                                                                                                                      | Dependencies and evidence to demand                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — S/M: truthful current examples**       | Typed current story adapters, explicit recorded/fake/native labels, narrow slot examples that do not accidentally claim whole-page completeness; one useful composed subject example | Preserve frozen recordings. Align current providers/read plans; remove unsafe cast-based authority claims. Reuse the completeness audit rather than publish another campaign.      |
| **1 — M: usable overview and destinations**  | Identity/action hierarchy, portrait defaults, synopsis fold, small profile previews, Details separation, typed/grouped optional failures and context-preserving links                | Composition + web + UI owners; settle preview budgets in the owning document. Covers and failure grouping are necessary parts of this reading slice, not cosmetic follow-ups.      |
| **2 — M: trustworthy Global reception**      | Compact real mean/count/scale, actual own rating, accessible distribution detail, independent imported-source state and honest updating/recovery                                     | Existing rating routes/publication contract; do not make Realm discovery or an owned-benefit batch a prerequisite. Native lifecycle and composed interface evidence later.         |
| **3 — L: selected Realm reception at scale** | One bounded chooser and panel, labels/continuation/search semantics, current disclosure and cap explanation                                                                          | Rating + Realm/Access owners establish the label/search and currentness gaps; no all-membership fetch or per-Realm panels. Depends on slice 2's state model.                       |
| **4 — M: compact native purchase access**    | Confirmed current offer entry, bounded chooser, exact terms handoff, preparation/restart/refusal recovery                                                                            | Existing commerce adapter and owner journey; can proceed after slice 1 without waiting for Realm ratings. Owned summary remains a separate missing capability.                     |
| **5 — M/L: deep catalogue traversal**        | Editions/parts/credits/relations full views with correct counts, sparse continuation, source detail and accessible return paths                                                      | Generic semantic/composition engine; replace interim overview-dependent availability only when owner API exists. No vertical branch explosion or recommendation-feed prerequisite. |

An owned-benefit summary is a separate later commerce slice only if the product requires it; define a bounded subject-owned projection and revocation semantics first.
It should not block a useful offer entry, and a link to entitlements must not be promoted as equivalent.
Feed/personal recommendation work is outside first-scope subject completion because `docs/scope.md` defers feeds.
The priority is coherent reading and action with actual existing capability, followed by the genuinely missing population and ownership surfaces.

## Ambiguities resolved and decisions left to owners

The following interpretations were necessary to make the investigation precise:

- “Context ratings” was split into question, population and semantic Context; the 20/300 layout analysis primarily concerns populations, with separate treatment of unbounded question chips.
- The Goodreads top image is an expanded state; the full image supplies the collapsed hierarchy. Neither establishes an original CSS viewport.
- Current development source and the public publisher were treated as distinct revisions; observed fixture defects were not attributed automatically to the native API.
- The latest `legacy-final` Realm chooser is bounded already; the unbounded question-context map and first-page discovery limit were named separately.
- Missing/closed, empty, withheld, preparing, denied and unavailable are different states; no recommendation silently maps one to another.
- The existing hundred-counted-membership rule was retained as implementation/owner semantics; the settled upper-bound requirement was not interpreted as authority to remove that cap.
- Portrait defaults, intact landscape art, no taglines and the shared search design were treated as settled. This report asks for delivery alignment, not another product decision.
- Research mode permits no implementation or acceptance execution. Docs-only work changes no typed workspace; original acceptance/native/browser verification remains deferred under the current execution policy.

No maintainer-only decision is needed to start slices 0–2 or the existing-offer portion of slice 4 after research is adopted.
The manager/owners can adopt the recommended reading budget and typed state model through the ordinary feature-design process.
If a later contract requires **every one of a person's 300 memberships to count**, the existing cap becomes a real product/architecture choice: retain and disclose 100, let the person select a bounded contributing set, or fund a larger propagation model.
Recommendation: preserve and explain the current bound for the initial slice; do not silently promise all-300 contribution or change aggregation semantics in web code.
Likewise, fuzzy name search across all subject-rated populations needs an owner API design if adopted; a nonfunctional search field is not a UI shortcut around that gap.

## Evidence index and handoff

Current source anchors, relative to the inspected revision:

- Reading contracts: `docs/subject-pages.md`; `packages/composition/README.md`; `services/kernel/src/presentation/README.md`; `services/kernel/src/semantic/README.md`.
- Route/composition: `apps/web/src/features/pages/subject.tsx`, `subject-queries.ts`, `data.tsx`, `overview.tsx`, `views.ts`, `view-tabs.tsx`, `subject-community.ts`.
- Ratings: `apps/web/src/features/pages/subject-ratings.ts`, `subject-ratings-view.tsx`, `rating-control.tsx`, `rating-actions.ts`, `public-rating-figure.tsx`; `services/kernel/src/rating/{routes.ts,aggregate-read.ts,aggregate-read.sql,aggregate-populations-page.sql,public-figure-http.ts,public-figure.ts,voter-realms.ts,README.md}`.
- Commerce: `apps/web/src/features/pages/subject-slots.tsx`; `apps/web/src/checkout/{subject-purchase.ts,subject-offers.ts,subject-offers-region.tsx}`; `apps/web/src/routes/__root.tsx`; `services/kernel/src/commerce/{subject-offers.ts,README.md}`.
- Covers: `packages/ui/src/components/{cover-model.ts,cover.tsx}`; `packages/ui/README.md`; `apps/web/src/features/pages/{subject-page-cover.tsx,subject-frame.tsx,overview.tsx}`.
- Story provenance: `apps/web/src/stories/{subject.stories.tsx,page.tsx,subject-purchase.stories.tsx}`; `stories/subject-rating/subject-rating.stories.tsx`; `stories/patterns/subject-purchase-slot.stories.tsx`; `apps/web/src/kernel/{recorded/subject-page.json,fake/ratings.ts,fake/subject-offers.ts}`.

The only tracked deliverable is this report.
The only write outside the worktree is the explicitly permitted ignored `/home/edge/projects/rezics/rezics-next/.reference/INDEX.md`, registering the three reused references and their licences/revisions.
Screenshots, observation script, browser profile/cache and copied authority/reference assets remain ignored under the worktree's `.temp/goal/` paths.
No other Goal's source, frozen file, acceptance test, publisher or runtime was changed.
Adoption belongs to the manager and owning documents; the report itself supplies evidence and recommendations, not a second source of product authority.
