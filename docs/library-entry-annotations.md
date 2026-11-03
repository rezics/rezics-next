# Personal entry annotations

The private personal entry annotation owner stores one person's note and list priority for one canonical Subject.
These values are independent of explicit state, copies, sessions, labels, public reviews, ratings and Collection
member notes. The separate [source provenance owner](library-entry-provenance.md) retains reviewed provider records;
clearing annotations never clears those records.

## Native owner API

All routes require an authenticated account and current `library_entry:read` or `library_entry:update` authority.
They use the Library command receipt engine, current Subject resolution, the account lifecycle fence and the
original idempotency key.

- `GET /v1/libraryEntries/{subjectId}/personal` returns the private annotation revision, note, priority and all
  bounded source observations. A missing personal fact returns revision `0`, null annotation values and an empty
  observation list after the canonical Subject is admitted.
- `PUT /v1/libraryEntries/{subjectId}/annotations` with an `Idempotency-Key` header accepts an expected `revision` and a `note` and `priority`
  operation, each `{op:"set",value:...}`, `{op:"clear"}` or `{op:"unchanged"}`. Revision `0` creates the first
  annotation version. A stale revision is a conflict. Replaying the original key and body returns its original result.
- Notes contain 1–4,096 UTF-8 bytes. Priority is an owner-local list position from 1 through 100; 1 is highest.
  Null means the owner has no priority. An empty note is cleared explicitly.

Use `Personal note` and `Personal priority` as the owner-facing labels; display null priority as `Unranked`. Read and
write responses containing personal values use `Cache-Control: private, no-store`. Return `400 invalid_request` for
invalid operations or bounds, `401 authentication_required` or `invalid_credentials` for authentication failure,
`403 forbidden` for denied writes, `404 not_found` for a noncanonical or unavailable
Subject, `409 conflict` for a stale annotation revision, `422 idempotency_conflict` when a request key is reused
with another body, and `503 overloaded`, `partition_unavailable`, `transaction_retry_exhausted` or `deadline_exceeded`
for temporary unavailability.

The read response is `PersonalEntry`: `{subjectId, annotationRevision, note, priority, annotationUpdatedAt,
sourceObservations}`. Source observations are documented with their exact fields in the provenance owner contract.
Notes are absent from events, Search inputs, public Collection responses and command errors.

## Everything and lifecycle

A nonempty note, a set priority, or at least one reviewed source observation is a native owner fact in the existing
Library entry family. It contributes the canonical Subject to Everything without adding an explicit state, session,
copy or label. A cleared annotation-only shell does not contribute membership. State queries still read only explicit
state and state chronology; annotation and source writes do not change them. Existing native owner indexing includes
these facts under the same currentness and terminal-erasure fences.

Terminal account fact deletion removes annotation and source rows together. Ordinary state removal does not clear
them. The [Library and Collections owner contract](library-and-collections.md#private-rich-personal-entries) owns the
combined behavior.

## Web private editor

The existing Subject Library slot mounts the authenticated personal-entry editor. It reads the generated
libraryEntries({subjectId}).personal.get method and writes through .annotations.put. It exposes a UTF-8 byte
counter with the native 4,096-byte note cap, owner-local priority 1–100 and an explicit Unranked state. Note and
priority edits are field-local, so clearing one leaves the other unchanged. The editor is independent of current
shelf state and remains available for an annotation-only subject while that subject is admitted.

The BFF binds each read and command to the current authenticated viewer, authorization and CSRF session. On an
uncertain write, Retry sends the original body and idempotency key. A conflict refreshes the entry; the person must
review the new revision before deliberately applying their still-visible draft. No credential arrival submits a
command. Native 401 retires the displayed private entry. Source provenance remains a separate owner fact and is not
cleared by annotation edits.
