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
its reports. A Subject is never converted to a board, thread or post target. An appeal keeps its native ID on
`/moderation/workbench?queue=appeals&board={boardId}&case={appealId}` with the same cursor. Native `inspect` must select that exact ID independently of the pending page, including
resolved appeals. Missing inspection is unavailable and never triggers scanning or a refill. This report case page does not imply a platform-wide appeal.

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
`POST /v1/moderation-appeals/{appealId}:resolve` command on the selected workbench appeal. The original decision,
statement and target reference remain separate from the current destination. The selected presentation uses only the
native allowlisted appellant display name and handle plus the current board/thread destination reference. It never
falls back to `appellantId` or reads a current target body. Concealed and unavailable context keeps the appeal and its
resolution visible. Appeal reads do no per-row target, identity or media hydration. The independent selected
presentation consumes one exact appeal and its resolution, never a matching row from the pending page.

Decision: show only native appellant display names and handles and the current board/thread destination IDs; never
fall back to appellant IDs or render current target bodies. Keep concealed and unavailable states explicit.

A session, board, queue, page or reader replacement retires the mounted case or appeal and its command authority.
Uncertain retry keeps the original sender, credentials, key and operands. Authoring departure uses the existing
report-review and appeal navigation contexts.

## Inspection recovery

Decision: retry a selected appeal inside its mounted workbench owner with the identical captured search; do not
invalidate the route or refresh a pending or uncertain resolution. A keyboard retry returns focus to the next
recovery control or admitted workbench boundary. Pointer input, moved focus, departure or session retirement cancels
that handoff. Refresh is explicit and remains disabled until the original resolution settles; uncertain recovery
continues to use only the original frozen command and sender.

## Remaining binding

The report case page and typed return builder remain bound to their existing clients. The installed generated
board/thread Appeals GET declares only `cursor`, `limit`, `appeals` and `next`; it lacks `inspect`, `selectedAppeal`,
`appellantIdentity`, `targetContext`, `resolutionCommand`, `source` and `provenance`. Content's producer schema and
examples in `services/kernel/src/content/appeal-routes.ts` contain those fields, but they have not arrived in the
installed client. The named `native-appeal-inspect` seam remains unavailable without an undeclared request, cast or
page-only fallback. The consumer view accepts the composed shape, while native page/selection provenance and opaque
session custody still need to be bound. No new native DTO or endpoint is authored by Web.

Decision: retain the installed pending list and make exact inspection explicitly unavailable until generated composed
inspection types arrive; keep the independent selection consumer ready without deriving selection from queue rows.

The next binding must preserve actor/session/source provenance and the opaque native session header, project the
allowlisted appellant and current destination, retain exact pending/resolved status, and bind the original command.
Native authorization remains authoritative at execution; `canResolve` is advice. Current context has no target body,
and original evidence must never be relabelled as current content. Source delivery, installed declarations, executed
acceptance and public publication remain separate boundaries.

## Cost

- **Touches:** one board Appeals GET per explicit pending read; no Account, Media or current-target reads. The
  unsupported selected inspection currently performs zero native calls; once the generated request arrives, each
  explicit selected retry will repeat that exact read. Resolution uses the existing command owner. Pending or
  uncertain resolution blocks refresh and retry reads.
- **Bound:** one page of at most 20, one optional exact selection, the native continuation and one original command.
  Recovery retains one current projection, one in-flight read and one focus handoff, without a page history.
  An empty page with `next` stays sparse. A missing selection is unavailable even when the page contains its ID.
- **Growth:** pending adaptation retains the native page in O(rows + admitted bytes), with no deduplicated enrichment
  graph. Inspection and same-input retry do not advance or refill the queue. Keyboard recovery adds constant work. Command retries retain the same sender, CSRF headers,
  frozen body, key and operands; they do not reread or recover request identity.
