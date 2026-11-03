# Independent progress measures

This document owns scalar progress values recorded together in one private Library session. A session is one
consumption occurrence; it may retain multiple independent scalar measures without translating one into another.

Decision: Keep the existing session's `mode`, `unit`, and `total` as its primary measure; admit up to seven additional
profile-approved scalar units in that session, and guard every measure write with the existing session revision.

## Admission and meaning

The existing Semantic library profile is the only source of measure IDs, labels, bounds, precision, total policy and
activation. The primary and each additional unit must be admitted as `scalar_amount` by the subject's active profile,
with native structure `none` and identity `none`. The accepted session pin fixes the profile release and accepting
type for every measure in the session. A measure ID is that profile's exact unit ID; there is no local unit catalogue,
conversion ratio or new global vocabulary.

At most eight measures, including the primary unit, may be recorded in one session. Additional IDs must be distinct
from each other and from the primary unit. The server sorts additional IDs by code unit for stable receipts and reads;
the primary measure is always first in the returned array. Unsupported units, structures or mode combinations return
`422 unsupported_library_profile`.

Stored `amount` and `total` values remain decimal strings. `amount: null` means no value has been recorded; `amount: "0"`
is the recorded value zero. `total: null` means no total is known. Bounds and precision apply separately to each
measure using its accepted and current descriptors. Updating or clearing one measure does not change any other
measure. A dimension difference does not trigger conversion.

The measure array is an owner-only projection of the existing session row. The primary value stays in the existing
session columns; additional values are stored with that row and share its owner, profile pin, history, revision and
terminal deletion. No separate measure store or cleanup phase is introduced.

## Native API contract

Existing single-measure calls keep their request and response shape. The `measures` result property is omitted for
single-measure sessions. For a multi-measure session, authenticated owner methods are:

### Create

`POST /v1/progressSessions` keeps the existing fields and accepts `additionalMeasures` only for `mode: "scalar_amount"`:

```json
{
  "subjectId": "...",
  "mode": "scalar_amount",
  "unit": "chapter",
  "total": "24",
  "additionalMeasures": [{ "unit": "volume", "total": "12" }]
}
```

Each measure starts with an absent amount (`null`). The `201` response contains the existing session fields and:

```json
"measures": [
  { "unit": "chapter", "amount": null, "total": "24" },
  { "unit": "volume", "amount": null, "total": "12" }
]
```

The primary unit is the existing `unit`; `additionalMeasures` contains only further scalar units. Create continues to
require the existing `Idempotency-Key`. Replaying its original key and normalized command returns the original
session response without another session or activity effect.

### Read

`GET /v1/progressSessions/:sessionId` returns the same owner-only session projection, including all measure values.
Foreign and anonymous reads retain the existing concealed `404` response. `?presentation=FULL` includes the existing
top-level primary presentation and a `presentation` on each returned measure. Each presentation preserves the existing
`known`, `unknown` and `unavailable` meanings and says whether current recording is `supported`, `unsupported` or
`unavailable`. It uses the exact accepting release for labels and the current active profile only for admission; it
never rewrites or hides stored values because a profile changed.

### Record and correct

`POST /v1/progressSessions/:sessionId:record` keeps the existing revision and idempotency contract. Include
`measureId` to address one scalar unit:

```json
{ "revision": 3, "measureId": "chapter", "amount": "10.5" }
```

The `200` response is the full session projection with the addressed value changed, all other measure values retained,
and the session revision advanced once. A stale revision returns `409 conflict` with no effect. An unknown measure ID
returns `400 invalid_request`; an unavailable or incompatible profile returns `422 unsupported_library_profile`.
Replaying the same command with its original `Idempotency-Key` returns the same response and appends no second history
entry. Reusing the key for a different command returns the existing idempotency conflict.

Targeted clear is `{ "revision": 3, "measureId": "volume", "clear": true }`. It sets only that measure's amount to
`null`, retains its total and every other value, advances the session revision and records one `{measureId, clear:true}`
history intent. The existing `{ "revision": 3, "clear": true }` form still clears the whole session's recorded values;
it retains totals, the session, pin, lifecycle state and dates. Both forms require the same revision and idempotency key.

The typed client exposes `ProgressSessionCreate.additionalMeasures`, optional `ProgressSession.measures`, and
`ProgressScalarMeasure { unit, amount, total }`; values and errors match this HTTP contract.

## Web consumer

Web owns the independent-measure visit on the existing progress session page. It reads the owner session with
`presentation=FULL`, projects at most eight admitted scalar values, and edits chapter and volume in the same
occurrence without converting or completing one from the other. Generic cursor and completed-unit editors stay on
the single-measure path.

Decision: Native `:record` addresses one `measureId`. Saving more than one dirty unit sequences those records
against the shared returned revision. There is no combined multi-measure payload in the installed producer.

Unknown commands keep the original sender, credentials, idempotency key and operands. A stale revision needs an
explicit refresh before a new key. Partial success keeps remaining drafts. Missing `KernelClient.progressSessions({ sessionId }).$record.post` with `measureId` stays unavailable at that seam. Historical or unsupported
descriptors are shown as supplied; Web does not invent labels or a new profile.

Mounted UI: `apps/web/src/library/independent-measures/` with the session page caller in
`apps/web/src/library/progress-session.tsx`. Navigation to session history uses the existing progress session
route. Commerce remains the native producer.

Decision: The installed native `retired` state stays unavailable at the Web read/receipt adapter until its owner delivers a retired-session presentation; existing lifecycle states retain their meaning.

## Composed occurrence correction and recovery

The installed writer already owns exact-ID measure admission, immutable accepted pins, independent amounts and totals,
targeted correction/clear, journal separation, shared revision CAS and original receipt replay. No second writer or
measure profile is installed. Both retained MAL and AniList row reviews use that writer through their existing
[explicit occurrence selection](library-import-progress-adoption.md), including simultaneous chapter and volume
when the current compiled profile admits them. Bundled profile limitations remain explicit.

Decision: identify an occurrence by its native ID and immutable start, and fence new measure effects with its shared
revision; `transactionId` identifies its latest write and must not invalidate a sibling measure's accepted result.

Each newly dispatched adoption step checks its reviewed subject identity epoch, accepting type and exact current
profile pin inside the native writer. The existing complete Source-component binding remains available to callers
that review those coordinates. A changed release, removed unit or incompatible descriptor refuses a new effect;
changing the profile does not rewrite an accepted amount, total or original meaning. Per-measure clear still uses
the historical owner fact without needing a newly admitted value. Import clear additionally requires its explicit
current row consent and review.

An attempted command with an uncertain acknowledgement reuses its original unit, operand, revision and key through
the native command, before current session readback or current profile matching. A valid own receipt returns the
original immutable value even after profile replacement or session retirement. Without that receipt, the native
review binding refuses a new effect under changed meaning. Retained provider intent is checked again before
dispatch, including repeated starts; replaced consent cannot authorize a new effect. An admitted result is saved
independently of subsequent readback. A later concurrent update may make the next fresh measure stale but cannot
turn an already accepted sibling into a refusal. Failed acknowledgements retain the pending key/revision; stale
fresh steps require deliberate new review.

Retirement keeps its existing [occurrence lifecycle](library-occurrence-correction.md): ordinary detail, journal,
history and source pages conceal the retired session. Its retained pin/values and authorized exact receipts survive;
they do not provide a new current read or write permission. No separate retired-session display is introduced.
Native absent amounts, recorded zero, explicit clear history, and provider unknown/missing source values stay
distinct. An unavailable exact release yields unavailable meaning; an unsupported historical pair keeps its raw
value and unknown meaning. Current labels never fill either gap. Journal dates, assessment and their independent
revision are unchanged by measure writes. Scalar episode amounts never populate canonical Episode membership or
infer completion or dates.

## Cost

Operation: independent-measure session inspect and guarded record.
Neighbourhood: one owner session GET (`presentation=FULL`); writes are `:record` against that session id.
Formula: read components `C_read = 1` session GET, independent of owner history length `N`. Projection and retained
state are `O(F)` where `F <= 8` is the admitted measure count from the native response. A save issues `D` record
commands, `D <= F`, chained on the shared session revision; it does not list history or fan out independent
revisions. Installed cap `MAX_PROGRESS_MEASURES = 8` from the producer; this journey exercises the genuine
chapter+volume pair (`F = 2`) and does not fabricate an eight-measure profile.
Test: `apps/web/tests/independent-progress-measures.test.tsx` (scales `N = 20, 200, 2_000`).
This is a Web loader/controller bound, not a new kernel engine path.

### Native and composed source derivation

These are inclusive source-derived terms, not executed growth measurements. Let `F <= 8` be the session's measure
count, `D <= F` selected dirty measures, `S` explicit starts, `A` actual dispatch attempts including retries, and `N`
unrelated retained facts. Hold `F`, `D`, `S`, selected rows and page size fixed while varying `N`. Repeated caller
attempts multiply work; receipt replay is not free. There is no bound on how often a caller may explicitly retry.

Use `T` for mint/release of native read time, `O` for an owner-authorized account/partition/session snapshot, `E` for
one exact immutable release read, `H` for active-release selection, and `Q` for the existing source-anchor operation.
`Q` includes the current account check, before/after identity mappings, subject resolution, Access, accepting type,
source reference and component observation. Include every native home/pool visited by these terms, its SQL
statements, rows/blocks and definition bytes; response length alone cannot price them.

- Presented detail is `2T + 2O + E + H + 2Q`, plus `2Q` for a distinct explicit version and the requested summary
  projection. All `F` measure presentations share these observations. Serialization and measure projection are
  `O(F)` plus actual accepted/current definition bytes; no release or authority lookup is repeated per measure.
- Each record attempt prepares an owner fact snapshot, `E + H + Q`, then enters the existing command runner.
  The runner's reservation, current principal/account/partition authority, receipt lookup, serialization and retry
  work remain included even on replay or refusal. A guarded clear instead prepares its addressed session and
  `H + Q`; ordinary native clear requires no profile read. A start prepares `H + Q` and any explicit version source.
- A fresh scalar record orders the existing owner counter/subject head and session point locks, reads the locked
  fact, performs one session CAS and one history append, and touches the existing activity projection. Price head
  installation, triggers/source invalidation, outbox, receipt persistence and transaction statements as well as those
  point operations. The session JSON rewrite and immutable receipt contain `O(F)` values. Scalar measures create
  no sparse-unit or canonical Episode rows. Journal fields and revision are neither locked separately nor rewritten.
- An authorized replay pays preparation and current command authority/receipt costs but does not repeat the CAS,
  history append, activity, source invalidation or outbox effect. Any native internal retry pays its actual repeated
  preparation, reservation, reads, lock acquisition and serialization; rollback statements also count.
- Each fresh adoption step additionally pays the provider's current binding/cancellation observations, one presented
  session inspect, an admission checkpoint, its native dispatch and a result checkpoint. Review has its own source
  observation and addressed inspect. Pending receipt recovery skips the pre-dispatch inspect/binding but repeats
  consent checkpointing and the native dispatch. There is no post-dispatch whole-session equality prerequisite.
  Include the final checkpoint and all repeated provider mutations/receipts. Upper dispatch work is
  `O(A * (S + D))`, with the above native terms charged for every dispatched command.
- MAL retains its bounded document read/parse/serialization; AniList retains indexed row pages and checkpoints.
  Charge their actual retained evidence bytes, row reads/writes and cleanup rather than treating those as constant
  zero. Session terminal erasure removes the existing row and its existing history/children in their bounded pages,
  including retired occurrences; measures add only capped row/receipt bytes. Existing provider expiry/cancellation
  and receipt retention costs remain with those owners. No new background worker or cleanup participant is added.

The original independent native `64/512/4096` three-scale journey, all-pool counters, retained native handles and
controller placement remain unchanged. Full/frozen acceptance, native growth and browser execution are deferred to
integration. Focused composed cases live in `services/kernel/test/library/progress-measures.test.ts`; existing
`progress-http.test.ts` and `progress-presentation.test.ts` retain their correction, zero, unknown pair, incompatible
unit and missing-release assertions. Source cost derivation does not claim measured rows, blocks or statements.

## Scope

This slice supports profile-approved scalar units, including chapter and volume when both are admitted by the same
profile. It does not add cursor or sparse-unit measures, canonical episode membership, historical user dates, repeat
totals, a new entry state, provider-specific progress storage, or a parallel import engine. Consumers may preserve
separate source values only when their active Library profile admits both units.

The focused native journey is in `services/kernel/test/library/progress-http.test.ts`. Broader native and browser
acceptance remains controller-owned.
