# Moderation interfaces

Web owns moderator-facing routes, private reader lifetime and presentation. Content owns queue candidates, case
identity, native scope, projection, authorization and disclosure. Reporter status and the author's decision/appeal
pages remain separate journeys. The workbench does not derive moderation scope coverage from Realm membership or
Realm board listings. Case-detail triage stays on the existing board and catalogue review pages until a dedicated
case-detail outcome owns it.

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

## Workbench queue and scope

An authorized signed-in moderator enters `/moderation/workbench`. The workbench reads one selected board or catalogue
queue at a time. Board and catalogue deep links may be entered directly; a board does not need a Realm parent. Every
selected queue repeats its exact native authorization. A board grant does not grant Global catalogue access, and
there is no platform-wide appeal adjudication or cross-board case search.

Reports, pending board appeals and resolved reports are distinct queues. Reports use native `status=pending|resolved`
with `targetKind` and `order`; appeals use the board's pending list. Continuation uses the native queue cursor. Each
row retains its independent report or appeal ID and selected queue snapshot. Catalogue reports require current Global
`moderation:read_reports`; the catalogue has no native appeal queue. The queue reads installed native list declarations
only. It does not hydrate target documents or reported revisions. Private evidence and appeal statements appear only
when that list returned them. Denied, unavailable and retired reads render no cases. Viewer or session replacement
retires the mounted private owner.

The local public directory contract in `workbench-queue/directory.ts` is a consumer seam only; it neither mounts an
HTTP route nor supplies a native source. The production scope directory is unavailable, so unselected discovery
renders unavailable rather than a complete empty result and has no scope labels or controls. The consumer does not
fall back to `GET /v1/me/realms` or `GET /v1/realms/{id}/boards` for moderator-scope coverage. See
[Remaining producer bindings](#remaining-producer-bindings) for the missing source and declarations.

### Public directory consumer contract

A page has closed `state` advice. `preparing`, `unavailable`, `denied` and `stale` retain no items or continuation.
`ready` has at most 20 items, nullable opaque `next`, opaque final native `source` (up to 256 characters) and exclusive
`validUntil`. The horizon must cover both candidate coverage and current actor/authority lifetime, at most 180 seconds.
Each item has a native `scope` (`board` with `id`, or independently authorized `catalogue`), current `label`, nullable
safe Realm `parent` (`id`, `label`), supported `queues` and closed `viewer.open` advice (`permitted`, `denied`,
`unavailable`). Board IDs and parent IDs are at most 128 characters and labels are at most 1024 characters. Catalogue
has no parent or appeals. No counts, reporters, evidence, grants or membership facts cross this seam. Discovery advice
is never command authority. Only native permitted advice creates enabled queue controls or a native destination.

`directoryCursor` is independent of the selected queue's `cursor`; it belongs to the private read key and captured
URL. A failed continuation retries the same search/frontier. A ready sparse page with `next` explains that more scopes
may exist; it never declares a complete empty result. Unknown or malformed source data becomes unavailable. Expired
observations discard all directory labels, cursors and controls. Selection handlers check the original observation and
private visit at activation, so retained or late callbacks cannot navigate with retired advice. The private reader
owns account, credential/session, locale and route retirement and async generation guards.

### Cost: workbench queue and scope

- Touches: unselected discovery invokes only the local directory seam, whose production source makes no native read;
  a directly selected board queue or catalogue reports queue makes one exact native page read without directory,
  Realm membership or Realm board-list reads.
- Bound: the directory consumer retains at most 20 records, three queue choices each, 128-character identifiers,
  two 1024-character labels per item, a 256-character source observation and one 4096-character continuation. Queue
  reads retain one native page and cursor, without target or reported-revision hydration or a page accumulator. These
  browser bounds do not establish native materialization or work bounds.
- Growth check: `tests/moderation-directory-consumer.test.tsx` covers consumer admission and retained limits. Native
  candidate, grant, membership and repair populations, final disclosure observations and actual worker operations
  remain producer/controller work; no native Cost claim follows from these fixtures.

## Workbench case and exact appeal

A board, thread or post case uses `/moderation/cases/{reportId}` and selects that exact report independently of queue
pagination. The captured board, queue, status, filters, order and cursor restore only the return destination; the case
route never advances pages to find an ID. Unknown and concealed IDs share the unavailable response. Subject reports
remain on `/moderation/catalogue` and are never converted to board, thread or post targets. See the
[case and appeal guide](workbench-case.md) for the source, disclosure, retirement and operation Cost boundaries.

Report, decision, appeal and target IDs remain distinct references. The case route uses the stable report ID, and an
exact appeal selection uses the native appeal ID.

An exact appeal selection preserves its native appeal ID and captured workbench search. It is independent of the
bounded pending page and is never resolved by searching, scanning or refilling queue rows. Its presentation keeps the
original decision target separate from the current board/thread destination; it uses only disclosed appellant display
names and handles, never an appellant account ID or a current target body. Pending board and thread reads do no per-row
target, identity or media hydration. Board targets remain operational appeals.

Case dismissal and takedown continue to use the existing review commands. An uncertain command retains its original
sender, credentials, idempotency key and operands for explicit retry; current readback does not replace that intent.
Selected workbench retry stays inside its admitted private reader and preserves the exact search, including the appeal
selection and captured cursor. Keyboard recovery returns to the retry control or workbench boundary unless focus moved
or the owner retired. Pending or uncertain resolution blocks refresh until settlement.

## Remaining producer bindings

Connected list and case reads are `boards/{id}.reports`, `boards/{id}.appeals`, catalogue reports (with status and
order forwarded through the existing catalogue client seam), and exact moderator report inspection at
`GET /v1/reports/{reportId}`. Exact case inspection takes the report ID independently of queue pagination; the
captured queue state restores only the return context. Workbench rows preserve their report or appeal ID when opening
the corresponding case, catalogue or appeal destination.

Still absent is the native directory that lists only currently permitted moderation queues and its installed
declarations. The production consumer therefore uses `nativeModerationDirectoryUnavailable` and does not claim
`me.realms` or Realm-board listings as coverage. The integrated Content producer declares composed appeal inspection,
but the installed generated board/thread appeals client still lacks its `inspect` request and selected response.
Production exact appeal selection remains the named `native-appeal-inspect` unavailable seam and makes no native
inspection request. Catalogue appeals have no native list. Source preparation and local consumer tests do not prove
native execution. Native commands remain authoritative and retain their original sender, credentials, key and
operands.

## Own reporter inventory

`reporter-history/model.ts` derives the query and response from the installed `@rezics/client` declaration for
`GET /v1/reports/me`. `read.ts` uses that generated callable with private no-store transport and validates native
ownership, disclosure advice, exact safe destinations, selection and the original retry frontier before retaining
rows. The server prepares the signed-in session once and accepts only cursor and exact report selection; there is no
browser account selector. A native session header fingerprint remains independent from the prepared reader origin.
Preparing, denial, cursor expiry and dependency failure remain distinct from an empty ready page.

My reports is a localized, signed-in Library destination backed by public native exposure. Web admits a visit through
the current session incarnation and native account authorization; it does not require a private-control operation
grant. The served route uses one replacement page, exact selected-report confirmation and the fixed local status
return carrying its opaque cursor and selected report ID. Session, credential, exposure, locale, source and
navigation replacement retire the visit.

Decision: a missing configured native origin remains unavailable, including development; never present fixture data as a delivered inventory.

### Cost: own-history consumer read

- Touches: one session preparation and one mounted own-history GET; one response validation and source hash.
- Bound: one page with at most twenty ordinary rows and one exact selected row; no target or identity hydration,
  page search, total calculation or row accumulation. The wire validator does not establish a native materialization
  or serialization byte bound.
- Growth check: focused consumer cases pin exact endpoint/operands, sparse and preparing results, selection,
  private projection and safe advice. Native independent-population growth remains controller/producer work.

The localized route, private visit owner, account navigation and story states remain in the continuation brief;
this seam alone is not a served history page. Installed declaration head and native execution remain unverified.

Decision: an own-history visit retains one replacement page and exact selection; failed continuation retries its original operands, expiry restarts explicitly, and locale or native source replacement retires the visit.

Decision: My reports opens at `/moderation/reports`; its status return uses a fixed local destination carrying the exact cursor and selected report ID.

`reporter-history/journey.ts` owns prepared browser admission and page replacement through the shared private-reader lifetime; the localized Reports route mounts it through `view.tsx`.

Decision: served history next/select/restart commit closed route operands; retry/refresh reload the same address. The loader alone publishes each new private visit, and sparse frontiers retain continuation without claiming completed emptiness. Invalid status return operands recover to My reports.
