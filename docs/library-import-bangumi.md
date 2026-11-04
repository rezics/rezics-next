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
| `rate`                                  | Positive integer source scores use Bangumi's 1–10 scale; 0 is unrated, missing is absent, and invalid or unsupported values remain private evidence. No automatic conversion or aggregate import.                    |
| `ep_status`, `vol_status`               | Original counts including zero: book chapters and volumes, anime/live-action episodes; other ep_status measures remain unverified. No sessions inferred.                                                             |
| `tags`, `comment`, `notes`, `private`   | Private retained source evidence; only explicitly reviewed tags may enter native private labels through the separate label journey. Never public reviews or disclosure.                                              |
| `*_at`, `*_date`, unknown fields        | Original values and precision remain evidence with reasons. Bangumi warns updated_at is unreliable as collection time; no timestamp orders a command.                                                                |

`fields[]` contains each present source field, original value, known/unknown/invalid meaning and retention
reason. Missing fields have no entry; they never become zero or null. No unsupported field is reported applied.
Only explicitly confirmed state and separately confirmed [tag mappings](library-import-bangumi-labels.md) enter native Library. Other fields remain downloadable in
owner reads until deletion. Catalogue ingestion's excluded source media do not become available by upload.

Decision: native score adoption is manual: keep the Bangumi value and scale, let the owner choose Content units in review, require separate per-row consent on apply, treat zero and absence as non-scores, and make clearing a separate action.

When the owner has `rating:vote`, review shows the original source value and scale beside Content's actual question
revision, meaning, grain and units, the current own vote, and the selected native action/units. Review defaults to
preserving the vote. Apply must repeat the reviewed selection exactly; set and clear require `consent: true`.
Unsupported source values may be paired with explicitly chosen Content units, without claiming a conversion.
Source `private`, upload confirmation and state adoption are not vote consent. Notes and provider aggregates are
never published or imported. The score outcome remains typed `unavailable`: Content has not installed a
`createVoteCommands.putVoteOutcome` guard for the reviewed question revision, current vote or absence, and canonical
counting identity. This slice stores the exact reviewed operands and command key in the existing row, but performs no
vote write until that owner guard exists.

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
{ ordinal: number, target?: string, score?: { action: "preserve" } | { action: "set", units: number } | { action: "clear" } }
// 200 { ordinal, review: BangumiReview }
POST /v1/libraryImports/bangumi/{uploadId}:apply
{ rows: [{ ordinal: number, reviewToken: string, state: "preserve" | "replace" | "omit", skip: boolean,
  score?: { action: "preserve" } | { action: "set", units: number, consent: true } | { action: "clear", consent: true } }] }
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
Score review, confirmed choice and outcome JSON are capped at 71,680, 8,192 and 16,384 bytes per row; a page is
capped at `10 * (32,768 + 71,680 + 16,384) + 4,096` encoded bytes and the apply request at 4,096 bytes. These
caps include private evidence, the unexposed current-vote baseline, selected native operands and result fields.
Credentials and malformed envelopes are rejected. Native request/command deadlines and abort stop new rows;
already admitted commands may finish. Cancel stops new row admission; acknowledged effects remain.
Retries retain the original token, target, state, revision and native command key; failed rows retry that command,
and a lost acknowledgment replays its receipt. A new review cannot replace a confirmed in-flight command.
Provider evidence remains available for seven days after upload. At that absolute deadline, expired uploads are
unavailable to reads, review, new application and provider-evidence export; a read never renews the deadline. The
scheduled owner scrubs provider evidence, comparison data, choices and ordinary outcomes, retaining only the bounded
confirmation fields, original native keys and opaque native receipt digests for 24 hours after the original deadline.
An addressed metadata retry during that window reads only this linkage and exact existing native receipts; it never
reopens provider evidence or admits a new effect. Expiry before native admission returns an unattempted or stale field.
The indexed scheduled owner scrubs at most 99 row keys per command and then deletes at most 99 row keys plus one
upload root per command after the recovery window.
Retired accounts are left to Library's terminal owner graph, whose appended `bangumi_upload` phase also drains at most
100 keys per page. Explicit deletion and either cleanup path preserve acknowledged native state and labels. Review
command receipts retain only the opaque review token, not the private review response. Shared command-history erasure
retains the existing Library pending-custody limitation; this source makes no complete erasure attestation.
The expiry fence covers fresh state, labels and metadata admission at the native write boundary. Receipt-only recovery
checks the current account/client/requester, exact original command identity and the locked Bangumi root/row. Terminal
account erasure uses its existing owner phase to remove the same linkage and never removes acknowledged native facts.
Examples above are constructed API guidance; focused native test execution is reported separately.

Local verification attempted `bun run --cwd services/kernel typecheck`; it reported, among other diagnostics,
`../../packages/client/src/index.ts(268,8): error TS2307: Cannot find module './kernel/rating/own-votes-counted' or its corresponding type declarations.` The focused command
`bun run --cwd services/kernel check test/library/list-import-bangumi-http.test.ts test/library/library-export-http.test.ts test/library/erasure-owned-graph.test.ts`
stopped before executing tests at `Schema dump differs from db/library/schema.sql.` The Content-owned schema
derivation handoff is pending. Frozen acceptance, native64/512/4096 growth, browser and root checks were not run.

## Web journey

The signed-in page is `/library/import-bangumi`, documented in
[personal Bangumi import](../apps/web/src/library/personal-bangumi-import.md). Library navigation adds that entry
beside the MyAnimeList importer; the two sources keep separate controllers. Upload, preview, review, confirmation,
partial results, cancel and discard stay in the mounted visit. JSON, comments and private rows never enter the URL
or persistent browser storage. A replacement upload deletes the previous native document first. Viewer or CSRF
replacement retires retry authority. Web binds the generated `libraryImports.bangumi` methods when present and
otherwise shows unavailable. Score action/result declarations and Web rendering remain continuation work; this
slice does not claim a completed score UI.

Decision: unmatched target search is display assistance through the existing authenticated subject suggestions; only
the explicit UUID submitted to `review.target` is identity. Apply defaults to preserving local facts. Ambiguous match
is rendered if native returns it; unique released provider claims cannot currently produce that set automatically.

Own-upload attestation does not verify a Bangumi account. Preview does not mutate Library facts. Apply revalidates
identity epoch and release; stale means a deliberate new review. Cancellation stops new admission; already admitted
work may finish. Evidence deletion removes evidence and reviews, not admitted facts.

Decision: after the seven-day source deadline, keep only bounded Bangumi native receipt linkage for 24 hours; source reads and new effects remain unavailable after the original deadline.

## Cost

- Operation: `library.bangumi.preview`, paged owner read, `library.bangumi.review`, `library.bangumi.confirm` apply
  batches, cancel and delete. Existing Library entry writes remain Commerce-owned.
- Touched neighbourhood: `library.bangumi_upload` / `library.bangumi_upload_row` on the owner route, unique Bangumi
  external claims, current released profile state roles, and the personal Library entry command. Web retains the
  current 10-row page plus N metadata rows; it does not scan other owners or fork the native engine.
- Formula: one preview parses at most 256 KiB and writes one upload plus `N <= 100` evidence rows; `K` reads each
  fetch at most 11 rows and return at most 10, decoding no more than 10 complete retained JSON rows; `M <= N` reviews
  each address one row, its Bangumi claim, current Account/Source/Subject/profile/Entry observations, and (with
  `rating:vote`) one Content question and one own-vote read, then persist one bounded review and token-only
  receipt/event. `P` selected rows are submitted in `Q` user-confirmed batches, each `P_batch <= 5`; each row persists
  one bounded choice/outcome plus its receipt/event and any selected existing state command. The state command repeats
  current Account/scope, profile release and identity epoch, current provider-claim binding and the locked
  upload/review/choice/expiry fence; exact native receipt replay bypasses fresh admission. A confirmed score plan is
  bounded by the same `P`, with no refill or account-wide vote scan. Score vote writes currently equal zero because
  guarded admission is unavailable. Once Content provides it, each selected score command must include its repeated
  Account/scope, question, Subject/currentness and counting identity guards, component/aggregate work, receipt and
  encoded permitted result; that nested native cost remains unmeasured and cannot be claimed from this provider
  review. `R` retries address the same retained choice and native key.
- Expiry/background: one due-index keyset read selects one source-scrub or final-delete stage. At most 100 addressed row
  keys take two account-fenced page commands per stage (99 rows then one row); the scrub stage also updates one root,
  and the final stage deletes one root. Each page repeats the current-account fence, root lock and exact due-time
  check, and writes one receipt plus a bounded event when it changes rows. A worker segment handles at most 100 due
  upload roots before a durable continuation; population growth is separate from that fixed caller bound. Terminal erasure continues through
  the existing append-only owner phase, selecting at most 100 row/root keys per command with the account tombstone
  fence and replay receipt.
- Export: each V4 evidence page fetches at most 17 ordered rows to return at most 16; each selected row reads and
  serializes its full retained evidence JSON, capped at 32 KiB. Expired uploads are filtered at read time. This changes
  no V1/V2/V3 inventory and does not enable V4 recovery.
- Installed caps: `BANGUMI_LIMITS` in `services/kernel/src/library/list-import-bangumi-model.ts`.
- Growth check: Web focused test `apps/web/tests/personal-bangumi-import.test.tsx` drives 10, 50 and 100 native-shaped
  rows through the same controller and asserts call counts, 10-row reads, 5-row writes and the retained-byte bound.
  Expiry adds one indexed due-key lookup and at most four 99-row page commands over the seven-day source and 24-hour
  linkage stages. Each started metadata phase costs one exact receipt-only native query at recovery; missing receipts
  cannot dispatch writes. The existing all-pool 64/512/4096 caller growth remains with integration. V1/V2/V3
  recovery is unchanged and V4 provider evidence remains export-only.

## Selected retained tag adoption

The [label adoption contract](library-import-bangumi-labels.md) specifies installed `tags`, `reviewLabels` and
`applyLabels` routes and generated methods, separate confirmation epochs, native name/capacity limits, per-item
outcomes, source-evidence exclusions and continuation boundaries. State review and its original receipt remain
unchanged. Web324 consumes this typed delivery in the existing complete Bangumi interface.
