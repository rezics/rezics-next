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

| Source                                                                                 | Native proposal or visible retention                                                                                                               |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Watching/Reading, Completed, On-Hold, Dropped, Plan to Watch/Read (or codes 1/2/3/4/6) | Unique released role active/completed/paused/dropped/planned, explicitly confirmed as `status`                                                     |
| Score                                                                                  | Original integer 1–10 scale; zero means no rating. Review can record owner-selected units; explicit native units use Content conditional admission |
| Episodes, chapters and volumes                                                         | Independent original measures, including simultaneous manga counts; retained, no invented subjects or sessions                                     |
| Comments, tags, repeat totals                                                          | Private note, original tags and count; retained, no public review, inferred label or dated repeat session                                          |
| Start/finish dates                                                                     | Year/month/day precision, all-zero unknown, invalid calendar dates marked invalid; no invented first day                                           |
| Privacy, source timestamps, other fields and export metadata                           | Retained privately; never a command clock or publication decision                                                                                  |

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
//   currentScoreVote: {units:number|null,revision:number,at:string} | null, outcome: MalOutcome | null }
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
// and admission {status:"conditional",reason:null} with the complete native version-1 guard.
POST /v1/libraryImports/mal/:id/apply
{ confirm: true, rows: [{ row: 0, version: "review-1", fields: ["status", "score"] }] }
// 200 { id, outcomes: [{row:0,status:"unavailable",applied:["status"],retained:["my_score"],
//   score:{action:"adopt",status:"unavailable",reason:"atomic_guard_unavailable",vote:null}}], remaining: [], stopped: false }
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
the existing bounded plan. `readVoteReview(actor, questionId, targetId)` supplies the complete counted/current
observation and immutable guard (question revision/lifecycle, canonical identity and all epochs, own-vote witness).
Page and unstarted apply detect changed observations. Existing reviews without a complete guard remain unavailable
and require a fresh review; they are never upgraded by sampling new operands during apply.

Decision: compose Content's existing conditional writer and complete native review operands with Library checkpoints;
retain original guards and keys across uncertain delivery, and require native readback before reporting score success.
Frozen vote observations use Content's meaning, or the question label when meaning is absent. Reviewed question DTOs keep Content's optional meaning, including null; they do not copy the display label into meaning.
Confirmation calls `preparePutVote(actor, input, key, admission?)` once with the captured actor, frozen observation and
source-document admission, persists `score.started` with that command, then `putVoteOutcome` with those operands; an
uncertain retry first uses `reconcilePutVote(actor, receipt)`.
Decision: retain each reviewed vote guard as an opaque JSON string keyed by review version so document canonicalize
cannot reorder identity operands. Apply prefers the stored review guard (the same jsonb-roundtripped object Content's
vote-review producer admits), parses the opaque encoding only when that object is absent, and calls putVoteOutcome with
the prepared input rather than overlaying a second parse. A Rating redirect of the Library-selected Subject stores
no vote guard and requires an explicit new target review. Native stale/unavailable errors are definitive typed
outcomes. Unexpected delivery/readback errors throw and retain that checkpoint for exact command retry; current reads
cannot settle uncertain delivery. A review refresh cannot replace a started unresolved score, including when labels are
refreshed. Missing score consent remains resumable. A selected score without a completed review is
`score-action-not-reviewed`: status may still appear in `applied`, and the row status follows that unsuccessful
independent score. Independent effects cannot turn a selected unsuccessful vote into overall success.

The consumer adapts the native flat question scale fields into the existing nested review scale.
Public MAL client types keep conditional score admission and applied outcomes from the Kernel model snapshot until
the compiler `typecheck --emit-client` emitter republishes them. Mutation callers send a required Idempotency-Key;
page and apply reads do not.
Definitive score outcomes persist independently before Progress, remaining labels or independent state; retries retain that original
result and read current native state. A label refresh cannot erase an unresolved started vote.
Same-home guarded effects complete through Content's writer; foreign homes remain `atomic_guard_unavailable` through
Semantic's same-home fence. No local vote writer, resolver or permission mechanism is introduced. Successful producer
admission is followed by `readOwnVote`; receipts are never displayed as current votes.
The page's `currentScoreVote` comes from a fresh native Rating reader on each visit, independently of retained
review baselines and effect outcomes. The owner Entry reader remains the page's current Library state source. Whole-list positive/changed-reimport,
effect-before-ack retry, all native fences and mounted caller acceptance remain required after producer integration.

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

Decision: native redirect checks reuse the fixture steward on a token and Global grant that both carry `subject:merge` and `gate:subject_identity`; a reduced sibling token is denied even when the role row exists. Guarded score and redirect checks place the Library-selected Subject on the voter's identity home and finish identity bootstrap on that partition before Rating review or merge. Native import vote, merge, progress and metadata actors occupy partition 0 with those Subjects so Global merge authorization and Rating's same-home guarded path apply. Partition 0 identity bootstrap waits until the first Library-selected Subject exists on that home so the first scan includes it; sealing the empty question/control home first leaves later creations past the cursor. Native import tests recapture identity dirty after each Subject write, after link drain on each HTTP send once a Subject is mapped on that home, and before direct Rating apply, so Entry, Progress and vote writes cannot leave Mapping pending. A mapped home with no dirty originals and empty control pending/prepare pins stays current; recapture does not start another bootstrap generation or republish an installed epoch. They drain held prearm after mapping completes; unpublished Search/Library acknowledgements do not pin the group against later Progress, Rating or merge. Mapping-complete pending jobs are current once that job's epoch is installed; native import tests then publish that job so later bootstrap can recapture dirty and a later merge or vote job can start. A home is current for later Progress, Rating and merge only after those jobs are published and control pending/prepare pins are empty; mapping-complete pending classification alone does not free home capacity. Apply commits selected scores and Progress before independent state so Entry writes cannot dirty the vote or occurrence target. A preparing identity job may change `prearm_phase`, `prearm_transaction_id` and `cancellation_transaction_id`; intent and receipts stay immutable. Later Subject writes recapture identity dirty before Rating, Progress or merge resolve the mapping. Guarded Rating apply uses the same `rating:vote` token-scope check as HTTP PUT; it does not require an Access account grant. HTTP merge on an active identity terminal admits the job and mapping applies the redirect; it does not persist-command the catalogue redirect against that hold.

Integration decision: MAL and Bangumi retain their separate native review guards, routes and erasure phases.
Landing `list-import-mal.test.ts` pins tags-only apply (`fields: ['tags']`, status omitted) on the mounted HTTP path.

Native rating cost: at most 20 selected rows per page/review/apply batch use one complete native `readVoteReview`
per row (question directory/current account, bounded counted-reader prepare/read/finish, original/canonical slots and
identity epoch fences). Unstarted apply and page repeat these observations; each score-reviewed page row also reads the current native own
vote for `currentScoreVote`, even when independent fields have not completed. Each effect persists one started checkpoint,
invokes one conditional native command with its original key/guard, reads current own vote, and persists one
independent definitive score checkpoint before other selected effects. An uncertain retry
repeats that exact command's authorization, exposure and receipt lookup before disclosure; it does not refresh review
operands. Include the producer's question/lifecycle, identity and own-vote fences, receipt digest, native vote,
component/aggregate work and transaction commit/rollback in the same caller cost. Guard bytes, checkpoints and outcomes
remain within the existing 48 MiB document and 512 KiB result caps; no new cap, scan or measurement writer is added.
Full producer cost and growth at scale remain unmeasured controller acceptance.
