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
| `tags`, `comment`, `notes`, `private`   | Private retained source evidence; only explicitly reviewed tags may enter native private labels through the separate label journey. Never public reviews or disclosure.                                              |
| `*_at`, `*_date`, unknown fields        | Original values and precision remain evidence with reasons. Bangumi warns updated_at is unreliable as collection time; no timestamp orders a command.                                                                |

`fields[]` contains each present source field, original value, known/unknown/invalid meaning and retention
reason. Missing fields have no entry; they never become zero or null. No unsupported field is reported applied.
Only explicitly confirmed state and separately confirmed [tag mappings](library-import-bangumi-labels.md) enter native Library. Other fields remain downloadable in
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

## Web journey

The signed-in page is `/library/import-bangumi`, documented in
[personal Bangumi import](../apps/web/src/library/personal-bangumi-import.md). Library navigation adds that entry
beside the MyAnimeList importer; the two sources keep separate controllers. Upload, preview, review, confirmation,
partial results, cancel and discard stay in the mounted visit. JSON, comments and private rows never enter the URL
or persistent browser storage. A replacement upload deletes the previous native document first. Viewer or CSRF
replacement retires retry authority. Web binds the generated `libraryImports.bangumi` methods when present and
otherwise shows unavailable.

Decision: unmatched target search is display assistance through the existing authenticated subject suggestions; only
the explicit UUID submitted to `review.target` is identity. Apply defaults to preserving local facts. Ambiguous match
is rendered if native returns it; unique released provider claims cannot currently produce that set automatically.

Own-upload attestation does not verify a Bangumi account. Preview does not mutate Library facts. Apply revalidates
identity epoch and release; stale means a deliberate new review. Cancellation stops new admission; already admitted
work may finish. Evidence deletion removes evidence and reviews, not admitted facts.

## Cost

- Operation: `library.bangumi.preview`, paged owner read, `library.bangumi.review`, `library.bangumi.confirm` apply
  batches, cancel and delete. Existing Library entry writes remain Commerce-owned.
- Touched neighbourhood: `library.bangumi_upload` / `library.bangumi_upload_row` on the owner route, unique Bangumi
  external claims, current released profile state roles, and the personal Library entry command. Web retains the
  current 10-row page plus N metadata rows; it does not scan other owners or fork the native engine.
- Formula: `1 preview + K page reads + M reviews + Q apply batches + lifecycle + R retries`, with page `<= 10`,
  apply `<= 5`, `M <= N <= 100` and `Q <= ceil(M/5)` only when the user confirms full batches.
- Installed caps: `BANGUMI_LIMITS` in `services/kernel/src/library/list-import-bangumi-model.ts`.
- Growth check: Web focused test `apps/web/tests/personal-bangumi-import.test.tsx` drives 10, 50 and 100 native-shaped
  rows through the same controller and asserts call counts, 10-row reads, 5-row writes and the retained-byte bound.
  Native statement/index bounds stay with the Commerce engine; this journey introduces no new kernel query path.

## Selected retained tag adoption

The [label adoption contract](library-import-bangumi-labels.md) specifies installed `tags`, `reviewLabels` and
`applyLabels` routes and generated methods, separate confirmation epochs, native name/capacity limits, per-item
outcomes, source-evidence exclusions and continuation boundaries. State review and its original receipt remain
unchanged. Web324 consumes this typed delivery in the existing complete Bangumi interface.
