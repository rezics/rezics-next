# Moderation interfaces

Web owns moderator-facing routes, private reader lifetime and presentation. Content owns queue candidates, case
identity, native scope, projection, authorization and disclosure. Community owns Realm membership and the paged
Realm board directory. Reporter status and the author's decision/appeal pages remain separate journeys. Case-detail
triage (resolution forms, target inspection and bulk actions) stays on the existing board and catalogue review
pages until a dedicated case-detail outcome owns it.

## Affected-author decision receipt

`/moderation/decisions/{id}` is the affected person's exact private receipt. Content's response contract composes the
retained reason, decision time, deadline, current appeal result, closed `viewer.appeal` advice, optional `targetContext`
and final source provenance in `GET /v1/moderation-decisions/{id}`. The installed generated response supplies
closed advice and context. The final source observation is the producer's opaque `rezics-session-token` response
header, hashed before crossing the server boundary. Missing native source observation keeps the read unavailable.
Web selects that exact endpoint once and never hydrates a post or thread. Available context supplies only current
native Board and Thread destinations through the existing localized route helpers. Concealed and unavailable
context remain distinct without hiding the independent receipt or native operational reasons. Only native permitted
advice together with current browser command admission presents the form. Authorship, readability and browser time
never create appeal authority; the appeal command repeats native authorization.

Decision: bind the final opaque native session header as the decision source observation, independently of the prepared
reader origin; never decode it or invent an actor/session/source response DTO.

The [private-reader guide](private-reader-lifetime.md) records retirement across account, session/CSRF, locale,
exposure, route and native source replacement. Explicit recovery admits a fresh visit. An uncertain command retains
its exact decision, statement, key and credentials for explicit retry; acknowledgement and current readback remain
independent. Original intent, drafts and late callbacks retire with the visit.

### Cost

- Touches: one selected composed decision read plus existing session preparation; one explicit appeal command and
  one selected current decision readback after an acknowledgement or conflict.
- Bound: one decision ID and one visit. There is no target hydration, queue scan, polling, persistent draft, or
  accumulated receipt history. Statement, optional context, advice, draft, original intent and readback live only for
  that admitted visit.
- Growth: Content's current schema declares no `maxLength` or byte cap for retained decision statements, appeal
  resolution statements, or context titles. Appeal submissions have `maxLength: 2000`; takedown reason writes have
  `maxLength: 1024`. Web varies supplied text/context and unrelated fixture history while asserting one selected
  response. This does not bound Content's nested native reads or serialized bytes; Content/controller owns that
  physical cost evidence.

## Workbench queue

An authorized signed-in moderator enters `/moderation/workbench`. One navigation entry replaces the previous
catalogue-only shell link. The workbench selects **one** currently permitted scope at a time:

- a Realm from `GET /v1/me/realms`, then one board from that Realm's paged `GET /v1/realms/{id}/boards`
- or the Global catalogue (`GET /v1/catalogue/reports`), which still requires current Global `moderation:read_reports`

Membership or a listed board is not moderation permission. Each selected queue repeats exact parent/target
authorization. A board moderator is never widened to catalogue authority. There is no platform-wide appeal
adjudication and no aggregate case search across boards.

Submitted reports, pending appeals and resolved cases are exclusive queues. Reports use native
`status=pending|resolved` with `targetKind` and `order`. Appeals use the board appeal list (pending by nature).
Catalogue has no appeal list; that control stays visible and explains the missing native seam. Continuation uses
the sealed native cursor, not report target IDs. Each row carries a stable report or appeal ID into the existing
detail surface (`/moderation/cases/{reportId}`, the selected workbench appeal, or `/moderation/catalogue`).

The queue reads installed native list declarations only. It does not hydrate target documents or reported revisions. Private evidence
and appeal statements appear only when that list returned them. Unavailable, denied and retired reads render no
cases. Viewer or session replacement retires the mounted private owner.

## Remaining producer binding

Connected: `me.realms`, Realm boards, `boards/{id}.reports`, `boards/{id}.appeals`, and catalogue reports (status
and order forwarded through the existing catalogue client seam). Absent: a producer that lists only currently
permitted moderation queues; a moderator case-detail GET; catalogue appeals. Native uncertain commands stay on the
existing review pages and retain original sender, credentials, key and operands. Workbench rows open
`/moderation/cases/{reportId}` or the selected workbench appeal (`case`) and return to `/moderation/workbench` with
the captured snapshot. Loaded pending board reports can be dismissed through the existing per-report command, at most
twenty on the current page.

## Exact appeal inspection

The existing selected workbench consumer accepts one exact selection independently of the bounded pending page.
It never selects by searching pending rows. Its presentation keeps the original decision target separate from the
native current board/thread destination and uses only disclosed appellant display names and handles. It does not
read current target bodies or fall back to the appellant account ID. Board and thread pending reads do no per-row
target, identity or media hydration. Board targets remain operational appeals.

The integrated Content producer supplies composed inspection, but the installed generated client still lacks its
`inspect` request and response. Production exact selection remains the named `native-appeal-inspect` unavailable
seam. The local composed admission seam checks exact selection, final source provenance, current actor/client/epoch,
private reader and opaque native session header. The selected consumer carries that token only on the private read
and original frozen command; it is never decoded or rendered, and resolution retry echoes it unchanged. Generated
request binding and mounted native producer cases remain continuation work. See the [case and appeal guide](workbench-case.md)
for the source, retirement and Cost boundaries. Native command authorization stays authoritative; a current resolved
observation or changed `canResolve` hint cannot acknowledge an uncertain original command.

Selected workbench retry stays inside its admitted private reader and preserves the exact search, including the
selected appeal and captured cursor. Keyboard recovery returns to the retry control or workbench boundary unless
focus moved or the owner retired. Selected resolution reports pending and uncertain intent synchronously to the
workbench, which blocks refresh until settlement; explicit unknown retry keeps the original command.

## Own reporter inventory consumer seam

`reporter-history/model.ts`, `read.ts` and `server.ts` implement the named minimal local consumer seam
`report.own_history` against mounted `GET /v1/reports/me`. This is a public wire validator, not installed generated
client typing. The server prepares the current session once and accepts only cursor and exact report selection;
there is no browser account selector. A response must carry an opaque native session header, hashed independently
of the prepared reader origin. Closed viewer/action advice, exact safe native destinations, selection and original
retry frontier are checked before rows are retained. Concealed targets remain independent from readable reports.
Preparing, denial, cursor expiry and dependency failure remain distinct from an empty ready page.

Decision: while shared declarations are pending, use an explicit public-wire own-history seam and keep a missing
configured native origin unavailable, including development; never present fixture data as a delivered inventory.

### Cost: own-history consumer read

- Touches: one session preparation and one mounted own-history GET; one response validation and source hash.
- Bound: one page with at most twenty ordinary rows and one exact selected row; no target or identity hydration,
  page search, total calculation or row accumulation. The wire validator does not establish a native materialization
  or serialization byte bound.
- Growth check: focused consumer cases pin exact endpoint/operands, sparse and preparing results, selection,
  private projection and safe advice. Native independent-population growth remains controller/producer work.

The localized route, private visit owner, account navigation and story states remain in the continuation brief;
this seam alone is not a served history page. Installed declaration head and native execution remain unverified.
