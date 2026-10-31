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

Start an isolated local catalogue from the worktree root with an unused port:

```sh
bun run --cwd apps/web storybook --host 127.0.0.1 --port 16497 --exact-port --ci
```

Connect an MCP HTTP client to `http://127.0.0.1:16497/mcp`. Initialize the session, list tools and read their
descriptions before choosing a tool. The same server exposes `http://127.0.0.1:16497/manifests/components.json`
and the canonical story index at `http://127.0.0.1:16497/index.json`. Select a different unused port for another
worktree; keep the endpoint and manifest on that worktree's server. The addon is already configured in both
catalogues. Neither a shared dev server nor a public MCP service is required.

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
manifest (`manifests/components.json`, enabled by `features.componentsManifest` in the web configuration), so the agent reads components, stories and
documentation, previews stories and runs their tests against its own uncommitted changes. The published catalogue may
also serve a read-only documentation MCP (`@storybook/mcp`) from its manifest for reading the released catalogue;
development never depends on it.

Browsers are not forbidden, they are unnecessary for this work. The local MCP already reads, previews and tests
stories, so opening Storybook through the Chrome plugin, Playwright MCP or a script against `iframe.html` only adds
time and tokens. Use a browser when a question needs real browser behaviour the MCP does not cover, and prefer the
headless `apps/web/scripts/screenshots.ts` for visual review captures.
