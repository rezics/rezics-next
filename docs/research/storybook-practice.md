# Storybook as the frontend review surface

Research date: 2026-10-29. Repository observation: `643158ee2e1f1dd1ebb8bdafe20a61d88ef99005`.
This is evidence and a proposed work plan, not an adopted interface or testing contract.

## Recommendation

Make `storybook.rezics.com` a review catalogue of real pages and reusable product compositions. Lead with Library,
Collections and representative subject pages. Retain the primitive regression suite, but put its catalogue last.
Spend new story work on meaningful states, permissions and interactions rather than another rendering of an
unchanged upstream primitive. Keep recorded-response route stories, the existing Vitest browser integration and
failing accessibility checks. Add a small, explicitly enumerated local screenshot comparison suite after improving
the review fixtures. Publish an immutable static artifact for each reviewed development commit and point the main
domain at the newest successfully published build. No paid visual testing service is required.

The target is a reviewer who can open a deep link, identify the commit, switch phone/desktop, locale and theme,
and inspect a complete product state without a running backend. Passing that fixture does not prove the backend's
authorization, disclosure, indexing cost or lifecycle behavior. Those remain native acceptance responsibilities
under [verification](../development/verification.md) and the [web outcome](../goals/web.md).

## What exists and what it proves

The contract's 125 stories are **125 source files**, not 125 enumerated states: 97 files under
`packages/ui/src/components`, 27 under `apps/web/src/stories`, and `apps/web/src/shell/page-heading.stories.tsx`.
Counting named `export const` declarations gives 387, 62 and 2 respectively; this rough inventory includes the
intentional accessibility failure probe and does not establish indexed or passing coverage. The web Storybook's
current glob includes only `src/stories`, so the separate page-heading file is not part of that published surface.
There are 30 route modules including the root shell and canonical/redirect variants. Sources:
[web configuration](../../apps/web/.storybook/main.ts), [UI configuration](../../packages/ui/.storybook/main.ts),
[page stories](../../apps/web/src/stories/), [routes](../../apps/web/src/routes/).

Both packages pin Storybook and its React-Vite, Vitest and accessibility addons to **11.0.0-alpha.8**, alongside
Vitest **5.1.0-beta.1** and Playwright **1.64.1**. Research therefore uses the **11 alpha** documentation and the exact
Storybook tag, not advice for versions 6–8 or an assumption that 11 is stable. The installed release records React
prebundling fixes; earlier 11 alpha entries record Vitest 5 support and changes to test setup. The migration guide
requires Vitest 4 or later and removes manual `setProjectAnnotations` calls from addon setup. Keep these pins aligned;
do not mix old `@storybook/test` examples with this repository's `storybook/test`. No dependency upgrade is proposed.
Evidence: [web manifest](../../apps/web/package.json), [UI manifest](../../packages/ui/package.json),
[release notes][sb-release], [tagged migration guide][sb-migration].

The existing previews already apply eight locales and light/dark themes and use `a11y.test: 'error'`.
Both Vitest configs use `storybookTest` with Playwright Chromium; neither enumerates all global combinations.
The UI preview declares phone/desktop viewport presets; a toolbar option alone neither resizes a headless test
browser nor multiplies its tests. Page stories use the real generated route tree, memory history and a fresh query
client, with Start/Workers adapters and recorded kernel responses. This is valuable integration evidence, although
it does not run Worker SSR. Sources: [web preview](../../apps/web/.storybook/preview.tsx),
[UI preview](../../packages/ui/.storybook/preview.tsx), [web Vitest](../../apps/web/vitest.config.ts),
[UI Vitest](../../packages/ui/vitest.config.ts), [PageStory](../../apps/web/src/stories/page.tsx).

The [existing capture script](../../apps/web/scripts/screenshots.ts) builds once and captures selected stories,
locales, themes and a requested width, waiting for rendering and fonts. It writes review PNGs, not baseline
comparisons. Its default is desktop, every story, eight locales and two themes; it is unsuitable as the default
per-edit command. The [web README](../../apps/web/README.md#storybook-and-page-recordings) describes recording and
capture. The actual page-response type assertion is in
[page-stories.test.ts](../../apps/web/tests/page-stories.test.ts), even though the README names a separate test.

## Primary-source practice

### Stories, hierarchy and state enumeration

Storybook defines a story as one rendered state and supports both small components and composed screens. Its page
guide presents two approaches: pass data into presentational screens, or mock dependencies of connected screens.
Composed args can reuse child fixtures. It does not require every page to be rewritten as a presentational component.
[Story model][sb-stories], [page guide][sb-pages], [multiple components][sb-composition].

| Source inspected    | Observable practice                                                                                                                                                                                                                                                                                                                                                                                                                  | Application to REZICS                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Primer React | `SelectPanel` has default, feature, example and development stories; named examples include async fetching and customized no-results behavior. The Storybook config excludes `.dev` stories from production. Its preview deliberately sorts README, playground, features and examples and supplies theme and breakpoint controls. [Panel][primer-panel], [features][primer-features], [main][primer-main], [preview][primer-preview] | Separate understandable product examples from exhaustive developer diagnostics. Use explicit named async, empty and failure states.                  |
| Microsoft Fluent UI | Public Button stories collect appearance, shape, size, disabled, loading and long-text examples with description and best-practice text. A separate visual-test app enumerates dark, high-contrast and RTL variants and captures default, hover and pressed states. [Public stories][fluent-public], [visual stories][fluent-visual], [steps][fluent-steps]                                                                          | A prop gallery and an interaction-state regression suite serve different readers. Keep state variants selective and explicit.                        |
| BBC Simorgh         | The Home Page story wraps the real page in service/request/theme context and loads local service-specific JSON. It distinguishes an interactive example from selected hidden test variants. Error Page names 404/500 cases across services. The preview supplies service selection; a docs wrapper includes README and health metadata. [Home][bbc-home], [errors][bbc-errors], [preview][bbc-preview], [docs][bbc-docs]             | Page stories are useful alongside component stories. Language/service context and difficult failures deserve fixtures; docs should expose readiness. |

These are observations of the pinned public source, not claims about each company's entire internal workflow.
Primer and Fluent are design systems, so broad primitive coverage is rational for them. REZICS consumes a primitive
system and must additionally review domain behavior. BBC provides the closest inspected page-level example.
These three teams provide complementary evidence; the report does not infer a universal percentage of stories
that should be primitives or claim a comprehensive survey of every named design system.

Shared patterns are named reproducible states, shared context, examples separate from diagnostics, explicit visual
dimensions, and explanatory documentation. The implementations differ: BBC uses local JSON fetches and selected
Chromatic stories, Primer has a local Playwright screenshot suite, and Fluent has Storywright interaction steps.
Adopt the patterns with this repository's React/TanStack adapters; do not copy their infrastructure or infer that
their choice of hosted testing is necessary. [BBC home][bbc-home], [Primer screenshot tests][primer-tests],
[Primer runner configuration][primer-runner], [Fluent steps][fluent-steps].

### Data, globals and coverage

Args express component inputs; controls let a person explore them. Persist important outcomes as named stories:
an arbitrary control setting is not a reproducible test case. Storybook supports slash-separated titles, explicit
sorting and tags. Tags can distinguish review, regression and planned examples without pretending that a sidebar
filter is a test exclusion. The `dev` and `test` tags have separate meanings. [Hierarchy][sb-hierarchy],
[args][sb-args], [tags][sb-tags].

Use globals for theme, locale and viewport context, not the subject's state or viewer permissions. Global decorators
must actually apply the selected value. Storybook's Vitest plugin accepts `initialGlobals` per project, permitting
explicit theme/locale runs; browser dimensions must also be set in browser configuration. A global toolbar is an
exploration tool, not a coverage report. [Globals][sb-globals], [Vitest integration][sb-vitest].

Storybook recommends args for ordinary fixture data; loaders run before rendering and are an advanced escape hatch
for asynchronous preparation. A loader that preloads the answer cannot, by itself, demonstrate the page's in-flight
loading state. Its network-mocking guide documents MSW interception and per-story overrides, including success and
failure responses; the inspected 11 guide uses **MSW addon v3** conventions, so old v2 snippets need care.
[Loaders][sb-loaders], [network mocks][sb-msw].

For REZICS, retain real recordings as the data authority for implemented response shapes. Add small named scenario
overrides to the existing fake/adapters rather than introducing a second parallel mock transport. Recordings and
MSW solve different problems: recordings supply data, MSW intercepts requests. Consider MSW only if new browser
requests bypass the existing adapter, reusing those same JSON payloads. It is unnecessary for pure composites and
cannot intercept a Worker binding invocation occurring outside the browser. Do not replace real routing with a
story-only lookalike page. This recommendation follows the current [recording interface](../../apps/web/README.md#storybook-and-page-recordings)
and [Start adapter](../../apps/web/.storybook/react-start.ts).

Measure two distinct things. Code coverage measures executed statements/branches, not whether every product state
exists; Storybook's coverage guidance describes coverage of the tested stories and requires an appropriate Vitest
coverage provider. Product coverage needs an explicit denominator. Do not report the number of files, automatic
render tests or a line-coverage percentage as proof of complete UI coverage. [Code coverage][sb-coverage].

Proposed coverage ledger: each required scenario has a surface, owner-document anchor, persona, fixture provenance,
stable story ID, interaction assertion, required visual tuples, implementation status, last passing commit and last
human review commit. Distinguish **specified**, **backend implemented**, **interface exposed**, **story tested** and
**visually reviewed**. Missing/not-yet-implemented rows stay visible in the denominator. Publish counts of implemented
required scenarios with stories, required interactions passing, required screenshots reviewed, and blocked rows.
Optional code coverage is a diagnostic run on an owner-selected schedule, not a new per-brief percentage gate.

## Proposed review catalogue and existing-story disposition

Order the main sidebar as `Review`, `Pages`, `Patterns`, `Components`, then the existing `shadcn` group. Under Pages,
order `Library`, `Collections`, `Subjects`, `Discovery`, `Community`, `Commerce`, `Account`. Under Patterns, group by
user job: browsing a shelf, filtering members, editing a contribution. Keep components alphabetical within groups.
Use `storySorts` in `.storybook/main.ts` and tags before moving files. The installed 11 alpha no longer reads
preview `parameters.options.storySort`; adopt Primer's ordering principle without copying its older configuration.
Preserve stable story IDs and current acceptance-required names. Storybook supports explicit IDs for preserving
links when titles change; title changes otherwise change derived IDs. [Hierarchy][sb-hierarchy],
[exact-version sorting migration][sb-sorting-migration], [permalinks][sb-permalinks].

Publish one review entry with local page stories and a built UI Storybook under `/ui/`, linked or composed into the
manager using relative `refs`. Composition can expose another built Storybook without rebuilding its components in
every web story. A single root manager with local UI stories is an alternative, but would need locale-provider and
decorator alignment; do not maintain both integrations. Start with the two already independent configurations and
smoke-test composition, iframe assets and deep links in the deployed layout. [Composition][sb-sharing-composition].

| Existing source family                                                                                                                                                                           | Disposition when implementation is briefed                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/ui/src/components/shadcn-*.stories.tsx`                                                                                                                                                | **Keep** regression files, interactions and titles. Group last and filter out of the default review selection using a custom `primitive` tag; leave test inclusion intact. Do not add copies to the web catalogue. New primitive variants need a REZICS use case, a local customization or an upstream regression. |
| `cover`, `cover-card`, `progress-row`, `shelf-*`, `selection-bar`, `item-menu`, `entity-picker`                                                                                                  | **Keep and extend** as the browsing pattern. Reuse fixtures in pages. Keep sizing, failure, keyboard and selection regressions; merge redundant _review presentations_ into a Shelf pattern page rather than deleting assertions.                                                                                  |
| `document-*`, `editor-*`, `rich-text-editor`, `prose`, reactions, rating, content-actions, report-dialog, media-image, undo-toast, withheld, tombstone, locale/localized-text/show/relative-time | **Keep**: these encode local product behavior, rich content, disclosure or localization. Consolidate docs around Document, Composer and Feedback patterns; keep distinct behavioral stories.                                                                                                                       |
| `shelf-page` Overview/InProgress and `library-entries` StatusTab                                                                                                                                 | **Retain current tested examples**, mark the status-tab arrangement as transitional in review docs. New target examples use Collection-led navigation. Do not portray an entry-only response as Everything.                                                                                                        |
| `cover-wall.stories.tsx` Default/Small/Large                                                                                                                                                     | **Keep** the mixed-content density comparison. Reuse the real shared tile and profile-valid fixtures; replace misleading arbitrary state/type combinations when its implementation contract permits. Do not use this attractive wall as page coverage.                                                             |
| `search`, `search-typed`, `search-empty`                                                                                                                                                         | **Merge the reviewer navigation** into one Search index with Default, Typed, No matches links. Keep physical files and required Signed In/Signed Out exports while existing acceptance names them.                                                                                                                 |
| `board` and `board-realm`; `subject` and `subject-relations`; `composer` NewThread/Reply/Edit                                                                                                    | **Keep** each semantic distinction, with shared domain folders and fixture builders. Combine overview docs, not permission contexts or interaction expectations.                                                                                                                                                   |
| `library-entries`, `library-collections`, `library-collection`, `library-following`, `library-progress`, `library-progress-session`, `library-copies`, `library-log`                             | **Keep** route integration and extend to the matrix below. Review navigation puts Following and History beside Library; Copies becomes a related management surface, not another compulsory Library tab.                                                                                                           |
| `home`, `agent`, `space`, `realms`, `settings`, `shell`, `missing-subject`, `offer`, `order`, and shell `page-heading`                                                                           | **Keep** current user-visible states, especially deleted organization, long CJK title, delisted offer and settlement variants. Include the omitted page-heading via the UI/shell catalogue or an explicit additional glob. Add the uncovered routes below.                                                         |
| `accessibility-probe.stories.tsx`                                                                                                                                                                | **Drop from the published review build only**: it intentionally fails for an unnamed button. Keep it available to the negative-control harness. A publication-only exclusion must not change test discovery.                                                                                                       |
| Future duplicates and generated prop permutations                                                                                                                                                | **Drop from new review scope** when the same shared component, input and outcome are already covered. Keep a mapping to the surviving story; never remove an acceptance-required case to reduce story counts.                                                                                                      |

This proposal does not authorize removing existing tests. In particular,
[shadcn acceptance](../../packages/ui/tests/shadcn-stories-a-c.test.ts) requires individual filenames, `shadcn/`
titles, multiple exports and play functions; [page acceptance](../../apps/web/tests/page-stories.test.ts) names files
and visitor stories; [foundation acceptance](../../packages/ui/tests/foundation.test.ts) requires the failing probe.
Use sidebar ordering, tags and review indexes without changing those contracts. Merging duplicate source exports
can be separately considered only where their owner's acceptance permits it. There is no evidence-based reason
to erase the existing regression investment merely because it occupies the wrong place in the review sidebar.

## Concrete component coverage plan

Every row below is a proposed required scenario family, not a claim that it exists today. Give distinct asynchronous,
permission and failure outcomes stable named exports; use an args matrix inside a single story only for side-by-side
visual comparisons. Shared components stay in `packages/ui`; connected domain patterns stay with `apps/web`.

| Component or pattern                                     | Required states and content                                                                                                                                                                                                                                                                                                                              | Interaction evidence                                                                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cover and cover tile (`Cover`, existing `CoverCard` API) | Portrait, square, landscape, absent cover, loading, broken image, withheld and revealed; long Latin/CJK/mixed-direction title; no state, each configured profile state, meaningful progress and unknown progress. One cover radius; shared tile across search, Library, Collections, Continue and profiles. Target tile has no surrounding card surface. | Navigate through the title/cover link; separate menu actions never navigate accidentally; reveal requests no image before consent; cover viewer exposes credits. |
| Cover grid/row                                           | Empty, one item, mixed verticals, enough items for wrapping, small/medium/large density, long titles, selection, phone/desktop.                                                                                                                                                                                                                          | Keyboard reaches every item/menu; no horizontal page overflow; selection does not activate navigation.                                                           |
| Shelf pattern                                            | Everything/curated/state source using the same member presentation; grid/list/table, narrow-table fallback, URL-restored filters and layout; initial empty, filtered empty, loading, preparing, retryable failure, next/deep/final page.                                                                                                                 | Switch display without changing membership; remove/clear filters; page forward/back without duplicates; selection survives only where its contract permits.      |
| Library navigation and Continue                          | Few/many pins, renamed built-in, no pins, empty Continue, session-eligible and profile-active-state-eligible item, unknown total progress; phone selector and short desktop pinned sidebar.                                                                                                                                                              | Pin/unpin/open Collection, use phone selector; distinct Library/Following/History destinations.                                                                  |
| Collection header                                        | Curated, Everything, state and Liked; logical empty vs materialized; owner, readable public visitor, unlisted visitor and private concealed; renamed/long title, long description, missing optional dynamic metadata.                                                                                                                                    | Owner rename/visibility action; permitted follow/unfollow/export/mount; no invented dynamic count, timestamps or curated controls.                               |
| Collection member list/editor                            | Zero/one/many members; canonical duplicates collapse in browsing, separate occurrence IDs/notes/order in curated editing; pending identity epoch, changed cursor, hidden original/terminal, partial availability.                                                                                                                                        | Edit/reorder/remove the specific occurrence; restart after cursor invalidation; dynamic sources have no occurrence editing.                                      |
| Status chip and state menu                               | No state, every state in at least Book/anime/game definition fixtures, long localized wording, historic accepted pin, missing/retired active profile. Chip is visible on every tile that actually has a state.                                                                                                                                           | Choose/clear state; preserve historic display and clearing; unavailable new values are explained. Saving to a Collection never creates Planned.                  |
| Progress row/session controls                            | Zero/partial/complete, unknown total, page/episode/time units when configured, active/paused/completed session, several sessions for one subject, historic pin, validation and mutation error.                                                                                                                                                           | Keyboard step/input, start/finish session, rollback/retry; unknown progress draws no fabricated zero bar.                                                        |
| Shared filter bar                                        | Type, tags/genres, people, year and declared numeric properties; owner state/label/progress/holding; multiple selected chips, clear-all, long labels, no result, preparing, rejected unsupported plan.                                                                                                                                                   | Combine/remove filters; distinguish owner-only controls; numeric strict boundary; clearing restores the admitted population.                                     |
| Selection bar and item menu                              | None/one/many selected; selected page vs all admitted matches; preview, pending, success, stale selection, inspectable partial failure, permission loss. Keep status/progress/save/reaction/follow distinct.                                                                                                                                             | Confirm the previewed population, reject stale preview and display failed items; retry reflects the current response, never a fabricated all-success toast.      |
| Subject header, relations and cards                      | Every configured launch presentation/type, covered/uncovered/withheld, long localized titles, sparse facts, historic/deleted contributor, relation/edition/character cards and unavailable slot.                                                                                                                                                         | Open tabs/paged slots and subject links; header actions respect persona; Sources is discoverable at page end.                                                    |
| Composer and document                                    | New thread/reply/edit, valid/invalid/empty, plain/rich/long text, spoiler, link, image upload pending/failure, locale text, saving, saved, rejected/conflict, permission revoked.                                                                                                                                                                        | Keyboard editing and toolbar focus, validation, submit/rollback/retry, cancel and unsaved-changes behavior where specified.                                      |
| Other product cards and feedback                         | Collection/Space/Realm/thread/offer cards; short/long/missing image, no optional metadata, hidden/tombstoned content, loading and disabled action; reaction/rating selected/unselected/error; undo available/expired/rejected.                                                                                                                           | Accessible action names and focus; distinguish follow from save and reaction; no private follower totals.                                                        |

The no-surface tile, radius, chip and Sources recommendations follow the supplied personal-space draft as requested.
Its input path is `.temp/goal/supermanager/decisions/personal-space.md` (2026-10-28), read from the read-only main
checkout because it is absent in this worktree. Navigation and membership already agree with
[Library and Collections](../library-and-collections.md). The draft's tile surface and credit placement still differ
from the older [UI README](../../packages/ui/README.md#cover-cards). Adopt those visual rules in their owning
documents before an implementation brief changes current tested behavior; this report does not silently settle
that documentation discrepancy or change frozen assertions.

## Library and Collections in depth

All following expectations come from [Library and Collections](../library-and-collections.md), with filter grammar
and readiness owned by [filtered lists](../filtered-lists.md), logical identity by
[Dynamic Collections](../dynamic-collections.md), labels by [independent labels](../library-labels.md), and historic
profile behavior by [profile consumers](../library-profile-consumers.md). Where runtime/DTO support is missing,
record a planned row and a dependency; a fabricated success recording cannot move it to implemented coverage.

| Surface/scenario family                   | Named cases the brief must enumerate                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Library landing                           | First-use empty logical Everything; populated mixed-vertical Everything; entry-only transitional **Tracked entries**; Continue present/absent; Liked and user pins; phone selector vs short desktop sidebar; loading/preparing/error. No mandatory status tabs, following feed or public follower counts.                                                                                                                |
| Everything membership                     | State-only, effective-label-only, retained-session-only and retained-holding-only subjects qualify; removal of one fact leaves another support. Curated-only, rating-only, follow-only, published-log-only, empty shells and trash do not qualify. Present these as a fixture comparison with an asserted expected set.                                                                                                  |
| State Collections                         | Profile-specific state identity, an empty sibling of an in-use state set, same state wording from different profiles, renamed/pinned state Collection; retained historic pins after retirement; labels-only support does not create a state set. Never infer historic type from current metadata.                                                                                                                        |
| Liked                                     | Subject like, subject love, switch like→love, unlike and another reaction kind; thread/post reaction excluded; reaction-only subject absent from Everything; copy-to-curated persists after unlike. Private by default.                                                                                                                                                                                                  |
| All Collections and creation              | None/one/many, built-in vs curated, pinned/unpinned, rename, pagination, create valid/invalid/pending/error; save a subject with no state without creating an entry state. Cover `/library/collections` and `/collections/new`, not only a seeded list.                                                                                                                                                                  |
| Shared Collection members                 | Curated/Everything/state/Liked × owner context, with public and unlisted visitor examples for published readable sources. Grid/list/table change presentation only. Curated duplicates have separate notes/order in editing and one canonical subject in browsing. Dynamic DTOs omit occurrence IDs and fabricated count/time/order metadata.                                                                            |
| Concrete filters                          | Light novel work-form + harem tag; word count strictly **over 1,000,000**; both together. Fixtures include 1,000,001, exactly 1,000,000 and absent word count, plus separate Chinese character count. Same-statement qualifiers, declared units and unknown-under-NOT follow the shared grammar.                                                                                                                         |
| Cross-surface filter parity               | Repeat those three questions in a public Zone, public curated Collection, owner Library and owner Library combined with state. Also run shared members behavior for built-in state and Liked. Show sparse matches as a filled/final page or explicit preparing, not misleading successful empty-page chains.                                                                                                             |
| Private filters and disclosure            | Owner-only state/label/progress/holding, including NOT state with no entry. Withheld harem under positive and NOT predicates cannot influence visible membership, exclusion, order or counts. Public/unlisted views reveal permitted members, not private facts/predicates or unchecked totals/facets.                                                                                                                   |
| Readiness and paging                      | Preparing source/index, pending identity epoch, stale catalogue readiness, rejected `422` plan, deep/final page, epoch-changed cursor restart, read-your-write, immediate loss of visibility. No client full-library scan or client sorting to simulate missing backend support.                                                                                                                                         |
| Identity                                  | Two originals resolve to one canonical subject; owner latest state wins while conflicting records remain; labels union and sessions/copies remain separate. A withheld original stays withheld even with a readable terminal. Curated occurrence IDs are preserved, not rewritten to the terminal.                                                                                                                       |
| Permissions and publication               | Owner private, public visitor, unlisted direct visitor, hidden/unknown indistinguishable not-found, missing/revoked credentials sign-in, suspended valid bearer `403 account_suspended`. Follow and Zone mount do not grant subject access. Publication preview shows membership without private selection facts.                                                                                                        |
| Bulk, export, follow and mount            | Selected vs all filtered; preview/execute same population; stale preview rejection; partial failure; readable unlisted follow; curated ItemList retains permitted occurrence order/notes/multiplicity, dynamic export is unique; mounted Zone preserves source disclosure; denied/unavailable owner capability is explicit.                                                                                              |
| Following and History                     | Subjects/Collections/Spaces together, none, paged, hidden/deleted targets and unfollow failure; sessions and published logs as separate History sections, empty/loading/error, session detail and public log view. No implied feed.                                                                                                                                                                                      |
| Copies, labels and progress               | Separate state/labels/copies/sessions; labels without profile; accepted legacy/profile pins; missing profile blocks only new profiled values; no assumed digital entitlement from a holding; multiple copies/sessions; validation, conflict, rollback and retained history.                                                                                                                                              |
| Individual removal and terminal lifecycle | Hidden immediately; undo available strictly before 720 hours, boundary expired, denied/CAS/capacity failure; no deadline renewal on replay. Terminal account time conceals private/unlisted output immediately. Public eligible retained output uses last COMPLETE A, never pending B, and has de-identified presentation. Stories illustrate response states; native lifecycle tests prove cleanup and no resurrection. |

Use one fixture/scenario builder parameterized by source kind and persona to run common assertions across these
surfaces. Do not multiply whole pages for every pair when behavior is shared: component tests cover fine-grained
membership sets; route stories demonstrate the integrated member renderer, navigation and permissions. Each stated
parity requirement still needs an explicit ledger row; reuse is not permission to omit a surface.

## Page and route coverage beyond the library

Each row needs a populated reference, initial loading, retryable failure and empty/missing/denied states where
meaningful; explain non-applicable cases. Include permitted signed-out and signed-in views, with auth redirects
checked at the real route boundary. The existing names stay stable where acceptance requires them. This table
accounts for all 30 modules; route aliases can share rendering stories but need focused canonical/redirect tests.

| Route modules / existing stories                                                                                                                            | Additional explicit coverage                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__root.tsx`, `index.tsx`; shell/home/page-heading                                                                                                          | Phone navigation open/closed, keyboard focus and skip link, long localized heading, signed-in/out actions, missing optional home rows, Continue preparing/failure. Header/shell in every route fixture uses actual shared code.                                                   |
| `subjects/$id.tsx`, `$id_.$slug.tsx`, `$id_.$slug_.$view.tsx`, `$id_.relations.tsx`, `$id_.$slug_.relations.tsx`; subject/subject-relations/missing-subject | Book/anime/game and remaining configured launch profiles; absent/withheld cover; sparse facts, editions/credits/characters/relations/posts/reviews/Collections slots; empty/paged/unavailable slot; concealed subject; Sources at end. Alias and slug redirects stay route tests. |
| `@{$handle}.tsx`, `@{$handle}_.$view.tsx`; agent                                                                                                            | Reader/verified person and other permitted agent presentations, long biography, sparse public profile, empty/public Collections slot, paged view and invalid view, private personal facts absent.                                                                                 |
| `search.tsx`; search/search-typed/search-empty                                                                                                              | Blank query, type/facet selection, sparse matches, combined filters and rating ordering, preparing/unavailable, no matches, pagination, hidden result removal and long result cards.                                                                                              |
| `boards/$id.tsx`, `boards/$id_.new.tsx`, `threads/$id.tsx`, `threads/$id_.$slug.tsx`; board/board-realm/thread/composer                                     | Empty/paged board and posts, Realm context, new/reply/edit, deleted organization, withheld/tombstoned post, permission loss, validation and submission failure; route slug behavior separately.                                                                                   |
| `spaces/$address.tsx`, `realms/$id.tsx`, `realms/index.tsx`; space/realms/board-realm                                                                       | Readable empty/populated Space/Realm, permitted membership states/actions, participation pending/error, hidden Space/Realm, empty/paged Realm list. Add a direct Realm-detail story instead of counting its board crumb as route coverage.                                        |
| `offers/$id.tsx`, `orders/$id.tsx`; offer/order                                                                                                             | Existing long CJK/delisted and paid/pending/failed/canceled; no entitlement inferred from success redirect; forbidden order, unavailable settlement refresh and action retry.                                                                                                     |
| `settings.tsx`; settings                                                                                                                                    | Existing auth personas, persisted preference, locale/theme change, save pending/failure and recovery, validation; no account secret in fixtures.                                                                                                                                  |
| `curate/presentation.tsx`; currently uncovered                                                                                                              | Authorized initial curation, valid changed preview, validation error, save pending/failure/conflict and denied access. Keep it outside public-review priority if its exposure is closed, but count it in route inventory.                                                         |
| Nine Library/Collection/log modules                                                                                                                         | `/library`, `/library/collections`, `/library/copies`, `/library/following`, `/library/progress`, `/library/progress/$id`, `/collections/$id`, `/collections/new`, `/logs/$id`: use the detailed matrix above, not just one successful recording per module.                      |

Auth pages, routed Zones, moderation and notifications belong in the eventual first-public catalogue according to
[scope](../scope.md) and [web outcomes](../goals/web.md); add their surface rows when their implementation is briefed.
Do not invent existing routes or count a shared dialog as full page coverage. The route inventory above is a measured
starting point, not a cap on the product surface.

## Interaction, accessibility and visual checks

Keep **Vitest addon browser mode** as the interaction runner. Storybook recommends it over the Jest/Playwright test
runner for Vite projects; it turns stories into render tests and executes their play assertions without requiring a
running published Storybook. Avoid paying for two interaction orchestrators. Use `storybook/test` assertions/spies,
role/name queries, awaited user events and outcome assertions. A page-ready assertion is useful smoke coverage but
is not proof that its mutation works. [Vitest addon][sb-vitest], [test runner][sb-runner], [interactions][sb-interactions].

Keep accessibility failures as errors, including the negative-control harness. The addon can integrate accessibility
results with component tests; inspect intermediate interactive states too, including an open menu, modal or expanded
filter. Add keyboard/focus restoration, escape, error association, target-size and 200% zoom/reflow review for the
new patterns. Run a screen-reader review of key flows: axe success does not establish accessible operation or WCAG
conformance. W3C explicitly requires human evaluation alongside tools. [Accessibility addon][sb-a11y],
[W3C evaluation guidance][w3c-evaluation].

For free local visual regression, prefer a small **Playwright Test screenshot suite against the same built static
artifact reviewers receive**, using `toHaveScreenshot`, over introducing the old Storybook test runner. Add a pinned
`@playwright/test` matching the existing Playwright version in that follow-up; it is not currently declared. Visit
selected story iframe IDs, set globals and viewport, wait for the same settled story/font/image readiness as the
capture script, then compare reviewed reference PNGs. Primer's inspected suite already visits story IDs across
themes and compares local screenshots. Playwright documents that baselines depend on OS/browser/environment.
[Primer tests][primer-tests], [Primer config][primer-runner], [Playwright visual comparisons][playwright-snapshots].

Vitest's native `toMatchScreenshot` is another no-service option, supporting reference and diff images in browser
mode. It could avoid a second runner with a dedicated visual project and portable stories. Prefer the static-artifact
approach here because it also catches publishing, iframe and asset integration defects and reuses today's capture
boundary. Do not implement both. The Storybook hosted Visual Tests addon is a separate Chromatic integration, not a
promise of free local baseline storage. [Vitest visual testing][vitest-visual], [Storybook visual tests][sb-visual].

Determinism requirements: synthetic recorded content and local licensed/generated images/fonts; fixed clock,
timezone, identifiers, random seed and locale; clean query/cache/storage per story and persona; reduced motion,
settled finite animations, hidden caret, known image decode completion and browser/DPR. Reset global cookies and
decorator side effects between stories. Fluent explicitly settles Web Animations as well as CSS animation timing;
take the lesson, not its global monkey patch. Baseline capture and comparison run on the same pinned Linux browser
image. Never mask the component being reviewed or accept global large diff tolerances. [Fluent preview][fluent-preview],
[Playwright comparison guidance][playwright-snapshots].

Require human review before updating a baseline and keep reference/actual/diff artifacts for failures. A missing
baseline is incomplete evidence, not an automatic pass. Keep approved reference PNGs in a dedicated tracked test
snapshot directory; transient builds/reports stay in `.temp/`. Review the intentional visual change and its changed
commit together. The current PNG capture command remains useful for manual evidence before baseline gating exists.

### Proposed execution budget

The following bounds are a plan, not measured runtime claims. Maintain an explicit set of required tuples so that
selectivity cannot silently weaken locale or privacy acceptance. Eight locales are `en`, `zh-Hant`, `zh-Hans`, `ja`,
`ko`, `de`, `fr`, `es`; themes are light/dark; primary widths are 390 and 1280 CSS pixels. Also manually inspect
320-pixel reflow for new layout patterns and mixed RTL content; RTL is a content stress case, not a new launch locale.

Run behavior assertions for every newly required state at its declared default context. For each changed page or
shared pattern, nominate one complete reference state for **all 32 locale × theme × width tuples**. Exercise other
states at the default plus their risk tuple: long German/French phone, CJK missing-cover phone, dark overlays and
permission/preparing phone. Include all 32 tuples for a specific state when its contract needs them. Encode globals
and actual browser sizes in projects/capture jobs; do not assume the toolbar ran the matrix.

Use changed-surface selection for ordinary briefs, including consumers of shared components, and a scheduled full
review sweep for the stable catalogue. That sweep is a separately authorized check, not a reason for every worker
to run all stories. Keep existing acceptance gates; additions must use existing admission/isolation interfaces in
[web check routing](../../apps/web/scripts/check.ts) and package isolated runners. Limit an optional focused check to
at most twelve named nearby test files. No full web check is requested for this report.

### Cost: behavioral story verification

- Touches: selected story files, their real shared components, route adapters and local fixtures; browser workers
  through the existing check lanes. Native recording refresh is a separate, explicitly selected producer operation.
- Bound: one required acceptance run after the final relevant edit plus root typecheck; optional diagnostics name
  at most twelve files. If a story file contains several states, charge every exported test actually executed.
- Growth check: record exported/executed counts, browser worker cap, queue time separately from run time, fixture
  requests and peak memory at 1, 4 and 12 selected files. Growing unrelated stories must not expand a focused run.

### Cost: visual review and regression

- Touches: one built artifact, declared story/global/viewport tuples, local media, browser capture and diff artifacts.
- Bound: with P changed reference states and E additional enumerated risk tuples, capture at most `32P + E` images
  per selected build; enumerate E before running. Initially retain the capture script's limit of four concurrent
  pages, further constrained by check admission. No backend call or database is required for replay.
- Growth check: pilot 1, 4 and 12 reference states, recording image count/bytes, build duration separately from
  capture/diff duration and peak memory. Add unrelated catalogue fixtures without expanding the selected tuple set.

### Cost: static publication

- Touches: web/UI static outputs, story index, fixture media, build metadata and the latest-version pointer.
- Bound: build each required catalogue once per chosen development commit and reuse the exact outputs for smoke
  checks, review and publication; publish only after required checks. Retention and byte limits must be chosen in
  the publication brief, rather than retaining every image from every iteration indefinitely.
- Growth check: measure artifact bytes/build time for the current catalogue and after 4/12 representative new
  patterns; verify immutable builds and latest-pointer updates never need a running kernel or copy private data.

## Reviewer documentation and versioned publishing

Add `@storybook/addon-docs` at the aligned Storybook version and MDX globs as an implementation task: neither current
main config enables it. Opt into autodocs only for maintained public component APIs, explaining intended use,
important args, keyboard behavior and linked named cases. Use MDX for workflows and cross-component comparisons;
embed existing CSF stories rather than implementing a second UI in documentation. [Autodocs][sb-autodocs], [MDX][sb-mdx].

The small useful docs set is:

1. **Start reviewing**: current commit/build time, fixture-only behavior, how to use globals, phone/desktop and deep
   links, where to find new/changed patterns and how visual review is recorded.
2. **Library and Collections**: Library/Following/History map, Everything/state/Liked/curated distinctions, shared
   members/filter behavior and links to exact matrix stories and owning product documents.
3. **Content and composition**: cover tile/grid, subject header, Sources, composer and accessible interaction
   examples; point to the owning design contracts for rationale rather than creating another authority.
4. **State coverage and readiness**: generated ledger, implemented vs planned rows, fixture provenance and test/
   visual-review evidence tied to a commit. Link to a missing scenario without representing it as a working page.
5. **Foundations**: tokens, text/spacing, locale/typography, focus/contrast, and links to primitive docs/regressions.
   Avoid an autodocs page for every unmodified upstream prop simply to increase the page count.

Storybook builds a static site that can be served independently of the application backend. The hosting scheme
below is a REZICS recommendation, not a Storybook built-in version registry. [Publishing][sb-publish].

Build web and UI with their real CSS, generated routes/localization and mock adapters, without production secrets.
Keep metadata containing full Git SHA, Storybook version, fixture revision and build timestamp. Store immutable
artifacts under `/versions/<full-sha>/` with the UI build beneath that version, and update `storybook.rezics.com` to
the newest successfully published development version. If the next build fails, retain the prior working version
and display its actual SHA. Do not label the currently published version as a newer failed commit.

Deep links retain the version and story ID; the root can redirect to the latest immutable version or serve a small
version chooser. Use relative composition refs and test assets, `/media`, iframe paths and generated routing below
the version prefix: today's absolute `/media` paths need a version-aware base or routing strategy before this layout
works. The publication smoke acceptance must open one web page, one UI composite, one docs page, local media, a
non-default locale/theme and a bookmarked story directly under the versioned URL. Publish the tested artifact,
not a later unverified rebuild. Host-specific Workers routing/cache configuration belongs to the publication brief;
the report does not select a storage product or authorize a deployment.

## Convention required in each future interface brief

Each interface brief should contain the following concrete information, with its acceptance prepared before code:

- User outcome, owner-document links, affected routes/shared consumers, and existing stable IDs it must preserve.
- A state table naming every required export: persona, data/preparation/mutation state, expected disclosure, fixture
  source and whether the backing API already exists. Label design-only examples `planned` in the coverage ledger.
- Default args plus a small set of semantically distinct named states. Continue typed CSF3 (`satisfies Meta`,
  `StoryObj`) and `storybook/test` in this codebase; no mass migration to experimental factories for this purpose.
- Story ownership: shared presentational component beside UI code, connected pattern beside its domain, route story
  using `PageStory` under the current discovery path. Choose unique titles and preserve acceptance-required exports.
- Deterministic fixtures and reset/cleanup for handlers, query clients, storage, globals and clock; no live service
  dependency. Refresh changed producer recordings through the real recorder and type-check the response boundary.
- Named play assertions for the actual outcome and failure recovery; role/name selectors and awaited events,
  `findBy`/`waitFor` rather than sleeps. Include permission losses and keyboard interactions where applicable.
- Explicit screenshot tuples, baseline owner/review, all launch locales/both themes/phone+desktop reference evidence,
  and accessibility/manual review expectations. Custom tags such as `review`, `primitive`, `planned` and `visual`
  classify intent; custom tags have no execution effect until the runner maps them explicitly.
- The exact existing acceptance command, relevant named extra files if any, root typecheck and check admission;
  costs for selected states/tuples. Never edit frozen acceptance to simplify story consolidation.

## Ordered implementation tasks for adoption

1. **Adopt the workflow in its owners.** Update web/UI guidance with the chosen review hierarchy, brief checklist,
   ledger and snapshot policy. Reconcile cover surface/radius/credits and obsolete shelf status tabs in the owning
   documents against the personal-space direction before briefing visual changes. Preserve current acceptance.
2. **Make the current catalogue reviewable.** Add aligned docs support, a Review landing/index, stable-link inventory,
   primitive tags/order, publication-only negative-probe exclusion and UI composition. Include the omitted heading.
   Acceptance: existing gates unchanged; all current reviewer links resolve and the probe still proves a11y failure.
3. **Make fixture state explicit.** Extend the existing scenario adapter with named isolated loading/preparing/error/
   empty/persona responses. Build the ledger from the actual story index and a declared scenario list, rejecting
   missing IDs or silently empty selections. Keep unimplemented backend outcomes visibly pending.
4. **Build the high-value composites.** Cover tile/grid, visible profile state chip and progress row first; then
   Collection-led navigation, shelf, Collection header/members, shared filter/selection bar and domain cards.
   Require consistent rendering in Library, Collections, Continue, search and profile consumers.
5. **Complete Library and Collections route evidence.** Deliver the matrix in dependency order: current curated
   navigation, dynamic/profile/label members and filters, then Liked/Continue and publication/bulk/export/mount
   outcomes as real APIs become available. Add Following/History, creation, copy/session and lifecycle cases.
6. **Fill remaining route gaps.** Add direct Realm detail, profile views, Collection creation and presentation
   curation; extend other pages' failures and permission states. Share redirect evidence with route tests.
7. **Pilot local regression and measure it.** Add the selected Playwright Test harness and reviewed references for
   tile, shelf, filter overlay, Collection and composer; reuse the static artifact. Prove deterministic diffs and
   bounded selected runs before widening the manifest. Retain existing interaction/a11y gates without duplication.
8. **Publish immutable review builds.** Implement the version prefix and metadata, smoke-test the full deployed
   layout, then expose the latest successful development version at the main Storybook domain. Add retention and
   failure visibility, and supply immutable links in interface review evidence.

No implementation or deployment is performed by this research. The adoption tasks need their own acceptance; this
report's acceptance is a nonempty report with cited practice and a concrete component/page coverage plan.

## Source register and reproducibility

All repositories were shallow-cloned as untrusted reading material under the main checkout's ignored
`.reference/storybook-practice/`; no dependencies were installed and no source from those clones was built or run.
The reference index records these revisions. Recommendations describe designs to implement in REZICS, not source
files or passages to copy. Licences below describe inspected repository source; BBC editorial data, brands and
third-party assets do not acquire a reuse licence from its software licence.

| Local reference path                         | Repository / inspected commit                                                                                                     | Licence                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `.reference/storybook-practice/storybook`    | [storybookjs/storybook](https://github.com/storybookjs/storybook), `0798ec85fdba7001777219b4f6a8eb8de75f1ee9` (`v11.0.0-alpha.8`) | [MIT](https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/LICENSE) |
| `.reference/storybook-practice/primer-react` | [primer/react](https://github.com/primer/react), `f733dcb2b086c6da7902bfecfcf68cd61c7daab3`                                       | [MIT](https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/LICENSE)          |
| `.reference/storybook-practice/fluentui`     | [microsoft/fluentui](https://github.com/microsoft/fluentui), `32c88c8685f71c5903dc84e685faee9e401258d1`                           | [MIT](https://github.com/microsoft/fluentui/blob/32c88c8685f71c5903dc84e685faee9e401258d1/LICENSE)    |
| `.reference/storybook-practice/simorgh`      | [bbc/simorgh](https://github.com/bbc/simorgh), `bf40a304159afd776e1257d8bebc35be6280ea82`                                         | [Apache-2.0](https://github.com/bbc/simorgh/blob/bf40a304159afd776e1257d8bebc35be6280ea82/LICENSE)    |

Web documentation was accessed on 2026-10-29. Storybook links explicitly select major 11, whose docs can advance
beyond the installed alpha; the exact tagged source/release notes anchor version-specific claims. Playwright,
Vitest and W3C links below are official documentation/standards guidance, not copied content.

[sb-release]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/CHANGELOG.prerelease.md
[sb-migration]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/releases/migration-guide.mdx
[sb-stories]: https://storybook.js.org/docs/11/writing-stories
[sb-pages]: https://storybook.js.org/docs/11/writing-stories/build-pages-with-storybook
[sb-composition]: https://storybook.js.org/docs/11/writing-stories/stories-for-multiple-components
[sb-hierarchy]: https://storybook.js.org/docs/11/writing-stories/naming-components-and-hierarchy
[sb-sorting-migration]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/MIGRATION.md#storysort-in-the-preview-replaced-by-storysorts-in-main
[sb-permalinks]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/configure/user-interface/sidebar-and-urls.mdx
[sb-args]: https://storybook.js.org/docs/11/writing-stories/args
[sb-tags]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-stories/tags.mdx
[sb-globals]: https://storybook.js.org/docs/11/essentials/toolbars-and-globals
[sb-loaders]: https://storybook.js.org/docs/11/writing-stories/loaders
[sb-msw]: https://storybook.js.org/docs/11/writing-stories/mocking-data-and-modules/mocking-network-requests
[sb-vitest]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-tests/integrations/vitest-addon/index.mdx
[sb-runner]: https://storybook.js.org/docs/11/writing-tests/integrations/test-runner
[sb-interactions]: https://storybook.js.org/docs/11/writing-tests/interaction-testing
[sb-a11y]: https://storybook.js.org/docs/11/writing-tests/accessibility-testing
[sb-coverage]: https://storybook.js.org/docs/11/writing-tests/test-coverage
[sb-visual]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-tests/visual-testing.mdx
[sb-autodocs]: https://storybook.js.org/docs/11/writing-docs/autodocs
[sb-mdx]: https://storybook.js.org/docs/11/writing-docs/mdx
[sb-publish]: https://storybook.js.org/docs/11/sharing/publish-storybook
[sb-sharing-composition]: https://storybook.js.org/docs/11/sharing/storybook-composition
[primer-panel]: https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/packages/react/src/SelectPanel/SelectPanel.stories.tsx
[primer-features]: https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/packages/react/src/SelectPanel/SelectPanel.features.stories.tsx
[primer-main]: https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/packages/react/.storybook/main.ts
[primer-preview]: https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/packages/react/.storybook/preview.jsx
[primer-tests]: https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/e2e/components/ActionList.test.ts
[primer-runner]: https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/playwright.config.ts
[fluent-public]: https://github.com/microsoft/fluentui/blob/32c88c8685f71c5903dc84e685faee9e401258d1/packages/react-components/react-button/stories/src/Button/index.stories.tsx
[fluent-visual]: https://github.com/microsoft/fluentui/blob/32c88c8685f71c5903dc84e685faee9e401258d1/apps/vr-tests-react-components/src/stories/Button/Button.stories.tsx
[fluent-steps]: https://github.com/microsoft/fluentui/blob/32c88c8685f71c5903dc84e685faee9e401258d1/apps/vr-tests-react-components/src/stories/Button/utils.ts
[fluent-preview]: https://github.com/microsoft/fluentui/blob/32c88c8685f71c5903dc84e685faee9e401258d1/apps/vr-tests-react-components/.storybook/preview.js
[bbc-home]: https://github.com/bbc/simorgh/blob/bf40a304159afd776e1257d8bebc35be6280ea82/src/app/pages/HomePage/index.stories.tsx
[bbc-errors]: https://github.com/bbc/simorgh/blob/bf40a304159afd776e1257d8bebc35be6280ea82/src/app/pages/ErrorPage/index.stories.jsx
[bbc-preview]: https://github.com/bbc/simorgh/blob/bf40a304159afd776e1257d8bebc35be6280ea82/.storybook/preview.tsx
[bbc-docs]: https://github.com/bbc/simorgh/blob/bf40a304159afd776e1257d8bebc35be6280ea82/.storybook/DocsDecorator/index.tsx
[playwright-snapshots]: https://playwright.dev/docs/test-snapshots
[vitest-visual]: https://vitest.dev/guide/browser/visual-regression-testing
[w3c-evaluation]: https://www.w3.org/WAI/test-evaluate/
