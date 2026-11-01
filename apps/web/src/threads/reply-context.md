# Recovered reply context lifetime

In-page parent context uses only the page's already disclosed post and author summaries. Off-page context uses the
existing ordinary current parent read, after an explicit View or Retry action. A relationship supplies an address,
not permission. The result must match both the selected parent and thread exactly. Available context retains the
current author, bounded spoiler-free excerpt, licence and exact revision link; refusals, erasure, withholding and
failed reads share the existing generic unavailable state.

`ThreadReading` binds its shared `ReplyParentReader` to the original thread, page read authority, disclosed posts
and authors, page admission and reader account, and the existing QueryClient's browser session observation. The
observation reads the public session cache and subscribes to its notifications, without fetching a session or
changing shared cache state. State, account and CSRF changes increment a local revision, including away/back changes
within a single React batch. Replacing the QueryClient also replaces the observation. Unknown or unavailable browser
sessions cannot become anonymous authority; signed-in browser recovery requires a known account and CSRF token
matching the page's available account identifiers. A genuine signed-out session retains public anonymous recovery.
Standalone prepared views without a QueryClient and server-rendered fixtures retain their explicit page admission;
this does not populate a browser session or grant unknown browser clients readiness.

Each queued read checks its original scope and pending ownership immediately before transport and on completion.
Retirement clears the private preview and pending ownership permanently. Returning to old account fields or page
values cannot revive that reader. A replacement scope starts closed and empty, and needs another explicit action.
An in-flight read may finish remotely, but its retired result cannot restore context. Losing the final row subscriber
clears that parent's ownership, so a late result cannot be lent to a newly subscribed row. Close/reopen within a live
scope retains the current result and shares one pending read per parent. Retry remains an explicit current action.

Effect cleanup disconnects the reader and clears its generation, previews and pending work. Strict Mode effect replay
may reconnect the same still-current scope; old connection work stays invalid. Explicit disposal and scope retirement
are irreversible, including calls to `activate` or `connect` afterward. This lifetime changes no composer, draft,
reply target, command, routing or native authorization behavior.

Cost is one constant-size cache observation per reading region and constant bookkeeping per selected parent. Normal
render and session changes make no recovery request. There is no cache-wide invalidation, polling, retry loop or
new transport protocol; the existing bounded author lookup is unchanged.

`tests/reply-context-lifetime.test.tsx` authors composed regressions for the default reading region and parent
context, using the real session cache and a deferred native-shaped parent response. Acceptance, native disclosure,
browser, Storybook and growth verification remain deferred to integration; Web typing alone does not prove them.
