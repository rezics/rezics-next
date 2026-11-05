# Current public Web completeness audit

Research date: 2026-10-31. This is evidence and a recommendation, not an adopted product contract or a release approval.
The public delivery contains substantial interface work, but a story being published does not establish that its
page is designed, that its dependencies work, or that the corresponding native capability is available.

## Scope, authority and provenance

This report answers the public Pages/Patterns completeness question. The complete authority, including the backend
addendum, was read from `.temp/goal/web/research-20261031.md`. Its settled choices are inputs: hundreds of Realms
and Spaces, 200,000 kinds, thousands of follows, millions of Collection items; portrait default frames for every
kind while preserving landscape images; no marketing taglines; one centred header search field, a scope chip,
Filters at its right end, and a phone full-screen search panel. None is reopened here.

The inspected development revision is `6d3f767467c85dbb9d3bb561d12af784407bd92c`. The current public
[`build.json`](https://storybook.rezics.com/build.json) exposes commit
`b29a80a0aad38c008125fb032f5fe1af96bd6164`, built `2026-10-31T08:32:54.450Z`,
Storybook `11.0.0-alpha.8`. The cell observations ran from `2026-10-31T14:14:02.326Z` to
`2026-10-31T15:11:17.483Z`. After the sweep, the index and build were fetched again: index bytes have identical
SHA-256 `820bbb9d6a9e45f4aa7b19dab1fcdd4eb629d70eccf0faf2d8aae3fa1a1aaa9d`, and build metadata is
byte-identical. This fences the observed public delivery; it cannot promise the URL will remain unchanged later.
Development and public are different revisions. A read-only Git comparison found no differences under
`apps/web` or `packages/ui` between them; this supports the source explanations for these surfaces, without
claiming that development backend bindings were exercised by the public static site.

The architecture, scope, development feature-design and Goal definitions, Web/UI owner READMEs,
`docs/research/system-inventory.md`, `design-status-web.md`, `design-status-search.md`, and relevant Search/Library
owner inventories were read alongside actual source. Inventory language is not substituted for implementation.
The current task's English-report instruction takes precedence over the older authority file's translation and
publication instructions. No Outline publication, implementation, deployment, native acceptance or backend timing
was performed.

### Exact public matrix

The raw [`index.json`](https://storybook.rezics.com/index.json) is preserved byte-for-byte with response headers.
Its index format is v5, with 1,955 total entries. Selecting `type === "story"` and titles beginning `Pages/` or
`Patterns/` gives **1,899 stories, 228 titles, 3,798 story-width cells**. Pages contributes 1,248 stories/2,496 cells;
Patterns contributes 651 stories/1,302 cells. Docs and other story groups are outside this explicitly requested matrix.
No representative subset replaces it.

The reusable evidence root, in both this worktree and the primary checkout, is:

`.temp/goal/web/research-shots/web-completeness-audit/`

All evidence paths below are relative to that root unless stated otherwise. The primary copy is at
`/home/edge/projects/rezics/rezics-next/.temp/goal/web/research-shots/web-completeness-audit/`.
It is ignored research evidence, not product source. The main checkout's tracked files were not changed.

| Artifact                                                                                                    | Meaning                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.json`, `index.headers.txt`, `index.final.json`, `index.final.headers.txt`                            | Exact initial/final public index and HTTP provenance; hashes are recorded.                                                                                             |
| `build.json`, `build.final.json`, `build.final.headers.txt`, `root.html`, `root.headers.txt`, `iframe.html` | Exposed version and delivered bootstrap evidence; final version comparison.                                                                                            |
| `manifest.json`                                                                                             | Every requested story ID, title/name/import path, width/height, requested URL/globals, capture status, timestamp, screenshot path/hash, diagnostics and review status. |
| `shots/<story-id>--<width>.png`                                                                             | One public-browser screenshot per required cell; width is exactly 1280 or 390 CSS pixels.                                                                              |
| `cells/<story-id>--<width>.json`                                                                            | Observed story ID, URL, text, image load state, document dimensions, render phase and browser console/network exceptions.                                              |
| `contact/index.json`, `contact/sheet-*.jpg`                                                                 | Visual inspection atlas; pixel-identical PNGs share an inspection with an explicit list of all matching cells.                                                         |
| `visual-review.json`                                                                                        | Agent visual classifications and notes keyed by screenshot SHA-256, with atlas location.                                                                               |
| `summary.json`, `manifest.csv`, `titles.json`                                                               | Final counts, portable exhaustive matrix and per-title grouping.                                                                                                       |
| `incomplete-cells.json`, `failure-groups.json`, `diagnostics.json`                                          | Explicit incomplete observations, visible provider/import/section failures and per-cell diagnostic counts.                                                             |
| `manifest.capture.json`                                                                                     | Original capture manifest retained before review annotations; raw per-cell embedded requests can still say pending.                                                    |
| `initial-loading-attempt/`                                                                                  | Preserved early spinner observations, superseded only by subsequent matching-state evidence.                                                                           |
| `scripts/`                                                                                                  | Ignored observation/atlas scripts; never installed as application or test code.                                                                                        |

### Observation method and limits

The browser is system Chromium controlled through its debugging protocol. It loads only the live public origin;
there is no local build, server, request substitution or reference-project execution. The initial viewport heights
are 900 at width 1280 and 844 at width 390, device scale 1. Screenshots include the complete document, with a
30,000-pixel height ceiling explicitly recorded if reached. English/light is requested consistently. Actual
language/theme, image failures, horizontal document width and the observed story identity are retained.

The 390 capture exercises CSS responsiveness using a desktop Chromium user agent and pointer. It does not prove
physical-phone keyboard, touch, safe-area or screen-reader behavior. Full-document images do not prove that fixed
controls avoid overlap at every scroll position. Post-play scroll offsets can paint sticky headers and fixed
bottom navigation partway down a full-document image. This is a capture artifact, not proof of a duplicated shell.
A fresh `pages-catalogue-create-subject--invalid-fields` phone comparison records scrollY 853 and the real sticky
header at viewport top 0; the separate `comparisons/*--top.png` after scrolling to zero shows one ordinary header.
The settings comparison likewise supplies an actual first viewport. These bounded comparisons prevent misdiagnosing
post-play full-document chrome as a product composition defect; original images remain unchanged. Dark themes, other locales, zoom, 320 CSS pixels, authenticated
production journeys and undisplayed interactive branches are not silently counted as observed.

Public Storybook may automatically run a story's existing `play`; this audit does not invoke a test runner or
interpret its terminal phase as a pass. Normal story selection uses the same `setCurrentStory` channel as the
Storybook sidebar. Reusing browser tabs avoids repeatedly fetching the entire preview. The pinned Storybook source
confirms that channel in `code/core/src/preview-api/modules/preview-web/PreviewWithSelection.tsx`. StoryRender's
`playing`, `completing`, `afterEach`, `finished` and `errored` phases describe the renderer, not design approval.
A stable screenshot can be captured after 30 seconds while a play is still running; that phase is disclosed.
A 180-second outer observation ceiling preserves an unavailable/blank observation rather than manufacturing content.

The early fresh-context attempt produced spinners before imports completed. Those images remain preserved and are
not counted as successful page renders. Subsequent capture resumes the same index matrix, retaining completed cells.
Browser restarts affect only the audit's own browser. This is one progressive campaign, not a replacement publisher.
Stateful side effects across ordinary story navigation are a limitation; a visually unexpected state needs a bounded
direct-visit comparison before its cause can be assigned to product code rather than fixture/navigation isolation.

Visual review uses the screenshot, including a full-document miniature and a larger first viewport. Defect examples
are enlarged separately. DOM text and errors help identify what a visible failure means; they do not establish
visual success. This is a completeness triage, not pixel-perfect typography approval or accessibility certification.

### Classification and honest counts

**All 3,798 required cells were captured and visually inspected**: 3,205 distinct PNG hashes, reviewed through
134 contact sheets, with explicit hash-identical reuse covering the remaining cells. There are no pending capture
cells, missing screenshot files, hash mismatches or height-truncated images. This is exhaustive observation
coverage, not a claim that 3,798 designs work.

| Surface / width | Finished | Unfinished design | Broken layout | Error-unavailable wall | Missing data |     Total |
| --------------- | -------: | ----------------: | ------------: | ---------------------: | -----------: | --------: |
| Pages / 1280    |       20 |               769 |             0 |                    220 |          239 |     1,248 |
| Pages / 390     |       20 |               763 |             4 |                    228 |          233 |     1,248 |
| Patterns / 1280 |      201 |               228 |             7 |                    110 |          105 |       651 |
| Patterns / 390  |      208 |               225 |             1 |                    108 |          109 |       651 |
| **All cells**   |  **449** |         **1,985** |        **12** |                **666** |      **686** | **3,798** |

Only 449 cells (11.8% of the requested matrix) are visually finished in their exercised, bounded state. Many of
these are isolated controls, navigation regions, honest empty lists or recovery states; only 40 are Pages cells.
The denominator includes intentionally unavailable/denied/loading stories, so this is **not** a normal-user failure
rate, a ready-state completion percentage or a backend grade. No undocumented ready-only denominator was invented.
The wall count includes 32 unexpected QueryClient-provider failures and three dynamic-import failures, separately
listed in `failure-groups.json`. The remaining walls include deliberately modelled access/lifecycle/fault states;
those are not all bugs. Partial unavailable sections are visibly present in 189 cells (`missing-section` group).

`summary.json` contains the counts above; `manifest.json` and `manifest.csv` give every story-width decision,
review note, exact source, screenshot/hash, observed identity, render phase and diagnostic link. `titles.json`
provides the complete 228-title inventory without replacing the per-export matrix.

**Incomplete render/interaction evidence remains explicit.** Twelve cells have a blank/spinner/withheld body:
`patterns-library-collection-access--loading`, `patterns-community-thread-reading--loading`,
`patterns-community-realm-home-presentation--current-denied`, `patterns-composed-member-list--concealed`,
`patterns-community-realm-claim-review--confirm-review` and `patterns-community-realm-claim--claim-journey`,
each at both widths. The last two remain preparing/rendering journey observations, not completed confirmation
screens; the others include intentional loading/concealment examples. None was called finished.

At capture, renderer phases were finished 2,928; completing 586; playing 261; errored 12; afterEach three;
rendering four; preparing three; unrecorded one. `incomplete-cells.json` explicitly enumerates 878 cells with a
non-finished phase and/or blank body, with separate reasons. Completing/cleanup is not necessarily a broken render;
still-running play is not an observed later interaction outcome. A readable screenshot can be classified visually
without claiming that its entire play finished or passed. The early named Collection desktop observation lacks a
phase record. Twenty-one early cells have document-title identity rather than renderer-ID evidence; all titles
match their requested IDs. All 3,777 recorded renderer IDs match. Post-play route transitions remain in each cell's
observed URL, rather than being silently treated as the original route's state.

Diagnostics are similarly not a pass/fail total. Across the recorded cell windows there are 889 console-error
events, 384 error log entries, 1,087 warning log entries, two console warnings, 16 verbose entries, 156 HTTP 404
responses, 25 HTTP 502 responses, 203 non-cancelled network failures and 547 cancellations. Events can describe the
same failure more than once; a reused tab can also produce late diagnostics from a prior request. These are not
889 failed stories or a native availability measurement. `diagnostics.json` maps counts to the raw per-cell
messages; `errorCount` in the original capture is an all-event count and must not be interpreted as an error total.
Visible errors and PNG review determine classifications, not console counts or Storybook phase alone.

A cell has one dominant visual class, with secondary findings retained in notes:

| Class                  | Meaning                                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finished               | The exercised visual state has a coherent usable layout and no observed unfinished-content defect. This does not mean the whole capability is implemented or native-tested.                         |
| Unfinished design      | Content renders, but hierarchy, placement, scale, copy or required composition remains incomplete. A stable DOM is insufficient.                                                                    |
| Broken layout          | Observed clipping, overflow, collision or disconnected panel surface obstructs the exercised state.                                                                                                 |
| Error-unavailable wall | Main content is replaced by a route/render error, denied/not-found screen, retry wall or unavailable state. Intentional fault/auth fixtures are distinguished from unexpected ready-state failures. |
| Missing data           | The page remains partially usable but expected sections, covers, summaries or dependent reads are unavailable or absent. An intentional empty list is not automatically missing data.               |

Dominance is wall, broken layout, missing data, unfinished design, then finished. Counts are visual-state counts;
they are not backend completion percentages. An intentionally denied story can correctly display a wall and still
belongs in the wall count. Conversely, a polished illustrative result does not enter the native-working column.
Pending, failed, wrong-story, blank/loading and truncated observations remain explicit incompleteness, not finished.

The older `c2c7` live capture is a different frozen source. It was not overwritten, promoted into this matrix or
used to fill current cells. Existing `.temp/goal/web/review-delivered-current/` screenshots and their separate
`review-delivered-terminal.json` are also left untouched; their local `127.0.0.1` error URLs do not establish the
current public site's result. No old screenshot was reused without matching public source, story, viewport and state.

## Findings grouped by cause

### Public ready-state provider errors and asset-delivery failures

**Defect class: error-unavailable wall; owner seam: Web story composition and its query/session consumers.**
`pages-subjects-subject--imported-scores` and `pages-commerce-order--active` display the full Storybook
“No QueryClient set, use QueryClientProvider to set one” error at both widths. Each was also opened in an
independent fresh public tab, with the same result; see the four matching `comparisons/` PNG/JSON pairs.
These are not intentionally denied or unavailable examples. The first source renders `RatingsView` directly;
its rating control calls `useQueryClient`. The Order Active component example renders `OrderPage` directly;
that component calls `useSession`, whose browser implementation uses a query. Neither export wraps that render
in `PageStory` or `PatternStory`. This identifies a concrete missing-provider boundary, rather than a failed
native API. The user cannot inspect the claimed ready design at all. Supply the minimal real providers for an
isolated example, or use the integrated page harness when the claim exercises it. A global shell is not itself
the cure for a missing QueryClient.

The same cause also affects the published `patterns-account-managed-account-detail` exports, including
`--member-restricted`: both widths show the QueryClient wall, also confirmed by fresh direct observation in
`comparisons/patterns-account-managed-account-detail--member-restricted--*.png`. The source file
`apps/web/src/stories/patterns/managed-account-detail.stories.tsx` constructs an illustrative reader but mounts
`ManagedAccountDetailCard` without the normal harness. The card now includes `ManagedAccountActions`, whose
`apps/web/src/settings/managed-account-actions.tsx` calls `useSession`. Supplying a read fixture did not supply
this newly composed dependency. A restricted member state should show its intentional disclosure boundary;
a provider exception before that state is an unexpected composition defect. These examples demonstrate why
provider ownership must follow the mounted subtree as it evolves, rather than the original component label.

The exhaustive manifest also finds the same provider wall in all four header-composing Search History exports
(`--local-queries`, `--empty`, `--unavailable-scope`, `--offline`) at both widths. `--history` and `--conflict`
render an isolated history section and do not share it. `apps/web/src/stories/search-history.stories.tsx` mounts
`HeaderSearchView` directly. Its `RecentPanel` now composes `CurrentTrendingSearches` from
`apps/web/src/search/trending-section.tsx`, which calls `useSession`; supplying local recent entries therefore no
longer makes the subtree provider-free. Together with five Order exports, Imported Scores and six Managed Account
Detail exports, this is 16 exports / 32 cells. An unavailable-scope fixture is not an excuse for a QueryClient
exception: it should reach its intended unavailable state. Add providers at the real subtree boundary, and keep
local/private-history evidence distinct from actual synchronisation/API support.

The first phone capture of `pages-community-thread--editor-mention` instead shows
`Failed to fetch dynamically imported module: https://storybook.rezics.com/assets/thread-media.stories-C5SnEn_Q.js`.
Its desktop observation renders the mention editor, and subsequent fresh direct visits render it at both widths.
The original failed PNG and diagnostics remain; `comparisons/` preserves the recovery separately. This is an
observed transient asset-delivery failure, not a demonstrated permanent phone layout defect. The capture does
not establish whether cache, connection or publication asset lifetime caused it. The publication/CDN seam should
retain versioned assets and distinguish delivery errors from component errors; do not remove the observation
from the counts merely because a later visit recovered.

Two additional desktop cells show dynamic-import walls:
`patterns-account-notice-preferences--refused` references
`/assets/settings-notifications.stories-D_zGHCwv.js`, and
`patterns-account-collection-privacy--ambiguous-response` references
`/assets/settings-privacy.stories-D4L1LWoZ.js`. Their counterpart states at 390 render; these two failures were not
independently revisited, so recovery is unknown. They remain errors in the matrix. These are observed delivery
failures, with the root transport/cache/CDN cause unproven; they do not establish a permanent desktop-only defect.

The cause that lets these states look complete in an inventory is counting exported stories or narrow fixture
assertions instead of observing their actual published composition. Storybook's renderer can even report a
terminal phase while its visible content is an error panel. The exhaustive visual manifest remains the evidence.

### Shared header, search and filters

**Defect class: unfinished shared design; owner seam: Web shell/header-search, with UI panel primitives.**
The named Collection page and Library/Home captures show an empty global search pill, with local filtering outside
it. The desktop search is placed in remaining flex space rather than centred on the viewport. At phone width the
closed search trigger is present, but this static state does not exercise the required full-screen search panel.
Relevant evidence includes `shots/pages-library-collection--signed-in--1280.png` and `--390.png`, and the Home pair.
The visual result contradicts the settled integrated composition even when its controls individually render.

In `apps/web/src/shell/shell.tsx`, the header uses a flex row, logo/toggle, then
`flex-1 md:ms-6 md:max-w-[40rem]` for search, followed by independently sized account controls with `ms-auto`.
That constrains width without defining a viewport-centred track. `ShellSearch` is a fallback, whereas
`apps/web/src/search/header-search/header-search.tsx` supplies route registration, scope and filter regions.
A route that never registers the supported scoped mode cannot gain it from the fallback's appearance.
The cause is an integration seam, not a missing search-input component.

The header-search owner README explicitly leaves screenshot review pending and describes recorded suggestions and
supported route handoffs. Interaction checks for typing/links do not ask whether the combined header is centred,
whether two filled surfaces visually masquerade as two inputs, or whether a Collection scope is actually honoured.
The user impact is uncertainty about where a query runs and needless travel between header and body controls.
Correct the layout once at the shell seam; give the header one surface and a real route-bound scope/filter provider.
Verify the closed and expanded states in a real PageStory where registration, route state and focus are exercised.
Do not treat a scope chip as authority for a backend predicate that the route/API does not implement.

The isolated header Patterns provide more than the integrated pages expose. Enlarged
`shots/patterns-header-search--expanded--1280.png` shows a blue focus ring around a separately filled composer
above a second filled recent/trending surface. Filters is at the **left of a second row**, with a submit arrow at
its right; that is not the settled right-end Filters arrangement. The phone expanded Pattern does fill the screen,
so it would be wrong to say no full-screen implementation exists. Its `--scope-chip--390` state explicitly says
search is unavailable in Reading list and offers scope removal; this is a visible supported-boundary refusal,
not working scoped search. `--filters-open--390` opens another bottom sheet over the full-screen search, with
count-unavailable/loading dependencies. These isolated states do not repair the Collection/Home route integration.

The source makes the appearance and placement intentional: `header-search.tsx` gives the outer expanded form
`bg-background`, the inner composer `bg-card`/`md:bg-popover`, `focus-within:ring-2`, and a second-row
`justify-between` containing Filters followed by submit. The blue ring itself supplies useful focus visibility;
removing all keyboard focus treatment would be the wrong response to visual clutter. Adopt one coherent field
surface, preserve accessible focus indication, and move Filters according to the settled composition. Credit the
existing full-screen primitive while finishing its integration and shared filter surface.

**Defect class: broken panel containment; owner seam: UI Menu/custom dialog and Collection filter consumer.**
The supplied maintainer image `.temp/goal/web/refs/maintainer-20261031/rezics-filter-panel-bug.png` was visually
inspected. The popover background ends near the trigger's width while fields extend to its right over page content.
It is reference evidence of the reported failure. The enlarged current public
`shots/patterns-library-collection-filters--reference--1280.png` independently reproduces it: the white surface
ends near x160, while input fields extend to approximately x536. Concept-selected, word-range-applied,
combined-filters, no-matches and preparing desktop states also visibly share the containment defect.
The `patterns-collection-editor--dynamic-rule` pair exposes the same seam in another consumer: desktop fields
extend beyond the tiny surface; phone keeps a narrow popup, compressing numeric fields to roughly 35 pixels and
wrapping Apply/Clear labels. This differs from the contained phone Library filter Pattern and belongs in the
broken-layout count at both widths. Current dev source contains an exact structural explanation: `packages/ui/src/components/menu.tsx` sets custom
content width to `Math.max(triggerRect.width, 128)`, then uses that number as the fixed portal's inline width.
`apps/web/src/library/collection-filters.tsx` independently asks its inner form for approximately 32rem on desktop.
The outer surface and inner form therefore disagree about the width they own. The shadcn menu's anchor-width rule
is a separate branch; changing it alone would not repair this custom-content portal.

The proposed correction is an explicit form/dialog panel sizing contract, clamped to available viewport width and
height, with one scroll owner and collision-aware positioning. A form is not a list of menu items merely because
both open from a button. The selected phone search mode is full screen; filter content inside it should share that
surface rather than open a tiny floating desktop menu. Do not infer a current open-panel fix from a closed screenshot.
The all-matrix open states are identified in the manifest. The phone filter Pattern itself has a contained
bottom sheet; that isolated component can be visually finished without claiming that the required integrated
phone search panel or Collection-scoped header works.

**Accessibility and disclosure.** An actual combobox needs an accessible name, popup relationship, keyboard selection,
Escape and focus restoration, and predictable IME composition behavior. The W3C [combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
is the primary interaction reference. A scope chip and clear action must announce scope changes; hidden prior scopes
must not survive navigation under a global-looking field. Recent searches are viewer-private data, not public fixture
suggestions. A 390-pixel screenshot does not establish [WCAG reflow at 320 CSS pixels](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).
These are proposed review obligations; this audit did not execute an accessibility acceptance campaign.

### Collection page, covers and facts

**Defect class: broken phone grid action; owner seam: Library shelf consumer and UI CoverGrid.**
The enlarged `shots/pages-library-label-shelf--three-works--390.png` shows the unavailable member's
“Remove label from…” button cut off at the right viewport edge. The corresponding forty-works, shelf-actions
and retained-undo phone observations share the defect. The document width is 470 at a requested viewport of 390;
the screenshot confirms visible clipping rather than relying on that measurement alone. `LabelShelfEntries`
in `apps/web/src/library/shelf-view.tsx` places a plain `LabelAssignmentRemoveForm` below the unavailable-member
tombstone. Its single-line Button does not fit the fixed-density three-column phone grid in
`packages/ui/src/components/cover-card.tsx`. Normal member actions use a compact menu instead. The user loses a
readable/reachable removal action exactly when a member is unavailable. Keep that lifecycle action, but make it
fit the card through a compact labelled menu or a wrapping bounded control. Review the unavailable-card branch
alongside ordinary cards; shared grid reuse did not cover this consumer's different intrinsic width.

**Defect class: missing cover integration and inconsistent presentation; owner seam: Commerce/Library DTO, Semantic
presentation and Web Collection page.** The required `pages-library-collection--signed-in` pair renders members
and personal actions. Member covers are visibly present; it would be false to report that this current pair has no
covers anywhere. Its Collection heading has no Collection cover. Both facts matter: a partially improved delivery
still fails the requested coherent cover hierarchy.

`apps/web/src/library/collection-page.tsx` already has conditional `page.cover` rendering. The member list computes
its own member ratio. Therefore absence of a hero is not proof that no cover component exists; the projection/fixture,
authorised selection and fallback need to reach that component. `apps/web/src/stories/library-collection.stories.tsx`
uses recorded/constructed page data and mode overrides. A page assertion about member visibility or layout does not
prove that the Collection header read supplies a usable cover or that native fallback selection works.

The mixed-types grid pair shows a landscape film frame among portrait book frames. This agrees with the older
`docs/collection-presentation.md` fallback table (movies/anime landscape, albums square, unknown square), but conflicts
with the current settled portrait default for every kind. This is an adoption gap between design authority,
presentation defaults and consumers, not a request to choose the ratio again. Preserve landscape image content using
fit/contain or an explicit opt-in presentation; do not destructively crop or rewrite imported originals.

The existing cover contract describes owner-selected media, then currently readable ordered-member fallback, with
`none`/`pending` distinct from a fabricated empty cover. Preserve these distinctions. Missing or revoked media must
fall back without exposing private members, titles or counts. Re-evaluate at lifecycle/disclosure changes; a cached
image URL is not continuing authority. A candidate scan across millions of members is not an acceptable page read.
Use maintained bounded candidate observations and honest preparation when they are not ready.

**Defect class: unfinished information hierarchy; owner seam: Web Collection composition and typed FULL fact producer.**
Some Collection states expose compact facts, while illustrative variants explicitly supply example facts. Source
inspection shows bounded row-fact rendering, not a general guarantee that all native Collection reads supply them.
Keep that distinction visible in the capability matrix. Design a consistent title, type/context, concise facts and
personal-action order that works in list and grid. Missing authorised facts should not turn into guessed labels,
per-row detail fetching or arbitrary Type-derived cover shape. The source-selected page and batch fact budget remain
part of the backend seam, even when the UI is attractive.

At a million items, a page of 100 with four fact properties and three displayed values is at most 1,200 displayed
fact values, not permission to read the entire Collection or to hydrate 100 detail pages. This is desk arithmetic,
not a measured backend result. Per-page limits, selective dependency maintenance, continuation and retained work all
need explicit owner accounting. The current curated limit and dynamic-source contract are distinct capacities;
do not call the curated 5,000-occurrence cap proof of million-item dynamic readiness.

### Home is a product surface, not a heading and rows

**Defect class: unfinished composition and missing personal read; owner seam: Web Home, Library Continue and
Presentation composition.** The Home pair visibly begins with “A clearer view of what matters”. That is the
marketing tagline the maintainer rejected. Signed-out Home then shows homogeneous kind rows; signed-in Home adds a
Continue retry/unavailable panel. The signed-in story does not prove a working personalised home or a mixed feed.
Evidence: `shots/pages-discovery-home--signed-in--1280.png`, `--390.png`, and the signed-out pair.

`apps/web/src/routes/index.tsx` uses public route composition and a separate personal Continue query;
`home-queries.ts` obtains the public page and batch subject names. `apps/web/src/stories/home.stories.tsx` explicitly
names the member state as Continue unavailable pending native binding, and its play expects that alert. This is
honest failure-state exposure but a materially unfinished ordinary entry experience. The reason it can satisfy its
assertions is that those assertions deliberately protect unavailable semantics, not Home's product usefulness.

Recommend a compact mixed discovery surface with bounded groups and a clear return-to-work region, using only
currently authorised data. Do not pre-render a tab for each Realm, Space, kind or follow. Searchable context
selection, a short recent/pinned list, and a paged “more” route handle the upper bounds. Do not hide unavailable
personal data behind a successful empty “nothing here” message. Public discovery should remain useful if the
personal read fails.

Scope matters: `docs/scope.md` defers the following-feed capability. A catalogue discovery composition is not proof
that a ranked following feed exists. Adding a genuine following feed would need the owning scope/design adoption;
this report does not silently expand the contract while repairing the settled Home composition concerns.

### Purchase-entry Empty mounts much more than the asserted slot

**Defect class: incomplete fixture/composition boundary; owner seam: Web Subject Page providers and Commerce slot.**
The required `patterns-subjects-purchase-entry-slot--empty` captures must be read as the actual composed page shown,
not merely a missing slot node. Both widths show a cover, title, About/facts and two editions, followed by five
consecutive failed sections: Characters, Credits, Reviews, Discussion and Lists, each with “This section could
not be loaded” and Retry. The slot is absent, but the composed page is **missing data**, with unfinished hierarchy
as a secondary finding. The 390 image is over 2,000 pixels tall before the final contribution links; the desktop
also exposes the failed sections in the full document. These are the current public
`shots/patterns-subjects-purchase-entry-slot--empty--1280.png` and `--390.png`, not the older frozen capture.

`apps/web/src/stories/patterns/subject-purchase-slot.stories.tsx` mounts the full `SubjectPage` in `PatternStory`,
casts a recorded page through `unknown` to `SubjectPageData`, and supplies slot fixtures. Empty checks that the
purchase slot is absent and the Subject heading remains visible. Populated checks one owner slot in the header;
the comment explicitly disclaims entitlement/offer authority. Neither assertion establishes that all Subject
sections have valid read providers or that a purchase can be authorised, paid for or fulfilled.

The user impact of a broad page filled with failed sections is a false impression that an “empty purchase slot”
is a reviewed complete Subject experience. Correct the fixture at the seam that is actually exercised: an isolated
slot contract can remain a Pattern without a shell, but a composed Subject example needs working coherent Subject
data/providers. Never invent commerce availability to make a design screenshot look populated. Show legitimate
unavailable states as separately named states rather than using them as the only ready-page presentation.

### Subject Rating Ready is a local visual example

**Defect class: unfinished rating hierarchy and limited integration evidence; owner seam: Ratings/Presentation and Web.**
Both `shots/patterns-subjects-subject-rating--ready--1280.png` and `--390.png` render without a main error wall,
but remain **unfinished design**. The opened distribution is a three-column list of numeric bucket/count pairs,
including many zeroes, rather than a readable visual distribution. The same Global 8.4 / 1,203 ratings is repeated
in a separate Kokoro card below the primary block. Processing/Bayesian explanatory copy has comparable visual
weight to the result. At 390 the card's rating wraps at the far right; it fits, so this is not classified as a
broken-layout cell. The page is a local rating presentation example, not an integrated Subject rating journey.

`apps/web/src/stories/subject-rating/subject-rating.stories.tsx` obtains figures from `kernel/fake/ratings`.
The Ready play checks that “8.4” appears and opens distribution details; Vote updates component-local state.
`apps/web/src/features/pages/subject-ratings-view.tsx` renders per-Realm data and a numerical distribution list.
These are real interface components around fake/local data, not evidence of a persisted rating command, authorised
current figure, deletion propagation or production distribution query.

The proposed coherent rating slice places the useful score, count and own-rating action near the Subject identity;
shows one selected context and a bounded comparison list; and discloses the histogram, provenance and other contexts
progressively. A pile of equal-weight context blocks scales with the number of contexts and obscures the work.
Do not turn hundreds of Realms into initial-page DOM or separate requests. Keep unavailable, below-threshold,
forbidden-own-vote and unknown-count states semantically distinct. A missing count is not zero and a private vote
must not leak through public aggregates or stale local cache.

### Subject hierarchy and long-content behavior

**Defect class: missing dependent reads plus unfinished hierarchy; owner seam: Subject composition, Web and semantic
relation/figure producers.** Many Subject captures retain the identity/cover while reactions, edition-of,
characters, related sections or other reads say they could not be loaded. The visual distinction is partial data
failure, not successful empty relations. A page full of separately correct retry cards is not a finished reader view.
The manifest and atlas retain exactly which state and width exhibit this.

The inspected Goodreads references (`goodreads-subject-top.webp`, `goodreads-subject-full.webp`) show a stable
cover/identity/action region, bounded description with expansion, progressively disclosed details/editions and
ratings lower in the reading hierarchy. Bangumi and Letterboxd provide independently readable primary subject
pages with related information grouped into tabs/sections. These references disagree in visual density; the shared
pattern is prioritisation and disclosure, not copying one site's typography or assuming its backend model.

`apps/web/src/features/pages/subject.tsx` composes read plans and page layout; `subject-ratings-view.tsx` handles
some failures locally. The PageStory supplies a query provider, router and fake/recorded transport, but direct component exports that
bypass it can still reach hooks without the required provider. A visible “No QueryClient set” error is a
provider-composition defect, not proof that the Subject API is down. Diagnose each error against its actual fixture
and source boundary before grouping it with genuine unavailable reads.

Long editions, relations, labels and historical progress variants are valuable stress inputs. The Library label
capacity captures show many chips before secondary Subject information, while progress pages expose stored IDs,
unit/status vocabulary and long histories. Honest historical data is necessary, but ordinary reading views need
concise labels, bounded summaries and deeper inspection routes. Preserve historical meaning without making the
main page an implementation dump. This is a design recommendation, not permission to mutate old records.

### Catalogue/editor density and unavailable-first compositions

**Defect class: unfinished hierarchy and partial/blocked content; owner seam: Web catalogue, account, moderation,
Zones and source-owning read adapters.** This is not confined to the three maintainer examples. The exhaustive
atlas includes ordinary catalogue contribution, publication, context, source/provenance and moderation editors
that expose IDs, raw release/rank concepts, extensive explanatory paragraphs and equal-weight secondary controls.
Examples include `pages-catalogue-edit-facts`, `pages-catalogue-context-review`,
`patterns-subject-candidate-review`, `patterns-curation-presentation-resolution` and
`patterns-community-exact-revision`. Their full story IDs, states and widths are in the manifest; a family name
here is not a claim that every export has the same dominant class.

The cause is treating correct lifecycle vocabulary and broad fixture enumeration as a finished task hierarchy.
Users need an understandable primary action, readable current values and progressive provenance/advanced details;
maintainers still need exact recorded identifiers in the deeper inspection route. An authorisation refusal,
concealed revision or missing meaning must remain explicit. Keep their semantics, but distinguish a deliberate
boundary from a useful ready view, and do not equate a form retaining a draft with a successful dependent read.
The owner should review a coherent ready/edit/confirm/recovery journey, with source owners supplying current
read/command evidence; Web should not fabricate authority to replace unavailable records.

The blank claim-confirmation/journey cells are a separate incomplete observation, not evidence that the native
ownership transition is absent. Likewise, intentionally concealed member content is not a layout bug. Attribution
requires a bounded fresh observation and provider/fixture trace before claiming a backend defect. The matrix
preserves these distinctions instead of declaring the whole backend broken from a screenshot.

## Implemented, exposed and tested are separate capabilities

In this matrix, “source” means actual inspected code, not a claim that a runtime dependency is ready. “Published”
means the public screenshot/Storybook surface. No row claims newly executed native acceptance. Existing test files
or plays are evidence of intended assertions only; their existence is not a recorded passing execution.

| Capability                             | Specified/designed                                                        | Backend implemented in inspected dev                                                              | API exposed                                                                      | Interface exposed                                                             | Tested evidence and limit                                                                |
| -------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Centred scoped header and phone search | Settled composition; header owner handoffs exist                          | Search has bounded Subject query/suggestion implementations; grants and producers remain separate | Current Subject search protocol; a scope-specific predicate needs actual support | Header-search components/stories and fallback shell; integrated visual gaps   | Existing typing/keyboard plays; this audit observes pixels, not native query correctness |
| Generic mixed discovery                | Adopted handoff documented                                                | Legacy Subject runtime and opt-in composition are not whole mixed readiness                       | Consumer asks `representation: discovery-v1`; validates/refuses legacy response  | Shared `DiscoveryResults`, Search Pages/Patterns, illustrative mixed fixtures | README explicitly says fixtures are not native recordings/readiness                      |
| Search filters/facets                  | Shared filter/facet contracts                                             | Compiler, admission, count-free continuation machinery; incomplete producers/growth proofs remain | Existing grant-gated routes; unavailable is not ready empty                      | Composer/filter form, local chips, broken sizing seam                         | Tests can assert AST/state without testing panel geometry or native population           |
| Curated Collection members             | Ordered occurrences/notes and privacy contract                            | Stored metadata/member readers and native commands exist                                          | Existing Collection/member routes                                                | Real page components with recording/fixture modes, covers on members          | Published layout/interaction state is narrower than current native lifecycle proof       |
| Collection hero cover                  | Owner media, readable ordered fallback, pending semantics                 | Existing Content checks and pieces of selection integration; complete DTO path must be traced     | Optional cover fields do not prove every native reader enriches them             | Conditional hero renderer; named pair lacks hero                              | No success inferred from optional field type or member images                            |
| Portrait default all kinds             | Settled current choice                                                    | Older presentation defaults still vary by Type                                                    | Presentation values can expose old ratios                                        | Mixed grid displays landscape/square forms                                    | Screenshot exposes adoption gap; no policy changed here                                  |
| Saved dynamic Collections              | Private rules, source generations, public explicit COMPLETE outputs       | Parser/admission/CAS/source adapters; missing producer bindings refuse/preparing                  | Rule read/create/edit interfaces with current authority checks                   | Real rule editor plus explicit preparing/unavailable states                   | Source typing and fixture cases do not prove million-item native currentness             |
| Library shelf/Continue                 | Private owner state, cursor/generation/currentness                        | Shelf readers/maintenance pieces; generation adapters still incomplete                            | Callable/mounted boundaries can return typed dependency unavailable              | Library and Home Continue unavailable panels are exposed                      | No zero-count readiness inferred; no backend measurement                                 |
| Subject rating figures                 | Context-specific figures and own-vote semantics                           | Rating/domain source exists; full native integration not exercised here                           | A production endpoint is not exercised by local-state Vote                       | Ready fixture, details list, local Vote and fault states                      | “8.4 visible” and local update do not cover visual hierarchy or persistence              |
| Purchase entry                         | Slot ownership and offer/entitlement seams                                | Commerce authority belongs to Commerce, not slot fixtures                                         | Empty Pattern does not establish purchasing API availability                     | FeatureSlotsProvider example with illustrative owner region                   | Slot absence/header assertion only; no payment/entitlement proof                         |
| Home discovery                         | Public composition plus separate personal region; following feed deferred | Public composition read/batch name and private Continue seams                                     | Existing page/query paths, not a new general feed                                | Tagline/kind rows and member unavailable state                                | Expected unavailable alert can pass while ordinary Home remains incomplete               |
| Public/private account/follow state    | Disclosure and private totals explicit                                    | Current account/library authority pieces, source-dependent readiness                              | Visibility/currentness, not CSS, decides available fields                        | Denied/hidden/unavailable stories show designed states                        | Screenshots cannot prove request concealment, cross-viewer isolation or erasure          |
| Full shell integration                 | Required only for exercised navigation/header/focus flows                 | No backend claim inherent in a shell                                                              | No endpoint readiness established by a decorator                                 | PageStory memory router/query transport; standalone Patterns also exist       | Working shell and providers must be observed for claimed integration                     |

Search source anchors include `services/kernel/src/search/http/routes.ts`, `search/hits.ts`,
`search/facet-discovery-runtime.ts` and its README. Library anchors include `library/collection-reads.ts`,
`collection-rules.ts`, `collection-source-native.ts`, the shelf contract and README. These contain meaningful
implementation; they also describe explicit absent readiness/currentness bindings. This report neither erases
that work nor promotes its diagnostic types into complete product capability.

## When Pages needs a full shell

A Pages story needs the actual functioning shell when its exercised claim includes global navigation, route-aware
header registration/search, Account state, locale routing, phone bottom navigation, overlays anchored to the header,
focus return or search/filter state surviving a transition. The shell must have working required providers and a
coherent route/transport state. A screenshot of the shell around a retry wall is not a working page proof.

A page-content/layout study or error-state Pattern can be isolated when its claim is explicitly limited and the
exercise does not depend on shell behavior. Adding every shell to every Pattern would repeat navigation chrome,
slow review and conceal provider requirements rather than solve them. Conversely, a Pattern that mounts most of
SubjectPage already exercises broad page dependencies even if its export name says “slot”. Its harness must match
those dependencies or reduce its claim and mounted composition.

`apps/web/src/stories/page.tsx` is the useful integration boundary: memory router, generated route tree,
QueryClientProvider, request context and recorded/fake transport. It is not an actual native SSR/browser session.
Keep isolated component evidence and integrated page evidence separately labelled. Shell-only controls that are
visible but unusable must never be counted as interface-complete because the main heading exists.

[Storybook decorators](https://storybook.js.org/docs/writing-stories/decorators) explain providing context;
[its visual-testing documentation](https://storybook.js.org/docs/writing-tests/visual-testing) distinguishes visual
comparison from interaction assertions. Those current docs were read on the research date; the pinned preview source,
not a different stable documentation version, explains this public alpha build's mechanics.

## Primary product comparison

The following is a bounded survey of about twenty relevant Chinese and international products, read on 2026-10-31.
Official help/public pages are primary evidence, not an authenticated usability study. Access failures are recorded
rather than filled from recollection. No translation service, scraping bypass, account operation or reference build
was used. Product text/images remain their owners' copyrighted material; no licence to copy their assets is assumed.

| Product and primary source                                                                                                                                                                                                        | Observed pattern or explicit evidence limit                                                                                                                                                                                                | Relevance                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| [Reddit search help](https://support.reddithelp.com/hc/en-us/articles/19696541895316-Available-search-features)                                                                                                                   | Community scope can be removed to broaden search; explicit refinements. Supplied desktop/phone images additionally show one cohesive search panel and Recent/Trending regions.                                                             | One understandable scope, one field, phone panel; screenshot is supplied reference, not this audit's live Reddit session.              |
| [X timeline help](https://help.x.com/en/using-x/x-timeline)                                                                                                                                                                       | For You and Following are distinct timeline modes, rather than a tab for every followed identity.                                                                                                                                          | Bounded top-level modes; no recommendation to adopt its ranking or marketing.                                                          |
| [GitHub code-search syntax](https://docs.github.com/en/search-github/github-code-search/understanding-github-code-search-syntax)                                                                                                  | Explicit qualifiers constrain search meaning; code-search semantics have their own scope.                                                                                                                                                  | Scope is a query contract, not a decorative label.                                                                                     |
| [YouTube filtering help](https://support.google.com/youtube/answer/111997?hl=en)                                                                                                                                                  | Search results support explicit refinements such as content type.                                                                                                                                                                          | Keep query and refinements connected.                                                                                                  |
| [Discord search help](https://support.discord.com/hc/en-us/articles/115000468588-How-to-Use-Search-on-Discord)                                                                                                                    | Channel, author, date and content refinements are explicit.                                                                                                                                                                                | Progressive structured search; not an unbounded set of context tabs.                                                                   |
| [Slack search help](https://slack.com/help/articles/202528808-Search-in-Slack)                                                                                                                                                    | Search and refinements are documented together. Only official help, not a private workspace, was inspected.                                                                                                                                | Do not claim cross-workspace/private disclosure behavior from a public screenshot.                                                     |
| [Notion search help](https://www.notion.com/help/search)                                                                                                                                                                          | Search window includes recent pages, sort and filters; database search and workspace search have different coverage.                                                                                                                       | Scope differences must be explained; recent history belongs to the current viewer.                                                     |
| [Steam public search](https://store.steampowered.com/search/)                                                                                                                                                                     | Results are paged; sort, price and tag refinements are separate structured controls.                                                                                                                                                       | Large taxonomy needs search/refinement and bounded result pages. Desktop page only, no authenticated mobile claim.                     |
| [Spotify Your Library help](https://support.spotify.com/us/article/your-library/)                                                                                                                                                 | Saving an album and saving all its songs are different operations; Library filtering/search and Liked Songs have distinct meaning.                                                                                                         | Avoid collapsing follow, like, collection membership and progress into one personal state.                                             |
| [StoryGraph official site](https://www.thestorygraph.com/)                                                                                                                                                                        | Product illustrations show mood/pace/genre refinement, tags/lists and reading statistics.                                                                                                                                                  | Useful presentation evidence; marketing illustrations do not prove live authenticated backend behavior.                                |
| [Goodreads subject](https://www.goodreads.com/book/show/199510278-glorious-exploits)                                                                                                                                              | Live access failed; supplied top/full images were actually inspected. Bounded synopsis, cover/actions and expandable details are visible there.                                                                                            | Visual reference only; no claim of current logged-in behavior or current implementation.                                               |
| [Bangumi subject](https://bgm.tv/subject/253)                                                                                                                                                                                     | Public subject has grouped overview, chapters, characters/staff, relations, comments, reviews and discussion navigation.                                                                                                                   | Chinese reference for dense catalogue information with hierarchy; no private actions exercised.                                        |
| [Douban book help](https://help.douban.com/tiaomu?app=4)                                                                                                                                                                          | Official help distinguishes book search from movie/music/community search, supports title/author/translator/ISBN, and describes separate version relationships. The subject URL failed, but this different official help URL was readable. | Chinese primary evidence for explicit search coverage and edition hierarchy, not a current subject screenshot.                         |
| [AniList query reference](https://docs.anilist.co/reference/query)                                                                                                                                                                | The public search UI returned 403; official API documentation describes media filters and a page maximum of 50.                                                                                                                            | Technical support for bounded discovery, with no claim that the inaccessible current UI exposes every documented filter.               |
| [Letterboxd Parasite](https://letterboxd.com/film/parasite-2019/)                                                                                                                                                                 | Public page groups cast, crew, details, genres and releases, with progressive cast disclosure.                                                                                                                                             | Subject hierarchy and secondary information; authenticated diary/ratings not exercised.                                                |
| [Apple Books iPhone guide](https://support.apple.com/en-ae/guide/iphone/iphab219b91/ios)                                                                                                                                          | The Mac guide failed; the iPhone guide documents custom collections, display/sort and a Library cover view.                                                                                                                                | Product documentation with an illustrated view; no device session or cross-region availability claim.                                  |
| [Qidian publisher product page](https://www.yuewen.com/app/?type=appqd)                                                                                                                                                           | The catalogue home supplied no readable page; the publisher describes a private customised shelf, synchronised progress, recommendations, book lists and chapter discussion.                                                               | Chinese reference separating personal continuation from discovery/community; publisher description is not measured working behavior.   |
| [Google Search refinements](https://support.google.com/websearch/answer/2466433?co=GENIE.PlatformDesktop&hl=en)                                                                                                                   | Refinements stay below search; available filter order varies with query. Advanced Search is a distinct deeper control.                                                                                                                     | Progressive disclosure with query-dependent controls; not a requirement to copy its placement over REZICS's settled right-end Filters. |
| [Netflix browsing](https://help.netflix.com/en/node/47765) and [My List](https://help.netflix.com/en/node/10523)                                                                                                                  | Browsing rows and personal saved titles have separate semantics. The documented list has a 2,000-title bound and mobile sort/filter; availability changes can hide titles.                                                                 | Separate discovery from personal state and lifecycle. This capacity is far below a million and supplies no REZICS growth proof.        |
| [Obsidian Search](https://obsidian.md/help/plugins/search)                                                                                                                                                                        | Vault search and current-note find differ; empty search exposes recents, and structured properties have explicit syntax.                                                                                                                   | Coverage, private history and structured refinement; local-vault costs do not transfer to partitioned server queries.                  |
| [Kobo collections](https://help.kobo.com/hc/en-us/articles/360033887953-Organize-your-eBooks-on-your-Kobo-eReader) and [filters](https://help.kobo.com/hc/en-us/articles/360017676993-Use-the-search-filter-on-your-Kobo-eReader) | My Books contains collections and explicit purchased/downloaded/read-state filters; collections synchronise across devices with possible delay.                                                                                            | Personal grouping, state and synchronisation are distinct from catalogue identity; no live eReader session exercised.                  |
| [Google Play Books library](https://support.google.com/googleplay/answer/9402600?co=GENIE.Platform%3DAndroid&hl=en)                                                                                                               | Shelves, Series, progress/author/genre filters, multi-filter Apply and list sorting are documented separately; some controls require named Android versions.                                                                               | Explicit action and surface/version boundaries, rather than assuming a screenshot proves every platform.                               |

Additional access limits were preserved rather than counted as observed designs: [MyAnimeList](https://myanimelist.net/anime.php),
[VNDB](https://vndb.org/v/all), [Trakt](https://trakt.tv/shows) and [Discogs](https://www.discogs.com/search/) failed or refused access;
[WeRead](https://weread.qq.com/) returned no readable content; [Bilibili](https://www.bilibili.com/) returned a browser-upgrade wall.
No current layout, authenticated behavior or missing capability is inferred from those failures.

The accessible sources share a small number of explicit modes/scopes, progressive filters, bounded first-page
results, and a hierarchy that separates identity/actions from details. They disagree about density, feed ranking,
which contexts are public, and whether search lives in a modal or page. REZICS already has settled choices for its
header and phone panel; those disagreements do not reopen them. Native library state, catalogue relations, public
lists and commerce availability should remain separate semantics even when shown together.

### Established open-source source evidence

Existing clones were reused read-only under the primary checkout's `.reference/`; no install, build or execution.
The reference index records this audit's topic, URL, commit, licence and date. Recommendations concern designs to
implement in REZICS's React/TypeScript stack, not files or long passages to copy.

| Project, pinned source and licence                                                                                                                                         | Finding and transfer limit                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Storybook](https://github.com/storybookjs/storybook/tree/0798ec85fdba7001777219b4f6a8eb8de75f1ee9), MIT; `.reference/storybook-practice/storybook`                        | `code/core/src/preview-api/modules/preview-web/PreviewWithSelection.tsx` receives `SET_CURRENT_STORY`; `render/StoryRender.ts` separates renderer/play phases. Supports the observation method, not a design-completeness inference.                                                                                                                                         |
| [Primer React](https://github.com/primer/react/tree/f733dcb2b086c6da7902bfecfcf68cd61c7daab3), MIT; `.reference/storybook-practice/primer-react`                           | `packages/react/src/SelectPanel/SelectPanel.tsx` has anchored/modal variants, responsive full-screen options, focus and live-region behavior; its CSS keeps list height within the overlay. Adopt explicit panel sizing/scroll/focus ownership in existing UI primitives; do not install another design system.                                                              |
| [BookWyrm](https://github.com/bookwyrm-social/bookwyrm/tree/fe2fa0bd2b16f1d95030d8ac1d41139e51b8cde4), Anti-Capitalist Software License 1.4; `.reference/shelves/bookwyrm` | `bookwyrm/templates/book/book.html` composes identity, cover/shelving, editions and reviews; `bookwyrm/views/books/books.py` applies viewer-sensitive review filtering and edition selection. Learn the hierarchy and viewer boundary; the restrictive licence is not permission to copy implementation. Its Django query costs do not establish REZICS's partitioned costs. |

## Old REZICS and legacy evidence

The old REZICS checkout was read only at `/home/edge/projects/rezics/rezics`, revision
`95167ceab7173dc1c5fb0ee70568c5c95f1dba8d`. Its
`apps/web/app/(app)/page.tsx` delegates to `apps/web/features/explore/home.tsx`. That source uses `ApiFeedList`
with query state for sort, content kinds, languages, Realm IDs and tags. It supplies a useful mixed-feed behavior
reference without a marketing hero. Arrays of selected contexts are not proof that loading an entire 200,000-kind
catalogue or thousands of follows is bounded; server query plans and chooser pagination would still need design.
`apps/web/features/collections/pages/collection-detail-page.tsx` includes a conditional Collection cover and a
content feed. That is actual source evidence for the missing hierarchy concern, not permission to copy the old page.

The new repository's read-only `legacy-final` resolves to `1ac6ed6e0668f04e30025c41e59ceaf3bdee5061`.
`git show legacy-final:apps/web/features/home/home-page.tsx`, `home/tabs.tsx`, `home/followed-concept-feed.ts`
and `home/rail.tsx` show a feed provider, Continue strip, bounded concept tabs/overflow and mixed discovery regions.
The followed-topic source uses 20 follows per page, 20 feed items by default and a maximum feed page of 64;
it would be inaccurate to say this source blindly renders a tab for every follow. In contrast, `rail.tsx` maps
every supplied `moderated` entry into a queue link and reduces all of them for its total; if the producer supplies
hundreds of moderated Realms, that rail grows with them. Bound the supplied summary/window and provide a deeper
route rather than hiding a full-array read behind a small-looking rail. The tab bounds still do not prove that all
backend work, selective invalidation or ranking remains bounded at current partition/disclosure upper bounds. Reuse behavior as evidence and redesign
within current authority; no merge, wholesale port or legacy runtime campaign occurred.

## Upper bounds, lifecycle and cross-surface correction

These are desk estimates and proposed invariants, not measured performance or adopted budgets.

| Risk                   | Upper-bound failure if implemented naively                                                                                                             | Recommended shape and owner seam                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Context navigation     | Hundreds of Realm/Space tabs exceed phone width and make initial work grow with membership.                                                            | A bounded recent/pinned subset plus searchable/paged selection; Web with Account/context discovery.                                                          |
| Kind selection         | 200,000 options in a select or initial JSON payload is not a usable chooser. Even 100 bytes per option would be about 20 MB before framework overhead. | Server-supported bounded discovery with continuation, explicit selected values and release/currentness; Search/Semantic.                                     |
| Follows                | Thousands of subscriptions must not become thousands of initial tabs or per-follow reads.                                                              | Bounded mixed query/feed admission, explicit pagination, generation-aware caches and honest unavailable states; Account/Library/Search.                      |
| Collection lists       | A million-item materialisation, cover scan or per-member detail hydration makes ordinary navigation unbounded.                                         | Current source-selected pages, bounded batch FULL facts and maintained cover candidates; Library/Commerce/Content.                                           |
| Rating contexts        | Rendering/requesting one figure block per Realm grows with all contexts and drowns the useful score.                                                   | Selected context plus a bounded comparison/disclosure route; Ratings/Presentation/Web.                                                                       |
| Error fan-out          | A separate retry panel per failed dependent read creates a wall of repeated alerts and uncontrolled retry fan-out.                                     | Keep identity and primary action useful; summarise shared dependency failure, retry at an admitted boundary, distinguish independently recoverable sections. |
| Cover revocation       | Cached member/media references can disclose revoked private content after a visibility change.                                                         | Current original/terminal disclosure, authorised media variants, generation invalidation and cleanup; owner source remains authoritative.                    |
| Private history/search | Recents, label names, reading progress or own-vote state can leak across viewers or public previews.                                                   | Viewer-scoped query keys, current authority before projection, no private criteria in public outputs; noindex/private preview policy.                        |
| State changes          | Rule/type/release/source changes can leave stale scope, cover, facts, counts or cursors under a fresh-looking UI.                                      | Bind continuation/selection to current generation and query; explicit reset/refusal/preparing states, preserving drafts and historical records.              |
| Phone interactions     | A page can fit at 390 while an expanded filter, virtual keyboard or bottom bar obscures its action.                                                    | Exercise the actual full-screen panel, safe scrolling, focus return, backdrop and keyboard; static screenshots are insufficient certification.               |

For concrete scale, a proposed first review budget could be 20 discovery cards, 50 chooser matches, five recents
and ten pinned contexts per initial surface, with explicit continuation. These are illustrative design budgets for
owner adoption, not current promises or measured limits. At 200,000 kinds, 50 matches is 1/4,000 of the catalogue;
at one million Collection items, a 40-row member page would be 1/25,000 of the collection. The backend cost must
follow the selected window and bounded enrichment batches, not require scanning those entire populations to find
that window. Keeping 20 cards but issuing one request per followed identity still fails the thousands-of-follows
bound. Rating comparison and cover fallback also need explicit bounded producers, not merely a visually limited
consumer. No latency, memory, throughput or database-growth measurements were run.

Cross-surface consistency requires the same portrait-default rule in Home, search, Collection list/grid, subject
relations and compact Library cards; the same search scope semantics in header, results, URL and back navigation;
and the same empty/unavailable/private distinctions in full pages and Patterns. A shared primitive helps only if
consumers agree on its contract. Do not repair the Collection filter by breaking menu lists elsewhere, or make
Subject look complete by supplying invented backend facts.

Security here is a source/design review, not an executed penetration test. Public Storybook fixture data and fake
viewer states do not establish real access control. Account privacy, current read grants, original/terminal
visibility, public publication boundaries, media authority, erasure and retained-history semantics stay with their
owners. The backend addendum's completeness questions cannot be answered from Web screenshots alone.

## Recommended coherent delivery slices

Order and size are planning estimates, not tickets, promises or adopted contracts. Each slice should update its
owning document only after the manager adopts the recommendation. Existing acceptance must not be weakened to
make the current public gallery appear complete.

| Order / approximate size    | Whole outcome                                                                                                                                                                     | Dependencies and evidence required at delivery                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 / small–medium            | Make the gallery's normal ready page compositions actually render; distinguish isolated Patterns from integrated Pages and remove missing-provider/incompatible-fixture failures. | Existing router/query/transport providers; direct-visit and navigation comparison; retain explicit fault states and errors. No fabricated native data.             |
| 2 / medium                  | Deliver one centred scoped header, one filled surface, right-end Filters and the selected phone full-screen panel with contained filter forms.                                    | UI panel sizing contract, route registration, actual supported query semantics, focus/back/IME behavior; review closed/open/submitted/error states at both widths. |
| 3 / medium                  | Make Collection identity and all catalogue cards share portrait defaults, readable image preservation, cover fallback semantics and concise FULL facts.                           | Adopt settled default in Semantic/presentation owner contract; actual authorised Collection cover/fact projection; no unbounded fallback scans.                    |
| 4 / medium                  | Deliver a useful Home without tagline: bounded mixed public discovery and a working or gracefully independent personal continuation region.                                       | Existing public composition and honest Library readiness; no accidental adoption of a deferred following-feed capability.                                          |
| 5 / medium–large            | Deliver a coherent Subject identity/action/summary/details/ratings hierarchy; narrow purchase-slot examples or supply complete page dependencies.                                 | Subject read plan and current relation/figure batches, bounded context chooser, accessible progressive disclosure; commerce ownership unchanged.                   |
| 6 / owner-sized native work | Close the specific producer/currentness/API seams exposed by useful ready interfaces, including mixed discovery and private shelf readiness.                                      | Owning contracts and their native lifecycle/disclosure/growth evidence. Not a visual-polish follow-up that can be inferred from screenshots.                       |

For every slice, retain a matrix of designed, implemented, API-exposed, interface-exposed and executed evidence.
A screenshot approval should name source, exact story, state, viewport and limitations. Interaction assertions should
protect behavior while visual review protects hierarchy/containment. A normal-state assertion that only waits for a
heading or a number is insufficient evidence for the whole composed page.

No new maintainer-only choice is needed to repair the settled header, cover defaults or removal of taglines.
If a genuinely ranked following feed is proposed beyond the current scope, the options are to retain bounded public
catalogue discovery or explicitly adopt that separate capability with its owners; recommend the former for this
repair. This is the one scope boundary to resolve before expanding the work, not a reason to delay the settled fixes.

## Delivery record

The completed evidence root is mirrored at the exact primary-checkout location above, including the raw index,
final snapshots, all 3,798 PNGs, per-cell diagnostics, 134 visual sheets and final manifest/classifications.
The audit's browser profile is deliberately excluded from that reusable mirror; it is temporary browser state,
not necessary research evidence. Existing publishers, the old frozen `c2c7` capture and other researchers' files
were preserved.

Decisions made in this report: use the current public index as the exhaustive denominator; credit portrait/member
covers and the isolated full-screen search primitive where they actually exist; count intentional fault states by
visible class without calling them unexpected product failures; treat hash-identical PNGs as shared visual evidence;
retain still-running and blank observations explicitly; require shell integration only for the claim exercised;
attribute missing providers to the mounted subtree rather than to a supposed failed native API. Settled product
choices remain inputs. Recommendations await owner adoption.

No tracked file outside `docs/research/web-completeness-audit.md` changed. Outside that declared report path, ignored
`.temp/goal/web/research-shots/web-completeness-audit/` artifacts in this worktree and the primary checkout were written
because the contract requires reusable progressive capture. Authority/reference images were staged under the exact
worktree `.temp/goal/web/refs/` and `.temp/goal/supermanager/refs/` paths for read-only inspection. The primary
`.reference/INDEX.md` gained reuse/provenance entries for the existing Storybook, Primer React and BookWyrm clones;
no clone was installed, built or run. These are the explicit research exceptions, not product changes.

Only this English report is a tracked worktree change. Ignored scripts, screenshots, manifests and reference-index
entries are research evidence under the explicitly authorised locations. Reference-index additions document reuse,
not adoption. No product workspace changed, so there is no applicable workspace compiler to run. Original acceptance,
native/browser test campaigns, root checks, gates and promotion remain deferred under the execution policy; public
browser observation in this report is the expressly authorised research capture. This source report is not whole-Web
Goal or native completion.
