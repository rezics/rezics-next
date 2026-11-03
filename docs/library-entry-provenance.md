# Personal entry source provenance

The native source evidence owner retains reviewed provider observations for a person's canonical Subject. A provider
observation is addressed by the owner, Subject, opaque provider key and opaque provider record ID. Different records
remain independent. This is not a provider parser, scheduler, catalogue producer, source synchronizer or public
disclosure control.

## Meaning and precision

Privacy is explicitly labelled provider-entry meaning. When a value is unknown but the source supplied a bounded
field token, `sourceValue` retains that token for owner review; it is one field value, not the raw provider payload.

- `known/private`: the provider record was private.
- `known/source_visible`: the provider record was visible at its source. This does not grant REZICS Publication or
  disclosure.
- `unknown`: the format carries a privacy field whose meaning is unknown.
- `absent`: the provider record has no such field.
- `cleared`: the owner explicitly removed the retained value.

Source-created and source-updated timestamps retain their original string, precision and zone knowledge. An
uninterpretable but bounded source token may be retained as `{status:"unknown",sourceValue}` for owner review; it
does not claim a parsed date or timezone. Accepted
precision is year, month, day, minute, second or fractional second. Fractional precision retains up to 18 digits.
Accepted zone values are `utc`, `offset` and `unknown`; an unqualified timestamp and the RFC 3339 `-00:00` unknown
offset remain unknown-zone evidence. Partial values such as `2004-02` are retained as month precision. Offset
values such as `2004-02-29T23:59:01.123+08:00` remain byte-for-byte unchanged.
Impossible calendar dates and invalid offsets are rejected; values are never converted to today's date or normalized
through a host timezone.

Each privacy/timestamp field distinguishes `absent`, `unknown`, a known value, explicit `cleared`, and an incoming
operation of `unchanged`. The owner may review uncertain values without inventing provider facts.

## Native owner API

- `POST /v1/libraryEntries/{subjectId}/sourceObservations` explicitly admits one reviewed provider record. The
  body carries `provider`, `recordId`, `confirmReviewed:true`, `privacy`, `sourceCreated` and `sourceUpdated`, with
  an `Idempotency-Key` header. A known timestamp input is `{status:"known",value}`; precision and zone are derived
  without changing the value and returned in the owner DTO.
- `PATCH /v1/libraryEntries/{subjectId}/sourceObservations` explicitly corrects one record using `provider`,
  `recordId`, its current `revision`, `confirmReviewed:true`, field operations and an `Idempotency-Key` header. `clear` stores `cleared`; `set`
  stores the supplied absent/unknown/known provider meaning; `unchanged` retains the exact current value.
- `GET /v1/libraryEntries/{subjectId}/personal` returns the same records alongside note and priority. Each observation
  exposes its revision and native `recordedAt` separately from source-created/source-updated values.

Provider keys are 1–64 ASCII identifier characters, record IDs are at most 192 UTF-8 bytes, unknown privacy field
tokens are at most 192 UTF-8 bytes, source timestamp strings are at most 64 UTF-8 bytes, and one owner may retain at
most 32 observations per Subject. The API stores only these identities and reviewed fields, never credentials or raw
provider payloads. It resolves the supplied Subject through
current native Subject authority and never creates identity or vocabulary from an unknown provider mapping.

Admission requires an explicit confirmation and is insert-only for one provider/record key. A second admission of
that key conflicts; it cannot overwrite a known local fact. Correction requires the current observation revision and
confirmation. Stale edits conflict. Original command-key/body retries return the same result without changing the
observation or its native audit time. Source privacy never changes public Collection or published-log policy.
Terminal Library account-fact deletion owns every retained observation.

## Web labels and recovery

Label fields `Provider`, `Provider record`, `Provider privacy`, `Source created`, and `Source updated`. Render privacy
as `Private at source`, `Visible at source`, `Unknown`, `Not supplied`, or `Cleared`; render timestamp precision and
zone exactly as returned. Keep `Recorded at` labelled as the native record time. Require the owner to confirm the
provider record before admission and again before correction. A conflict requires re-reading the personal entry and
accepting the current revision before a new command. Retain the exact original key and body when the network outcome
is uncertain. Show `400 invalid_request` for invalid field operations, unsupported date shapes or the observation limit,
`401 authentication_required` or `invalid_credentials` when authentication fails, `403 forbidden`
for denied writes, `404 not_found` for an unavailable canonical Subject or observation, `409 conflict` for stale
revisions or duplicate addresses, `422 idempotency_conflict` when a key is reused with another body, and `503`
`overloaded`, `partition_unavailable`, `transaction_retry_exhausted` or `deadline_exceeded` for temporary
unavailability.

## Personal-list adapter contract

The four existing personal-list import owners consume these native operations only after owner review; they do not
write a second Library store. Keep the provider key and record ID as the exact source address and retain observations
from different records independently. Use the public typed fields `PersonalEntrySourceAdmission`,
`PersonalEntrySourceCorrection` and `PersonalEntryObservation` from `@rezics/client`:

- Admission is `POST /v1/libraryEntries/{subjectId}/sourceObservations` with `provider`, `recordId`,
  `confirmReviewed:true`, and explicit `privacy`, `sourceCreated` and `sourceUpdated` values. Submit `absent` only
  when the source has no field, and `unknown` when it has a field whose meaning cannot be interpreted. When safe,
  retain that bounded source field as `sourceValue` so the owner can review the original token.
- Read with `GET /v1/libraryEntries/{subjectId}/personal`; each observation returns the same address, its own
  revision, all three source meanings, and native `recordedAt`. Source observations contain no note, priority,
  credentials or raw provider payload.
- Correct with `PATCH /v1/libraryEntries/{subjectId}/sourceObservations`, the exact address, current observation
  revision, confirmation and an operation for every field. `unchanged` preserves the retained value, `clear` records
  explicit owner removal, and `set` replaces only the reviewed field. Re-import never infers a correction by comparing
  timestamps. On `409`, reread and ask for review before sending a new command; on uncertain network outcome, retry
  the same idempotency key and body.
- Apply an imported note or priority only through `PUT /v1/libraryEntries/{subjectId}/annotations`, using
  `PersonalEntryAnnotationWrite` and the current `PersonalEntry.annotationRevision`, after explicit owner confirmation.
  Supply `unchanged` for omitted or unmodified values. The adapter never maps source privacy to
  public visibility and never derives priority from a provider rank or rating. If it cannot retain the original
  timestamp and its precision/zone meaning, report that mapping as unsupported and do not submit a normalized value.

## Web source review

The private Subject Library editor lists native observations independently by provider and record. It displays the
source privacy meaning, source-created and source-updated values with their returned precision and zone, and native
recordedAt separately. Missing, cleared and unknown values retain their distinct labels. Source-visible is explicitly
not REZICS-public. The privacy editor defaults to retaining the current field, requires review confirmation, submits
one field operation with the observation revision, and leaves both source timestamps unchanged. A conflict requires
a fresh entry read and a deliberate review before a new correction. An uncertain correction retries the same key and
body; accepted PATCH results are reconciled with a personal-entry readback.

The existing personal-list import confirmation pages remain owned by their provider import journeys. AniList, Bangumi
and MAL submit `PersonalEntrySourceAdmission` through the generated `libraryEntries(...).sourceObservations.post`
method after the existing import apply, only when the owner confirms source privacy and original timestamps in that
same confirmation flow. Record identities stay the provider's own: AniList list-entry `id` when present, otherwise the
AniList media identifier; Bangumi `subject_id`; MAL `${kind}/${identifier.value}`. AniList unix `createdAt`/`updatedAt`
values remain `unknown` and are never converted to dates. MAL created time is format-absent. Unsupported timestamp
shapes are reported and not submitted. Admission is its own exact-retry command (raw UUID idempotency key); an
uncertain admission retains sender, credentials, key and operands and never replays an accepted import. Import cost
ledgers do not count admission calls. VNDB remains unavailable until its generated `libraryImports.vndb` client family
is delivered; no second parser or import route is introduced.
