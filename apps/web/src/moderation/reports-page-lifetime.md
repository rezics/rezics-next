# Original report page lifetime

The Reports branch of the board moderation route now binds
`prepareModerationReportRead` → `readModerationReportPage` → `ModerationReportsPage` →
`ModerationReportsView` → `BoardReportQueue` → `ReportReviewCard`. The Appeals branch now shares the moderation-local original-reader observation described in
[private reader lifetime](private-reader-lifetime.md). The server read still prepares the native viewer, uses
private no-store responses and generated native reads with limit 20, and independently resolves
and deduplicates targets, exact reported revisions, authors and declared media.

Each native report read allocates a fresh generation and original input object containing the board,
thread, post, cursor and normalized status/kind/order. Post scope continues to take precedence over
thread and board scope. Navigation uses the original selectors and scope, clears the cursor on
selection/restart, and never treats an empty page with continuation as an exhausted list.

Browser preparation records a local session-cache revision before reading. The default mounted page
compares that same revision, native viewer, original input and navigation generation. One read-only
QueryClient cache observation remembers exact Query identity, external success (including equal data), error, setState, removal/recreation
and state/account/CSRF transitions synchronously, including an
away/back change hidden in a React batch and changes between loader completion and mount. Unknown,
preparing, denied, signed-out and unavailable sessions cannot admit private report bytes. An initially healthy
authenticated null-CSRF reader may display only when its actual prepared subject and distinguished null fingerprint
match the original known browser observation. This explicitly replaces the earlier initial missing-CSRF denial oracle;
a subsequently observed token-to-null transition still retires the original owner. Commands require a current token.
They never become anonymous authority. There is no session fetch or shared-session mutation here.

Navigation events, reloads, readiness loss, source replacement and account/session changes permanently
retire the old visit. Retirement unmounts reasons, submitted evidence, current targets, exact revision
bodies/media/links, drafts, selections, receipts, retry and continuation controls. The original reader's
local handoff and mounted ownership fence restoring old props or a shallow loader copy. Input object
identity is not a retirement marker: default cache structural sharing may reuse it in a healthy newly
prepared native generation. A replacement QueryClient or action transport
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

Report selection, bulk review, nonempty individual reasons and sending or uncertain commands register with the
shared authoring departure owner. Stay preserves the original loaded IDs, review phase, reason and immutable
command/key. Leave synchronously retires every local continuation and the original reader before replacement
callbacks or route reads. Session and admission revocation still hide private evidence immediately. Browsing and
validated receipts require no decision; other selected or unattempted work remains protected during follow-up reads.
Clear and Cancel remain local controls, and exact retry never schedules unattempted rows.
Decision: local selectors and same-tab links use the shared decision, including search-only navigation; injected
queues reuse an enclosing owner or create their own boundary without acquiring private reader authority.
Decision: Only a successful explicit cursor continuation transfers local focus to the admitted report article boundary; the route's ordinary focus handling remains in place.

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
shares this connected lifetime.

Implementation references read were the existing reports loader/page, queue/card/action/bulk composition,
current session query, delivered Appeals, Decision and Reporter consumers and route, recovered reply-context
lifetime/reading-region pattern, target enrichment/presentation and the content owner's report contract.
No external reference project was named for this surface, and no external source was ported.

The historical Reports-only implementation typing receipt (before this connected change) is `bun run --cwd apps/web typecheck`, completed locally in the
foreground with exit 0: `No type errors in 1,476 files` (729.81 ms compiler phase). Generation and route
generation also completed. No acceptance assertions or other verification suites were executed.

The adjacent change in `reports-view-card.tsx` only supplies the original owner's current/generation
callbacks to its existing review controller. It is necessary to suppress late individual success/refresh
callbacks and does not change card content, native transport or standalone public props.
