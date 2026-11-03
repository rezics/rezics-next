# Personal Library export, version 1

The authenticated native API exports current owner facts independently of public Collection ItemList export.
Decision: use a fifteen-minute fenced, replayable page stream with no retained private artifact; a source change
requires a new request identity, including after a completed stream or a failed local download.

## Mounted methods and Web handoff

All methods require a bearer account and `library_entry:list`, `library_entry:read`, `copy:list`,
`progress_session:list`, `progress_session:read` and `collection:read` scopes. Native owner admission and the
personal_library, reading_progress and collections gates apply on every invocation, including retries.
All responses are `application/json`, `Cache-Control: private, no-store`. There is no public download token.

| Method                                       | Request                                         | Response                                             |
| -------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| `POST /v1/libraryExports`                    | Structured-string `Idempotency-Key`; no body    | Original capture status                              |
| `GET /v1/libraryExports/{id}`                | Bearer owner                                    | Status and original `first` cursor                   |
| `GET /v1/libraryExports/{id}/pages?cursor=…` | Original opaque cursor, at most 4096 characters | Bounded records, `next`, final manifest              |
| `DELETE /v1/libraryExports/{id}`             | Bearer owner                                    | Cancelled status; all cursors cease delivering facts |

A status has `format`, `version:1`, `exportId`, `capturedAt`, `expiresAt`, `privacy:"private"`, `state`,
`completeness:"supported-native-facts"`, `fullExport:false`, `sections`, `omissions` and `first`.
A page has `{exportId,state,records,next,manifest}`. Each record has `section` and the fields below.
Only the final page has a manifest; it adds cumulative `rows` and `recordBytes` to the format/version/coverage
fields. A non-final page never asserts completeness. An empty intermediate page can still have `next`.
Web fetches sequentially, keeps the original identity and cursors, and assembles a local JSON artifact
`{manifest,records}` only after a final `ready` page. The manifest's omissions must remain visible with the file.
Download uses those exact collected bytes; a local save failure can retry them. If local bytes were lost, replay
`first` under this capture; a changed source returns `stale`, never a replacement under the completed identity.

## Stored field meanings

Record keys use native snake_case. UUIDs retain their entire routable identity, never shortened IDs.
`subject_id`, `requested_subject_id` and `version_subject_id` also have corresponding `*_reference` objects
`{id,href:"https://rezics.com/subjects/{id}"}`. These preserve native canonical accepting anchors and original
requested/version anchors separately; the routable Subject URL follows later identity redirects. They assert no
current metadata visibility, provider identity or entitlement. No subject metadata is fetched to make the export.

| Section        | Meaning                                                                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| entries        | `subject_id`, `requested_subject_id`, `incarnation_id`, stored exclusive `state`, `revision`, `library_profile_pin`; `created_at`, `updated_at`, `activity_at`, `finished_at` remain independent timestamps           |
| labels         | `label_id`, `normalized_name`, `revision`, `created_at`, `updated_at`; only live owner labels                                                                                                                         |
| assignments    | Composite `(subject_id,label_id)`, nullable historical `assignment_id`, revision and dates; only live assignments with a live label parent                                                                            |
| sessions       | `session_id`, subject/version anchors, mode/unit, total, amount, locator, position, completed-unit count, state/revision/pin, started/completed/last-changed dates; active, completed and abandoned retained sessions |
| units          | `session_id`, exact opaque `unit_id` and `added_at`; a sparse completed set, never a derived interval                                                                                                                 |
| history        | `session_id`, `change_no`, original `intent`, `recorded_at`; independent recorded progress intents                                                                                                                    |
| holdings       | `copy_id`, subject, kind/status, all three stored profile pins, location/source, acquired/disposed dates, note, revision and creation/update timestamps; only retained live copies                                    |
| collections    | Own active metadata: identity, title/description/privacy/revision, membership kind, builtin identity/pins, presentation kind, stored rule/filter/sort/release/revision and dates                                      |
| collectionPins | Owner `collection_ids` ordering and revision; references do not disclose referenced Collections                                                                                                                       |
| occurrences    | Own curated live `member_id`, parent/subject IDs, note, `ordinal_key`, member revision and `added_at`; duplicates retain independent identity and order                                                               |

A pin retains provenance, immutable release digest, accepting Type and profile ID exactly as stored. Unknown old
vocabulary stays readable as raw text plus its stored pin, including null pins; no current meaning is guessed.
Decimals and bigint revisions are decimal strings. Native integer revisions/counts remain numbers. SQL dates are
`YYYY-MM-DD`, timestamps are PostgreSQL timezone-bearing text preserving microseconds, and null means unstored,
never zero or an estimated date. Free-form copy `source` is preserved text, never parsed into a provider ID.
A holding implies no purchase, license, entitlement, state, session or label. Stored rules are references only;
export never evaluates them or starts dynamic publication. All owner facts remain private in this artifact,
regardless of any Collection visibility field.

## Coverage and bounded continuation

Installed native owner tables supply these sections. The manifest explicitly marks personal import source evidence
and provider identifiers unavailable: this base has no owner Library import-evidence/identifier store. It does not
scan shared provider custody or invent identifiers. No successful absent-source section or fabricated zero count
is emitted. `ready` means all supported native sections were exhausted, never a completed full account export.
Trash, published/working output, credentials, Access capabilities, secrets, other accounts and Commerce order or
financial evidence are excluded. No compatibility with a re-import endpoint is promised.

One control row per owner survives for at most the current capture; no private fact payload is retained server-side.
Native fact fences cover entries, labels, assignments, sessions, measures/history, copies, Collection metadata,
occurrences and Collection pins. Each page holds the account terminal barrier and source fence while reading.
Any intervening native edit conservatively makes the capture `stale`, even when unrelated to already read pages.
A new capture has a new idempotency key; original command receipts never regenerate it on replay.
One live capture at a time returns `409 conflict` for another new request. Cancel, expiry or a stale/limit outcome
allows a new identity. An older replaced identity returns `404`, including its original create replay.

Keysets use owner/parent indexes with no offsets. Each page reads at most sixteen fact rows and one parent key,
guards each SQL-projected row at 64 KiB, and emits at most 120,000 encoded record bytes. A stream stops at
100,000 records or 32 MiB; `limit` returns no records or manifest and requires a narrower future format or support.
`stale`, `expired`, `cancelled` and `limit` return no records, next cursor or successful manifest. Expiry is fixed
at capture plus fifteen minutes; retries never renew it. Malformed/cross-capture cursors return `400 invalid_cursor`;
foreign/missing identities return `404`; current native authentication/authority failures return `401/403`.
Native deadlines, admission and cancellation apply before and after each bounded transaction; aborted work rolls
back and cannot publish a success manifest. Terminal account deletion immediately denies capture, every page and
final delivery. The appended native Library owned-graph phase erases the single control row; no deletion
coordinator, private output generation or public capability is added.
