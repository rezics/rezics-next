# Private progress-session journal

This is the owner contract for personal start and finish dates and a private reflection on one existing Library
progress session. The session ID identifies one real occurrence, so rereads and rewatches of the same subject retain
separate journals. Native session progress remains authoritative; this journal does not create or replace a session.

## Mounted API

The owner-only authenticated routes are:

```http
GET   /v1/progressSessions/{sessionId}/journal
PATCH /v1/progressSessions/{sessionId}/journal
```

GET returns `{journal:{sessionId,revision,startDate,finishDate,reflection}}`. Missing values are `null`. PATCH takes
`{revision,startDate?,finishDate?,reflection?}` and an `Idempotency-Key`, and returns
`{journal:{sessionId,revision,changed}}`. The PATCH receipt intentionally contains no private date or reflection
copy. Read the current values with GET after the write; an uncertain PATCH retry returns the original revision and
`changed` result without applying another edit.

Decision: date and reflection fields share one journal-local revision independent of progress; PATCH receipts retain
only session ID, resulting journal revision and `changed`, while GET supplies private values.

`revision` is journal-local and starts at `0`. One revision covers all three fields. It advances once when at least
one value changes. An omitted field is unchanged; `null` explicitly clears that field; a supplied equal value is a
no-op. Clearing an already absent value and an empty patch return `changed:false` without advancing the revision.
The command receipt still binds the original request, so an uncertain response retries with the same key and exact
body. A different edit with a stale journal revision returns `409 conflict` and changes nothing.

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
The empty string is a value; `null` clears it. TypeBox checks the character limit and the native parser enforces
both limits.

The values are columns on the owned `progress_session` row and use its exact `(route, session_id)` key plus the
account owner predicate. They do not enter progress-change history, public logs, public Collections, Search, public
DTOs, event payloads or errors. The existing session-updated event carries only `sessionId`. The journal adds no
separate metadata receipt, event type or cleanup worker. Terminal account erasure deletes the owning session row;
the idempotency receipt stores only its request digest and the small revision/change acknowledgement.

Historical import adapters may admit dates that fit this contract. They must preserve unsupported source evidence
privately rather than round it to a supported precision. No importer is part of this producer contract.

## Web318 receiving contract

Web318 owns the reserved private diary/journal integration. An existing progress detail opens this API by its
session ID; it does not add another diary navigator. GET supplies the current journal revision and values. The editor
PATCHes changed values with that revision, retaining one idempotency key and the exact body while the result is
uncertain. On `200`, it GETs the current journal before treating local state as synchronized. On `409`, it keeps the
draft and GETs again before offering reconciliation. `401` means the current sign-in is unavailable; `403` means
editing is denied; `404` means the occurrence is missing or concealed; `503` leaves the draft and original retry
identity intact. The precision above is the complete supported date shape.

## Derived cost

For a fixed admitted field set `F <= 3` and reflection byte cap `B = 4096`, one addressed read or edit is bounded by
`Cfixed-authority + Csession + Cmetadata + Cnative-command/history + Ccleanup`. This is a source derivation, not a
measured total:

- `Cfixed-authority` is the existing authenticated admission and current account/scope check in the Kernel route and
  `createLibraryCommandRunner`; it uses owner-keyed account reads and the installed Access/command authorization.
- `Csession` is one indexed session-key read for GET, or one exact owner/session `FOR UPDATE` plus one primary-key
  compare-and-swap UPDATE for a changed PATCH. Missing, foreign and stale rows do not add a history traversal.
- `Cmetadata` is no separate row: the at-most-six date integers and one bounded reflection share that session row.
  The request and selected-field work are `O(B + F)` and independent of owner history `H`.
- `Cnative-command/history` uses the existing owner command receipt keyed by request identity and the existing
  owner-only event. A changed PATCH emits at most one event containing only the session ID; the replay response
  contains only session ID, revision and `changed`. Omitted, clear, unchanged, stale and rollback paths stay within
  the same fixed key probes and receipt envelope; a replay uses the receipt and does not repeat the session update.
- `Ccleanup` remains the installed account-owned progress-session and command-receipt lifecycle. Journal values add
  no side-table page or traversal; deleting the session row removes its dates and reflection with it.

Native growth acceptance remains controller-owned and unmeasured here. It must compare 64, 512 and 4,096 same-owner
occurrences, unrelated owners, and retained versus cleared journal values with a fixed addressed response, and record
statements, examined rows/buffers, bytes and lifetime cleanup for read, edit, stale refusal and receipt replay. Source
typing and this derivation do not establish that execution evidence.
