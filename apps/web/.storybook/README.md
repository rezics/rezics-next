# Storybook review builds

The published review site combines two Storybooks into one entry point. The web Storybook is at `/`; it lists the
product stories by area. The UI Storybook is built once into `/ui/` and composed into the same sidebar through a relative ref.
During development, the ref uses the UI dev server at `http://localhost:6007`.
Set `STORYBOOK_UI_URL` to the own-worktree UI origin when using isolated ports; Web's local source remains available
when the composed catalogue is offline.
Page-only acceptance sets `STORYBOOK_DISABLE_COMPONENT_REF=1`; it exercises the Web page catalogue without requiring
the separately served UI Library. Ordinary local review keeps the composed reference enabled.

For an isolated worktree dev server, its local `/mcp` connection and component manifest, follow
[Agent access](../../../docs/development/storybook.md#agent-access). The web preview supplies missing connected-story
query context while preserving page and per-story providers. Both catalogues use the alpha's React docgen manifest
generator with deferred prop extraction for selected components. Server startup, index readiness and manifest readiness are
separate stages; select canonical component/story IDs through the installed MCP documentation tools.

Both previews leave the initial viewport unset so Storybook opens at its responsive default. Viewport options are
manual choices; do not initialize an unregistered `responsive` option, which the installed Storybook resolves through
its first available device before clearing it. Normal story opening must not traverse phone sizes.

## Sidebar organization

Use the Web product areas to browse a page or workflow. Use the composed **UI Library** to browse a reusable
component by what it does. `Overview` links both browse paths. Web composes the UI catalogue through its
`ui` ref, labelled `UI Library`.
[Storybook composition](https://storybook.js.org/docs/11/sharing/storybook-composition).

### Product areas

Use `Area/Feature/Surface`. A feature folder collects pages, connected regions and workflows that people look
for together. Name a leaf for the surface, such as `Collection Page` or `Collection Editor`. States such as
`Signed Out`, `Empty` and `Unavailable` sit inside that leaf. Give a landing surface its own leaf when its feature
folder also contains other surfaces, as in `Library/Collections/Collection Directory`.

```text
Overview
Library
  Collections
    Collection Directory
    Collection Page
    Collection Editor
    Collection Preview
    Collection Filters
    Collection Comparison
Discovery
  Search
    Search Page
    Search Typeahead
    Search Refinement
Community
  Boards
    Board Directory
    Board Directory Workflow
Account
  Sign Up
    Entry
    Return
```

Use the feature's product area to resolve overlap. A catalogue correction belongs with Catalogue, and a visit to
read the resulting subject belongs with Subjects. Use Storybook tags for filters that span folders, such as
`interaction`.
[Storybook naming](https://storybook.js.org/docs/11/writing-stories/naming-components-and-hierarchy),
[Storybook tags and filtering](https://storybook.js.org/blog/storybook-tags).

### UI Library

In the UI catalogue, use `Category/Component` and group shadcn and REZICS components by their primary use. Keep Editor under
`Editor/Writing`, `Editor/Reading` and `Editor/Preferences`, with its existing overview as the entry point.

| Folder in UI Library | Use | Examples |
| --- | --- | --- |
| Actions | Invoke a command | Button, Button Group, Content Actions |
| Forms | Enter or select a value | Input, Checkbox, Native Checkbox, Entity Picker |
| Navigation | Move between destinations or views | Breadcrumb, Pagination, Tabs |
| Overlays | Open a temporary interactive surface | Dialog, Drawer, Dropdown Menu, Report Dialog |
| Data Display | Read a record, list or value | Table, List Row, Meta Line |
| Feedback | See progress, status or an outcome | Alert, Toast, Skeleton, Shelf Empty |
| Media | Present images and covers | Cover, Cover Card, Media Image |
| Layout | Arrange, divide or reveal content | Scroll Area, Separator, Accordion |
| Editor | Write or read a document and configure the editor | Rich Text Editor, Document Body, Presets |

Give each component one location and use its recognizable name in the leaf label, such as `Alert Dialog` or
`Rich Text Editor`. Within a category, sort component titles alphabetically. For example, look for Button at
`UI Library → Actions → Button`, Cover at `UI Library → Media → Cover`, and Document Body at
`UI Library → Editor → Reading → Document Body`.
[Storybook's organization survey](https://storybook.js.org/blog/structuring-your-storybook/#by-functionality),
[Amsterdam Design System's component categories](https://github.com/Amsterdam/design-system/blob/develop/storybook/AGENTS.md#story-files).

### Sidebar changes

Set literal CSF `title` values and keep the sidebar order in `storySorts` in the [Web config](main.ts) and
[UI config](../../../packages/ui/.storybook/main.ts). Both catalogues alphabetize titles within their ordered
sections. [Storybook 11 sorting](https://storybook.js.org/docs/11/api/main-config/main-config-story-sorts).

Update current documentation links and the selectors in [smoke](../scripts/storybook-smoke.ts) and the
[catalogue checks](../tests/storybook-catalogue.test.ts) when a title changes. Verify the new paths with the built
indexes and confirm that reviewers can browse, search and open representative Web and UI stories.

## Source layout

Find an isolated component story beside its implementation, using the same basename (`cover.tsx` and
`cover.stories.tsx`). This applies to app-local components, shared UI and shadcn primitives, and Editor components.
For a story that mounts a route or exercises several connected components, start from the owning product feature:
`apps/web/src/stories/<area>/<feature>/` for Web or `apps/auth/src/stories/account/<feature>/` for Auth. Shared
package workflows live in their owning package under `src/stories/<feature>/`. Keep page and connected examples
for the same feature together, including attached MDX and feature-only fixtures. Cross-feature preview helpers
belong in the owning catalogue's `src/stories/support/`. Share fixture data through plain modules such as
`fixtures.ts`; keep shared API recordings at their existing [Web fixture seams](../README.md#fixture-and-recording-workflow).

Use `kebab-case` for source paths and a recognizable subject for each `.stories.tsx` basename. In a feature folder,
`collection-page.stories.tsx` and `collection-editor.stories.tsx` identify different surfaces. Keep ordinary states
as named exports in the same file. See the [sidebar organization](#sidebar-organization) for display titles.

| Subject | Target source path |
| --- | --- |
| Collection page | `apps/web/src/stories/library/collections/collection-page.stories.tsx` |
| Collection editor | `apps/web/src/stories/library/collections/collection-editor.stories.tsx` |
| Sign-up return | `apps/auth/src/stories/account/sign-up/sign-up-return.stories.tsx` |
| Page heading | `apps/web/src/shell/page-heading.stories.tsx` |
| Cover | `packages/ui/src/components/cover.stories.tsx` |
| Button | `packages/ui/src/shadcn/button.stories.tsx` |
| Rich-text editor | `packages/editor/src/components/rich-text-editor.stories.tsx` |

From the sidebar back to source, look up the entry's `importPath` in that catalogue's `/index.json` (Web) or
`/ui/index.json` (composed UI on the published site). For a new or relocated file, check its `stories` glob in the
[Web config](main.ts) or [UI config](../../../packages/ui/.storybook/main.ts) and confirm it appears in the index.
Storybook documents co-location and glob matching in its [story loading reference](https://storybook.js.org/docs/11/api/main-config/main-config-stories).

### Source migration

1. Move each feature's stories and attached MDX together. Follow [sidebar changes](#sidebar-changes) if a display
   title changes with the move.
2. Move the remaining stories by feature and update MDX imports, test imports, source-path assertions and the
   [page-story ledger](../../../docs/development/page-stories.md) where they reference moved files. Before expanding
   app globs, review files outside today's indexed paths. Switch callers of the Web `search-field.stories.tsx`
   compatibility entry to the indexed Header Search module and remove the re-export. Apply the
   [canonical outcome rules](../../../docs/development/storybook.md#catalogue-and-ownership) before publishing
   Auth route recovery, which currently has display-only exports.
3. For each batch, compare the affected IDs and `importPath` values in the built indexes. Use the
   [source and publication checks](../../../docs/development/storybook.md#catalogue-and-ownership) for identity
   and catalogue coverage.

## Build and review locally

From the repository root, run:

```sh
bun run --cwd apps/web storybook:build
```

The build generates web fixtures and route output, then builds both catalogues with the real CSS and generated
Paraglide output. It uses recorded or fake responses only. The accessibility probe remains excluded. The output is
`apps/web/storybook-static/`; `build.json` records the full commit SHA, Storybook version and UTC build time. The
manager title displays the short commit and build time. The build reports its total bytes and elapsed time.

The deployment command builds once, smoke-tests that same directory locally, and uploads only after both steps pass:

```sh
bun run --cwd apps/web storybook:deploy
```

The smoke test opens a page deep link, a composed UI story, a Japanese dark-theme page and a page with its recorded
cover image. It checks for browser errors and failed story images. A failed build or smoke test leaves the deployed
version unchanged. Before Wrangler runs, deployment removes any leftover `apps/web/.cloudflare/output` directory.

## Version links and routing

Each publish creates a new Worker version with `wrangler versions upload`. Wrangler prints that version's permanent
`workers.dev` preview URL; use it as the immutable review link. The deploy script then assigns 100 percent of
traffic to that version, applies the `storybook.rezics.com` custom domain with `wrangler triggers deploy`, and checks
that `https://storybook.rezics.com/build.json` reports the deployed commit. Static assets are served at the origin
root, so absolute `/media/` fixture paths work on the version preview URL too.

To validate the local build and Wrangler config without publishing or changing the domain, run:

```sh
bun run --cwd apps/web storybook:deploy --dry-run
```

This runs Wrangler's local `deploy --dry-run` validation and prints that no version or domain changes will be made.

## Publishing after dev advances

The holder of the Cloudflare credentials publishes from a clean checkout of the current dev head. Check the review
site against that checkout with:

```sh
bun run --cwd apps/web storybook:deploy --status
```

Exit 3 means the review site is stale; run `storybook:deploy` to publish. Exit 0 means it is current. Exit 2 means
the live build could not be read; check the domain before deploying. Run this check after each dev advance that changes
`apps/web` or `packages/ui`, and at least once a day while work lands. `--force` republishes the same commit, for
example after a Wrangler config change.
