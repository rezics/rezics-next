# Moderation interfaces

Web owns moderator-facing routes, private reader lifetime and presentation. Content owns queue candidates, case
identity, native scope, projection, authorization and disclosure. Community owns Realm membership and the paged
Realm board directory. Reporter status and the author's decision/appeal pages remain separate journeys. Case-detail
triage (resolution forms, target inspection and bulk actions) stays on the existing board and catalogue review
pages until a dedicated case-detail outcome owns it.

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
