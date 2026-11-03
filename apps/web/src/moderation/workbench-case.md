# Moderator workbench cases

## Case reference and return navigation

Decision: selected board reports open `/moderation/cases/{reportId}`; selected board appeals stay on the workbench
appeals queue with `case`. Both return to `/moderation/workbench` with the captured board, queue, filter, order and
cursor. Subject reports stay on the catalogue surface.

A board, thread or post case reference is `/moderation/cases/{reportId}` with the source queue's `boardId`, `queue`
(`reports` or `resolved`), `status`, `targetKind`, `order`, and optional `realm`, `thread`, `post` and `cursor`.
`reportId` is the stable native reference; the scoped queue fields preserve where the case was opened.
`workbenchCaseHref` on the workbench row builds this reference from the current snapshot. Returning reconstructs
`/moderation/workbench` with that board, queue, Realm, target-kind filter, order and cursor. The case route never
advances through pages to search for an ID. If the report is absent from that exact bounded page, the case is
unavailable.

Subject reports stay on `/moderation/catalogue`, where the catalogue report reader independently loads the subject and
its reports. A Subject is never converted to a board, thread or post target. A pending appeal keeps its native ID on
`/moderation/workbench?queue=appeals&board={boardId}&case={appealId}` with the same cursor; an absent ID on that exact
page is unavailable and is never found by scanning. This report case page does not imply a platform-wide appeal.

## Read and disclosure boundary

The route consumes the current typed Web report reader. It uses the existing scoped report-list operation, then the
existing independent current-target and exact reported-post-revision reads. It adds no endpoint and does not infer a
target read grant from the case reference or report visibility. The existing target presenter withholds unavailable,
erased and withheld bodies honestly. Only fields already disclosed by the report reader are rendered.

The browser visit is bound to the prepared private reader, QueryClient, current session and route navigation. Scope or
session retirement hides the case and retires its decision controller. The mounted form clears on retirement; pending
native settlement cannot update a successor visit.

## Decisions and recovery

The existing `ReportReviewCard` is the single-case decision control. Dismissal sends `POST /v1/reports/{reportId}:dismiss`
with the original idempotency key. A target takedown sends `POST /v1/{boards|threads|posts}/{targetId}:takeDown` with
the native `targetKind`, `targetId`, a required 1–1024 character reason and the same command's idempotency key. These
commands use the current session credential; native authorization and conflict results remain authoritative.

The form shows its confirmed or uncertain result before the reviewer follows the scoped queue return link. An uncertain
result permits only the existing exact retry, retaining the original sender, credentials, key and operands. Conflict,
denied and definitive refusal require refresh or a fresh read; unavailable current or reported content remains visibly
unavailable. Appeal resolution continues to use the existing minimal owner-scoped `AppealResolution` controls and native
`POST /v1/moderation-appeals/{appealId}:resolve` command on the selected workbench appeal. The original decision and
statement come from the captured appeals page; the current target is one independent post or thread read for that
selected appeal only. Queue rows still do not hydrate targets.

A session, board, queue, page or reader replacement retires the mounted case or appeal and its command authority.
Uncertain retry keeps the original sender, credentials, key and operands. Authoring departure uses the existing
report-review and appeal navigation contexts.

## Remaining binding

The case page, selected appeal view and typed reference builder are complete against existing report-list, appeal-list
and command clients. Rows bind the stable native ID and current queue snapshot; no producer API is pending. Content
still owns native authorization, conflict and command semantics. There is no moderator case-detail GET; absence on the
referenced page stays unavailable.
