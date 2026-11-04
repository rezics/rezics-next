# Personal VNDB list import

The mounted Kernel API imports only the authenticated person's uploaded `vndb-export version="1.0"` XML.
It does not fetch accounts, claim another person's account, create catalogue subjects, change provider mappings,
create holdings, labels or sessions, import provider aggregates, or publish notes/reviews. Web owns the interface.

Decision: compose explicit released entry-state commands with private source evidence; role suggestions never
grant an import mapping or invent state IDs, and every other field stays retained until its native owner admits it.
Profiles with no entry state set cannot receive a state. There is no separately released VNDB field mapping.
Integration preserves AniList label adoption with native operation metadata and existing erasure phase numbers; VNDB evidence cleanup appends after label consolidation.

Matching uses the admitted native `semantic.external_claim` tuple `(source="vndb", external_id="v123")`,
its tuple home, current canonical identity and subject readability. Alternate source namespaces are unavailable
through this slice. A title is display/search assistance only. Release IDs (`r123`) are never VN identities.
Release records, reviews, length votes, unknown containers and export metadata are retained privately.
Catalogue batch creation uses its existing native Record history (codec 3021) and admitted provider tuple;
VNDB review extends the native import guard union while other sources keep their original command operands.
Candidate arrays distinguish matched, ambiguous, unmatched, unavailable and unsupported. Native tuples are unique;
the ambiguous shape is reserved for multiple disclosed canonical candidates, never generated from titles.
Unmatched rows accept an explicit readable target obtained through ordinary catalogue search.

| Source field                                             | Review and native treatment                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playing / Finished / Stalled / Dropped / Wishlist labels | Suggest active / completed / paused / dropped / planned roles; the person explicitly selects an actual released state ID.                                                                                                                                                                                                        |
| Other labels and per-label attributes                    | Private evidence; no automatic local label creation.                                                                                                                                                                                                                                                                             |
| Vote                                                     | Retain exact raw spelling and original 1–10, step 0.1 scale. Zero is invalid. Values such as 7.3 have no exact native half-point value; the person may choose native units explicitly, with no rounding or exact-conversion claim. Native admission currently returns typed unavailable and performs no vote or aggregate write. |
| Started / finished                                       | Preserve year/month/day precision, including trailing unknown `00` components; invalid and unknown dates remain distinguishable. No command clock or historical session is inferred.                                                                                                                                             |
| Progress and measure                                     | Preserve original value, including zero, and supplied unit; no session or counted activity is inferred.                                                                                                                                                                                                                          |
| Notes, privacy, review, metadata, unknown XML            | Visible retained evidence with its reason; exact original XML is downloadable only by its owner. Notes are never public reviews.                                                                                                                                                                                                 |

Missing, empty/unknown, invalid and valid values have distinct `kind` values with original `raw` text retained.
Notes preserve significant whitespace when proposed for native adoption. Date parsing trims only its interpretation;
the original spelling, including whitespace and unknown components, stays in `raw`. Progress and privacy tokens also
retain their original spelling. Unsupported priority, timestamp and release vocabulary remains parsed evidence;
no native priority or timestamp meaning is guessed.
No absent value clears native facts. Existing entries are preserved by default; `replace:true` captures the current
revision and incarnation for explicit review. Confirmation names that immutable `reviewId`. Apply rechecks current
account authority, chosen identity, readability, release, cancellation and native admission. A changed basis returns
`stale`; refresh review. Native commands freeze target, state, revision, incarnation, review guard and command key.
An unknown failure retries that original command; it cannot be re-reviewed into different operands. Exact native
receipt replay remains possible after an acknowledgement is lost. Applied rows are never applied again.

Decision: a refreshed source review retires its metadata tokens rather than carrying them into a corrected match;
an unresolved state, metadata or date dispatch must settle before review replacement.
Corrected matches may explicitly adopt labels on the chosen readable target. New label operands bind both the
source review and its observed match digest; a later match change invalidates that consent. Existing label operands
retain their original native receipt input and conservative match check.

State dispatches retain their original target, body, guard and key after an unknown acknowledgement. Reconciliation
may dispatch that same command after cancellation or expiry: native receipt lookup returns an existing effect, while
the original source fence refuses every fresh effect. No following row or score action starts on that source.
An acknowledged state records the native transaction, partition, epoch and position. Metadata commands use the same
installed native admission protocol as labels: preparation repeats target/profile and match observations, and fresh
execution locks and checks the retained upload, row, target, source review, metadata token, selected fields, caller and
lifetime after native receipt lookup. Confirmations already in flight retain their pre-admission native digest.
Date retries likewise preserve the entire original patch, occurrence, admission identity and request key; only their
acknowledgement may advance after cancellation or expiry. Neither path can renew source lifetime or replace operands.

Private page, source and metadata reads require physically retained, unexpired evidence and recheck that condition
after awaited work. Cancelled, unexpired evidence remains privately downloadable. Expired evidence cannot supply a
new review, even if an old mutation receipt exists. Exact metadata/date acknowledgement reconciliation returns only
the bounded native outcome; it does not restore private evidence access. Label orchestration still requires its live
preview lifetime, so expired label acknowledgement reconciliation remains unavailable in this delivery.

Decision: score review requires the owner to choose native units explicitly; native zero is a vote, clear is a
separate explicit action, and source absence preserves the current vote.

## Native score review

The VNDB `vote` remains a private `fields.score` value with its exact `raw` spelling and source scale. A valid
source score can be reviewed for the standard question `00000000-0000-7000-8000-000000000001`, revision 1,
meaning and native units 0–20 step 1. The page shows the actual Content question and the owner's current vote or
absence. A source value such as 7.3 is valid VNDB evidence but has no exact native value; the owner chooses the
native units deliberately. An exact candidate for 7.5 is shown only as a candidate, never applied automatically.
Source zero is invalid and cannot be adopted as a vote. A clear uses a separate `{ kind: "clear" }` selection and
never means source absence or native units zero. Only `kind: "vn"` score fields can enter this flow; release IDs,
reviews and length votes stay retained evidence.

The explicit review choice records `adopt-native-vote` or `clear-native-vote` consent, the selected target, exact
source score, question revision/meaning/scale, current vote or absence, source fingerprint and stable native command
key in the existing `library.vndb_import.decisions` JSON. Refreshing a score review creates a new score review ID;
an older confirmation is stale. The existing 8 MiB decisions bound includes these private baselines and operands.
Parsed evidence reserves one 32 KiB slot per possible page row for score context and reviewed-result bytes inside the
existing 16 MiB evidence cap. The XML, escaped JSON request, page, batch, upload count, lifetime and erasure bounds
remain unchanged; no score table or second evidence store is added.

Effects are typed `unavailable`. The installed Content producer is
`createVoteCommands.putVoteOutcome(actor, input, idempotencyKey)` and has no conditional reviewed-current guard for
question revision, canonical/counting identity and vote absence/current revision. Until Content supplies that guard
inside its native writer, Library does not call the writer, clear a vote, expose a success result or claim Done. The
next delivery must preserve Content's authorization-before-receipt, receipt replay and component semantics. When
available, the command must use the frozen review operands/key and return only the native vote's permitted public
view. Existing native authorization continues to control question/vote reads; no provider aggregate is imported.

## Caller cost and cleanup

For a page of `p <= 8` source rows, the existing private upload read and owner checks are repeated as before. Score
context adds at most one Content question read and one current-own-vote read for each addressed VN target. Matching
still addresses only each selected provider tuple and at most two disclosed candidates; a chosen target adds its
existing Library profile/source observation. A score review repeats the bounded upload/owner read, one tuple match,
the chosen target observation, one Content question/current-vote pair, and one Library review receipt plus the locked
decision JSON update. No history, other-account vote or account-wide vote scan is added.

An apply batch selects at most eight actions total, even when one row selects both state and score. Each current
score action reads its exact upload row and writes one bounded Library unavailable outcome/receipt. It currently
executes zero Content vote commands, aggregate changes or rating components. After the missing Content guard is
delivered, each selected score action will additionally pay the existing writer's target/question preparation,
current-vote and counted-target locks, native receipt, emitted aggregate work and returned component; Content owns
those native terms. Exact physical counts and shared native growth remain unmeasured. The whole journey is bounded by
`1 upload + P pages + R reviews + A selected apply actions + lifecycle cleanup + exact-key retries`, with rows/page,
actions/apply, five-second apply scheduling, XML/JSON/evidence/decision bytes and upload lifetime under the existing
`VNDB_LIMITS` and table constraints.

The upload remains one `library.vndb_import` owner row. Expiry is removed by the next upload or explicit DELETE;
cancel retains acknowledged native state, and terminal erasure uses the existing VNDB phase. No score-specific table,
account vote discovery, payer or cleanup participant is introduced.

Limits: 2 MiB UTF-8 XML (JSON wire bound 12 MiB + 64 bytes, including escaping); depth 32 before parsing; at most 5,000 review rows including metadata; 16 MiB parsed evidence;
four uploads per account; eight rows per page/apply; a five-second scheduling budget per apply, with bounded native
commands already in flight allowed to finish. Cancellation/deletion orders against fresh admission under the same
owner lock, stops new rows and leaves acknowledged effects intact. Each row returns applied/skipped/stale/unsupported/
failed. Unstarted rows are omitted when `stopped` is deadline/cancelled; resume the same selection. Uploads expire
after 24 hours for new work, are removed on the next upload or explicit DELETE, and belong to Library terminal erasure.
The XML and JSON limits are independent: DTD/entity declarations, malformed XML and XML over 2 MiB return HTTP 400;
the escaped JSON request wire bound over 12 MiB + 64 bytes returns HTTP 413. Browser `File.size` is not the escaped
JSON wire size and cannot predict that limit; only native admission decides whether a request fits. Evidence and review
payloads never enter public Search, events, logs or error details. Responses use `Cache-Control: private, no-store`;
mutation receipts carry only bounded identifiers/outcomes, while source evidence stays in the owner table. HTTP
admission also requires personal Library exposure and the current `library_entry:update` scope; native entry reads
require `library_entry:read`.

The following are constructed typed request/result examples for Web, not execution evidence. All mutations except
apply require the ordinary quoted `Idempotency-Key`; apply reuses the stable commands named by its review IDs.
The exported `createVndbImport` result types and mounted `vndbImportRoutes` form the typed response contract.

```ts
// POST /v1/libraryImports/vndb:preview
const previewRequest: { xml: string } = {
  xml: '<vndb-export version="1.0"><vns><vn id="v123"><title>Title</title></vn></vns></vndb-export>',
};
// 200: {uploadId: UUID, rows: 2, limits: {bytes:2097152,depth:32,rows:5000,evidenceBytes:16777216,page:8,uploads:4,lifetimeMs:86400000,applyMs:5000}}
// GET /v1/libraryImports/vndb/{uploadId}?offset=0
// 200: {uploadId,state:"active",expiresAt:ISODate,total:2,next:null,rows:[{ordinal:0,kind:"vn",identifier:{provider:"vndb",kind:"vn",value:"v123"},title:"Title",labels:[],suggestedRole:null,fields,retainedReason,evidence,match:{status:"unmatched",candidates:[]},target:null,decision:null,scoreDecision:null,nativeScore:{question,currentVote,sourceReason,exactUnits,admission},fieldsTreatment}, metadataRow]}
// POST /v1/libraryImports/vndb/{uploadId}:review
const reviewRequest: { ordinal: number; action: 'state'; targetId: string; state: string; replace: boolean } = {
  ordinal: 0,
  action: 'state',
  targetId: '01900000-0000-7000-8000-000000000001',
  state: 'playing',
  replace: false,
};
// 200: {reviewId:UUID,status:"reviewed",targetId:UUID,state:"playing",baseline:null,replace:false}
type Service = ReturnType<typeof import('../services/kernel/src/library/list-import-vndb.ts').createVndbImport>;
type ScoreReviewRequest = Extract<Parameters<Service['review']>[2], { action: 'score' }>;
const scoreReviewRequest: ScoreReviewRequest = {
  ordinal: 0,
  action: 'score',
  targetId: '01900000-0000-7000-8000-000000000001',
  questionId: '00000000-0000-7000-8000-000000000001',
  questionRevision: 1,
  selection: { kind: 'vote', units: 15 },
  consent: 'adopt-native-vote',
};
// 200: {reviewId:UUID,status:"reviewed",targetId:UUID,action:"vote",units:15,question:{id,revision,meaning,label,grain,scale,aggregateEffect:"public-standard-aggregate"},currentVote:{state:"absent"},consent:"adopt-native-vote",sourceReason,nativeAdmission:"unavailable"}
// An explicit clear instead uses selection:{kind:"clear"}, consent:"clear-native-vote". units:0 remains a vote.
// GET again shows current candidate states, conflicts, retained fields and the stored decision before confirmation.
const applyRequest: { rows: { ordinal: number; reviewId: string }[] } = {
  rows: [{ ordinal: 0, reviewId: '01900000-0000-7000-8000-000000000002' }],
};
const applyResult: Awaited<ReturnType<Service['apply']>> = {
  uploadId: '01900000-0000-7000-8000-000000000003',
  outcomes: [{ ordinal: 0, reviewId: applyRequest.rows[0]!.reviewId, status: 'applied' }],
  stopped: null,
};
type ScoreApplyRow = Parameters<Service['apply']>[2][number];
const scoreApplyRequest: { rows: ScoreApplyRow[] } = {
  rows: [{ ordinal: 0, scoreReviewId: '01900000-0000-7000-8000-000000000004' }],
};
// Current installed result: {uploadId:UUID,outcomes:[{ordinal:0,scoreReviewId:UUID,status:"unavailable"}],stopped:null}
// POST /v1/libraryImports/vndb/{uploadId}:apply
// 200: {uploadId:UUID,outcomes:[{ordinal:0,reviewId:UUID,status:"applied"}],stopped:null}
// action:"skip" => skipped; action:"retain" => unsupported, with evidence still readable.
// GET /v1/libraryImports/vndb/{uploadId}/source => 200 {xml:string}
// POST /v1/libraryImports/vndb/{uploadId}:cancel => 200 {uploadId:UUID,state:"cancelled"}
// DELETE /v1/libraryImports/vndb/{uploadId} => 200 {uploadId:UUID,state:"deleted"}
```

Catalogue dependency history keeps the conservative account-bearing classification when duplicate declarations
conflict; native command and Record account associations remain independently guarded.

Read references: `legacy-final:services/main/src/modules/library-import/formats/vndb.ts`, its contract/bounds/XML
helpers and `csv.ts#sourceDate`; native entry/profile/identifier contracts; `.reference/INDEX.md` (no VNDB entry).
The native HTTP scenarios live in `services/kernel/test/library/list-import-vndb-http.test.ts`; broader frozen
acceptance remains an integration responsibility. No provider live-account or alternate-source support is claimed.

## Inclusive retained-source caller derivation

Let `B<=2 MiB` be original XML, `E<=16 MiB` retained parsed evidence, `D<=8 MiB` decisions, `N<=5000` rows,
`U<=4` uploads, `P<=8` page rows, `A<=8` selected actions, `M<=8` label mappings and `I<=64` label items.
These are fixed caller bounds, independent of unrelated account/catalogue/receipt population. Count actual invocations,
including refusals, rolled-back attempts and lost-ack retries; successful creations are not the denominator.

Each `load` selects and decodes the whole retained XML/evidence/decision document, costing `O(B+E+D)` bytes even
when the subsequent operation refuses. It performs current authority checks before and after the read. Ordinary
reads additionally seek the retained header after loading and after page/metadata work. Reconciliation still pays
the whole load; it skips only the source-read admission that would prevent original receipt lookup. Each addressed
`rows->ordinal`/`decisions->ordinal` projection can detoast/examine `E+D` on the server despite returning one row.
Every repeated projection, source digest, matching digest and JSON serialization is charged independently. Hashing
one row is bounded by that row's retained bytes; it is not priced as one constant operation.

Matching performs one tuple-home partition observation and tuple seek returning at most two candidates. Each candidate
repeats the full current Library profile/source observation and native Entry read. A selected target repeats those
reads independently. Thus page composition reaches at most `3P` target observations, plus one question read and at
most `P` current-own-vote reads. A metadata review/view reaches up to three target observations; each fresh metadata
native dispatch prepares up to four more through its retained-row, match and target checks, in addition to the native
personal command's canonical resolution. Both annotation and provenance dispatch pay that preparation independently.
Date apply reaches up to three target observations to recover its retained intent, up to three more for fresh
currentness, and up to three more at native admission; receipt replay skips the fresh admission body only. State
retries repeat the native writer's source preparation and authority/receipt work under the unchanged operands.

For each pool, sum actual SQL statements, returned/examined rows, loops, blocks, bound/result bytes and serialization
over every reached attempt. Include account/Access/partition checks, reservations, owner/address locks, original receipt
lookups, native type preparation, component/event/fence writes, and transaction retries. Library state start/finish,
metadata confirmation/progress, date intent checkpoints and label creation/assignment acknowledgements each dispatch
their own native command and repeat those costs. A lost acknowledgement adds another full dispatch; a refused or
failed dispatch is never refunded. Current score application executes zero vote/aggregate commands but still pays
the Library unavailable receipt and its authority work. Do not infer Content installation from a bounded result.

Upload parses, hashes through the native command digest, serializes and indexes `B+E` before returning, including
idempotent upload retries. Its row-index trigger inserts `N` evidence rows and advances the source fence for each.
Pruning/DELETE/terminal cleanup includes up to `U` parent rows, `U*N` evidence children and `U*I` adoption items,
their indexes/fences, retained receipt work and export cleanup/background participants. This fixed worst case must
remain separate from growth in unrelated owners/history. The V4 exporter uses its existing indexed evidence pages;
it does not reinterpret V1/V2/V3 or make V4 recoverable. Independent all-pool 64/512/4096 executed measurements,
composed V4 fidelity/recovery refusal and terminal cases remain controller acceptance, not results of this derivation.

The existing Web signatures remain unchanged. For example, retrying
`apply(actor, uploadId, [{ordinal, reviewId}], record)` after a lost state acknowledgement may return
`{uploadId,outcomes:[{ordinal,reviewId,status:'applied'}],stopped:'cancelled'}` after expiry. This acknowledges the
original effect only; subsequent page/source reads return not found. This is a constructed shape, not acceptance evidence.
