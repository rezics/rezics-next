# Web feature organization

Group code by user capability so a task flow, its locale text, typed API adapter
and stories can change together. Routes stay thin; shared controls belong in
[Rezics UI](design-system.md). The [import rules](../../.dependency-cruiser.json)
keep service implementation and Eden client construction behind web adapters.
Validate external data at its trust boundary; client selectors cannot grant
authority, and exact selection must survive server and browser navigation.

## Data fetching

The [server Eden client](../../apps/web/features/api/main.ts) reads with the
request session; the [browser client](../../apps/web/features/api/browser.ts)
goes through the [BFF](../../apps/web/features/api/bff.ts), which alone attaches
the Main bearer token. [BFF tests](../../apps/web/tests/session-bff.test.ts)
cover forwarding and token separation. Interactive query factories include
scope, locale, exact selection and acting subject where results depend on them.

Studio's writes ([`features/studio`](../../apps/web/features/studio/)) show
pending, stale, partial, denied, offline and recoverable outcomes in their
stories; receipt-aware query invalidation remains a feature task.

## Performance and accessibility

Measure the production build, not the dev server: `vinext build`, then serve
`dist/` with `wrangler dev --config dist/server/wrangler.json` (or
`task web:preview` on a QA stack). The [performance report](../../apps/web/tests/perf-report.ts)
loads each page type cold on a desktop and on Lighthouse's throttled phone
through a local stand-in for the edge, because `wrangler dev` serves HTTP/1.1
and buffers gzip until a streamed page ends, which the edge does not. The
[accessibility audit](../../apps/web/tests/a11y-audit.ts) runs axe on every
page type signed out and as a writer and moderator, in both themes and widths.
The [budgets](../../apps/web/tests/perf.e2e.ts) and [accessibility checks](../../apps/web/tests/a11y.e2e.ts)
run in the QA browser tier.

Stream what Main is slow to answer behind a Suspense boundary rather than
holding the page for it, as Home does with its posts. Keep server-only modules
(the translator in `i18n/instance.ts`, `features/config/env.ts`) out of
anything a client component imports; the page's script budget catches a leak.
