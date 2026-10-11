# Search regression causes and idle deadline specification

Analysis baseline: `5988f09c5e03ad7bb9ef2c6d21370aabb3ff8d06`, 2026-10-11.
Run 9 tested `7c190de0c49d5c505498543036caadd18a37bdf7`, run
`20261010t200744-9ae88e`. This report is the only authored change. No product,
test, generated artifact or shared-stack change was made.

The brief's read-only Outcome takes precedence over its later request to add
instrumentation and fix native code. Those are implementation specifications
below. This session cannot supply an after-fix measurement or turn IDs green.

## Evidence and acceptance coverage

The run-9 JSON files were absent from this worktree. Their preserved copies and
the original run XML/logs were read from the main checkout without modifying
them. Relevant evidence roots, relative to that checkout:

- `.temp/goal-program/run9-acceptance.json`
- `.temp/goal-program/run9-failure-clusters.json`
- `.temp/goal-orchestration/regress/20261010t200744-9ae88e/manifest.json`
- That run's `qa/<batch>/attempt-1/<run>/shards/` and `logs/` directories.
- `.temp/goal-program/msg-kernel-search-timeouts.md`

Program's approved classes mean: **A**, a first-public-scope function is
incomplete without the change; **B**, the function works today or can remain
behind a platform permission while deferred; **C**, defer or cut. Evidence:
the approved planning report `.temp/reports/规划-2026-10-11.md`, lines 19–21.
Assertion and fixture repairs below are B unless a newly reproduced product
failure establishes incomplete public behavior. They still belong in the
already authorized red-ID triage; they do not establish a new A product task.

An acceptance ID is green only when **all** its registered failing files are
green. Run 9 associates these 14 IDs with the following files:

| ID | Required failing-file corrections |
| --- | --- |
| SEARCH01 | scale; grouped |
| SEARCH02 | scale; candidate overflow |
| SEARCH03 | Content publication |
| SEARCH04 | scale; grouped |
| SEARCH07 | scale; selection oracle |
| SEARCH08 | scale; erasure rebuild |
| SEARCH10 | grouped; candidate overflow; growth Context |
| SEARCH11, SEARCH12 | private search |
| SEARCH15 | Content crash **and media-production** |
| SEARCH16, SEARCH18 | scale |
| SEARCH19 | Content publication; selection oracle; **content-eligibility-order; services/main/tests/content-projection.integration** |
| SEARCH20 | erasure rebuild **and Trust-ops erasure-restore** |

The bold files are omitted from the brief's initial failure list. Fixing only
its named files cannot establish SEARCH15, SEARCH19 or SEARCH20 green.
Trust-ops owns retained-erasure reconciliation and the erasure-restore family;
this report does not propose edits to those files by Kernel.

## Established causes and small implementation sessions

Line numbers below refer to the analysis baseline. Each session must preserve
the original behavioral assertions after correcting setup or observation.
No session may reopen a retired writer or weaken native qualification to get
a fixture through.

### Public scale counters

**Cause:** stale expectation following native delta qualification,
`016a78f48`; inventory fallback for raw-bypass changes remains intentional
(`0b85f83ba`). Owner Kernel; B; no native image build.

`tests/qa/integration/public-search-scale.test.ts:225–227` expects
`[[2,3,1],[2,3,1],[2,3,1]]`; standalone QA observes
`[[2,3,0],[2,3,0],[2,3,0]]`. Query and health counts match. A correctly
qualified command-only stack should perform zero full inventory reads.
The later inventory-equals-readiness assertions at lines 235 and 246 repeat
the obsolete assumption and would mask the subsequent scenario after the
first assertion is fixed.

Run 9's mixed shard includes raw-writing publication-selection-members;
`scripts/qa/stack-environment.ts:70–71` therefore denies the exclusive
assembler. The standalone selection uses the exclusive assembler
(`scripts/qa/cli.ts:414–415`). This explains why the same test reaches
different first failures in the shared shard and alone.

Bind inventory expectations to the advertised native capability
`commandHealth.publicSearchDeltaAvailable`: zero with exclusive native
delta, one per proof with bypass fallback. Keep explicit query/health bounds
at corpus sizes 1, 32 and 101. Repair the later comparisons on the same
basis. Retain the separate exclusive/bypass proofs in
`tests/qa/unit/search-budgets.test.ts:270–334`. The
counter unit test at lines 63–87 must continue excluding background queries.
Do not remove the corpus scaling assertions or count background work as
foreground work.

Run 9's initial shard reached a later classification cancellation at line 442;
its isolated retry instead failed at line 227. These are two distinct causes,
not evidence that ordering repairs either one. Classification setup is a
separate dependency below. This correction alone cannot green the scale IDs.

### Context cost measurement and missing-chain injection

**Cause:** stale query-shape and call-count assumptions after `d27907918`
replaced transitive `rv:baseRevision*` traversal with indexed pinned hops.
Owner Kernel; B; no native image build. Candidate ID: SEARCH10.

`tests/qa/integration/growth-search-context.test.ts:78–84` only recognizes the
old traversal. At line 133 it expects 4 queries, one selection and one chain
read; run 9 observes 6 queries, two selections and zero *recognized* chain
reads. Zero is a broken meter, not proof that no inheritance was read.

One Luna session changes this meter and
`tests/qa/integration/context-fixture.ts:45–73`'s missing-chain fault injector
to recognize the current `SELECT ?revision ?base ?depth` pinned-hop query
(`services/main/src/modules/context/interpretation.ts:185–199`). The injector must
match the requested pinned revision, fail exactly that hop, and preserve
`maxResponseBytes` when forwarding calls.

Expected current bounds: consumer samples at 1/4/16 consumers have queries 6,
selection rows 2, chain calls/rows 2. An explicit Context at depth d has
queries `2*(d+2)`, selection rows 0, chain calls/rows `2*(d+1)`; depths 0/4/8
give queries 4/12/20 and chain calls/rows 2/10/18. Keep the depth admission
limit and prove consumer growth does not alter these counts. These numbers
describe two bounded passes; do not make the contract require an arbitrary
population-independent constant for growing inherited depth.

Proof: growth Context file plus grouped search's missing-chain case at
`search-grouped-native.test.ts:291–294`. Changing a meter without making
that negative case actually inject the fault is insufficient.

### Grouped native fixture Definitions

**Cause:** fixture supplies arbitrary property Definition identifiers after
`b77c9bbc9` made relation Definitions exact native revisions. Owner Kernel;
B; no native build. Candidate IDs SEARCH01/04/10.

The first and Chinese cases fail before any grouped count assertion:
`tests/qa/integration/search-grouped-native.test.ts:138` and `:598` call
their Statement helpers at `:123` and `:584`, expecting 201 and receiving
400 `invalid_request`. Fixture property references at `:107–120` and
`:563–575` use `/definition/hair-color-v1` and `/definition/gender-v1`.
`services/main/src/modules/statement/qualification.ts:437` now admits
exact native Definition references.

One session authors those two property Definitions with the existing
`changeSemanticComponent` owner, uses the returned component as predicate
and immutable revision as relationDefinition, and grants semantic reads to
the actors used by these cases. Follow the sealed, native fixture setup in
`tests/qa/integration/statement-qualification.test.ts:59–78`; do not add a
raw RDF seed. Retain the existing opaque Context entry references where
they remain supported; do not expand the change to a semantic migration.

Also update line 177's acceptance batch detector from
`VALUES (?statement ?wantedGlobalSlot` to the current
`VALUES (?statement ?wantedKind ?wantedGlobalSlot ?wantedLocalSlot)` in
`services/main/src/modules/statement/read.ts:762`.

Proof: all grouped positive assertions, fact/support/participant/Work/
occurrence grains, two overlapping occurrence result rows without duplicate
fact or support counts, Chinese text+rating+Statement join, and real
missing-chain refusal. Count/facet behavior is not yet shown defective:
`grainIds` at grouped query lines 81–87 deduplicates the explicit grains.

The disclosure case has another cause:
`tests/qa/fixtures/reference-disclosure.ts:125` writes through `/rezics/update`,
which returns 404 on this product-only stack, reached from grouped line 371.
This is a harness seed assumption owned by Kernel's G-1630/G-1636 raw-seed
migration. Hand it to that owner; do not add another fixture write endpoint
or independently classify the same seed mechanism. Green grouped IDs depend
on that migration as well as the Definition and meter corrections.

### Current classification fixture through the existing owners

**Cause:** obsolete fixture writer, retired by `392c629b6`.
`classification/decision.ts:234–238` intentionally cancels every new legacy
admission while retained receipts still replay. Owner Kernel; B fixture
migration; no native image build. IDs SEARCH07/19 and the scale IDs, also
CTX02/03 and WORK03 in the oracle.

Run 9's scale initial shard reaches cancellation at line 442;
`tests/qa/integration/public-selection-oracle.test.ts:248` reaches the same
writer through its helper at lines 202–214. Do not restore the retired
ClassificationApplication/ClassificationDecision mechanism.

One session adds a small shared fixture helper using the existing owners:

1. Create a real public SemanticContext with one entry whose target is the
   proposition's concept, relation is CLASSIFIED_AS and definition is the
   proposition's pinned sense revision.
2. Record a resource Statement with MainVersion subject, CLASSIFIED_AS
   predicate, CLASSIFICATION_PROPOSITION_PROFILE relationDefinition,
   concept resource value, empty applicability, and **explicit Context
   interpretation** pinned to that Context revision.
3. Cache the support Statement/meaningKey per MainVersion+sense; decide its
   **qualified-fact** target with support IDs, the existing global/Realm
   acceptance context, expected head and proper Access admission. Return
   the Statement decision receipt's immutable revision for subsequent CAS.

The expected meaning is defined in `classification/resolve.ts:164–180`;
the search resolver already consumes that qualified-fact decision. Migrate
scale's setters at lines 429–439 and 661–669 and the oracle's helper.
Preserve fallback, Realm overrides, accepted/rejected/deprecated decisions,
CAS, public selection, author changes, paging, mute and fault assertions.
Do not add another production classification adapter or wait on G-1618.

Static admissibility was checked: `qualification.ts:513–519` has the
CLASSIFICATION_PROPOSITION_PROFILE special case; Context entries admit
the pinned HTTPS sense reference; explicit interpretation uses the Context
resolver in `statement/graph.ts:192–195`. MainVersion has the native subject
type required at graph line 295. **Do not use interpretation kind definition
with a ClassificationSense revision**: `qualification.ts:623–628` requires
a retained native InterpretationDefinition for that path. End-to-end QA of
the new fixture remains the implementation session's proof obligation.

Run both scale and oracle together and alone after migration. Any other
classification fixture using the same retired setter is a proposed follow-up
to this shared helper, not an independent production writer.

### Candidate overflow bootstrap

Standalone `20261011t072632-f3e00f` reproduces
`tests/qa/fault-recovery/search-candidate-overflow.test.ts:58`, expected
200 / observed 503. Its fresh structured log establishes
`main.route.dependency_unavailable`, DatabaseError `42P01` (undefined SQL
relation), trace `824ca2a16a5e3105bb9cee96d394ddb9`, at 07:27:12.888Z;
`main.realm-directory.refresh` has the same SQL code/trace immediately
afterwards. This is **not evidence of a native text qualification refusal**.

The self-managed test starts storage and initializes RDF at lines 29–38,
then supplies an Access pool at lines 39–42 without applying owner SQL
migrations. Its route uses real default SQL dependencies. A supported
bootstrap correction and the exact first SQL dependency are specified from
the source trace below once the investigation is complete. Owner Kernel;
B harness assumption; no native build; candidate IDs SEARCH02/10. Preserve
512 candidates => complete empty 200, actual Lucene count 513, and the
513th candidate => typed 422 budget outcome. Do not increase the candidate
limit or seed missing SQL tables individually.

### Private original source fixture

**Cause:** synthetic edit admission and missing Access owner after
`8a4a1cd76` required the original editor's admission. Owner Kernel; B;
no native build. IDs SEARCH11/12.

`tests/qa/integration/private-search-native.test.ts:476` raises
`exact private source is unavailable`. Its inner cause is
`Access admission store could not be reached` from
`services/main/src/modules/contribution/history.ts:562`, wrapped by
`search-private.ts:107`. The fixture environment at lines 118–119 lacks
`accessAdmission`; `editDraft` at lines 171–174 dispatches a synthetic
admission. Production supplies temporal Access at `composition.ts:270`.

One session attaches `accessAdmission: access` and makes editDraft grant,
register and claim the real `contribution.edit` admission. Use
`private-original-source.test.ts:74–95` as the existing supported pattern.
Keep exact original source validation, stale-send withholding, expiry,
recovery fence, and durable read receipt checks. Public search must still
exclude private bytes. Do not relax the production Access check.

### Deferred Content projection observations

**Cause:** stale rejected-promise expectations after `8e7740c9f` introduced
independent failed-target retention. Owner Kernel; B; no native build.
IDs SEARCH03/19, subject to the other ID dependencies.

`tests/qa/integration/content-publication-native.test.ts:143` expects a
rejection. `services/main/src/modules/content/relay.ts:402–410` catches the
missing-eligibility failure and returns `deferred` with retained pending
coverage. One session changes the test to assert deferred, completed cursor
still 2, scan advanced to 3, and the pending target retained. The public
read must remain unavailable; after admitting eligibility the existing
retry at line 170 must project and close the coverage gap.

The same session covers `content-eligibility-order.test.ts:181–185` and
`:223–227`. Its relayTo helper now reports its own high-water failure
instead of propagating the old inner exception. Assert deferred/scan/
completed/pending state directly and preserve public read refusal and
superseded/recovery checks at lines 239–246.

Its stale-worker proxy at lines 206–217 must intercept `command`, not
`commandWithReceipt`: relay uses `env.fuseki.command` at line 330 following
`c55dbd5ac`. Prove the intended v3 interleaving happened before asserting
that the stale worker cannot replace the current body. A changed expectation
without repairing this injector would remove the concurrency proof.

Launch's `tests/qa/integration/media-production.test.ts:35` is a related
observation correction: expects 5 queries, observes 6 after `493b7ebdc`
added the anchor ASK (`relay.ts:345–366`). Launch should assert exactly one
bounded anchor read and no body/projection write. This is needed for
SEARCH15; coordinate the explicit file with Launch rather than changing it
under an unrelated claim.

### Crash scenario pins a generation too late

**Cause:** stale pin placement after `c45b6d99b` began fencing changed
Content heads. Owner Kernel; B; no native image build. IDs SEARCH15/OPS16,
with the additional media dependency for SEARCH15.

`tests/qa/fault-recovery/content-projection-crash.test.ts:170` calls
`assertPublicTextReady` after replacement publication at line 147 and
eligibility at line 162, before relay. Native
`SearchDeltaJournal.java:727–737` marks the affected units and lines
849–851 reset qualification. Refusing this generation is intentional and
predates the G-1584/G-1600/G-1613/G-1617 startup changes.

One small session moves the pin immediately after the successful restarted
old-body query at lines 114–116, before authoring the replacement. Assert
public-text refusal after the replacement heads and before relay. Keep
both snapshot-moved checks at lines 173–174, the TDB2/Lucene split-commit
fault, both old/new phrase refusals, offline rebuild, restart and later
success. Do not requalify the changed heads merely to obtain the old pin.

### Erasure rebuild replay identity: confirm before editing

**Probable cause:** stale original physical receipt identity after rebuild;
the swallowed runtime refusal has not yet been established. Owner
Trust-ops for retained-erasure reconciliation (G-1634), with Kernel native
receipt evidence; provisional B fixture correction, no native build if
confirmed. IDs SEARCH08/20/WORK10/OPS10.

`tests/qa/fault-recovery/erasure-search-rebuild.test.ts:257–266` completes
rebuild and verifies kept/replacement/unpublished results. Its new
zero-position replay at line 273 omits the rebuild job identity, then
fails at line 274: `replay stopped before Content owner cut`.

`relay.ts:33–38` uses original projectionIdentity unless passed `rebuildId`.
Rebuild intentionally creates new MatchUnits and fresh receipts.
`CommandService.java:986–998` replays original receipts through
`SearchDeltaJournal.java:474–490`, which refuses absent original physical
units/source pins. `services/main/tests/content-projection.integration.test.ts:329–370`
already asserts that a rebuild needs fresh delivery receipts. The product
adopts completed rebuild coverage at `rebuild.ts:1045`.

First capture the pending target and native refusal in a focused reproduction.
If they establish this identity mismatch, pass the completed `job.id` to
the separate verification replay, prove it reuses the rebuilt receipts and
does not change graph/body state, and retain superseded/projected coverage
and the later erasure-during-rebuild refusal. Do not change the physical
original-receipt qualification rule. If a different deferred failure is
observed, re-specify from that evidence. SEARCH20 also needs G-1634's
erasure-restore work; do not edit its retained fault files in a Kernel task.

## Idle public deadline: evidence before a remedy

The four reported idle breaches are a defect against the existing 1,500 ms
budget (`search-readiness.ts:34`): one each in UTC hours 00 and 02, then
06:49:13 and 06:51:16 on 2026-10-11. The last trace IDs are
`bc9583868a780cafd876517aa545b376` and
`67274b426ca32997630081d10324f4a9`. Program reports no workers/QA then,
with six subsequent 200 responses around 0.3 s. That is incident evidence,
not a 200-request percentile sample.

**No native phase has been causally tied to those traces.** Read-only Docker
metadata confirms `kernel-g1584-fuseki` exists (created
2026-10-10T01:36:18Z). It was not mounted, restored or changed. The current
dev Fuseki started at 2026-10-10T17:00:57Z and returned no retained records
for 06:48:45–06:51:45. Log rotation is plausible, unproven. Current logs show
occurrence discovery at 07:24:17; that does not connect it to the incidents.

### What code establishes

| Phase | Evidence | What it does and does not establish |
| --- | --- | --- |
| Ranked reader opening/parsing | `FilteredGraphTextIndex.java:318–364` | The native one-second timer starts after opening/parsing; those phases consume Main's budget outside that timer. Their actual incident duration is unknown. |
| Delta proof readers | `SearchDeltaJournal.java:572,604,988,996` | qualifiedProof(-1) proves twice; each proof opens two committed readers. Avoidable work exists; its latency is unmeasured. |
| Recovery audit | `SearchDeltaJournal.java:146–157,321–397` | Whole-generation audit holds the writer monitor. Public reads do not take that monitor; a direct read-lock claim is unsupported. |
| Post-commit qualification | `CommandService.java:933–956` | Writer epoch remains odd through qualification; concurrent public searches may wait. No historical incident overlap is available. |
| Occurrence discovery | `label-index-worker.ts:10–16`; `label-index-backfill.ts:38–49` | Every-second LIMIT-1 discovery can still inspect the entire active population when no pending work exists. |
| Occurrence placement batches | `OccurrenceLabelIndex.java:140–151`; `label-index-backfill.ts:78` | Each 64-write batch rescans/skips its completed prefix; visited records are unbounded by the write limit, under a 60-second command. |
| Schema rebuild | `CommandModule.java:72–88`; `OccurrenceTextSchema.java:33–75` | Runs before HTTP admission; no periodic idle schema-rebuild call was found. |
| Supported TDB2 compaction | `compact-tdb2.sh:28–29,54`; `fuseki-owner.sh:21–24` | Repository compactor refuses a live owner. No repository periodic compaction invocation was found. |
| Lucene merge | No incident-phase evidence | A plausible I/O contributor requiring instrumentation, not an established cause. |

The rustfs scanner is Program's scope and is not a Kernel remedy.

### Session: bounded phase evidence (A prerequisite; native build)

Instrument the existing read-budget and native request machinery, not a
second owner for deciding search readiness.

1. `services/main/src/infrastructure/fuseki.ts:3–30`: extend
   FusekiReadBudget with the shared deadline and capped in-flight call
   diagnostics. Retain fixed call families (health, delta-proof, query,
   template-query), duration, attempt and read/writer-wait phase. Use at
   most eight history entries plus an omitted count. At timeout report the
   currently active call, even if it has not completed.
2. `search-readiness.ts:58–107` and `routes/search.ts:80–87,459,545`:
   enable bounded diagnostics for ordinary SearchRequestTimedOut errors.
   Existing diagnostics only run under REZICS_LOAD_RUN_ID. Do not copy its
   arbitrary exception-message logging into production: never log SPARQL,
   phrase, resource/actor identifiers, body, request payload or exception
   bodies. Propagate a validated remaining budget in the range 1–1,500 ms
   and existing traceparent (`packages/observability/src/runtime.ts:309–316`).
3. Native request entry and the above phase sites: track reader open,
   parse/rank/witness work, proof, text prepare/commit, qualification/audit,
   occurrence discovery/project and merge activity. Existing CommandWork
   covers commands only; queries and independent maintenance need evidence
   too. Reuse its duration conventions without putting readiness decisions
   in a diagnostic registry.
4. Emit a deadline snapshot while the request is still active. A completion
   log alone misses hung work. Bounds: 128 active requests, eight phase
   durations per request, eight active background phase entries, one event
   per request, <=2 KiB event, process emission cap plus suppressed count.
   Remove request state in finally; no dataset transaction/lock or inventory
   scan while producing evidence. Saturation must be visible. For a merge
   observed by sampling, report observed activity/interval, not an invented
   exact merge duration or causal conclusion.

Proof: extend `tests/qa/unit/search-budgets.test.ts:487–512` for ordinary
diagnostics, decreasing remaining budgets, bounded/redacted output, abort
and cleanup. Add `PublicSearchPhaseEvidenceTest.java` with controlled blocked
reader/proof/maintenance phases, one watchdog event before release,
concurrent requests, saturation, emission caps and cleanup. Extend
`SearchDeltaJournalStartupTest.java` for audit/recovery visibility. Logging
alone turns no SEARCH ID green; it supplies the evidence required for the
next A session.

### Session: fix the measured phase (A; native build for Java changes)

Choose one remedy from the measured phase. Do not dispatch this as a
speculative multi-mechanism architecture task.

- If reader opening dominates, share committed-directory readers with
  acquire/release lifetimes and refresh outside foreground reads. Preserve
  committed generation checks, source revocation/deletion visibility and
  writer-epoch fences. An IndexWriter near-real-time reader can expose
  uncommitted data and is not a replacement for this contract.
- If duplicate proof dominates, remove the duplicate identical proof for
  since=-1 and reuse its pinned reader. Preserve the final committed-cut
  fence and concurrent-write rejection.
- If parsing/rank/witness work dominates, start the timer before opening
  and parsing and carry one remaining budget through every phase. Returning
  a timeout sooner is not successful idle availability; measure 200
  responses again.
- If audit/qualification dominates, retain closed qualification until
  repair proves the authoritative cut. Add bounded/checkpointed scheduling
  or cancellation without removing the writer fence or exposing a partial
  generation.
- If merge I/O dominates, compare bounded concurrency/throttling against
  segment accumulation and read latency before selecting a configuration.

Tests must prove commit/rollback visibility, merge-only generation movement,
erasure/source revocation, reference lifetime during refresh, cancellation,
restart, concurrent qualification and absence of leaked foreground work.
Retain `g1048PublicSearchAvailabilityTest.java:121–171` label-lag/schema
availability checks. SEARCH18 directly exercises the request budget;
SEARCH15/20 still require their recovery scenarios.

### Session: occurrence maintenance work bounds (B until causally established)

Bound examined records rather than just 64 mutations or LIMIT-1 output.
Under the existing Structure owner, replace full-population idle discovery
and repeated completed-prefix scans with pending work and durable seek
progress; add deadline checks. One session must cover both discovery and
the resume cursor, or split those into two explicit steps if necessary.
Tests: large completed populations with no pending work, growing pending
generations, bounded visited records, restart, stale revision, text generation
change, removed placements and no lost work. This is not yet an established
fix for the four incidents. Defer wider scheduler/search redesign (C) unless
the phase measurements require it.

### Restore and percentile protocol

The retained 22 GiB volume is a pre-rebuild snapshot, not an interchangeable
current baseline. Make an independently writable copy through the supported
restore/clone procedure; never mount the shared volume writable or stop the
shared stack. Qualify/rebuild the copy through product operations and record
that preparation and the resulting native pin/generation. Preparation,
startup and readiness must meet the existing 10-minute budget.

On isolated Main/Fuseki, with ordinary relays enabled and no other workers or
QA load, send 200 sequential requests for one documented, stable public
query. Record every HTTP status, monotonic wall latency, trace and timeout
phase; separate cold-start preparation from the measured workload. Run the
identical workload before and after the chosen change, including enough
maintenance overlap to reproduce the diagnosed obstruction.

Report nearest-rank p50/p95/p99 over the 200 requests (sorted ranks
100/190/198), maximum, count of non-200 responses and count above 1,500 ms.
Report failed-request latency too; never drop failures and claim a passing
200-only percentile. Required outcome: 200 successful responses and zero
deadline breaches. A fast p99 cannot excuse an over-budget maximum.

| Measurement | p50 | p95 | p99 | Breaches |
| --- | --- | --- | --- | --- |
| Before, 200 idle probes | Not measured | Not measured | Not measured | Not measured |
| After, 200 idle probes | Not measured: no implementation | Not measured | Not measured | Not measured |

Active QA and other workers were present during this analysis. A sample now
would not reproduce Program's idle workload. G-1587's older rebuild-read
measurements (84 variants/346 MatchUnits; paged reads 571 ms, slowest 273 ms)
are not substituted for public-search percentiles.

### Primary mechanism references

- [Lucene 10.3.1 SearcherManager](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/search/SearcherManager.html): background refresh avoids penalizing foreground requests.
- [DirectoryReader](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/index/DirectoryReader.html): committed directory versus near-real-time readers and reference lifetimes.
- [IndexSearcher](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/search/IndexSearcher.html): search timeout scope does not cover reader construction.
- [ConcurrentMergeScheduler](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/index/ConcurrentMergeScheduler.html): background merges, producer stalls and I/O throttling are possible mechanisms, not incident evidence.
- [Pinned Jena 6.2.0 TextIndexLucene source](https://raw.githubusercontent.com/apache/jena/jena-6.2.0/jena-text/src/main/java/org/apache/jena/query/text/TextIndexLucene.java): writer construction and rollback must retain any selected instrumentation/configuration.
- [TDB2 administration](https://jena.apache.org/documentation/tdb2/tdb2_admin.html): upstream live compaction serves reads while holding writes; the repository further restricts its supported compactor to a stopped owner.

Any native implementation needs its pinned image built and qualified. The
Dockerfile's exact Maven line (`infra/jena/Dockerfile:15`) is:

```sh
mvn -B -ntp -DexcludedGroups=com.rezics.jena.ExternalFixture -DargLine=-Xmx384m -DforkCount=1 -DreuseForks=false package
```

ExternalFixture coverage runs separately through the focused native wrappers;
the excluded category is not proof of those cases. Run task gen/gen:check and
the affected explicit tests, Main typecheck, changed-directory type-aware
oxlint and ast-grep. A route-contract change also needs web:typecheck. Image
refresh of the shared stack remains Program's action.

## Reproduction ledger

All fresh QA uses `bun scripts/goal/goalctl.ts test <files>` with isolated
stacks. No shared backend or dev server was started. Artifacts after the
first run are under this worktree's `.temp/goal/qa/` and
`.temp/goal/qa-order/`. Fresh run results and unresolved causes are completed
below before handoff.

| File | Standalone QA | Observed first failure |
| --- | --- | --- |
| public-search-scale | `20261011t072252-d0d76b`, fail | :227, inventory 1 expected / 0 observed |
| search-grouped-native | `20261011t072448-34cce0`, fail | :138/:598 expected201/400; disclosure raw seed404 |
| search-candidate-overflow | `20261011t072632-f3e00f`, fail | :58 expected200/503; foreground SQL42P01 |
| growth-search-context | `20261011t072731-4745c8`, fail | stale cost meter at :133 |
