# Importer reconciliation completion evidence

Reviewed checkout: `50253f81316a8e975d67971fb62ed42db3145c10`.
All relative `file:line` citations below refer to that commit, before this report.
This is internal review evidence, not a replacement contract or a completion certificate.
The complete external manager brief was read from
`/home/edge/projects/rezics/rezics-next/.temp/goal/managers/imports.md` (101 lines).
Its Done-when still requires merge on main and a passing root gate. Neither is established here.
No root/kernel checks, remote checks, installation or product tests were run for this review.
“Proved” below means a traced production path and substantive existing assertions, not a fresh passing run.

## Authority and scope

Current owners are `services/importer/README.md:50`, `docs/deletion.md:6`,
`docs/scope.md:11`, `services/kernel/src/content/README.md:336`, and
`services/kernel/src/semantic/README.md:1086`. Discussion material is not a competing authority.
Source conversion semantics, licensing details, API authentication and media transport are separate reviews;
only their reconciliation handoffs are considered here.
The reference index at `/home/edge/projects/rezics/rezics-next/.reference/INDEX.md` was read.
No external reference implementation was needed to design a surface: this report designs none.
The importer README's backpressure references concern the already adopted retry design, not new requirements.

Interpretation decisions:

- The brief's “own tables” means the active `ImportSession`/`RunStore`/`RecordBindings` path,
  not that the standalone `RecordStore` must also be called (`services/importer/src/import-session.ts:42`).
- “Stops before writes” means authoritative API effects and baseline publication; bounded private staging
  necessarily writes first (`services/importer/src/importer.ts:895`).
- “Atomic publication” means the complete local generation pointer; successful remote per-command effects
  and acknowledged records may precede it. There is no source-wide remote transaction.
- “Only public bulk API” in the older brief cannot literally cover every later addition:
  current README documents separate source-statistic PUTs (`services/importer/README.md:34`), and
  `services/importer/src/importer.ts:589` calls that port. Media also has its owning public API.
  These recorded contracts supersede the older transport wording; this review creates no further exception.
- Local operational journals do not inherit authoritative user-record deletion jobs merely because they
  contain provenance (`services/importer/README.md:68`). No new journal retention interval is decided here.

## Scoped requirements and evidence

### Journal identity and source/run isolation — proved-by-current-code-and-tests

`services/importer/src/importer.ts:917` records native key/revision (or `unversioned`), digest,
converter revision and state. `services/importer/src/run-store.ts:321` keys entries by
(source, run_id, record_key); `:341` keys acknowledged metadata by (source, record_key).
Revision/digest/converter revision are comparison data, not five independent primary-key columns.
`services/importer/src/record-bindings.ts:161` keys immutable request journals by source/record/key.
`services/importer/src/importer.ts:101` hashes compound operation identities under a source/record prefix.

`specs/imports-ledger.test.ts:604` asserts independent snapshots/digests for identical keys in two sources,
then checks an empty run for one changes neither and sends no writes (`:628`, `:648`).
The real adapter constructs `Importer` with file-backed SQLite (`services/importer/tests/ledger-driver.ts:12`),
but delegates API/fence effects to the specification's fake ports (`:14`).
`specs/imports-run-plans.test.ts:465` exercises cross-source/run/result-key rejection through the production
`RunStore` adapter (`services/importer/tests/run-plans-driver.ts:7`); it is a storage test, not HTTP.
Standalone `RecordStore` has its own metadata PK/counters (`services/importer/src/record-store.ts:153`);
reopen/source separation and idempotent vanished counts are asserted in
`services/importer/tests/record-store.test.ts:24` and `:45`. It is not the coordinator's active baseline.

### New, changed, vanished and same-content refresh — proved-by-current-code-and-tests

`services/importer/src/run-store.ts:775` classifies against acknowledged row plus sanitized projection.
`services/importer/src/importer.ts:539` skips effects for equal acknowledged metadata, after fence reads.
A changed native revision, digest or converter revision triggers planning; current returned candidate IDs
are retracted and replacement proposals target the bound subject (`:610`, `:635`).
Missing snapshot members are enumerated with the source/active/seen index, not a global set
(`services/importer/src/run-store.ts:1055`); the coordinator stages their state as vanished
(`services/importer/src/importer.ts:1001`).

`specs/imports-ledger.test.ts:330` asserts same-native-revision content changes alter digest and retract
old actual candidates; `:349` asserts revision updates and converter-only changes with unchanged digests.
`:365` asserts mixed new/changed/unchanged results. `:376` asserts exactly 20% disappearance retracts only
that record's candidates and permits reappearance. All use the real coordinator/fake remote boundary above.
For real API evidence, `specs/imports-api.test.ts:448` asserts all four sources retain identical effects,
baselines and stored values after restart; `:485` through `:529` checks replacement IDs, actual old
retractions, stable subject identity, retained community adoption and converter-only reproposals.
The API wrapper selects `api-driver.ts` through `IMPORT_API_DRIVER`
(`services/kernel/test/imports/api-outcomes.test.ts:10`), which opens the runtime/observer fixture
(`services/kernel/test/imports/api-fixture.ts:16`). Runtime calls production `readDump` or `VndbTablesStore`,
then `Importer.runRecords` (`services/kernel/test/imports/api-runtime.ts:650`), `createImportTransport`
(`:431`), and actual `createKernel(...).handle(Request)` (`:290`, `:504`). There is no socket server:
fetch is injected in-process; response loss is deliberately simulated (`:505`). The VNDB API fixture
supplies archive entries directly (`:655`); the raw ustar layer has separate executable evidence below.
Fixture `read`/`effects` delegate to native observers (`services/kernel/test/imports/api-fixture.ts:26`).
No fresh execution result is supplied by this report.

### Direct dumps, full acquisition and malformed-tail safety — proved-by-current-code-and-tests

`services/importer/src/importer.ts:914` consumes/converts the whole stream before sealing (`:942`)
and before planning effects. Duplicate keys invalidate staging (`services/importer/src/run-store.ts:546`).
`services/importer/src/dumps.ts:94` calls `dumpLines`; native identities/revisions are extracted at `:172`.
Framing is validated at EOF (`:238`); duplicates deliberately pass to durable staging (`:67`).
`services/importer/src/dumps-bytes.ts:136` rejects oversized backing allocations before scanning;
line growth is bounded/geometric (`:145`).
`services/importer/src/archive.ts:243` validates checksums, types, padding, both terminators and trailing EOF;
`:334` yields owned pieces at most 512 bytes. It never extracts archive paths to the filesystem.
`services/importer/src/vndb-tables.ts:243` stages table streams; only complete validation marks ready (`:330`).
The CLI composes `readArchive` and table acquisition (`services/importer/src/cli.ts:681`).

`specs/imports-ledger.test.ts:456` checks invalid tails preserve baseline across reopen and send no writes;
`:483` does the same for an upstream failure. `services/importer/tests/importer-reconciliation-growth.test.ts:217`
asserts EOF precedes the fake transport's first effect and the input is iterated once.
`specs/imports-dumps.test.ts:153`, `:175`, `:186` assert malformed/truncated framing and visible duplicates;
its adapter dynamically loads production `readDump` (`services/importer/tests/dumps-driver.ts:229`).
`specs/imports-archive.test.ts:345` and `:355` feed production archive output into table staging and assert
upstream/trailer failure invalidates staging; `:360` asserts cancellation never publishes partial ready state.
Archive instrumentation observes JS I/O boundaries, not arbitrary native addons
(`services/importer/tests/archive-driver.ts:24`).

### Mass-disappearance stop before effects — proved-by-current-code-and-tests

`services/importer/src/run-store.ts:585` computes missing from maintained prior/survivor counters.
Default threshold is 0.2 (`:418`); comparison is strictly greater, while loss of every prior record always
stops, even at threshold 1 (`:598`). Rejected seals release the run without switching the generation.
The coordinator returns before bootstrap, proposals, statistics or deferred-cover work (`services/importer/src/importer.ts:942`).
`specs/imports-ledger.test.ts:406` uses changed survivors plus a new record and asserts no bulk calls,
unchanged baseline and persistence across reopen. `:420` checks strict custom thresholds and all-missing.
Real API assertions exist at `specs/imports-api.test.ts:531`, `:549`, `:590`; they are not executed here.

### Durable partial receipts and ordinary restart — proved-by-current-code-and-tests

Bootstrap bytes precede sends (`services/importer/src/importer.ts:450`); ordinary plans persist envelopes
and reject reused keys with different bodies (`services/importer/src/run-store.ts:803`).
Dispatch validates the complete response before acknowledging and atomically updates bindings plus
RunStore (`services/importer/src/importer.ts:469`, `:488`). Failed/missing entries remain pending
(`services/importer/src/run-store.ts:1105`). Reopen drains original work before consuming newer input
(`services/importer/src/importer.ts:866`, `:946`).
`specs/imports-ledger.test.ts:498` asserts only accepted records advance while the full snapshot stays null;
`:565` asserts interruption after fake remote success replays keys without duplicate fake effects.
Malformed/missing/duplicate/mismatched result cases at `:781` onward assert baseline retention.
`services/importer/tests/import-session.test.ts:193` uses actual reopened storage, asserts newer input
was never consumed and the original body was resent (`:220`); its remote receipts remain simulated.
Real receipt recovery assertions are in `specs/imports-api.test.ts:817`.
This proof does not cover every deferred-cover crash window; see the defect below.

### Ownership and atomic local publication — proved-by-current-code-and-tests

One SQLite connection backs both active stores; bindings set `synchronous=FULL`
(`services/importer/src/import-session.ts:43`, `services/importer/src/record-bindings.ts:149`).
Standalone RecordStore/RunStore initially use NORMAL; their isolated tests are not power-loss proofs.
`services/importer/src/import-session.ts:55` acquires an exact-source immediate-transaction guard,
using PID plus Linux boot/birth identity; lease rotation is holder-only (`:82`).
`services/importer/tests/import-session.test.ts:78`, `:123`, `:155` assert live-owner exclusion,
independent-source progress, stale-capability refusal and recovery after a child process dies.
These establish process/reopen behavior on Linux, not disk-loss or filesystem-corruption recovery.
`services/importer/src/run-store.ts:1156` gates finalization on all expected records resolving and pages
membership updates before one complete-pointer switch (`:1193`).
`specs/imports-run-plans.test.ts:555` asserts the old generation survives an unresolved command,
then finalizes one row per page across reopen and checks all new baseline rows.

### Tuple fences, retention and deletion boundaries — proved-by-current-code-and-tests

`services/importer/src/importer.ts:191` reads all field-group tuples and validates opaque revision strings;
planning does this before unchanged shortcuts (`:537`), dispatch repeats it (`:471`), and deferred-cover
resolution checks before/after provider work (`:676`, `:718`). Omission proof is durable, and fenced
commands are filtered without replacing their immutable stored originals (`:474`).
`specs/imports-ledger.test.ts:655` checks every unchanged/changed/converter refresh reads exact tuples
and never resends the fenced group; `:690` tests source/record/group isolation, `:721` a late fence.
`specs/imports-run-store.test.ts:388` proves another group's omission cannot resolve failed facts;
`:424` preserves `9007199254740993` exactly across reopen. These use real storage with supplied proof,
not an authoritative fence read. Production bindings adapter directly instantiates `RecordBindings`
(`services/importer/tests/bindings-driver.ts:5`).
`specs/imports-api.test.ts:601`, `:655` assert server takedown survival and a race after preflight.
Final disclosure remains Content/Semantic's responsibility, not a guarantee of client preflight alone.
Retraction deletes only the exact local current-candidate pointer and retains its journal acknowledgement
(`services/importer/src/record-bindings.ts:380`). It is not communal deletion, restore or purge;
`services/importer/README.md:68` owns this boundary and `docs/deletion.md:26` distinguishes takedown retention.

### Bounded reconciliation, no hidden one-record scan — proved-by-current-code-and-tests, with limit below

Source acquisition is intentionally linear in supplied records. Staged/pending/vanished/finalization pages
are capped at 100; current candidates at 300 total/100 per group (`services/importer/src/importer.ts:423`).
Run plans cap at 300 commands and split into public 100-command/65,536-byte envelopes
(`services/importer/src/run-store.ts:698`). No entire historical key set is accumulated.
`services/importer/tests/importer-reconciliation-growth.test.ts:120` grows real same-source history at
32/128/512, measures actual SQLite calls, and asserts fixed work/calls plus linear command work (`:160`, `:192`).
Its API is fake; the probe's `blocks:0` explicitly means unavailable counters, not zero I/O
(`services/importer/tests/support/sqlite-growth.ts:15`). Exact candidate queries include source/record/group
(`services/importer/src/record-bindings.ts:428`). Per-invocation retries cap at eight logical sends
(`services/importer/src/importer.ts:95`, `:355`); repeated operator runs/providers have no lifetime deadline.
EOF acquisition and storage growth evidence do not prove a universal wall-clock bound.

## Concrete defects and missing evidence

**incomplete/contradicted — deferred-cover acknowledgement crash window.**
Small failing-test sketch: one Bangumi record with one cover; provider returns pending during planning,
then available media ID M in deferred resolution. Let proposal P commit and bindings acknowledge candidate C;
interrupt immediately before `resolveDeferredCover` (`services/importer/src/importer.ts:759`, `:762`).
Reopen the same state and resolve the same M. Expected: retain C, replay only original work, then commit.
Code-derived actual: `:727` now sees C as current and builds a new retraction of C; `:750` reuses P's key.
The server replays P's receipt without recreating C; retraction removes C. Bindings' duplicate P
acknowledgement is a no-op (`services/importer/src/record-bindings.ts:351`). The run can finish with no live cover.
This is a deterministic sketch, not an executed reproduction. Existing post-success interruption hooks
run before local acknowledgement (`services/importer/src/importer.ts:240`), so they do not establish this window.
Smallest owner/path boundary: importer deferred-cover orchestration and its coordinator outcome tests;
no media transport or server contract change is implied.

**incomplete/contradicted — hostile object width is not admission-bounded.**
For N=16/64/256 own keys, pass `{ sourceKind: 'wikidata', normalizedRecord: wideObject }` to a valid
source-record `RunStore.stage`; give `wideObject` an oversized first string and N remaining null fields.
Expected under the README's bounded-validation criterion: rejection without enumerating all N keys.
Actual: `Reflect.ownKeys` allocates the complete key list before the byte budget rejects the first value
(`services/importer/src/run-store.ts:185`); `exact` also enumerates descriptors (`:115`).
A growth sketch measures keys visited/allocation before rejection, asserts no persisted row, and grows N.
The README already acknowledges this limit (`services/importer/README.md:157`). Smallest boundary:
RunStore input validation/tests. This does not invalidate indexed database seeks for admitted bounded records.

**unverified — current execution and landing.** Existing executable assertions and driver wiring establish
reviewable evidence, not current passing results. Main merge/root gate, power-loss recovery and the precise
crash sketch above remain unverified here. Known central check-host saturation is infrastructure, not a product
defect; no host check was attempted and no overload-driven product change is proposed.
