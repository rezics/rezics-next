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
detail surface (`/boards/{id}/moderation` or `/moderation/catalogue`).

The queue reads native list DTOs only. It does not hydrate target documents or reported revisions. Private evidence
and appeal statements appear only when that list returned them. Unavailable, denied and retired reads render no
cases. Viewer or session replacement retires the mounted private owner.

## Remaining producer binding

Connected: `me.realms`, Realm boards, `boards/{id}.reports`, `boards/{id}.appeals`, and catalogue reports (status
and order forwarded through the existing catalogue client seam). Absent: a producer that lists only currently
permitted moderation queues; a moderator case-detail GET; catalogue appeals. Native uncertain commands stay on the
existing review pages and retain original sender, credentials, key and operands.
