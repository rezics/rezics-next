# Server boundaries and navigation verification

The build phase checks these changes without a stack. The wave prove phase must
run the browser matrix below against its pinned revision and inspect the captured
screenshots. Component remounts and synthetic `pageshow` events in stories cover
the shared behavior; they do not establish document navigation or browser history
behavior.

## Server rendering diagnosis (AUD-006)

`Providers` calls `useState` unconditionally inside a React component. Its callers
render JSX, and React and React DOM are pinned to the same version. The existing
development dependency prebundling already includes React Query to avoid a second
React instance after late dependency optimization. None of these source checks
identifies the cause of the reported intermittent null hook dispatcher.

`providers.test.tsx` exercises the real provider with 24 separate server renders
and 12 concurrent streaming renders that suspend and resume. It checks request
cache isolation, hook errors and React's client-render fallback markers. These
checks passed before the navigation changes; the reported failure has no current
stack-free reproduction. The provider and development overlay remain enabled.

Development and production verification are both required. In each runtime,
repeat anonymous Home → Discover → search → return, including direct Discover
loads and refreshes, at 390×844, the reported 1415px width, and 1440×1000. Cover
English and Simplified Chinese and light and dark themes. Inspect server logs,
browser console, streamed response fallback markers and overlays, including after
development dependency optimization or an HMR update. Exercise Discover, profile
and Work samples from the original audit on the same revision. Record repetition
counts and runtime identity with the evidence. A clean production run does not
explain a development failure.

If it recurs, preserve the complete server stack and dependency optimizer log,
check which React and renderer modules the failing request loaded, and compare
the cold and warmed development graphs. Duplicate React, a mismatched renderer
or a call outside rendering are diagnostic possibilities from
[React's invalid hook guidance](https://react.dev/warnings/invalid-hook-call-warning),
not established causes here. Preserve request-local query clients as described by
[TanStack's server rendering guidance](https://tanstack.com/query/latest/docs/framework/react/guides/advanced-ssr).
Do not close AUD-006 on the unit results alone.

### Concrete startup failure and targeted runtime verification

The correctly configured development launch at `92b8a78f1cb06fb4a02703f2b471b80d1d069199`
exited 201 before listening. Cloudflare's Worker export discovery loaded
[`address/edge.ts`](../address/edge.ts), whose eager `react-dom/server.browser`
import selected React's throwing `react-server` export. The pre-shell recovery
response now produces escaped native HTML without importing a React renderer.
The server boundary test follows route, middleware and Worker imports, including
barrels, side effects and lazy imports, to reject the same renderer boundary.

After that repair, a development request exposed a separate null dispatcher in
`useShell`'s `use`, alongside an SSR dependency optimizer reload. Vinext copied
the top-level browser dependency includes into RSC, while SSR first discovered
`tailwind-variants` during rendering. [`vite.config.ts`](../../vite.config.ts)
now scopes browser includes to `client` and prepares the shared localization and
styling helpers in both server environments. The resolved-configuration tests
check those boundaries. This trace does not establish the cause of the original
intermittent `Providers` / `useState` report.

The targeted development launch and production build / Worker preview passed
at clean revision `e4f628e572d0561ddb2d49b5cfbe0f50c9ccf1be`, using the shared
development environment and its matching OAuth client fixture. Each runtime
loaded `/en`, `/en/discover`, `/en/discover?q=book`, `/en/proposals` and
`/en/proposals?view=review-requested` at 1415×950 and 390×950, signed out.
All ten documents returned 200 with the expected headings and no browser errors,
overlays or streamed error fallback markers. An absent Japanese resource with
a trailing slash and repeated query parameters returned the localized 404
recovery document; its actual mobile screenshot was inspected. Both frontend
processes were stopped. No backend refresh, record preparation or API mocking
was performed, and no credentials were retained.

The retained worktree evidence is `.temp/startup/before/` for the initial
failure, `.temp/startup/development/` for the subsequent dispatcher trace, and
`.temp/startup/development-live-assets/` and
`.temp/startup/production-live-assets/` for the passing runtime checks. Each
runtime directory contains `result.json` and `web.server.log`; passing runs
also contain `localized-address-recovery.png`. The executable proof files are
`.temp/startup/reproduce.ts`, `.temp/startup/runtime.test.ts` and
`.temp/startup/production.ts`. Recorded job
`5a4e92d0-fb70-4084-a04f-dcd7719b0025` steps 1 and 2 retain the passing output.
Raw Chromium diagnostic runs are retained separately in
`.temp/startup/development-scoped/` and `.temp/startup/development-network/`:
the latter captured `net::ERR_NETWORK_CHANGED` on client modules during host
interface changes. Passing runs used the existing `serveStoryAsset` helper to
fetch unchanged GET assets from the actual frontend. Documents and API traffic
kept their ordinary browser transport; HTTP errors were preserved.

These bounded startup and anonymous page checks do not complete the repeated
AUD-006 matrix above, the signed-in Proposals matrix, or the navigation proof
matrix below. Preserve those independent acceptance checks on the final wave.

## Navigation focus verification

The original retained Topics report at `b79c8be7c` describes wave revision
`92b8a78f1cb06fb4a02703f2b471b80d1d069199`; its evidence remains unchanged.
The rightmost link's border box fit inside the row, while its painted focus
ring extended beyond the clipping edge. Discover, Studio views and work tabs,
and Library shelves now reserve padding around their scrolling contents. The
shared reveal owner also exposes keyboard focus, preserving it through resize
and history restoration instead of scrolling back to the selected destination.
Public Site navigation uses that owner with its existing edge padding.

`navigation-focus.stories.tsx` measures the actual computed outline and outer
box shadows against the viewport and every clipping ancestor, independently of
the production reveal gutter. It covers forward and reverse keyboard traversal
for Discover's seven links, Studio views and work tabs, a 52-link public Site,
and Library custom shelves and Loans. Initial selected-link geometry, accessible
names, link counts and the selected marker have separate assertions. A resize
and persisted `pageshow` case checks that focused All stays visible while Topics
remains selected. These events do not prove actual browser history transitions.

The 24 surface / viewport / theme cases and the resize case passed, together
with the six existing selection stories, in recorded job
`5516d855-d1f7-4d3f-b7bc-2da6dfe34174`. All 25 new screenshots were viewed at
390×844 or 1440×1000 in light and dark themes. The retained directory is
`.artifacts/qa/20261019t053432-4223af/story-screenshots/apps-web-features-shell-navigation-focus.stories.tsx/`.
Before the repair, the new assertion reached a clipped left focus ring; after
padding alone it exposed a resize callback that moved focus offscreen. Both
regressions are covered by the final stories. Recorded job
`5d5c23c9-38a3-4e13-9a69-315e26331701` subsequently passed all 25 stories with
the independent initial-selection assertion and all nine bottom-navigation
stories; its targeted unit step passed 99 cases with 1,184 assertions.

The continuation guard fingerprints the enclosing function. Only the existing
StudioHome context was refreshed for its padding change; the continuation
expressions, exceptions and guard rules remain unchanged. Discover's padding
lives in the extracted BrowseTabs owner after integration with the wave.
Its mutation assertions must still reject removal of Studio's owner continuation
or More link. Real signed-in routes, document navigation, history and activation
of each destination remain in the browser matrix below.

## Browser proof matrix

| Finding | Required journeys and assertions |
| --- | --- |
| D3-002 | In development and production, open `/en/proposals`, `?view=mine`, `?view=review-requested` and `?view=unknown`, then repeat under `/zh-Hans`. Cover signed out and signed in, 390×844 and 1440×1000, light and dark. Signed-out pages must show the localized sign-in entry with the correct return address. Signed-in pages must show the selected list or its real empty state. Unknown values must select mine. No server-to-client function error may precede authentication. |
| AUD-012 | At 390×844, run all eight locale stories, sign out/in, and check zero, ordinary and overflow unread counts. Accessible names must contain the visible captions; Alerts must retain the localized unread announcement. Run axe `label-content-name-mismatch` and check actual voice/screen-reader activation using the visible labels. Check focus, clipping and horizontal document overflow in light and dark. |
| D4-002 | Directly load Discover Topics, Lists and People at 390×844 and 1440×1000. Refresh, go back/forward, and change a search/filter. Measure the current link and selected marker inside the row without manual scrolling. Reach every one of the seven destinations by keyboard and confirm selection, URL and content type agree. Repeat the same transitions for Studio views and work tabs, public Site navigation, and Library shelves/custom shelves/Loans. Confirm a desktop Library column does not move the document vertically. |
| AUD-006 | Run the separate development and production repetition procedure above; retain the runtime evidence even when no recurrence is observed. |

Use real signed-in state, prepared records and public operation results in browser
journeys. An unavailable record is a preparation issue, not a reason to invent a
successful response.

## Proof files

Stack-free regressions:

- `apps/web/tests/server-client-boundary.test.ts`
- `apps/web/tests/dependency-environments.test.ts`
- `apps/web/tests/g-943-address.test.ts`
- `apps/web/features/address/g-1008.test.ts`
- `apps/web/features/proposals/list-state.test.ts`
- `apps/web/features/shell/providers.test.tsx`
- `apps/web/features/shell/bottom-nav.test.tsx`
- `apps/web/features/shell/current-page-visibility.test.ts`
- `apps/web/tests/g-1030-links.test.tsx` (existing locale, native-link and pre-hydration markup)
- `scripts/qa/repository-guards.test.ts` (guard registration)

Focused Storybook interaction, accessibility and screenshot review:

- `apps/web/features/shell/bottom-nav.stories.tsx`
- `apps/web/features/shell/current-page-visibility.stories.tsx`
- `apps/web/features/shell/navigation-focus.stories.tsx`
- `apps/web/features/shell/app-shell.stories.tsx`
- `apps/web/features/proposals/list.stories.tsx`
- `apps/web/features/studio/studio-home.stories.tsx`
- `apps/web/features/studio/studio-work.stories.tsx`
- `apps/web/features/zones/public-navigation-frame.stories.tsx`
- `apps/web/features/library/library-page.stories.tsx`
- `apps/web/features/library/loans/loans.stories.tsx`

Run these through `bun scripts/goal/goalctl.ts test <explicit files>` in the
authorized prove phase. Check real story IDs through the Storybook tooling before
selecting individual exports. The URL/runtime matrix still needs real browser
journeys beyond the component stories.
