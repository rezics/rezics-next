# Moderator workbench cases

## Case reference and return navigation

Decision: stable references pair the native report ID with its scoped queue snapshot; Subject cases stay on the catalogue surface, and report cases do not create another appeal surface.

A board, thread or post case reference is `/moderation/cases/{reportId}` with the source queue's `boardId` and its
optional `thread`, `post`, `cursor`, `status`, `targetKind` and `order` search values. `reportId` is the stable native
reference; the scoped queue fields preserve where the case was opened. `workbenchCaseHref(reportId, input)` builds this
reference. Returning reconstructs `/boards/{boardId}/moderation` with the same target scope, cursor, filters and order.
The case route never advances through pages to search for an ID. If the report is absent from that exact bounded page,
the case is unavailable. The existing board queue owns adding the entry link and retaining its list behavior.

Subject reports stay on `/moderation/catalogue`, where the catalogue report reader independently loads the subject and
its reports. A Subject is never converted to a board, thread or post target. Appeals remain on the scoped Appeals queue
at `/boards/{boardId}/moderation?tab=appeals`; this report case page does not imply a platform-wide appeal.

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
`POST /v1/moderation-appeals/{appealId}:resolve` command on the Appeals queue.

## Remaining binding

The case page and typed reference builder are complete against existing report-list and command clients. The queue
owner can bind each row's stable `reportId` and current queue input to `workbenchCaseHref`; no producer API is pending.
