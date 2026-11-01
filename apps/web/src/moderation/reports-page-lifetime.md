# Original report page lifetime

The Reports branch of the board moderation route now binds
`prepareModerationReportRead` → `readModerationReportPage` → `ModerationReportsPage` →
`ModerationReportsView` → `BoardReportQueue` → `ReportReviewCard`. The Appeals branch keeps its
existing loader, admission and callbacks. The server read still prepares the native viewer, uses
private no-store responses and generated native reads with limit 20, and independently resolves
and deduplicates targets, exact reported revisions, authors and declared media.

Each native report read allocates a fresh generation and original input object containing the board,
thread, post, cursor and normalized status/kind/order. Post scope continues to take precedence over
thread and board scope. Navigation uses the original selectors and scope, clears the cursor on
selection/restart, and never treats an empty page with continuation as an exhausted list.

Browser preparation records a local session-cache revision before reading. The default mounted page
compares that same revision, native viewer, original input and navigation generation. One read-only
QueryClient cache observation remembers state/account/CSRF transitions synchronously, including an
away/back change hidden in a React batch and changes between loader completion and mount. Unknown,
preparing, denied, signed-out, unavailable and missing-CSRF sessions cannot admit private report bytes.
They never become anonymous authority. There is no session fetch or shared-session mutation here.

Navigation events, reloads, readiness loss, source replacement and account/session changes permanently
retire the old visit. Retirement unmounts reasons, submitted evidence, current targets, exact revision
bodies/media/links, drafts, selections, receipts, retry and continuation controls. A weak set marks the
original native input object, so restoring old props, or a shallow copy made by the loader, cannot revive
it. A newly prepared native generation may recover. A replacement QueryClient or action transport
requires a fresh native page. The standalone prepared View and server rendering with no browser session
source remain explicit fixtures; the default route always uses the browser-bound Page wrapper.

Queued individual and bulk commands check their original caller immediately before transport and
before completion or refresh callbacks. Each review controller keeps its exact immutable command/key
and definitive receipt internally even when the caller retires; retirement never reclassifies native
success as uncertainty. Only a lost response offers explicit exact retry. Bulk dismissal stays sequential,
bounded to 20 loaded pending rows, with original row positions, single/bulk ownership exclusion and no
automatic retry or continuation after failure. Successful current cards still refresh normally. A late
command or refresh cannot schedule the next row, restore evidence or publish into a retired visit.

Effect disconnection immediately invalidates outstanding work. Strict Mode can reconnect a still-current
visit/controller; explicit retirement cannot reconnect. Controller connection tokens fence work started
before disconnection even if its original Boolean fields subsequently return. Disconnection immediately marks the read closed to new mounts. Strict Mode may reconnect the same
visit, while the final disconnect permanently retires it after that synchronous reconnect opportunity.

Cost is the existing bounded native page and deduplicated evidence, one constant-size session-cache
observation per QueryClient shared across loader/mount, one local caller generation and O(page size)
rendering. Mounted subscriptions disconnect on unmount. Weak retention does not store page history.
There is no polling, history scan, per-row profile request, extra recovery read on rendering, background
command or new native authority. The existing listTargetReports signatures are untouched.

The authored `tests/reports-page-lifetime.test.tsx` composes real generated-native-shaped reads, the default
Page/action binding, the existing session QueryClient, queue and cards. It covers immediate hiding,
queued-send prevention, same-account replacement, away/back, navigation, unmount, read/action completion,
source replacement, no revival, fresh recovery, deduplication, media retirement, withheld/erased evidence,
original input precedence, exact retry, receipts, ownership exclusion, bounded loaded selection and sparse
continuation. The server-function boundary supplies native responses rather than replacing page consumers.

Only changed Web workspace typing is run in this implementation attempt. Authored assertions, original
acceptance, native disclosure/growth, browser, Storybook, root and stack verification remain UNRUN and
belong to integration. Typing is not whole-feature or Goal completion.

Affected existing story families are `patterns-moderation-queue--` (all queue states) and
`pages-community-moderation-reports--` (Reports states). Story IDs and fixtures are unchanged; Appeals
remains the existing separate consumer.

Implementation references read were the existing reports loader/page, queue/card/action/bulk composition,
current session query, delivered Appeals, Decision and Reporter consumers and route, recovered reply-context
lifetime/reading-region pattern, target enrichment/presentation and the content owner's report contract.
No external reference project was named for this surface, and no external source was ported.

The implementation typing receipt is `bun run --cwd apps/web typecheck`, completed locally in the
foreground with exit 0: `No type errors in 1,476 files` (729.81 ms compiler phase). Generation and route
generation also completed. No acceptance assertions or other verification suites were executed.

The adjacent change in `reports-view-card.tsx` only supplies the original owner's current/generation
callbacks to its existing review controller. It is necessary to suppress late individual success/refresh
callbacks and does not change card content, native transport or standalone public props.
