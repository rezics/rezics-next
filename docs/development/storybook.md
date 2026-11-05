# Storybook catalogue

## Catalogue and ownership

Storybook has three tiers: **Pages** in `apps/web` show route level states in the full site shell; **Patterns** in
`apps/web` show connected compositions from the same recorded or fake data without the shell; **Components** in
`packages/ui` show shared UI. A state confined to one region belongs to a pattern. Page stories cover populated states
when the page frame differs by viewer, plus empty, unavailable and error outcomes.

Keep one complete folder per page, component or pattern, with user facing nouns. Product areas retain Library,
Subjects, Discovery, Community, Commerce and Account in that order, followed by integrated areas including Catalogue,
Zones and Imports. Preserve supplied canonical folders and IDs, including shared folders such as
`Patterns/Collection Editor`; a shared pattern does not require an extra product-area level. Name stories for persona
and outcome (`Signed out`, `Owner, empty`, `Filter sheet open`), not viewport, theme or locale. Keep the hierarchy
compact and include every required behavior state, even when a folder needs more than eight. Regression only stories
carry the `!dev` tag; do not use it to hide required states. Cross cutting exposure views use the `exposure` tag in
the page they cover.

Locale and theme are Storybook globals. Review the same canonical IDs at `phone390` and `desktop1280` using the
viewport toolbar, with locale and theme globals; do not create width, locale or theme behavior variants. A phone only
state can set `globals.viewport` at story level. Browser coverage runs at desktop and phone widths. Do not use the removed
`parameters.viewport.defaultViewport` setting.

The title and story name rules follow [Storybook naming](https://storybook.js.org/docs/writing-stories/naming-components-and-hierarchy),
[tags](https://storybook.js.org/docs/writing-stories/tags), [globals](https://storybook.js.org/docs/essentials/toolbars-and-globals),
and [refs](https://storybook.js.org/docs/api/main-config/main-config-refs).

The critical Personal Library navigation regression renders the actual tabs component in a focused DOM test. It checks
that the caller and all eight generated locale messages load without starting Storybook or a native service. Run it
from the repository root with:

```sh
bun test apps/web/tests/library-page-smoke.test.ts
```

The Web landing integration check selects this command for changes under `apps/web`, `packages/ui`, and
`packages/document`.

## Agent access

Start an isolated local catalogue from the worktree root with an unused exact loopback port:

Both launchers bind only to loopback addresses, defaulting to `127.0.0.1`, and create no tunnel. Web composes the UI
catalogue from the worktree's `STORYBOOK_UI_URL`.

```sh
CACHE_DIR="$PWD/.temp/storybook-cache/web" bun run --cwd apps/web storybook --host 127.0.0.1 --port 16497 --exact-port --ci
# Or inspect the shared UI catalogue, using its own unused port:
CACHE_DIR="$PWD/.temp/storybook-cache/ui" bun run --cwd packages/ui storybook --host 127.0.0.1 --port 16498 --exact-port --ci
```

Connect an MCP client using Streamable HTTP to that catalogue's `/mcp` endpoint, for example
`http://127.0.0.1:16497/mcp`. Initialize the session, list tools and read their installed descriptions before choosing
a tool. The CLI's startup message means the server is listening; a successful `/index.json` read establishes index
readiness. Neither startup nor MCP initialization establishes component metadata readiness. Read the component
manifest from the same server with:

```sh
curl --fail --show-error --max-time 120 http://127.0.0.1:16497/manifests/components.json
```

The canonical story index is at `http://127.0.0.1:16497/index.json`. A successful JSON manifest response with local
components, props and canonical stories establishes manifest readiness. Then call `docs-list` with
`withStoryIds: true`, select a returned component ID with `docs-show`, and select a returned story ID with
`docs-show-story`. When the installed schema exposes `storybookId`, use `"local"` for local component/story reads.
These tools
read metadata; they do not require opening a preview or running browser story tests.

Both configurations enable `componentsManifest` and `docgenServer: false`.
This alpha deliberately returns 404 for the dev JSON manifest with server-side docgen. With that service off, the
React manifest preset uses synchronous React docgen. The pinned renderer is patched to resolve JSX imports first,
then extract props only for the selected component and declared subcomponents. Other JSX imports remain available
for source examples without generating unused API payloads. This retains the complete catalogue, source imports,
stories and docs. The JSON manifest reports `meta.docgen: "react-docgen"`.
When multiple files share a canonical component ID, its API still comes from Storybook's selected file; the patch
also merges the other files' story examples under that ID instead of dropping them. Canonical IDs stay unchanged.
The patch is registered in the root `patchedDependencies`; remove it when upstream defers incidental JSX prop
extraction and retains every source file's stories for shared IDs. The focused default-composition regression is
`apps/web/tests/storybook-local-manifest.test.ts`.
Do not enable `experimentalReactComponentMeta` with the pinned TypeScript 7 package: it lacks the legacy compiler
API (`ts.sys`) required by this alpha's component-meta generator, which otherwise returns component errors without
props. Neither server-side docgen nor that experimental flag provides a working substitute with these pins.
Builder-side docgen is deprecated for Storybook 12; revisit these flags when upgrading.

Keep one server per catalogue and one outstanding request per endpoint. Retain the owned server/request handles,
logs, endpoint and terminal results under `.temp/`. If a read times out, inspect its terminal error and the existing
server log before making any further request; an empty response is unknown readiness, not a missing route. A JSON-RPC
error or tool result with `isError: true` is a tool failure even when HTTP returns 200.

Select different unused ports for another worktree; keep MCP, manifest and source identity on that worktree's server.
Web retains its UI composition ref: when running both catalogues, set `STORYBOOK_UI_URL` to the own-worktree UI
server's origin before starting Web. The local catalogue remains usable when that ref is unavailable. The addon is
already configured in both catalogues. Neither a shared dev server nor a public MCP service is required.

The default web preview uses `connectedStoryProviders` from `apps/web/src/stories/connected-story.tsx`.
It supplies a missing QueryClient for connected regions such as local search history and imported subject scores.
Each selected story owns its fallback client, retains it during rerenders and clears it on unmount or story change.
Existing ancestor providers are reused; nested providers such as `PageStory`, `PatternStory` and per-story clients
keep control of their prepared data and deliberate error states. The fallback does not catch errors or replace
kernel responses. Locale, theme and viewport remain globals on the same canonical story IDs.

The focused provider regression composes the actual named stories with these default providers, without a native
service: `bun test apps/web/tests/story-provider-composition.test.tsx`. This covers rendered local history and
imported score content, independent story clients and preservation of story-owned clients.

The pinned Vitest `5.1.0-beta.1` remains outside addon-vitest's declared peer range. Local MCP initialization and
manifest reads do not establish compatibility of browser story tests; do not override the peer range or waive tests.

Storybook 11 is used for its agent interface. An agent developing interface work uses the local one: the Storybook
dev server started from its own worktree serves the MCP endpoint (`@storybook/addon-mcp`, `/mcp`) and the component
manifest (`manifests/components.json`, enabled in both configurations), so the agent
reads components, stories and documentation, previews stories and runs their tests against its own uncommitted changes.
The published catalogue may also serve a read-only documentation MCP (`@storybook/mcp`) from its manifest for reading
the released catalogue; development never depends on it.

Browsers are not forbidden, they are unnecessary for this work. The local MCP already reads, previews and tests
stories, so opening Storybook through the Chrome plugin, Playwright MCP or a script against `iframe.html` only adds
time and tokens. Use a browser when a question needs real browser behaviour the MCP does not cover, and prefer the
headless `apps/web/scripts/screenshots.ts` for visual review captures.
