# Using Storybook's features for interface review

Research date: 2026-10-29. REZICS source inspected at `3415ec5b0fafb08fbf73f60105ab8680e8400dcd`.
This report supplies evidence and proposed tasks; adoption belongs in the owning development document.
The sidebar work already owns naming, hierarchy, tags and composition. Its rules are assumed here, not redesigned.
**Recommendation:** make each story a reproducible product scenario, use globals to explore its environment,
and run that same scenario through an explicit browser and screenshot matrix. Prioritize correctness of those
dimensions and fixture isolation before adding more addons.

## Evidence and version boundary

Both [web](../../apps/web/package.json) and [UI](../../packages/ui/package.json) pin Storybook and their installed
addons to **11.0.0-alpha.8**, with Vitest **5.1.0-beta.1**. Version 11 is an alpha, not a stable-release assumption.
Storybook's exact tagged `MIGRATION.md`, docs and implementation are the authority for API availability here.
Major-11 website docs and external teams can advance independently; their configuration syntax is not a migration
recipe. For example, the tagged Vitest addon guide still mentions Vitest 3, while the same tag's migration guide
requires Vitest 4 or later. Use the migration requirement; REZICS's pins satisfy it. [Migration][migration],
[Vitest guide][vitest-guide]. All recommendations and proposed sizes below are judgments, not observed team policy.
An explicit **inferred** label identifies behavior not exercised or directly established by the inspected source.

Sources were read, never installed, built or executed. Existing clones were reused; Gutenberg was shallow-cloned.
Paths below are relative to `/home/edge/projects/rezics/rezics-next/.reference/`; its `INDEX.md` records reuse.
Each source URL below uses the recorded commit unless it is an official documentation page.

| Reading clone                     | Repository and revision                                                                                                                                                         | Source licence                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storybook-practice/storybook`    | [storybookjs/storybook](https://github.com/storybookjs/storybook/tree/0798ec85fdba7001777219b4f6a8eb8de75f1ee9), `0798ec85fdba7001777219b4f6a8eb8de75f1ee9` (`v11.0.0-alpha.8`) | [MIT](https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/LICENSE)                                                                                         |
| `storybook-practice/primer-react` | [primer/react](https://github.com/primer/react/tree/f733dcb2b086c6da7902bfecfcf68cd61c7daab3), `f733dcb2b086c6da7902bfecfcf68cd61c7daab3`                                       | [MIT](https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/LICENSE)                                                                                                  |
| `storybook-practice/fluentui`     | [microsoft/fluentui](https://github.com/microsoft/fluentui/tree/32c88c8685f71c5903dc84e685faee9e401258d1), `32c88c8685f71c5903dc84e685faee9e401258d1`                           | [MIT](https://github.com/microsoft/fluentui/blob/32c88c8685f71c5903dc84e685faee9e401258d1/LICENSE)                                                                                            |
| `storybook-practice/simorgh`      | [bbc/simorgh](https://github.com/bbc/simorgh/tree/bf40a304159afd776e1257d8bebc35be6280ea82), `bf40a304159afd776e1257d8bebc35be6280ea82`                                         | [Apache-2.0](https://github.com/bbc/simorgh/blob/bf40a304159afd776e1257d8bebc35be6280ea82/LICENSE)                                                                                            |
| `storybook-features/gutenberg`    | [WordPress/gutenberg](https://github.com/WordPress/gutenberg/tree/8b123377c98ce938b0a83078284c20648b66fce6), `8b123377c98ce938b0a83078284c20648b66fce6`                         | [GPL-2.0-or-later project; contributions since April 15, 2021 dual GPL-2.0-or-later/MPL-2.0](https://github.com/WordPress/gutenberg/blob/8b123377c98ce938b0a83078284c20648b66fce6/LICENSE.md) |

The register describes software source licences, not permission to reuse brands or editorial assets. Implement the
patterns in REZICS's React/TanStack stack; no external source files or substantial passages need copying.
The readable supermanager sidebar report and [earlier practice survey](storybook-practice.md) were consulted as
context. Current local source takes precedence over their older inventories. No live deployed catalogue was
retested in this desk research; statements about production behavior beyond source are **inferred**.

## Local configuration: what is already useful

| Surface read                                                                                                 | Observation at the inspected revision                                                                                                                                                                                                                            | Consequence                                                                                              |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [Web main](../../apps/web/.storybook/main.ts), [UI main](../../packages/ui/.storybook/main.ts)               | React-Vite; both register Vitest and a11y; only web registers docs. Web provides public assets, media, route generation and server-module aliases.                                                                                                               | Retain working adapters and aligned pins. UI docs require an explicit addon/config task.                 |
| [Web preview](../../apps/web/.storybook/preview.tsx), [UI preview](../../packages/ui/.storybook/preview.tsx) | Theme and eight locales are globals; decorators set document theme/lang; UI supplies `LocaleProvider`; web calls Paraglide and sets a theme cookie. Both set `a11y.test: 'error'`. UI defines phone/desktop presets using `viewports`; web lacks shared presets. | Much of the foundation exists. Unify dimensions and verify decorators react correctly to switches.       |
| [Web manager](../../apps/web/.storybook/manager.ts)                                                          | Displays commit/build time from `build.json`. UI has no manager file at this revision.                                                                                                                                                                           | Manager chrome is distinct from preview theme; preserve revision evidence.                               |
| [PageStory](../../apps/web/src/stories/page.tsx)                                                             | Real memory router, route tree, query client, request/persona context, recorded fixtures and many meaningful readiness/interaction helpers.                                                                                                                      | Extend this integration seam; do not replace route pages with cosmetic mock screens.                     |
| [Web Vitest](../../apps/web/vitest.config.ts), [UI Vitest](../../packages/ui/vitest.config.ts)               | One Storybook project and Chromium instance each; no explicit width/theme/locale matrix. UI reduces motion.                                                                                                                                                      | A toolbar choice is not a matrix. Coordinate with the sidebar task's two-width projects.                 |
| [Screenshots](../../apps/web/scripts/screenshots.ts)                                                         | Builds once, enumerates `index.json`, captures selected IDs × locales × themes at one width (1280 default, height 720), four workers; waits for story completion and fonts. PNG names omit width.                                                                | Add width iteration and evidence metadata; preserve bounded concurrency and one build.                   |
| [Publication smoke](../../apps/web/scripts/storybook-smoke.ts)                                               | Tests root and composed frames, media, errors and Japanese/dark globals. Story discovery uses specific title/name strings; it does not assert width.                                                                                                             | Extend to a reproducible viewport link and stable IDs in coordination with the existing sidebar changes. |

Storybook 11 essentials are built into core: a short addon list does not mean Controls, Actions, Viewport, Measure
or Outline are absent. Do not install the obsolete essentials/interactions packages to make their buttons appear.
Their useful configuration is usually in preview, parameters, args and play. [Essentials][essentials], [migration][migration].

## Viewport: exploration, locked scenarios and automated dimensions

**Purpose and observed practice.** The toolbar resizes the story iframe for responsive exploration. Primer derives
viewport presets from its actual design breakpoints in `packages/react/.storybook/preview.jsx`. BBC Home Page
`TestLite` captures one story at 399 and 899 using `parameters.chromatic.viewports`; the toolbar and test variants
are separate concerns. Fluent's visual Button app separately tests dark/high-contrast/RTL and default/hover/pressed
states. These are dimension matrices, though their older syntax and duplicated exports are not the REZICS design.
[Viewport][viewport], [Primer preview][primer-preview], [BBC home][bbc-home], [Fluent visual stories][fluent-visual].

| Mechanism                                                      | What it controls                                                  | Recommended REZICS use                                                                                                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolbar + `parameters.viewport.options`                        | Available iframe sizes; interactive choice                        | Shared `phone` 390×844 and `desktop` 1280×900 presets in both previews. Keep ordinary stories unlocked. The proposed shared desktop height resolves the current 860/900 inconsistency. |
| `initialGlobals.viewport`                                      | Initial environment, without a story lock                         | Optional project default, not evidence of testing all widths.                                                                                                                          |
| Story `globals.viewport: { value: 'phone', isRotated: false }` | Pins one scenario's environment and disables its viewport toolbar | Only genuinely phone-specific states, such as an open mobile drawer; the sidebar task already owns these annotations.                                                                  |
| Vitest projects + `storybookTest({ initialGlobals })`          | Independent executions of the same story under selected globals   | Two width projects, explicit viewport globals and matching browser sizes; optionally focused dark/locale projects later.                                                               |
| Chromatic `parameters.chromatic.modes`                         | Several visual captures/baselines from one story                  | Understand the model; keep local screenshots unless hosted visual review is adopted separately.                                                                                        |

**Pinned implementation detail that matters:** `code/addons/vitest/src/vitest-plugin/viewports.ts` calls
`page.viewport()` before running each composed story. With no recognized viewport global it selects **1200×900**;
it can therefore overwrite a viewport specified only in Vitest browser configuration. Set each project's
`storybookTest({ initialGlobals: { viewport: { value: 'phone' } } })` (or `desktop`), using recognized preview
presets, and verify the actual `window.innerWidth`. Story globals are merged over initial globals in portable
stories, so a phone-only story remains phone-only even in a desktop project; do not count that as desktop coverage.
[Addon viewport implementation][vitest-viewports], [test execution][vitest-execution], [portable globals][portable].
Vitest itself supports [browser.viewport](https://vitest.dev/config/browser/viewport); the addon adds this per-story resize.
This refines the two-width work already assigned; it does not add a second sidebar or browser-matrix project.

**Common misuse:** widths in story names; setting removed `parameters.viewport.defaultViewport`; locking every
story; assuming toolbar presets or two browser instances automatically exercise every width. The exact migration
removes `defaultViewport`, but explicitly retains **both** `viewports` and `options`: UI's existing `viewports` is
supported, not itself broken. Prefer `options` for consistency with current docs. [Tagged migration][migration].

**Visual modes and screenshots.** Chromatic modes combine globals and create independent visual baselines; they
do not make local Vitest execute that matrix. BBC's legacy `chromatic.viewports` is evidence of the pattern, not
the preferred new API. REZICS should implement equivalent local jobs `(storyId, locale, theme, width, height)`.
Repeatable `--width` values should default to the two review presets; resolve each selected story once, then
iterate the matrix. Put dimensions in filenames and a manifest, so two captures cannot overwrite each other.
Keep `--story` selection, nonempty-selection failure, one static build and the existing four-worker bound.
Honor pinned story dimensions or explicitly skip/report incompatible cells; never label a phone-locked capture
as desktop. This skip/manifest policy is a **recommendation**, not behavior currently implemented.
[Chromatic modes](https://www.chromatic.com/docs/modes/), [Chromatic viewports](https://www.chromatic.com/docs/viewports/).

For manager review, set the viewport global; for direct iframe captures, set Playwright's actual viewport as well
and assert the resulting size. Do not rely on manager-only iframe styling to resize an independently opened iframe.
Keep height 720 as an explicit screenshot profile if desired, but record it: a full-page PNG still uses viewport
height for sticky elements and media queries. Preserve render/play completion and font waits; additionally decode
images before capture, following the existing smoke helper. Reduced motion and disabled screenshot animations
already help; freeze scenario time where needed. Primer's Playwright config reduces motion/disables animations,
and Fluent's visual preview explicitly settles Web Animations. [Primer runner][primer-runner], [Fluent preview][fluent-preview].

## Globals, toolbars, backgrounds and reproducible review links

**Purpose and team use.** Globals express environment shared across stories. Primer's theme toolbar drives real
`ThemeProvider`/document settings; BBC's service selector drives language/service/theme/request providers.
Gutenberg provides RTL, host CSS and max-width-container toolbars with decorators; container width is a useful
dimension separate from browser width. These controls change actual rendering dependencies, not merely labels.
[Globals][globals], [Primer preview][primer-preview], [BBC preview][bbc-preview], [Gutenberg preview][wp-preview],
[container decorator][wp-container].

**Misuse and recommendation.** Keep theme/locale/viewport global, and keep persona, access state, entity data and
admissions story-specific. A global signed-in visitor can invalidate a story named Signed Out. Preserve the web
theme class/cookie and Paraglide behavior and UI provider, validate supported values, and use descriptive toolbar
items/dynamic titles. Verify changing locale or args refreshes route/query state without retaining previous data.
Use `html.lang` and real messages; an RTL simulation is a later diagnostic, not an extra launch locale.
Globals are not args, so empty Controls for theme is correct. Story-level globals deliberately lock their toolbar;
set them only when the scenario requires the restriction. [Globals][globals], [PageStory](../../apps/web/src/stories/page.tsx).

Backgrounds sets the canvas backdrop; it does not switch tokens, providers, text colors, portals or theme cookies.
Primer disables backgrounds at feature level; Gutenberg disables it in preview and uses a real theme decorator.
BBC offers backdrop colors alongside theme providers. For REZICS pages, disable the independent backdrop control
or make its purpose explicit so reviewers cannot produce a dark backdrop with light tokens and call it dark mode.
For isolated transparent assets, retain named backdrop choices where they answer a real contrast question.
Manager theming affects Storybook chrome only. [Backgrounds][backgrounds], [Primer main][primer-main],
[Gutenberg preview][wp-preview], [BBC preview][bbc-preview].

**Reproduction contract to adopt:** retain story ID, immutable build URL/commit, serializable args and globals in
every review link. Proposed manager query (substitute an actual indexed ID):

```text
?path=/story/<id>&globals=theme:dark;locale:ja;viewport.value:phone;viewport.isRotated:!false
```

Encode the complete `globals` value with `URLSearchParams`; the decoded form above illustrates nested values.
The tagged `UrlStore.ts` reads globals through `parseArgsParam.ts`, which supports nested keys and `!false`.
This URL shape is source-supported; full reproduction through REZICS's composed UI deployment remains **inferred
until smoke-tested**. Confirm global propagation in the active ref iframe instead of assuming the parent theme
changes it. Existing smoke already proves Japanese/dark on web; extend it to assert actual width, theme/lang and
a visible localized landmark for web and UI. A locked story legitimately overrides URL globals; expose that
constraint in the evidence. Team previews demonstrate globals consumption; this URL smoke is our recommendation,
not a claim that each team implements the same link generator. [URL source][url-store], [parser][url-parser].

## Args and Controls: meaningful exploration with fixed regression anchors

**Purpose and practice.** Args are serializable component inputs; Controls edits them without writing a story.
Gutenberg Truncate exposes text and element controls and named line/character-count examples. Its ConfirmDialog
uses callback spies but disables the `isOpen` control because the example owns that state. Fluent Button provides
named usage examples plus description/best-practice text. Primer SelectPanel uses a working stateful wrapper,
and its separate Features stories explore complex interactions. [Args][args], [Controls][controls],
[Gutenberg Truncate][wp-truncate], [ConfirmDialog][wp-confirm], [Fluent public stories][fluent-public], [Primer panel][primer-panel].

**Common misuse:** a Controls table that changes nothing because `render` discards args; editable router/client
objects; hundreds of uncontrolled fixture fields; or one playground standing in for tested permission/failure states.
REZICS should expose bounded scenario enums on page/pattern wrappers where exploration is useful: `persona`,
`state`, item count, display layout or long-text fixture. Map a valid selection to existing recorded scenarios,
not arbitrary fabricated authorization. Do not expose every combination when only some have producer evidence.
Use `argTypes.options`, select/radio controls, descriptions and disabled controls for functions/internal objects.
A pattern's text, density or layout can be independently editable; fixed named page states may need no Controls.
Pages do not have to become prop-only components to support a small typed story wrapper. [Page guide][pages].

Preserve important outcomes as named stories with fixed args: Owner Empty, Read Only, Preparing, Retryable Failure.
A changed control is exploratory until saved as a story and executed in CI. A playground can supplement these
anchors, not replace them. When args change, key/reset scenario data and the query client by relevant args;
otherwise the panel can advertise one persona while rendering cached data from another (**risk inferred from the
current memoization/global adapter design**, not a reproduced defect). Use `useArgs` only for genuinely controlled
examples that must keep callbacks and Controls synchronized. [Args][args], [Controls][controls].

## Actions, Interactions and play: observable behavior, not ceremonial clicks

**Purpose and practice.** Actions logs callback invocations and arguments; Interactions explains each awaited play
step and assertion. They answer different questions. Gutenberg ConfirmDialog defines `onConfirm`/`onCancel` with
`fn()`. Primer SelectPanel's `LegacyContrast` clicks the trigger, checks enabled/focused input, filters, asserts
one visible option and clears it. Fluent's visual Button steps capture default, hover and pressed states, while
separate tests can cover behavior beyond the picture. [Actions][actions], [Interaction testing][interactions],
[Gutenberg dialog][wp-confirm], [Primer features][primer-features], [Fluent steps][fluent-steps].

**Misuse and REZICS application.** Logging an action is not an assertion. A `play` that merely finds `main` proves
readiness, not the scenario's outcome. Retain shared `pageReady`/route helpers but assert the named state and one
meaningful behavior: unavailable Save is disabled with a reason; filtering changes visible rows; submitting a
valid form yields the expected callback/payload and feedback; cancel closes the overlay and restores focus.
Current `replyReady` stops once Send is enabled; that is valid for an editing-state screenshot, not proof that
reply submission works. Describe such helpers accurately. Do not assert native kernel authorization from a fake.
[Page helpers](../../apps/web/src/stories/page.tsx), [web Goal](../goals/web.md).

Use `fn()` from `storybook/test` for callback args, await `userEvent` and `expect`, and group longer flows with
`step`. Prefer roles and accessible names. Scope normal queries to canvas; for portalled dialogs/menus use the
story document's body. Use `beforeEach` to arrange/reset fixture state and its returned cleanup for disposal;
`afterEach` must not erase the final state reviewers need to inspect. Register module substitutions in preview,
then set story behavior before rendering. CSF Next mock-method access may require `mocked()` in this alpha;
ordinary callback assertions still work. Do not rely on `argTypesRegex` implicit actions as play spies.
[Interaction lifecycle][interactions], [Actions][actions], [migration][migration].

**Story versus test file:** put a short user journey in play when its resulting state is useful to view, replay,
debug and capture. Keep permutations, pure algorithms, adapter contracts, SSR/auth/network integration, long
multi-route flows and exhaustive timing races in focused test files. Reuse a story through portable stories if
that avoids duplicate setup. Avoid opening and then closing every overlay in one play when the intended reviewed
state is Open. One interaction path may need separate initial/final stories for visual evidence. These boundaries
are recommendations supported by the different Primer/Fluent public and test catalogues, not a Storybook rule.
[Portable stories guide][portable-guide], [Primer tests][primer-tests], [Fluent visual stories][fluent-visual].

## Accessibility, the Test panel, CI and coverage

**Observed practice.** Gutenberg sets `a11y.test: 'error'`, uses the Vitest addon with headless Playwright Chromium,
and has a custom reporter comparing executed story IDs with the built index's test-tagged IDs. Primer registers
a11y and has a separate Playwright suite; Storybook's own catalogue registers a11y/Vitest and selects a tagged
browser suite. These establish several viable arrangements, not a requirement for two duplicate runners.
[Gutenberg preview][wp-preview], [Vitest config][wp-vitest], [index reporter][wp-index],
[Primer main][primer-main], [Storybook main][sb-main], [Storybook browser project][sb-project].

The Accessibility panel reports axe violations, passes and incomplete/manual checks; vision simulation and
highlighting aid inspection. Keep REZICS's `test: 'error'` in browser CI. Check keyboard operation, focus return,
names and error announcements in play, plus manual screen-reader/reflow/contrast inspection where automation
cannot establish usability. The addon disables the region rule by default for isolated components: consider a
page-only region rule where appropriate; do not globally change primitive semantics. Keep the existing intentional
failure probe as proof that the gate fails. No broad `todo`/`off` or hidden-node exclusions to obtain green status.
[Accessibility guide][a11y], [W3C evaluation](https://www.w3.org/WAI/test-evaluate/).

| Where                           | What to run or inspect                                                                                                       | What it establishes                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Local Storybook                 | Accessibility panel, Interactions replay, Test widget selection/watch                                                        | Fast diagnosis of the selected scenarios; not CI evidence for every story/dimension.               |
| Browser CI                      | Existing storybookTest render/play/a11y suite at the two required widths; focused locale/theme coverage for relevant changes | Actual DOM/browser behavior and automated accessibility, with recorded scenario/global metadata.   |
| Publication smoke               | Built manager + active web/UI iframe, assets, reproducible link globals                                                      | Published artifact works; Vitest's portable-story run does not prove deployment/composition works. |
| Visual review/regression        | Local screenshots across declared widths/themes/locales; selected reviewed baselines when adopted                            | Layout and appearance evidence, separate from DOM assertions.                                      |
| Native/kernel and focused tests | Existing producer, permissions, adapter, routing and algorithm contracts                                                     | Real backend and nonvisual behavior that stories cannot prove.                                     |

The Test widget can run selected stories/groups, show failures and watch while developing. It is backed by a local
Vitest process; publishing static HTML is not provisioning a public CI test service (**inference from the addon
architecture**). Use CI artifacts/status for deployed review builds. In 11, test-runner support has ended; retain
our Vite/Vitest integration. Do not add manual `setProjectAnnotations` to its setup: the addon applies preview and
addon annotations itself. Portable stories in separate plain test projects have different setup requirements.
[Vitest guide][vitest-guide], [migration][migration].

**Coverage is a diagnostic, not scenario completeness.** The addon can report story-executed code coverage in its
widget and `/coverage/index.html`; its UI coverage is project-wide, not a selected story/group, and is unavailable
in watch mode. Configure coverage in the Vitest root, with matching provider support and meaningful source
include/exclude/report directories, before enabling it. Inspect branches in domain UI, not generated Paraglide,
route-tree or fixture bulk. For CI, label story coverage separately from combined application test coverage;
do not infer persona, locale or responsive coverage from a percentage. No inspected Primer/BBC/Fluent/Gutenberg
configuration establishes a story coverage threshold: introducing one would be our decision, not team evidence.
Prefer Gutenberg's index-versus-executed-ID idea to catch silent discovery gaps, with explicit expected matrices
and documented probe exclusions. [Coverage][coverage], [Gutenberg reporter][wp-index].

## Docs: usage decisions, autodocs, MDX and the Overview

**Purpose and practice.** Autodocs derives API/arg information and examples from component metadata; MDX explains
usage decisions that a prop table cannot. Primer loads MDX and enables the Code panel. Fluent Button attaches
description and best-practice Markdown. Gutenberg customizes docs blocks to show a primary example before the
description, controls and stories. BBC's docs container adds README and component-health information. These
catalogues document how and when to use components, not just their existence. [Autodocs][autodocs], [MDX][mdx],
[Primer main][primer-main], [Fluent Button][fluent-public], [Gutenberg preview][wp-preview], [BBC docs][bbc-docs].

**Misuse and recommendation.** Do not globally generate long API pages for route wrappers with no meaningful props,
or duplicate architecture/product specifications inside Storybook. Respect the sidebar work's single Overview:
make it a short review guide explaining globals, play/Test/a11y tools, fixture limits, build identity and links to
canonical contracts. A page story usually needs concise scenario metadata, not its own documentation page.
Use opt-in `autodocs` for reusable patterns/components where argTypes and examples answer consumer questions.
Add MDX only for nonobvious anatomy, composition, accessibility/keyboard behavior, tradeoffs or accepted usage.
Priority candidates are Cover/withheld imagery, editor/mention, selection/filter patterns and shared overlays.

UI currently lacks docs support and an MDX glob; add the pinned docs addon and a narrow MDX glob only when these
pages are implemented. Keep CSF stories separate from MDX; reference them with Doc Blocks instead of duplicating
fixtures. The Code panel is enabled by default with this alpha's docs addon; customize source snippets where a
router/fixture wrapper would obscure the actual component usage. Inspect generated controls/source before
enabling autodocs for every component. [Code panel][code-panel], [Autodocs][autodocs], [MDX][mdx].

## Data, loaders, MSW and module mocking

**Observed patterns.** BBC's Home Page fetches local service-specific JSON and composes real providers, while
its preview/time-machine code manages review environment/time. Storybook's own loader catalogue tests inherited
loader data; its preview registers `sb.mock`, and module-mocking stories set behavior in `beforeEach`. The official
Taskbox screen tutorial demonstrates MSW success/403 scenarios and a store decorator; it is an instructional
example, not evidence of Chromatic's entire production transport. [BBC home][bbc-home], [BBC time][bbc-time],
[Storybook loaders][sb-loaders-example], [preview][sb-preview], [module stories][sb-mock-example],
[Taskbox screen](https://storybook.js.org/tutorials/intro-to-storybook/react/en/screen/).

| Feature                            | Appropriate purpose                                                                | Misuse to avoid; REZICS recommendation                                                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Args/imported fixtures             | Small synchronous data and explicit scenario selectors                             | Prefer these for ordinary fixtures. Avoid a loader for every JSON object or a live API dependency in review builds.                                                                                                |
| Loaders                            | Async setup before render, assets too large to import eagerly, mock initialization | All levels run in parallel and merge results; do not depend on loader order or use a pre-render loader to demonstrate the UI's own loading transition. Use a deterministic pending-response scenario instead.      |
| MSW                                | Exercise browser fetch/HTTP/GraphQL boundaries with controlled responses           | Useful where requests bypass our adapter; reuse recorded payloads and fail unexpected application API requests. Do not introduce independently maintained fake API data or intercept fonts/media indiscriminately. |
| Recorded kernel adapter            | Replay real producer response shapes at our typed fetch seam                       | Keep it as default for PageStory; extend named scenario selection/reset for success, denial, empty, error and pending cases. It proves UI handling, not live authorization or SSR.                                 |
| `sb.mock` / mock modules / aliases | Replace imported services, browser-incompatible dependencies, clocks/IDs           | Register static mocks in preview; configure values per story with `beforeEach`. Keep existing Start/Workers aliases unless a concrete replacement improves the boundary.                                           |

The exact alpha network guide describes **MSW addon v3**; do not blindly paste a v2 recipe using a different handler
shape. CSF3 setup and CSF Next setup also differ. Select and pin a compatible addon only if a real uncovered
request path warrants it. Neither local package currently declares MSW. Storybook's loaders guide calls loaders
an escape hatch and recommends args for ordinary story data. No inspected product catalogue proves that replacing
our adapter with MSW would improve fidelity. [Network mocking][network], [Loaders][loaders],
[recorded fetch implementation](../../apps/web/src/kernel/fake.ts).

`sb.mock` is statically registered in preview, not a per-story `vi.mock` factory. Spy-only mocks preserve behavior;
full automocking replaces exported functions but still evaluates module code/dependencies. Use a replacement mock
file/alias for server-only modules or side effects that must never execute in the browser. The migration notes
that an automock parse failure in Vite can load the real module unmocked: unexpected real API access must fail
closed in fixture checks. Reset adapters, caches, selection, clocks and storage per story and on global/scenario
changes; keep final UI visible until cleanup. [Module mocking][mocking], [migration][migration], [Interaction lifecycle][interactions].

## Review tools and other features worth selecting deliberately

| Feature                                             | Primary-source practice and purpose                                                                                                                                                                                             | Common misuse; REZICS recommendation                                                                                                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Measure / Outline                                   | Core tools expose box dimensions/spacing and DOM outlines; Storybook's own main leaves these essentials enabled. No inspected team source establishes a special review process for them. [Guide][measure], [own main][sb-main]. | Absence from `addons` is not absence of the tool. Teach reviewers to use them for shelf spacing/alignment and overflow, then turn them off for captures. No extra addon or hardcoded diagnostic borders.                                             |
| Highlight / vision simulation                       | a11y uses highlights for offending elements; the alpha has an explicit selector/styles highlight API. Primer and Gutenberg register a11y. [Highlight][highlight], [a11y][a11y], [Primer main][primer-main].                     | Do not build a custom overlay framework. Keep the built-in a11y highlight available; inspect incomplete findings manually. Simulated vision does not prove accessibility.                                                                            |
| Canvas layout / fullscreen / zoom / open in new tab | BBC Home uses `layout: 'fullscreen'`; Gutenberg's max-width decorator represents real host containers. [BBC home][bbc-home], [layout][layout], [container][wp-container].                                                       | Browser zoom is not responsive width. Use fullscreen for real pages, padded/centered intentionally for primitives, and explicit host constraints for patterns. Inspect portals and sticky layout in the iframe and direct preview.                   |
| Hover/focus/pressed and animation review            | Fluent captures default/hover/pressed; Storybook uses a pseudo-states addon in its own catalogue. [Fluent steps][fluent-steps], [own preview][sb-preview].                                                                      | A forced CSS pseudo-state does not prove keyboard/focus behavior. Prefer real `userEvent` for interactions; consider selective pseudo-state visual galleries only where they add missing evidence.                                                   |
| Source / design references                          | Primer enables Code; Fluent supplies usage prose; Storybook registers a designs addon. [Primer preview][primer-preview], [Fluent public][fluent-public], [own main][sb-main].                                                   | Show component usage rather than fixture plumbing. Add canonical design links only when maintained references exist; no addon installation solely to fill a panel.                                                                                   |
| Performance diagnostics                             | Primer registers GitHub's performance panel and wraps stories in React Profiler. [Primer main][primer-main], [preview][primer-preview].                                                                                         | Storybook dev timing is not production page performance. Consider a focused render-cost investigation for large shelves/editors after correctness, not a new universal gate.                                                                         |
| Component manifests / MCP / CSF Next                | Primer enables componentsManifest and MCP; Storybook's own catalogue uses definePreview and experimental features. [Primer main][primer-main], [own preview][sb-preview], [migration][migration].                               | These teams demonstrate availability, not a need for REZICS to enable every experimental flag. Defer a manifest/AI-tooling or CSF Next migration until a concrete consumer and compatibility acceptance exist. Existing typed CSF3 remains suitable. |

## Shared patterns, differences and decisions

The sources share real context providers, small meaningful controls, named important scenarios, separate
interaction/visual evidence and usage documentation. They differ in runner, visual service and how they enumerate
dimensions: BBC uses Chromatic parameters, Fluent has a dedicated Storywright app, Primer has Playwright tests,
and Gutenberg uses the Vitest addon plus an index consistency reporter. There is no evidence that buying a visual
service, exposing every arg or enabling every addon is itself best practice.

Recommendations resolve the ambiguous boundaries as follows: preserve the existing recorded adapter; keep local
visual capture; use global environment dimensions and story-specific persona/state; coordinate with the existing
sidebar task instead of duplicating it; choose shared 390/1280 presets with recorded heights; opt into reusable
component docs; defer experimental tools. Proposed behavior and sizes below are **inferred planning estimates**.
No story, frozen acceptance, package manifest or runtime configuration is changed by this research.

## Primary source links

Paths in this list identify the exact files read in the registered clones. Website-only sources are
official Storybook, Chromatic, Vitest and W3C documentation, accessed on the research date.

[migration]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/MIGRATION.md
[essentials]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/essentials/index.mdx
[viewport]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/essentials/viewport.mdx
[globals]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/essentials/toolbars-and-globals.mdx
[backgrounds]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/essentials/backgrounds.mdx
[args]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-stories/args.mdx
[controls]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/essentials/controls.mdx
[actions]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/essentials/actions.mdx
[interactions]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-tests/interaction-testing.mdx
[a11y]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-tests/accessibility-testing.mdx
[vitest-guide]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-tests/integrations/vitest-addon/index.mdx
[vitest-viewports]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/code/addons/vitest/src/vitest-plugin/viewports.ts
[vitest-execution]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/code/addons/vitest/src/vitest-plugin/test-utils.ts
[portable]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/code/core/src/preview-api/modules/store/csf/portable-stories.ts
[portable-guide]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-tests/integrations/stories-in-unit-tests.mdx
[coverage]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-tests/test-coverage.mdx
[autodocs]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-docs/autodocs.mdx
[mdx]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-docs/mdx.mdx
[code-panel]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-docs/code-panel.mdx
[pages]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-stories/build-pages-with-storybook.mdx
[loaders]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-stories/loaders.mdx
[network]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-stories/mocking-data-and-modules/mocking-network-requests.mdx
[mocking]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/writing-stories/mocking-data-and-modules/mocking-modules.mdx
[measure]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/essentials/measure-and-outline.mdx
[highlight]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/essentials/highlight.mdx
[layout]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/configure/story-layout.mdx
[url-store]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/code/core/src/preview-api/modules/preview-web/UrlStore.ts
[url-parser]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/code/core/src/preview-api/modules/preview-web/parseArgsParam.ts
[primer-main]: https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/packages/react/.storybook/main.ts
[primer-preview]: https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/packages/react/.storybook/preview.jsx
[primer-panel]: https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/packages/react/src/SelectPanel/SelectPanel.stories.tsx
[primer-features]: https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/packages/react/src/SelectPanel/SelectPanel.features.stories.tsx
[primer-runner]: https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/playwright.config.ts
[primer-tests]: https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/e2e/components/ActionList.test.ts
[fluent-public]: https://github.com/microsoft/fluentui/blob/32c88c8685f71c5903dc84e685faee9e401258d1/packages/react-components/react-button/stories/src/Button/index.stories.tsx
[fluent-visual]: https://github.com/microsoft/fluentui/blob/32c88c8685f71c5903dc84e685faee9e401258d1/apps/vr-tests-react-components/src/stories/Button/Button.stories.tsx
[fluent-steps]: https://github.com/microsoft/fluentui/blob/32c88c8685f71c5903dc84e685faee9e401258d1/apps/vr-tests-react-components/src/stories/Button/utils.ts
[fluent-preview]: https://github.com/microsoft/fluentui/blob/32c88c8685f71c5903dc84e685faee9e401258d1/apps/vr-tests-react-components/.storybook/preview.js
[bbc-preview]: https://github.com/bbc/simorgh/blob/bf40a304159afd776e1257d8bebc35be6280ea82/.storybook/preview.tsx
[bbc-home]: https://github.com/bbc/simorgh/blob/bf40a304159afd776e1257d8bebc35be6280ea82/src/app/pages/HomePage/index.stories.tsx
[bbc-docs]: https://github.com/bbc/simorgh/blob/bf40a304159afd776e1257d8bebc35be6280ea82/.storybook/DocsDecorator/index.tsx
[bbc-time]: https://github.com/bbc/simorgh/blob/bf40a304159afd776e1257d8bebc35be6280ea82/.storybook/time-machine.js
[wp-preview]: https://github.com/WordPress/gutenberg/blob/8b123377c98ce938b0a83078284c20648b66fce6/storybook/preview.jsx
[wp-container]: https://github.com/WordPress/gutenberg/blob/8b123377c98ce938b0a83078284c20648b66fce6/storybook/decorators/with-max-width-wrapper.jsx
[wp-truncate]: https://github.com/WordPress/gutenberg/blob/8b123377c98ce938b0a83078284c20648b66fce6/packages/components/src/truncate/stories/index.story.tsx
[wp-confirm]: https://github.com/WordPress/gutenberg/blob/8b123377c98ce938b0a83078284c20648b66fce6/packages/components/src/confirm-dialog/stories/index.story.tsx
[wp-vitest]: https://github.com/WordPress/gutenberg/blob/8b123377c98ce938b0a83078284c20648b66fce6/storybook/vitest.config.mts
[wp-index]: https://github.com/WordPress/gutenberg/blob/8b123377c98ce938b0a83078284c20648b66fce6/storybook/vitest-story-index-reporter.ts
[sb-main]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/code/.storybook/main.ts
[sb-preview]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/code/.storybook/preview.tsx
[sb-project]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/code/vitest.config.storybook.ts
[sb-loaders-example]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/code/core/template/stories/loaders.stories.ts
[sb-mock-example]: https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/code/core/template/stories/test/ModuleMocking.stories.ts

## Concrete changes ranked by value

Each row is a separately briefable task, with its scope and a reviewable completion criterion. S means roughly
1–3 implementation files plus focused tests; M means roughly 3–6 files plus focused tests. These are estimates,
not permission to omit necessary tests. Adopt recommendations before dispatch; respect existing frozen tests.

| Rank / size                     | Task and concrete changes                                                                                                                                                                                                                                                                                     | Completion evidence                                                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 / S, coordinate existing work | **Make responsive runs truthful.** Share viewport presets in both previews; ensure the sidebar task's `apps/web/vitest.config.ts` and `packages/ui/vitest.config.ts` projects pass viewport globals through `storybookTest.initialGlobals`, not just browser dimensions. Keep required phone-only locks.      | Ordinary story runs report/assert 390 and 1280 actual widths; phone-only stories remain phone, with no false desktop coverage. Existing interaction/a11y acceptance stays intact.                                                   |
| 2 / M                           | **Capture a width matrix without duplicating stories.** Extend `apps/web/scripts/screenshots.ts` with repeated widths, dimension-bearing jobs/filenames and a manifest of actual globals, dimensions, URL and revision. Preserve one build, selected IDs, nonempty selection and four workers; decode images. | One selected story produces distinct phone/desktop files in one invocation; a locked story's incompatible cell is explicitly skipped/reported; no overwrites and failed play/image load fails capture.                              |
| 3 / S                           | **Make review links reproducible.** Extend `storybook-smoke.ts` and the Overview's examples with encoded theme/locale/viewport globals and build identity. Verify active web and composed UI frame; reuse stable IDs supplied by sidebar work.                                                                | A fresh browser opens a Japanese/dark/phone link and shows expected text, theme and 390 width in both catalogues; media and error smoke still pass.                                                                                 |
| 4 / M per pattern family        | **Make story interactions explain the outcome.** Improve first the shared page helpers and one Library filter/selection or editor family; add missing `fn` callback args and awaited steps, keyboard/focus/error assertions and deliberate open-state endings.                                                | Interactions replay explains the named outcome; a deliberately wrong callback/payload or focus target fails its focused test. No replacement of native kernel acceptance by fake success.                                           |
| 5 / M                           | **Isolate selectable fixture scenarios.** Extend existing PageStory/adapters with bounded typed persona/state selectors and beforeEach cleanup; add meaningful Controls only where changing args really switches recorded evidence. Introduce MSW only for a demonstrated bypassing HTTP path.                | Switching scenario/locale and revisiting a story cannot leak prior query/cache/mutation state; unknown fixtures/API calls fail explicitly; critical named states still run independently.                                           |
| 6 / M                           | **Expose useful component documentation.** Add pinned docs support/MDX discovery to UI; opt into autodocs for a small reusable family, add a usage MDX page only where needed, inspect Code snippets. Add tool/fixture guidance to the existing Overview.                                                     | Cover/overlay/editor examples explain API, composition and keyboard behavior with working controls and real reused stories; routes do not acquire redundant prop-table pages.                                                       |
| 7 / M                           | **Audit executed scenarios and dimensions.** Adapt Gutenberg's index comparison idea in our own harness and record expected/executed cells; retain the negative a11y probe. Pilot separately labeled domain UI coverage in the Vitest root with matching provider support.                                    | Missing indexed test stories or required width cells fail; intentional exclusions are explicit. Coverage artifacts identify untested branches without claiming full locale/persona coverage or adding an arbitrary percentage gate. |
| 8 / S                           | **Clarify review environment controls.** Give theme/locale items descriptive titles, remove misleading independent page backgrounds, document Measure/Outline/a11y highlight, and add host-container constraints only for patterns needing them.                                                              | Theme affects tokens/portals/lang correctly; backdrops are clearly separate; reviewers can inspect spacing without diagnostics appearing in captures.                                                                               |
