# Private progress-session journal

This is the owner contract for personal start and finish dates, a private reflection and a private numeric assessment on
one existing Library progress session. The session ID identifies one real occurrence, so rereads and rewatches of the
same subject retain separate journals. Native session progress remains authoritative; this journal does not create or
replace a session.

## Mounted API

The owner-only authenticated routes are:

```http
GET   /v1/progressSessions/{sessionId}/journal
PATCH /v1/progressSessions/{sessionId}/journal
```

GET returns `{journal:{sessionId,revision,startDate,finishDate,reflection,assessment}}`. Dates and reflection are null
when absent. Assessment is `{meaningRevision:1,units:number|null}`. PATCH takes
`{revision,startDate?,finishDate?,reflection?,assessment?}` and an `Idempotency-Key`, and returns
`{journal:{sessionId,revision,changed}}`. The PATCH receipt intentionally contains no private date or reflection
copy. Read the current values with GET after the write; an uncertain PATCH retry returns the original revision and
`changed` result without applying another edit.

Decision: date and reflection fields share one journal-local revision independent of progress; PATCH receipts retain
only session ID, resulting journal revision and `changed`, while GET supplies private values. Assessment is stored on
the same occurrence row with meaning revision 1; its integer units range from 0 through 20 in steps of 1 and display as
`units / 2`. PATCH accepts `{units:number}` to set it or `null` to clear it; omission preserves it.

`revision` is journal-local and starts at `0`. One revision covers dates, reflection and assessment. It advances once when at least
one value changes. An omitted field is unchanged; `null` explicitly clears that field; a supplied equal value is a
no-op. Zero is an assessment value; `assessment:null` means no current assessment, while an omitted assessment
preserves the current one. Clearing an already absent value and an empty patch return `changed:false` without advancing
the revision. The command receipt still binds the original request, so an uncertain response retries with the same key
and exact body. A different edit with a stale journal revision returns `409 conflict` and changes nothing.

The journal revision is independent of `progressSession.revision`. Progress recording, completion, abandonment,
completed units and measures keep their existing revision and history. Journal edits never change those facts,
`startedAt`, `completedAt`, `last_changed_at`, shelf activity, finished units, or the state of the occurrence. Active,
completed and abandoned sessions can all be journaled. A missing or foreign session is concealed as `404`; an
authenticated owner without update authority receives the existing denial response.

## Reported dates and reflection

Each reported date is a plain calendar value with supported precision from year through day:

```json
{"year": 2022}
{"year": 2022, "month": 11}
{"year": 2022, "month": 11, "day": 4}
```

Month requires year; day requires month. Calendar values are validated, including leap days. Unknown month or day
stays absent. The service does not fill components, compare start and finish ordering, attach a time zone, or turn a
partial date into an instant. Reported `startDate` and `finishDate` remain separate from native `startedAt`,
`completedAt`, command time and audit time.

Reflection is plain text, retained without trimming, limited to 2,000 Unicode characters and 4,096 UTF-8 bytes.
The empty string is a value; `null` clears it. Malformed Unicode and U+0000 are unsupported native text values. TypeBox checks the character limit and the native parser enforces
both limits. The PATCH route caps the complete JSON frame at 16,384 bytes, leaving room for worst-case JSON
escaping and the bounded date/revision fields while limiting parse work to a constant multiple of `B`.

The values are columns on the owned `progress_session` row and use its exact `(route, session_id)` key plus the
account owner predicate. They do not enter progress-change history, public logs, public Collections, Search, public
DTOs, native Subject votes or aggregates, event payloads or errors. Assessment writes do not call the public vote
writer. The existing session-updated event carries only `sessionId`. The journal adds no separate metadata receipt,
event type or cleanup worker. Terminal account erasure deletes the owning session row; the idempotency receipt stores
only its request digest and the small revision/change acknowledgement.

Historical import adapters may admit dates that fit this contract. They must preserve unsupported source evidence
privately rather than round it to a supported precision. No importer is part of this producer contract.

Decision: Web reviews an explicit selection for each journal field: untouched preserves it, Clear sends null, and typed empty reflection remains an empty text value; blank date or assessment input requires correction before Save.

## Web318 receiving contract

Web318 owns the reserved private diary/journal integration. An existing progress detail opens this API by its
session ID; it does not add another diary navigator. GET supplies the current journal revision and values, including
`assessment:{meaningRevision:1,units}`. The editor PATCHes changed values with that revision; assessment is
`{units:number}` to set or `null` to clear, while omission preserves it. It retains one idempotency key and the exact body while the result is
uncertain. On `200`, it GETs the current journal before treating local state as synchronized. On `409`, it keeps the
draft and GETs again before offering reconciliation. `401` means the current sign-in is unavailable; `403` means
editing is denied; `404` means the occurrence is missing or concealed; `503` leaves the draft and original retry
identity intact. The precision above is the complete supported date shape.

## Derived cost

For a fixed admitted field set `F <= 3`, reflection byte cap `B = 4096`, and PATCH frame cap `16,384`, one addressed
read or edit is bounded by `Cfixed-authority + Csession + Cmetadata + Cnative-command/history + Ccleanup`. This is a
source derivation, not a measured total:

- `Cfixed-authority` is the installed `deriveAccess` route admission plus the current-account lifecycle check. GET
  reads the account once by `(route, account_id)` inside its read transaction. PATCH holds that exact account row
  `FOR SHARE` and rereads it by the same key before receipt lookup; the command gate and request deadline bound
  contention independently of history size.
- `Csession` uses the primary key `(route, session_id)` and owner seek index `(route, account_id, session_id)`. GET
  probes one `(route, account_id, session_id)` row. PATCH locks that exact owner/session row once and, only for a
  changed value, performs one primary-key owner/revision compare-and-swap UPDATE. Missing, foreign and stale rows do
  not add a history traversal; stale edits roll back without a write or event.
- `Cmetadata` is no separate row: at most six date integers, one bounded reflection, assessment units and its meaning
  revision share that session row. The request frame remains at most 16,384 bytes, and selected-field work is
  `O(B + F)`, independent of owner history `H`. GET adds only the fixed assessment fields to its existing bound.
- `Cnative-command/history` uses one indexed original-receipt lookup by principal, kind and candidate key after
  current authority; stored receipts have a 32-byte digest and a 1..255-character key. A fresh changed PATCH adds
  the ordinary command fence and one ID-only progress event. Its receipt response is only session ID, revision and
  `changed`; no journal value is copied there. Omitted, clear, unchanged and stale paths use the same fixed receipt
  envelope; a replay returns the stored acknowledgement and does not relock or update the session or emit an event.
  A changed row still runs the existing profile-migration BEFORE trigger and native-source AFTER trigger once; that
  AFTER trigger applies the fixed old/new account fence upserts. Shared command-receipt retention remains unchanged.
- `Ccleanup` uses the installed owner erasure seek `(route, account_id, session_id)` with `LIMIT 1`; deletion targets
  that exact key after an existence check on each possible `(route, session_id)` child key for progress units and
  changes. Journal values add no side-table page or traversal; deleting the session row removes its dates, reflection
  and assessment with it.

Native growth acceptance remains controller-owned and unmeasured here. It must compare 64, 512 and 4,096 same-owner
occurrences, unrelated owners, and retained versus cleared journal values with a fixed addressed response, and record
statements, examined rows/buffers, bytes and lifetime cleanup for read, edit, stale refusal and receipt replay. Source
typing and this derivation do not establish that execution evidence.

## Web addressed journal editor

The existing progress-session detail now reads the installed
progressSessions({sessionId}).journal.get method and edits with .journal.patch. The editor accepts only reported year,
year-month or full calendar date, displays assessment units as `units / 2`, and keeps reflection independent of current
shelf state. Clearing a date, reflection or assessment is explicit. A journal correction uses the native journal revision and a fresh addressed readback; a stale revision
keeps the draft visible and requires review of the latest journal before resubmission. Unknown results retain the
original key and exact patch for explicit retry. Private reflection is never copied into publication.

The diary distinguishes these reported dates from native started/completed audit clocks and source observation
timestamps. Missing or partial dates are never filled with a guessed day, instant or duration. Current progress
controls and the caller's progress-session authority stay with the existing page.

## Occurrence assessment availability and editor lifetime

The generated journal GET/PATCH declarations publish meaning revision 1 with integer assessment units 0–20.
The existing editor displays the standard 0–10 scale in half steps on the exact selected occurrence, including zero.
An absent value renders blank; explicit clear sends `assessment:null`, while an unchanged assessment is omitted.
Dates, reflection and assessment share the exact journal CAS, independently of progress revision and the current
Subject vote. Only edited fields survive conflict review, so adopting the latest revision preserves unrelated current
fields and unsaved edits. A current read after an uncertain command is labelled as an observation; only an exact
original-key/body replay can resolve that command. It never infers success from matching current values.
Older archive decoding, V3 assessment meaning and V4 inert provider evidence retain their existing owners; this
editor adds no archive writer or recovery path.

Editor commands bind exact Session identity, viewer, credential and current source/return visit. Owner, credential,
occurrence or source replacement unmounts the prior private editor; read-exposure loss conceals it. Delayed results
cannot navigate, replace drafts or attach private metadata after replacement. A progress revision change alone does
not replace safe journal drafts. A command in flight prevents overlapping submissions. An uncertain write retries
its exact original key/body, including the original journal revision; a conflict preserves the draft for explicit
review. An accepted PATCH whose GET fails or predates its acknowledgement is shown as accepted with unconfirmed
current values, retaining that same replay identity. Journal and progress revisions remain independent.
