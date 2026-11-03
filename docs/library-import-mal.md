# Personal MyAnimeList XML import

Commerce owns native semantics; Web owns presentation. This imports the signed-in person's uploaded anime or
manga export, with no live provider credentials or catalogue ingestion. Native methods require both
`library_entry:read` and `library_entry:update`, current account authority and the personal Library exposure.
All responses and retained evidence are private. No notes, XML or titles enter public Search, logs or errors.

Decision: use `mal_anime` and `mal_manga` external claims and explicit confirmation of a unique released state
role; profiles have no MAL-specific mappings, so every other field remains visible private evidence.
Identifiers also retain `https://myanimelist.net/anime` or `/manga`. Existing admitted external claims are the
only automatic identity authority (the existing Semantic batch-create retains native history custody); an absent producer yields unmatched rows, never an invented provider service.
Titles assist display/search only. The page exposes readable candidates, unmatched, unavailable, matched and
already-matched rows. External claims are unique, so there is no ambiguous automatic candidate set in this slice.
An unmatched row can be explicitly assigned any currently readable canonical subject; this never changes a claim.

Decision: MAL scores are opt-in. The owner chooses native units explicitly, an existing vote is preserved unless
replacement is explicitly selected, and native clear is a separate action. Source values are never presented as an
exact conversion.

| Source                                                                                 | Native proposal or visible retention                                                                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Watching/Reading, Completed, On-Hold, Dropped, Plan to Watch/Read (or codes 1/2/3/4/6) | Unique released role active/completed/paused/dropped/planned, explicitly confirmed as `status`                                              |
| Score                                                                                  | Original integer 1–10 scale; zero means no rating. Review can record owner-selected units; conditional native vote admission is unavailable |
| Episodes, chapters and volumes                                                         | Independent original measures, including simultaneous manga counts; retained, no invented subjects or sessions                              |
| Comments, tags, repeat totals                                                          | Private note, original tags and count; retained, no public review, inferred label or dated repeat session                                   |
| Start/finish dates                                                                     | Year/month/day precision, all-zero unknown, invalid calendar dates marked invalid; no invented first day                                    |
| Privacy, source timestamps, other fields and export metadata                           | Retained privately; never a command clock or publication decision                                                                           |

Each field distinguishes missing, empty/unknown, invalid, zero and a value as applicable. `fields` preserves every
row leaf, `retained` explains fields without admission, and the original XML retains metadata and attributes.
The existing upload's explicit date review and journal adoption contract is in
[adopting imported consumption dates](library-import-consumption-dates.md).
Importing a status is an explicit native entry command; it does not infer holdings, entitlements or public content.
The native command's own effects, including its documented active-entry follow behavior, remain authoritative.

Mounted JSON methods (UUIDs below denote values returned by native HTTP):

```ts
POST /v1/libraryImports/mal:preview // Idempotency-Key: "upload-1"
{ xml: "<myanimelist><anime><series_animedb_id>1</series_animedb_id><series_title>A</series_title><my_status>Completed</my_status></anime></myanimelist>" }
// 200 { id: string }
GET /v1/libraryImports/mal/:id?after=0
// 200 { id, canceled: boolean, total: number, rows: MalPreviewRow[], sourcePath: string, next: number | null, limits }
// MalPreviewRow = MalRow & { target: string | null, candidates: {subjectId: string}[],
//   match: "matched" | "already-matched" | "unmatched" | "unavailable",
//   state: string | null, current: {state,revision,incarnationId} | null,
//   binding, source, review: MalReview | null, scoreReviewState: "observations-match" | "stale" | "unavailable" | null,
//   outcome: MalOutcome | null }
GET /v1/libraryImports/mal/:id/source // 200 { xml: string }; exact original, including export metadata
POST /v1/libraryImports/mal/:id/review // Idempotency-Key: "review-1"
{ row: 0, target: null, skip: false, replace: false } // null uses the admitted identifier
// 200 { id }; GET the page to inspect proposed state, retained fields and conflict before confirmation
// Optional score review input:
{
  row: 0, target: null, skip: false, replace: false,
  score: { action: "adopt", questionId: "00000000-0000-7000-8000-000000000001", questionRevision: 1, units: 19 }
}
// action "clear" has the same questionId and questionRevision and no units.
// The page returns original score and scale, selected native question/meaning/units, current own-vote baseline,
// and a typed unavailable admission result until the guarded Content writer is installed.
POST /v1/libraryImports/mal/:id/apply
{ confirm: true, rows: [{ row: 0, version: "review-1", fields: ["status", "score"] }] }
// 200 { id, outcomes: [{row:0,status:"unavailable",applied:["status"],retained:["my_score"],
//   score:{action:"adopt",status:"unavailable",reason:"conditional-vote-admission-unavailable",vote:null}}], remaining: [], stopped: false }
POST /v1/libraryImports/mal/:id/cancel // Idempotency-Key and {} body; 200 { id }
DELETE /v1/libraryImports/mal/:id // Idempotency-Key; 200 { id }
```

These are constructed typed transport examples, not execution evidence. Exact exported types are `MalRow`,
`MalPreviewRow`, `MalReview`, `MalApplyInput`, `MalOutcome` and the mounted route's inferred page result. A custom `target` resolves
an unmatched row. `skip:true` yields skipped; unsupported-only selections yield unsupported. Conflicts preserve
current facts unless `replace:true` was reviewed; replacement uses the captured revision and incarnation.
A changed identity, release or local revision yields stale/refresh-review, allowing a new review version.
Failed dispatches resume the immutable original native command; receipt replay cannot duplicate acknowledged effects.
Score review accepts only the standard question at revision 1 and native units 0–20, step 1. MAL `0`, missing and
unknown scores cannot be adopted; an explicit `clear` remains independent. Unsupported raw values remain visible and
can be paired with explicitly selected native units without claiming an exact conversion. Adoption over an existing
vote requires `replaceCurrent:true`; otherwise the local vote is preserved. A review records the question, meaning,
source value/scale, selected units, own-vote baseline, target observations, consent and stable command attribution in
the existing bounded plan. The page and apply paths recheck native question/vote authorization and detect changed
review context, but the score outcome remains typed `unavailable` and never writes a vote.

The missing Content admission signature is an extension to
`createVoteCommands.putVoteOutcome(actor, { questionId, targetId, units }, idempotencyKey)`: it must accept and
atomically enforce the reviewed question revision, canonical/counting Subject identity, expected current vote
revision or absence, and provider attribution. The current writer re-observes question/target before receipt handling
and locks vote rows for writes, but it does not compare these reviewed observations with the locked rows. Until that
producer is installed, MAL does not call it or claim accepted native outcomes.

Bounds: 4 MiB JSON wire body (413 beyond it), 2 MiB decoded XML UTF-8 (400 beyond it), 500 rows, depth 16, pages/apply batches of 20, 64 selected fields, 48 MiB retained evidence per upload, three retained uploads per
owner, seven-day readable lifetime. DTD/external entities, malformed roots/rows/IDs and duplicate IDs/fields fail
safely with source row ordinals and no source text. Expired uploads are reclaimed at the next upload; explicit
DELETE clears evidence now. The account erasure graph owns the entire evidence/review/intent document.
Reviewed score operands and private vote baselines count toward the existing 48 MiB document cap. Full serialized
apply outcomes, including score outcomes, remain within the existing 512 KiB result cap. No upload, evidence store,
account-wide vote scan, expiry job or cleanup phase is added.
Cancellation stops new dispatch; an already-started native command may finish. Request cancellation/deadline
stops subsequent rows without undoing prior effects. Return outcomes and remaining rows drive partial resumption;
failed rows are retried with their original review/operands, never a fresh identity. Preview changes only private
import evidence; native facts change only after review and explicit field confirmation.

The signed-in Web journey is `/library/import-mal`, documented in
[personal MAL import](../apps/web/src/library/personal-mal-import.md). Library navigation adds that entry beside
existing creation and discovery links. Upload, preview, review, confirmation, partial results and discard stay in
the mounted visit: XML, comments and private rows never enter the URL or persistent browser storage. A replacement
upload deletes the previous native document first. Viewer or CSRF replacement retires retry authority. Web binds the
generated `libraryImports.mal` methods when present and otherwise shows unavailable; it does not parse XML or fork
native matching.

Decision: unmatched target search is display assistance through the existing authenticated subject suggestions; only
the explicit UUID submitted to `review.target` is identity.

Integration decision: MAL and Bangumi retain their separate native review guards, routes and erasure phases.

Native rating cost: for at most 20 rows per page/review/apply batch, each score-selected row performs one current
question read plus the own-vote reader's question, Subject, account and vote reads. Page and apply repeat that bounded
read to recheck current authorization and detect stale review observations; the apply plan and outcomes add bounded
JSONB bytes to the existing document/result limits. This delivery performs no native vote command, receipt,
component, aggregate or cleanup write. The complete guarded writer and its nested receipt/component/aggregate
cost remain unmeasured controller acceptance, not a growth claim.
