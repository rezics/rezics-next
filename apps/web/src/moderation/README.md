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

An authorized signed-in moderator enters `/moderation/workbench`. Discovery consumes a paged native moderator-scope
response, independently of Realm membership. A supplied board scope can be selected without a Realm or parent.
One selected board or Global catalogue still reads its existing exact native queue, with its original cursor,
filters and independent authorization. Manual board and catalogue deep links remain supported.

Decision: until the native directory and its published declarations arrive, use the named
`nativeModerationDirectoryUnavailable` local consumer seam; never substitute membership or board inventories.

The native producer and installed typing are **not delivered**. The production discovery seam returns unavailable,
with no scope labels or controls. This is separate from a complete native empty page and from preparing projection
coverage. The former `me.realms` then Realm-board discovery and unconditional catalogue selection are retired.
Catalogue never offers an appeals control. An old exact catalogue-appeals link explains the absent producer.

### Public directory consumer contract

`workbench-queue/directory.ts` defines only a local public response shape, without private Content imports or a
cast of the installed client. It is the integration seam for a future native directory; it does not mount an HTTP
route or claim the source exists. The producer owner must adopt/mount the final public contract and supply its
OpenAPI input to the shared complete-input publisher before replacing this seam with installed declarations.

A page has closed `state` advice. `preparing`, `unavailable`, `denied` and `stale` retain no items or continuation.
`ready` has at most 20 items, nullable opaque `next`, opaque final native `source` (up to 256 characters) and exclusive
`validUntil`. The horizon must cover both candidate coverage and current actor/authority lifetime, at most 180 seconds.
Each item has a native `scope` (`board` with `id`, or independently authorized `catalogue`), current `label`, nullable
safe Realm `parent` (`id`, `label`), supported `queues` and closed `viewer.open` advice (`permitted`, `denied`,
`unavailable`). Board IDs and parent IDs are at most 128 characters and labels at most 1024 characters. Catalogue has
no parent or appeals. No counts, reporters, evidence, grants or membership facts cross this seam. Discovery advice
is never command authority. Only native permitted advice creates enabled queue controls or a native destination.

`directoryCursor` is independent of the selected queue's `cursor`; it belongs to the private read key and captured
URL. A failed continuation retries the same search/frontier. A ready sparse page with `next` explains that more
scopes may exist; it never declares a complete empty result. Unknown or malformed source data becomes unavailable.
Expired observations discard all directory labels, cursors and controls. Selection handlers also check the original
observation and private visit at activation, so retained or late callbacks cannot navigate with retired advice.
The existing private reader owns account, credential/session, locale and route retirement and async generation guards.

### Cost: directory consumer

- Touches: one supplied directory response for an unselected or Realm-filtered discovery page; one exact native queue
  read for a selected board/catalogue, without a directory read. Membership and Realm board inventories are not called.
- Bound: one page, at most 20 copied item records, three queue choices each, 128-character identifiers, two
  1024-character labels per item, a 256-character source observation and one 4096-character continuation. The consumer
  discards unknown fields, rejects duplicate scopes, malformed advice and unsupported catalogue queues, and keeps no
  page accumulator. These retained browser bounds do not establish upstream materialization or native work bounds.
- Growth check: `tests/moderation-directory-consumer.test.tsx` covers source admission and retained consumer limits.
  Native candidate, grant, membership and repair populations, 256/1024/4096 growth, final disclosure observations and
  actual worker operations remain the producer continuation's work. No native Cost claim follows from these fixtures.

Submitted reports, pending appeals and resolved cases remain exclusive queues. Reports use native
`status=pending|resolved` with `targetKind` and `order`; appeals use the board's pending list. Case rows keep stable
native report/appeal IDs and exact selected queue snapshots. Case-detail triage and uncertain native commands remain
on existing review pages with their original sender, credentials, operands and idempotency key.

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
