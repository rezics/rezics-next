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
- `apps/web/features/proposals/list-state.test.ts`
- `apps/web/features/shell/providers.test.tsx`
- `apps/web/features/shell/bottom-nav.test.tsx`
- `apps/web/features/shell/current-page-visibility.test.ts`
- `apps/web/tests/g-1030-links.test.tsx` (existing locale, native-link and pre-hydration markup)
- `scripts/qa/repository-guards.test.ts` (guard registration)

Focused Storybook interaction, accessibility and screenshot review:

- `apps/web/features/shell/bottom-nav.stories.tsx`
- `apps/web/features/shell/current-page-visibility.stories.tsx`
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
