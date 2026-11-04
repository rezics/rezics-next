# Moderator workbench cases

## Case reference and return navigation

Decision: selected board reports open `/moderation/cases/{reportId}`; selected board appeals stay on the workbench
appeals queue with `case`. Both return to `/moderation/workbench` with the captured board, queue, filter, order and
cursor. Subject reports stay on the catalogue surface.

Decision: moderator case reads use an additive inspection envelope on `GET /v1/reports/{reportId}`. The route
selects by `reportId` alone; the captured queue scope and cursor are used only for the return link.

A board, thread or post case reference is `/moderation/cases/{reportId}` with the source queue's `boardId`, `queue`
(`reports` or `resolved`), `status`, `targetKind`, `order`, and optional `realm`, `thread`, `post` and `cursor`.
`reportId` is the stable native reference; the scoped queue fields preserve where the case was opened.
`workbenchCaseHref` on the workbench row builds this reference from the current snapshot. Returning reconstructs
`/moderation/workbench` with that board, queue, Realm, target-kind filter, order and cursor. The case route never
advances through pages to search for an ID. It loads the exact report independently, so pagination or resolution of
the captured queue does not invalidate the link. Unknown and concealed IDs share the unavailable response.

Subject reports stay on `/moderation/catalogue`, where the catalogue report reader independently loads the subject and
its reports. A Subject is never converted to a board, thread or post target. An appeal keeps its native ID on
`/moderation/workbench?queue=appeals&board={boardId}&case={appealId}` with the same cursor. Native `inspect` must select that exact ID independently of the pending page, including
resolved appeals. Missing inspection is unavailable and never triggers scanning or a refill. This report case page does not imply a platform-wide appeal.

## Read and disclosure boundary

The route makes one exact report-resource read. The moderator response composes the retained report, its exact
reported post revision, current target state and destination, and current dismiss/takedown advice. Parent moderation
authorization precedes report detail, reporter disclosure and evidence. The reported revision remains separate from
current target availability; a concealed or unavailable current target never supplies a body or actions. Existing
native target readers bound disclosure, and existing report and moderation commands remain the only writers. Unknown
and concealed IDs share the unavailable response. The reader does not scan queue pages, substitute a target ID or
hydrate documents per row.

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

## Remaining generated binding

The installed generated board/thread Appeals GET still declares only `cursor`, `limit`, `appeals` and `next`.
The integrated Content producer declares the composed `inspect` request, but its declaration publication cannot
currently complete against the base compiler errors. Production inspection therefore retains the named
`native-appeal-inspect` unavailable seam and performs no native request. Pending rows never substitute for inspection.
The producer contract is in `services/kernel/src/content/appeal-routes.ts` and its final observation semantics are in
`services/kernel/src/content/appeals.ts`.

The local composed inspection admission seam checks the selected ID, explicit pending/resolved field, source
partition/epoch and position against final page provenance, and actor/client/authentication epoch against the same
credential used by the successful native read and the prepared private reader. It requires the opaque native response
session header. The browser's prepared reader independently checks its current session fingerprint and retires on
replacement. Native provenance is an observation, not command permission; `canResolve` remains advice.

Decision: carry the opaque native response session token only on an admitted private read and its original frozen
resolution command; never decode it, render it or reconstruct it from provenance. The command adapter sends that
original token unchanged. A current resolved observation cannot settle an uncertain command or replace its sender,
CSRF headers, key, outcome or statement. A changed `canResolve` hint does not prevent that original explicit retry;
native authorization and idempotency still decide its result.

The selected consumer can carry the opaque token through its existing private reader. Connecting the composed
admission seam to generated board/thread requests and mounted native producer cases remains continuation work.
No new native DTO or endpoint is authored by Web.

## Cost

### Cost: selected report inspection

- **Touches:** one exact report reference read, one parent moderation authorization before and after retaining the
  report, one exact private report read, and a final exact reference check. The composed read adds at most one exact
  reported-revision selection, the existing native reported-revision reader, one current target selection with its
  bounded containing Thread/Board observations, and one current action-advice authorization. It never calls a report
  queue reader.
- **Bound:** selection is one `reportId`; report evidence retains its existing 4096-character limit. Revision and
  target content use the existing point readers and their body, label, actor and nested-disclosure limits. The result
  has one report, at most one revision and one current target; withheld branches omit target values and destinations.
  Queue, unrelated report, revision and authority history do not expand selection cardinality.
- **Growth check:** the route transport regression proves an exact GET and no queue/target list calls; the native
  focused journey covers a pending report outside the first queue page and denied/unknown concealment. Independent
  256/1024/4096 source, authority and serialization growth measurements remain deferred; no physical-work ceiling is
  claimed here.

- **Touches:** one board or thread Appeals GET per explicit pending read; no Account, Media or current-target
  reads. Unsupported production inspection performs zero native calls. When the generated operation is installed,
  each explicit selected retry must repeat its identical captured read without scanning or refilling. The resolution
  adapter echoes the original opaque native session token unchanged, with the original key and operands. Pending or
  uncertain resolution blocks refresh and retry reads.
- **Bound:** one page of at most 20, one optional exact selection, the native continuation and one original command.
  Recovery retains one current projection, one in-flight read and one focus handoff, without a page history.
  An empty page with `next` stays sparse. A missing selection is unavailable even when the page contains its ID.
- **Growth:** pending adaptation retains the native page in O(rows + admitted bytes), with no deduplicated enrichment
  graph. Provenance validation is O(rows) with constant-size source comparisons. Inspection and same-input retry do not advance or refill the queue. Keyboard recovery adds constant work. Command retries retain the same sender, CSRF headers,
  frozen body, key and operands; they do not reread or recover request identity.
