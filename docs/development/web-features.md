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

Future write flows still need receipt-aware invalidation and stories for stale,
partial, denied and recoverable errors. The current create-Work flow handles
pending and denied outcomes; these broader states remain a feature task.
