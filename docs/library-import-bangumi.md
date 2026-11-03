# Personal Bangumi upload

Commerce owns this native source slice; Web consumes the mounted methods below. This is an uploaded
personal list, with no token, account fetch, catalogue refresh, subject creation or provider-mapping write.
The person attests ownership by uploading their records; this does not verify a Bangumi account identity.

Decision: accept a named REZICS wrapper around Bangumi v0 collection records; use unique released state
roles because current profiles have no Bangumi import declarations, and retain all other fields privately.

## Supported shape and primary references

The exact supported JSON file is `{ "format": "rezics.bangumi-collection.v1", "collections": [...] }`.
This is a REZICS upload envelope, **not an official Bangumi export** and not arbitrary third-party JSON.
Records follow Bangumi's `UserSubjectCollection`, with missing and additional fields retained explicitly.
Read primary reference: retained `search-header-and-scopes/bangumi-api`, revision
`65d29cff2331e08c0110d30d515f7f1b6488f845`, `open-api/v0.yaml`: `getUserCollectionsByUsername`,
`UserSubjectCollection`, `SubjectCollectionType`, `SubjectType`, `UserSubjectCollectionModifyPayload`.
[Official pinned schema](https://github.com/bangumi/api/blob/65d29cff2331e08c0110d30d515f7f1b6488f845/open-api/v0.yaml).
No third-party exporter format is claimed supported. The HTTP test uses real-shaped records from those fields.

| Source                                  | Native proposal / retained evidence                                                                                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subject_id`, `subject_type`, `subject` | Admitted Bangumi external claim resolves to currently readable canonical subject; nested title is display only. Types 1/2/3/4/6 remain book/anime/music/game/live action. Unknown types never gain a state proposal. |
| `type`                                  | 1 planned, 2 completed, 3 active, 4 paused, 5 dropped roles; only one state with that role in the current released target profile maps. Unknown/invalid values remain evidence.                                      |
| `rate`                                  | Original 1–10 scale, 0 means unrated, missing means absent; never a native vote or aggregate.                                                                                                                        |
| `ep_status`, `vol_status`               | Original counts including zero: book chapters and volumes, anime/live-action episodes; other ep_status measures remain unverified. No sessions inferred.                                                             |
| `tags`, `comment`, `notes`, `private`   | Private retained source evidence, never labels, reviews or public disclosure.                                                                                                                                        |
| `*_at`, `*_date`, unknown fields        | Original values and precision remain evidence with reasons. Bangumi warns updated_at is unreliable as collection time; no timestamp orders a command.                                                                |

`fields[]` contains each present source field, original value, known/unknown/invalid meaning and retention
reason. Missing fields have no entry; they never become zero or null. No unsupported field is reported applied.
Only the explicitly confirmed collection state enters native Library. Other fields remain downloadable in
owner reads until deletion. Catalogue ingestion's excluded source media do not become available by upload.

## Web HTTP contract

All methods require an authenticated current owner, the personal_library gate, existing Library scopes,
and private/no-store responses. IDs are UUIDs; errors contain native problem codes without upload contents.
Write methods except apply use the ordinary quoted `Idempotency-Key` header. Apply uses each review token.

```ts
POST /v1/libraryImports/bangumi:preview
{ upload: string } // JSON file text, exact envelope above
// 200 { uploadId: string, count: number }; no native personal facts changed
GET /v1/libraryImports/bangumi/{uploadId}?after=-1
// 200 { uploadId, cancelled: boolean, rows: BangumiRow[], next: number | null }
POST /v1/libraryImports/bangumi/{uploadId}:review
{ ordinal: number, target?: string }
// 200 { ordinal, review: BangumiReview }
POST /v1/libraryImports/bangumi/{uploadId}:apply
{ rows: [{ ordinal: number, reviewToken: string, state: "preserve" | "replace" | "omit", skip: boolean }] }
// 200 { uploadId, outcomes: BangumiOutcome[], remaining: number[] }
POST /v1/libraryImports/bangumi/{uploadId}:cancel
// 200 { uploadId, cancelled: true }
DELETE /v1/libraryImports/bangumi/{uploadId}
// 200 { deleted: true }
```

Exact response types are exported by `list-import-bangumi-model.ts` and carried by mounted route types.
A review identifies matched/already_matched, unmatched, unavailable, ambiguous or explicitly chosen rows,
readable candidate IDs, current state/revision/incarnation, proposed state, conflict and an opaque token.
Native provider claims are unique, so automatic ambiguous candidates cannot currently arise. For unmatched rows,
Web uses ordinary subject search as assistance and submits an explicit readable target; titles never auto-match.
Choose preserve by default; replace explicitly authorizes the reviewed revision/incarnation, including absence.
Apply validates the original identity epoch and release. Stale rows need a new review, never a remap.
Outcomes distinguish applied/skipped/stale/unsupported/failed with applied and retained field names.

Bounds: 256 KiB UTF-8 file, 1–100 rows, 8 KiB source row, 32 KiB expanded evidence row, nesting 16, 10 rows per read, 5 per apply.
Credentials and malformed envelopes are rejected. Native request/command deadlines and abort stop new rows;
already admitted commands may finish. Cancel stops new row admission; acknowledged effects remain.
Retries retain the original token, target, state, revision and native command key; failed rows retry that command,
and a lost acknowledgment replays its receipt. A new review cannot replace a confirmed in-flight command.
Evidence and review storage belong to Library's indexed account erasure graph, drained in 100-key pages;
explicit upload deletion removes both without undoing native facts. Shared command-history erasure retains the
existing Library pending-custody limitation; this source makes no complete erasure attestation.
Examples above are constructed API guidance; focused native test execution is reported separately.
