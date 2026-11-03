# Native Board opening receiver

## Installed Content source

Content now has a source-side opening reader and a mounted `GET /v1/boards/:id/page` route. Its operation is
`board_page.get`, exposed as public `content.board` with the `thread:read` action. The response is private and
`no-store`. The closed response schema contains one `board`, `pinnedThreads`, ordinary `threads`, opaque `next`,
`rankRefreshedAt`, `reactionsAsOf`, viewer participation and create-thread advice.

Each card contains the current `ThreadView`, its exact thread and Board target, separate thread/opening-post author
availability, media availability, reaction counts with a freshness witness or an explicit unavailable state, viewer
reaction state, unavailable conversation comments, and reply/react/share advice. Missing count keys stay missing;
zero and unavailable remain distinct. The page does not provide authoritative comment totals. Pin, watch and slow-mode
commands retain their existing owners.

The source query admits `new`, `active` and `hot`, with a cursor of at most 4,096 characters. Content selects at most
five initial pins and twenty ordinary candidates in native order. Continuation advances the ordinary source, keeps
the initial pin exclusion cohort, and preserves sparse `next` pages. A rejected continuation must retain its exact
input for retry; `invalid_cursor` requires an explicit first-page restart with the same Board and sort. A malformed
query, rank-not-ready result, denial, signed-out advice, closed Board and dependency failure keep their distinct
native outcomes. Web does not refill sparse pages or derive activity from loaded rows or revision timestamps.

## Web receiving status

Decision: keep the current Board route on its existing typed reads until `@rezics/client` publishes
`boards({ id }).page.get`; do not hand-author or fetch the source-only endpoint.

The source route and response schema exist in Content, but the installed `@rezics/client` has no generated
`boards({ id }).page.get` method or `BoardPageResponse` export. The generated route declaration contains the Board
`get` and `threads.get` operations only; `contracts/openapi.json` has no `board_page.get` operation. The checked Web
fixtures also have no native opening response. This exact publication gap prevents a typed loader integration. Web
must not cast the client, introduce a parallel DTO, or call the route with direct `fetch`.

Until that generated surface is installed, `loadBoardPageWithAuthors` remains the existing route reader: it composes
the Board read, the optional separate Realm read, the board-threads page and one batched author read. The current
Board route, its actual-reader admission, query ownership and transfer boundary, pin cohort, explicit cursor restart,
shared actions and command return behavior remain in place. They do not establish a one-request native opening or
consumer growth result.

When generated publication arrives, bind its actual signature, DTO, errors and examples through this loader and the
existing caller. Accept the envelope once before Query success, project the supplied fields into the existing
`BoardCommunity`, card and `FeedActionBar` contracts, and retire only the joins it replaces. Keep exact pin, watch and
slow-mode owners where the envelope has no corresponding authority. Do not treat Board readability, membership
labels or successful reads as permission to contribute or moderate. Preserve the caller's current-reader comparison,
source/session/locale retirement, and the independent-cache first-paint limit in
[Board page lifetime](board-page-lifetime.md).

## Evidence boundary

The Content source schema and route establish the producer implementation, not installed Web transport or native
execution. No Web fixture, story or type assertion can establish the missing generated publication, native authority,
hydration witnesses or physical growth. The current native receiver tests, named page stories, 1/10/25 selected-row
consumer measurement, and phone/desktop, theme, keyboard and locale review remain owed after publication. Content's
physical 256/1024/4096 growth and nested-authority evidence remains separate from Web consumer measurements.

The Board activity fields remain unavailable in this response. A01 and A02 Home findings are not satisfied by a
Board page, and A08 is not satisfied by post revision time or the loaded reply window. Keep existing plaintext,
preview bounds and author-declared spoiler reveal behavior when composing the admitted `ThreadView`.
