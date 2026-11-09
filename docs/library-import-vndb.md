# Personal VNDB list import

The mounted Kernel API imports the authenticated person's uploaded `vndb-export version="1.0"` XML into reviewed
personal state and selected native Progress, with explicit guarded score consent. It does not fetch or claim provider
accounts, create catalogue subjects or holdings, change provider mappings, import aggregates, or publish notes/reviews.
Web owns the interface; a changed re-import preserves the original Entry identity.

Imports owns the mounted personal-list caller and explicit unmatched match. It submits the supplied private export
through the generated VNDB preview method, seals the exact body and idempotency key in the existing `ShowcaseJournal`,
and returns the actual native upload UUID and row count. The existing review/apply API composes each native owner;
no second importer or Library vote writer is introduced.

Decision: explicit importer review and confirmation use stable intent IDs in the common private journal. Reopening
replays the original upload address, review body/key and selected state/Progress or score review IDs under the same
account, client, credential and origin. A changed form cannot replace pending operands. A deadline leaves the original
selection resumable; an acknowledgement describes command outcomes only. A separate fresh eight-row FULL Library
read supplies actual current Entry, Progress and counted-vote values. The development persona requests the existing
Library, Progress and vote scopes for these explicit choices; source scores never confer consent.

Native review digests sort object properties recursively, preserving array order, so JSONB storage cannot change
the identity of reviewed operands. State dispatch records its start checkpoint before sending the native command;
an interrupted acknowledgement throws and leaves the original intent available for receipt reconciliation.

Decision: the mounted Web caller carries state, explicit minute occurrences and deliberate native vote units
through the same retained review/apply commands. Native units zero and clear stay distinct. The official client uses
a typed compatibility binding for these already mounted additions until whole-Kernel declaration emission succeeds;
it yields to the generated Progress contract. Web trusts native responses and keeps current-session custody checks.

## Private evidence

| Source field                                                                         | Review and native treatment                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playing / Finished / Stalled / Dropped / Wishlist labels                             | Suggest active / completed / paused / dropped / planned roles; explicitly select a released native state ID.                                                                                                                     |
| Other labels and per-label attributes                                                | Private evidence; no automatic local label creation.                                                                                                                                                                             |
| Vote                                                                                 | Exact raw 1–10, step 0.1 evidence; zero invalid. Explicit native units and consent enter the native guarded writer, without rounding or automatic conversion. Supported commits require the native participants described below. |
| Started / finished                                                                   | Preserve year/month/day precision, including unknown trailing `00` components. Adopt only through explicit occurrence date review; no command clock is inferred.                                                                 |
| Play-time minutes                                                                    | Each `length-votes/vn/minutes` row declares minutes. Explicitly select one occurrence/start and the `minutes` measure; only a current released scalar `minute` profile admits it.                                                |
| Progress extensions, speed, releases, notes, privacy, reviews, metadata, unknown XML | Retain exact evidence and its reason; never infer unit meaning or public review content. Original XML is downloadable only by its owner.                                                                                         |

Missing, empty/unknown, invalid and valid values have distinct `kind` values with original `raw` text retained.
Notes preserve significant whitespace when proposed for native adoption. Date parsing trims only its interpretation;
the original spelling, including whitespace and unknown components, stays in `raw`. Progress and privacy tokens also
retain their original spelling. Unsupported priority, timestamp and release vocabulary remains parsed evidence;
no native priority or timestamp meaning is guessed.

## Matching

Matching uses the admitted native `semantic.external_claim` tuple `(source="vndb", external_id="v123")`,
its tuple home, current canonical identity and subject readability. Alternate source namespaces are unavailable
through this slice. A title is display/search assistance only. Release IDs (`r123`) are never VN identities.
Release records, reviews, length votes, unknown containers and export metadata are retained privately.
Catalogue batch creation uses its existing native Record history (codec 3021) and admitted provider tuple;
VNDB review extends the native import guard union while other sources keep their original command operands.
Candidate arrays distinguish matched, ambiguous, unmatched, unavailable and unsupported. Native tuples are unique;
the ambiguous shape is reserved for multiple disclosed canonical candidates, never generated from titles.
Unmatched rows accept an explicit readable target obtained through ordinary catalogue search.

Explicit selection reads the chosen work's current private Entry before showing replacement consent. This uses
one ordinary authenticated Entry read, independent of the export; absence and refusal remain distinct. Saving a
review against a different target refreshes the current native target, released state choices and counted vote
preview in one existing eight-row page read. A lost refresh retries only the read, retaining the acknowledged review.
Score consent is then based on that target's actual vote. The independent Library return read uses the same FULL
page's caller-private counted vote projection in native occurrence order, alongside status and Progress. It preserves
zero, absence and unavailable, without rescaling or filling gaps from import decisions. At most eight native rows
supply every layout and inspection; no per-row read is added. Result links carry the public-safe Library return landmark;
private upload addresses, source XML and native cursors stay off the public work URL.

Decision: consume the released import and graph owners; refresh explicit-match previews and retain the Library return
landmark rather than introducing another importer, vote writer or provider identity mapping.

## Original command custody

No absent value clears native facts. Existing entries are preserved by default; `replace:true` captures the current
revision and incarnation for explicit review. Confirmation names that immutable `reviewId`. Apply rechecks current
account authority, chosen identity, readability, release, cancellation and native admission. A changed basis returns
`stale`; refresh review. Native commands freeze target, state, revision, incarnation, review guard and command key.
An unknown failure retries that original command; it cannot be re-reviewed into different operands. Exact native
receipt replay remains possible after an acknowledgement is lost. Applied rows are never applied again.

Decision: HTTP 401, 403 or 404 for current authority or visibility remains `unavailable`, not a terminal refusal. Keep
the prepared journal intent retryable across reopen and replay its original body and idempotency key after authority
or visibility returns; record only terminal input refusals.

Choice: recovery fixtures use a fresh prepared upload or review intent, then reopen and replay its original sealed
identity, operands and key after authority returns.

Refreshing a source review retires its metadata tokens rather than carrying them into a corrected match. An
unresolved state, metadata or date dispatch must settle before review replacement.
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

## Progress

[VNDB's exporter](https://g.blicky.net/vndb.git/tree/lib/VNWeb/ULists/Export.pm?id=75a40d0dcbd4691abe8aed52c6447361cacf65c2)
places each play-time observation in `length-votes/vn/minutes`. The element declares minutes; its `vn` ID uses the
ordinary VN tuple matcher. Each observation remains a separate retained row. Speed, releases, date and notes do not
change its unit, create an enjoyment vote, or publish a length aggregate. Arbitrary `progress` and `unit` extensions
remain private evidence; a matching unit word alone cannot establish VNDB meaning.

Decision: adopt only the exported `minutes` scalar into a current released profile admitting `minute`, using the
shared Progress helper; retain Content's exact counted vote review and original command operands for guarded dispatch.

A Progress-only review selects `field: "minutes"` and one existing occurrence by session ID, or explicitly selects
`occurrence: {kind: "start", primaryUnit: "minute"}`. State review remains independent. Only selected measures are
written. Existing measures are preserved unless replacement is explicit, unrelated measures remain unchanged, zero
is an amount, absence preserves current facts, and `action: "clear"` separately clears one selected measure. Missing,
unknown, invalid and unsupported values have distinct outcomes. No occurrence or historical activity is inferred.
The result includes per-measure outcomes and the native reader's current occurrence and measures. Web offers one
bounded page of current occurrences for the explicitly chosen target, an explicit new minute occurrence, replacement
consent and a separate clear choice. Native review reports profile or source ineligibility before confirmation.

## Native score review

The VNDB `vote` remains a private `fields.score` value with its exact `raw` spelling and source scale. A valid
source score can be reviewed for the standard question `00000000-0000-7000-8000-000000000001`, revision 1,
meaning and native units 0–20 step 1. The page shows the actual Content question and the owner's current vote or
absence. A source value such as 7.3 is valid VNDB evidence but has no exact native value; the owner chooses native
units deliberately. An exact candidate for 7.5 is shown only as a candidate, never applied automatically. Source zero
is invalid and cannot be adopted as a vote. Clear uses a separate `{ kind: "clear" }` selection and is not source
absence or native units zero. Only `kind: "vn"` score fields enter this flow; release IDs, reviews and length votes
stay private evidence.

The explicit review choice records `adopt-native-vote` or `clear-native-vote` consent, the selected target, exact
source score, question revision/meaning/scale, current vote or absence, source fingerprint and stable native command
key in the existing `library.vndb_import.decisions` JSON. Refreshing a score review creates a new score review ID;
an older confirmation is stale. The existing 8 MiB decisions bound includes these private baselines and operands.
Parsed evidence reserves one 32 KiB slot per possible page row for score context and reviewed-result bytes inside the
existing 16 MiB evidence cap. The XML, escaped JSON request, page, batch, upload count, lifetime and erasure bounds
remain unchanged; no score table or second evidence store is added.

The [Rating module owner](../services/kernel/src/rating/README.md) supplies `readVoteReview` and
`putVoteOutcome`. Review captures its exact guard for question revision/lifecycle, canonical identity and published
epochs, and current counted own vote or proven absence. The consumer also captures exact question meaning, grain and
scale, the whole retained source digest, match digest and target source fingerprint. These private operands never
appear in public aggregates or HTTP review responses.

Apply uses Content’s `preparePutVote` to retain the normalized body and receipt digest together with the original
actor credential before dispatch. The existing native vote writer receives that frozen body, guard, observation
and key, plus the source owner’s admission. Source operands join the native receipt digest;
fresh execution checks the locked retained row, review, lifetime and cancellation after native receipt lookup.
The prepared vote envelope is not that source witness. Apply rebuilds the closed Semantic identity operand from the
retained guard so PostgreSQL JSONB key order and numeric coercions cannot fail `participant.prepare`.
Known source or native witness changes return stale. An unexpected error propagates while preserving the original
dispatch for exact retry. Current authorization precedes receipt disclosure. Cancellation or expiry permits only
reconciliation of a pending original command; no later action starts. Success reads current own state through
`readVoteReview`, including counted zero and explicit clear; neither a receipt nor an aggregate supplies readback.

Decision: supported same-home score effects use Content’s native question and Semantic identity participants;
pending dispatches first use `reconcilePutVote` with their original producer-prepared receipt, then dispatch the
original command only if no receipt exists. Historical dispatches retain their original guard and digest.

The supported native path commits deliberately chosen units, counted zero and explicit clear, and its current
readback uses `readVoteReview`. Source cancellation or expiry permits receipt reconciliation but refuses a fresh
effect. Foreign-home support and the Person merge guard remain separate; foreign question, source or persisted
control homes still return `atomic_guard_unavailable`. Native publication and money prerequisites remain unchanged.

## Caller cost and cleanup

For a page of `p <= 8` source rows, the existing private upload read and owner checks are repeated as before. Score
context adds one initial Content question read and one complete counted question/own-vote review for each addressed VN target. Matching
still addresses only each selected provider tuple and at most two disclosed candidates; a chosen target adds its
existing Library profile/source observation. A score review repeats the bounded upload/owner read, one tuple match,
the chosen target observation, one Content counted question/current-vote review, and one Library review receipt plus the locked
decision JSON update. No history, other-account vote or account-wide vote scan is added.

An apply batch selects at most eight actions total, even when one row selects both state and score. Each selected
score action reads its exact upload row, records its immutable dispatch and invokes the existing Content writer.
A pending retry with a retained producer receipt adds one native receipt-only lookup with current authorization
and disclosure; an absent receipt continues into the original writer. Charge target/question preparation, current-vote
and counted-target locks and source-owner admission on every reached
attempt, including unavailable or rolled-back attempts. Successful supported native effects additionally pay the
native receipt, aggregate work and returned component; Content owns those native terms. Acknowledgement records one
bounded Library result, and current own-vote readback repeats the counted reader. Exact physical counts and shared native growth remain unmeasured. The whole journey is bounded by
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

## Examples

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
// 200: {reviewId:UUID,status:"reviewed",targetId:UUID,action:"vote",units:15,question:{id,revision,meaning,label,grain,scale,aggregateEffect:"public-standard-aggregate"},currentVote:{state:"absent"},consent:"adopt-native-vote",sourceReason,nativeAdmission:"conditional"}
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
// Supported same-home admission: {uploadId:UUID,outcomes:[{ordinal:0,scoreReviewId:UUID,status:"applied"}],stopped:null}
// POST /v1/libraryImports/vndb/{uploadId}:apply
// 200: {uploadId:UUID,outcomes:[{ordinal:0,reviewId:UUID,status:"applied"}],stopped:null}
// action:"skip" => skipped; action:"retain" => unsupported, with evidence still readable.
// GET /v1/libraryImports/vndb/{uploadId}/source => 200 {xml:string}
// POST /v1/libraryImports/vndb/{uploadId}:cancel => 200 {uploadId:UUID,state:"cancelled"}
// DELETE /v1/libraryImports/vndb/{uploadId} => 200 {uploadId:UUID,state:"deleted"}
```

Catalogue matching keeps the conservative account-bearing classification when duplicate declarations conflict;
native command and Record account associations remain independently guarded. Only the admitted VNDB tuple namespace
is supported here; titles never create a match.

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
reads independently. Thus page composition reaches at most `3P` target observations, plus one initial question read
and at most `P` complete counted question/own-vote reviews. Each score dispatch additionally prepares up to four
target observations through its retained-row match, selected target and repeated current-target read, even for
receipt replay. A metadata review/view reaches up to three target observations; each fresh metadata
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
failed dispatch is never refunded. Score application dispatches the guarded native command and its source admission under frozen operands. Charge
question, identity and vote preparations, locks and rolled-back work even when native admission is unavailable.
Successful effects add native receipt/event/aggregate work and current counted readback; each lost acknowledgement
repeats dispatch with the original credential, guard and key. A bounded outcome does not prove native installation.

Upload parses, hashes through the native command digest, serializes and indexes `B+E` before returning, including
idempotent upload retries. Its row-index trigger inserts `N` evidence rows and advances the source fence for each.
Pruning/DELETE/terminal cleanup includes up to `U` parent rows, `U*N` evidence children and `U*I` adoption items,
their indexes/fences, retained receipt work and export cleanup/background participants. This fixed worst case must
remain separate from growth in unrelated owners/history. The V4 exporter uses its existing indexed evidence pages;
it does not reinterpret V1/V2/V3 or make V4 recoverable. Independent all-pool 64/512/4096 executed measurements,
composed V4 fidelity/recovery refusal and terminal cases remain controller acceptance, not results of this derivation.

Native source consent binds the canonical identity epoch, accepting type, profile release and owner epoch. A private review write advancing the partition position does not change that source. Entry command receipt positions are retained as decimal strings so retry evidence remains JSON serializable.

The native date caller preserves its prepared intent when an unexpected dispatch or acknowledgement error throws. Only known native refusal/conflict results become terminal field outcomes; a retry reconciles the original receipt. Receiving fixtures include the generated Progress result even for a state-only decision, where its value is null.

Date admission prepares current matching and profile evidence before the native journal transaction checks out its owner connection. The transaction still locks and validates the retained consent, source digest and exact occurrence binding before a fresh effect. Recovery may append private coordinator receipts and events; it must preserve native Entry and Progress facts.

Label-adoption review and recovery checkpoints emit the same private import-change event as other retained-source commands. Date callers take their revision from the current journal read, independently of the Progress session revision. Native acceptance retains exact failed owner-read problem details rather than inferring applied status from import acknowledgements.

The seeded caller sends an explicit Accept-Language preference (English by default) on its independent FULL Library read. Metadata checkpoint comparisons use canonical object-key ordering, preserving original annotation/provenance operands through PostgreSQL JSONB round trips while still rejecting changed values. Generated state-only review fixtures and stories carry a null Progress result.

After a lost metadata acknowledgement, the retained VNDB review can reconcile only its original native annotation or provenance receipt after source expiry. Receipt lookup binds the owner, client, requested-by identity, row, source review, metadata review, selection, command key and digest under the retained upload lock. It cannot dispatch a fresh effect, recover retired matching consent or disclose the expired source page; deletion or pruning removes this linkage.

Decision: focused importer, Kernel HTTP/coordinator and Web reopen/return tests pin preview, sealed review/apply, JSONB operand identity, Accept-Language, generated Progress, independent Progress readback and expired metadata-receipt recovery. Keep those existing assertions; apply rebuilds the closed vote-guard identity instead of adding tests. Remaining exact-self failures stay capability repairs.
