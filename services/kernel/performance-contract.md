# Kernel performance contract

This owner defines shared finite bounds and native growth measurement. Product operation costs remain in the owning
module's Cost section. [Performance acceptance](../../docs/goals/performance.capabilities.md) owns scenarios; the
[Performance Goal](../../docs/goals/performance.md) owns the outcome.

## Access domain composition

Decision: Access contract/core/application add no SQL, scan or extra statement. Native ports are the existing
Content avatar, Community realm-claim, Semantic identity, Library original-work and Kind-input, and Search
Kind-preparation producers; `admitOriginalWork` composes their declared vectors with
`HISTORY_ORIGINAL_LOCAL_ALLOWANCE` and `ADDITIONAL_ORIGINAL_TRANSFER_CONTROL`. Kind-audience overhead remains
`originalControlWork(0, 4, 13, statementBytes)`. Compact tests cover allow/deny and identity recovery; native
membership growth remains the bounded-work check.

## Work domain composition

Decision: Work contract/core/application add no SQL, scan or extra statement. Native SDK, SQL, clock, authorization,
receipt association and selected-admission adapters stay in `kernel-platform` and are bound by ordinary
`createKernel` / `createKernelRuntimeDefaults` / `server` / `worker` composition. Product module assembly lives in
`composition/work-modules.ts`. Compact `domain-composition` tests pin enqueue, registration, selected admission and
retirement against fake ports; the existing growth-work-client, selected-runtime-native, sdk-transaction-fence,
sdk-retirement-fence and growth-retention fixtures remain the bounded-work proof. Derived cost stays on the existing
admitted path.

## Finite bounds

Producer bounds are immutable, closed declarations over all nine axes. Composition uses overflow-safe sums, applies
the complete nested cost and enforces each declared ceiling before useful work. Conflicting declarations resolve
deterministically, and aliases are explicit. A declaration describes admissible work; it does not prove that work ran.

Count application-visible SQL, authorization and native work. Invisible database-engine MVCC housekeeping is outside
the application growth claim. A failed or unavailable native run is neither denial nor a product pass. Keep root,
module and native evidence distinct; use [verification](../../docs/development/verification.md#native-growth-evidence)
for evidence handling and check placement.

## Measured native units

Native engine units come from the harness `Cost` on every scale and repetition. `connections` and `slots` are counted
ceilings. A plan node without `Rows Removed by *` is omitted from the removed-row total.

## Growth checks

A growth check proves that the cost of one operation stays within a declared bound as its data grows; it counts rows,
shared blocks and statements, never time. An optional `byteBounds` can also bound `requestBytes` and/or `responseBytes`
using the same `constant`, `logarithmic` and `linear` rules. Its default slack is 0 absolute and 10% relative, and a
check can override that slack with `slack.requestBytes` or `slack.responseBytes`. A check without `byteBounds` is
unchanged. That 10% allowance covers about four extra bytes per value for integer text keys through scale 4096 when
the payload is at least 40 bytes. `bounds` remains required for rows, blocks and statements. `checkGrowth` admits the
complete configuration before `grow`, `warmup` or `operation`, keeps that snapshot for the run, and names the check and
field on configuration errors. Use `checkGrowth` from `test/support/growth.ts` with `seed` in `grow` to add rows between
scales. Grow both the total data and hot
partition, while keeping the operation's own neighbourhood fixed. Seed through production writes or bulk rows of
identical shape. Bulk seed transactions hold at most 500 rows and 1 MiB of serialized JSON across all table payloads,
including array framing; an individual row that cannot fit is rejected before insertion. The existing default slack is
2 rows or 10%, 4 blocks or 50%, and no statement slack. Other modules
import the public API from `test/support/growth.ts`. A check uses three to five scales, and its largest scale must not
exceed 4096.
`seed` snapshots the population definition and range before callbacks, uses captured callback references throughout
the call, and passes `finish` a detached `{ from, to }` copy; row-value snapshots remain owned by
`growth-seed-batches.ts`.

Every capture drains registered query and connection setup work, including tasks added while earlier work settles,
before restoring attribution on success or failure. If cleanup also fails, the initiating error remains the aggregate's
cause and cleanup failures remain available in its errors.

CTE buffer costs match producers and scans within nested native plan scopes. When a unique relationship cannot be
established, producer blocks stay in the total and the unmatched relationship appears in `Cost.limitations`.
Exported profiles keep those notes on each producing repetition and as the per-scale union `medianCost` already
forms; bound-failure attribution names the scale and repetition. Absence of the field is valid legacy evidence.
The notes explain unmatched pairing, not permission to subtract speculative work, and they do not change totals,
verdicts, eligibility or calibration.
A counted `limits` ceiling applies to every repetition at every scale and reports the unit, scale, 1-based repetition,
value and limit; counted `bounds` continue to compare medians.
Background limitations retain their native plan paths and identify the background plan index; a known
`backgroundPlanStatements` entry also identifies its statement occurrence, while plans without an occurrence remain
unattributed. Excluded background plans add no limitations.
Statement and occurrence row and block diagnostics use the same plan-cost projection as measured costs for each
included plan, sharing the capture plan-walk session so the aggregate node bound applies to both.
Grouped statement totals can differ from the capture when catalog or background inclusion differs.

Bulk-row seed values preserve finite JSON values, BigInt as decimal text, Date as ISO 8601 text and Uint8Array as
PostgreSQL bytea hex text. Each admitted row is owned as that encoded snapshot before later ordinals can mutate the
source row or nested containers. Traversal is limited to 64 nested levels and 100,000 visits per existing 1,000-ordinal
input window; raw byte arrays are limited to 524,285 bytes per ordinal. Unsupported, cyclic, too-deep or over-budget
values fail with table, row and column location before the SQL batch containing them is submitted.

Byte totals are recorded for each captured statement. Request bytes include the UTF-8 statement text whenever an
unnamed statement is sent and once when a named statement is first prepared on a connection, plus each parameter after
node-postgres prepares it: UTF-8 bytes for strings, the length for buffers, and zero for null or undefined. Response
bytes sum each returned data row's field payload before type parsing: null is zero, `bytea` (OID 17) uses its decoded
length, and every other text field uses its UTF-8 byte length. Command tags, notices, `auto_explain` output and the
harness's own `SET` statements are not counted. Foreground and background statement bytes are reported separately.
Capture validation decision: optional legacy metadata may be omitted; any supplied parallel arrays must be dense and
length-aligned, undefined plan owners remain unowned, and backend IDs are compared only when both sides are known.
`aggregateCaptures` must return every participating database capture; `mergeGrowthCaptures` concatenates optional
parallel evidence, including `planDatabases`, and rebases plan owners. Decision: the harness derives the costed
aggregate from those listed native captures through `mergeGrowthCaptures` and refuses a caller-built merge that drops
or replaces their statements, plans, bytes or attribution. Optional legacy fields stay omitted when every listed
capture omitted them. Database names are labels. The measured primary capture must remain among the listed captures;
unlisted secondary work is not discovered.
Growth checks support `step` and `series` rules. `series` is the default; `check.rule` selects an explicit rule, and
`GROWTH_RULE=series` also runs checks on the step baseline under series. Any other set value of `GROWTH_RULE` is a
configuration error. The only checks that use step by default are in `test/support/growth-baseline.ts`; each entry must
match a name declared directly on a `checkGrowth` call in its repository-relative test file. Finite generated names
from literal loop axes and literal conditional choices are recognized without running the fixture. Each entry records
the check and triage reason. When a baselined check is renamed, update its existing entry to its new declared name.
The list may only shrink, and new checks are never added. A listed check may not set `rule`
explicitly. When rows, blocks and statements all pass the series rule, the
harness fails with instructions to delete the entry. Owners remove an entry in the same change that fixes the fixture or
bound so series establishes the derivation; declare `indexProbes` for index-level block steps where needed. A growth
check fails only when it establishes growth above its bound. Each metric's series is judged on its running maximum, so a
decrease becomes a plateau and a decreasing or flat series passes. The check passes as compatible when that envelope of
the medians, within their uncertainty, fits the bound's family. It fails with `GrowthBoundError` only when the envelope
does not fit even when each scale takes any value in its median's distribution-free confidence interval (the
repetitions' minimum and maximum for five runs), widened by its uncertainty. Otherwise the verdict is inconclusive and
the check passes. A settle failure inside `checkGrowth` is recorded on its sample and makes a blocks violation
inconclusive. Failed statements with SQLSTATE 40001 or 40P01 make an established violation inconclusive unless complete
occurrence evidence independently establishes the same growth from successful foreground work. Accepted runs that still
use a new backend after four discards are retained but are not warmed evidence; without a complete warmed series the
verdict is inconclusive with reason `backends`. Successful statements
inside aborted attempts do not count as successful work. Byte metrics have no per-occurrence evidence, so retry-related
byte violations remain inconclusive; incomplete attribution is explained in `GROWTH_REVIEW`. Every inconclusive
verdict is in the report's `verdicts` and in one `GROWTH_REVIEW` stderr line, which performance reviews; it never blocks
the change under test. A cost that grows with data the operation does not need still fails. The series classifier and
shadow verdict use calibrated uncertainty from `docs/research/growth-uncertainty-calibration.md`: rows allow max(22, 0%
of the median), blocks max(9, 3%), and statements are exact. `slack` applies only to the step rule; byte metrics keep
their existing slack handling.

When any metric lacks complete unchanged-code calibration checks, `scripts/growth-calibrate.ts` prints named omitted checks,
missing runs, mismatched scales, unidentified or incompatible measurement identities and ineligible evidence to stderr, then exits nonzero without reporting fitted uncertainty, coverage or classifications.

For a logarithmic or linear blocks bound, `indexProbes` may declare the positive number of index descents one run
makes into growing relations. The blocks series may then include a non-decreasing staircase from zero, gaining at
most `indexProbes` blocks between consecutive scales. This models a depth transition for a fixed set of indexed
probes: B-tree and GiST fanouts exceed the harness's largest scale ratio, so one descent gains at most one level per
scale transition. The allowance can hide at most `indexProbes` blocks per step. A constant blocks bound rejects this
option because it is a bound to correct for growing indexes, not a discretization allowance.

Each measured session in the instrumented `pool` and `openPool` connections pins `max_parallel_workers_per_gather = 0`
and `jit = off`, then sets `work_mem = 4MB`, `random_page_cost = 4`, `effective_cache_size = 4GB`,
`effective_io_concurrency = 16` and `default_statistics_target = 100` explicitly. The fixed defaults keep container
configuration from changing a query plan; disabling per-query parallel workers also keeps shared worker availability
from changing the work counted by a capture. `admin` connections are for setup and assertions and are not measured. A
test can still use `SET LOCAL` for a planner option inside its transaction.

Use `includeBackends` for captures spanning multiple connections; it records the backend PID on every statement and
plan so reports can retain connection identity.
`captureWithFoldedCost` and `checkGrowth`'s `captureMode: 'cost-folded'` run one complete caller through that same
attribution, drain and transaction lifecycle while retaining bounded occurrence costs and plan provenance. The result
is a distinct `CostFoldedCapture`: it omits raw plan documents and marks occurrence diagnostics as cost-folded.
Multi-database `aggregateCaptures` is rejected during check admission for this mode; scalar profiles and growth
violations use the retained summaries.
Each captured statement is also an occurrence: one execution of a client statement, including failed executions.
The harness attaches that occurrence at node-postgres's wire dispatch boundary: simple queries at `Connection.query`,
and extended queries at `Parse` or `Bind`/`Execute`, including named prepared statement reuse. It retains custody
through `ReadyForQuery`, so promise or callback completion order cannot move a plan to another queued query. Plans,
including nested trigger and function plans, belong to the dispatched producer even when their Query Text matches a
later queued client query. SQL text is report data, never occurrence identity. Queue operations and per-capture plan
association process statements and notices in linear time; pending wire state is bounded by each client's outstanding
queries. Growth reports keep these ordered per-run records in `occurrenceRepetitions`, with foreground and background
statement lists kept separate. Use these records for checks that must prove the cost of each attempt, such as an
aborted transaction and its successful retry. `statementRepetitions` and grouped statement attributions remain useful
for overall profiles; they combine matching SQL across runs and must not be split by attempt. When a capture supplies
`planStatements`, grouped attributions charge each included native plan to that owner occurrence's client statement,
including nested trigger and function plans whose Query Text matches another client query or no top-level statement.
An explicit undefined owner stays ungrouped. Grouped attributions remain foreground-only. When `planStatements` is
absent, grouping still matches each document's Query Text.
Checks may declare `attempts: { commands }` to count top-level transaction attempts per backend. Reports retain
inclusive statement, row and block totals and the failed-statement SQLSTATE ledger, while also listing committed and
aborted attempts by SQLSTATE for each scale and repetition. Attempts add evidence and never replace the universal
growth verdicts: inclusive rows, blocks, statements and declared byte metrics always use the check's selected rule.
Recorded `40001` or `40P01` failures make an established violation inconclusive unless complete successful foreground
occurrences independently establish it; retry work remains in inclusive costs and reports. Retry-affected byte
violations remain inconclusive because bytes have no per-occurrence attribution. Per-execution row and block costs
remain in `occurrenceRepetitions`; when at least three scales have measured executions, the most expensive successful
committed or autocommit execution at each scale is judged against the same bound. Missing executions are not zero costs,
and fewer than three observed scales remain diagnostic evidence rather than an insufficiency failure. Retry-affected
attempts that cannot be separated from a per-execution violation are explicitly reported as inconclusive. Changes in
retry incidence are retained in the attempt ledger and profile but do not themselves fail a growth check. Committed
attempts must have the same statement count across scales and repetitions, and aborted attempts may run no more
statements. Checks without `attempts` keep the same inclusive verdicts without the additional transaction ledger.
Growth checks can also declare `counted` units: `read(value, scale)` extracts per-run integer counts, while `limits`
sets a ceiling at every scale and `bounds` sets a growth rule; reports include each unit's median and measured values.
Configuration and each callback result admit at most 32 unit names, 80 UTF-8 bytes per name and 2,560 unique name bytes
before those dictionaries are sorted or retained; undeclared diagnostic units within that budget stay in the sample.
The admitted name index is reused for slack membership, missing-unit checks and the report. A missing counted unit
remains unreported.
The harness provides `connections` as the number of distinct backend processes used by the operation when
`includeBackends` is enabled. The filtered-list plan counts live in [Filtered lists](../../docs/filtered-lists.md#cost),
under Cost.
Reylo freshness probes (statements selecting `fresh_table`, `fresh_column` and `fresh_type` with a catalog-only plan)
remain counted as catalog statements. The harness adds one finite allowance per distinct non-catalog SQL text and
attributed backend for each 60-second cache window during the captured operation (one group without backend IDs),
matching `reylo@0.6.0`'s per-query cache interval and concurrent first use. Other catalog-only statements retain one
allowance per distinct non-catalog query text; a statement that also reads data counts in full.

A statement that fails still counts as a statement, in the operation's or the background count, and its SQLSTATE is
recorded in `statementErrors` or `backgroundStatementErrors`; reports list failed attempts by SQLSTATE. PostgreSQL
produces no plan for it, so its rows and blocks are not measured. Completed statements earlier in an aborted attempt
retain all their measured work; the harness assigns no estimated cost to a failed statement.

Statements in the operation's async context count toward its cost. A DBOS workflow counts as foreground only when the
capture associates it with a start from that operation's async context; every other workflow remains background
regardless of workflow-ID spelling. Workflows started by a schedule and their children, and loops started outside both,
are reported as background work. Background statement counts follow measured
wall time, while rows and blocks per bounded background statement are compared with its first observed value at every
later scale using the default constant-cost slack. Missing executions are skipped. Per-statement background row and
block costs first sum every included native plan that belongs to one captured occurrence and statement identity, then
take the high-water of those occurrence totals. Distinct occurrences stay separate even when their SQL matches.
Nested function and trigger plans keep their own statement identity so parent-inclusive native work is not counted
twice. Captures without `backgroundPlanStatements` cannot recover occurrence identity from SQL text; those plans are
summed by statement text as one conservative execution. Statements reading only DBOS
system relations remain reported, but their row and block growth is not bounded because `grow` does not seed DBOS
history; that history's growth is a production retention question, not a growth check result. A scale with no
applicable background statement is skipped for that bound.

Plans are collected only inside a capture: an instrumented connection runs auto_explain just for the statements of a
measured run, and seeding is never explained. Capture setting transitions use the same SQL classifier as the attempt
ledger, so a leading-comment commit, full rollback or rollback-to-savepoint still invalidates the cached explaining
state and the next statement reasserts auto_explain; unknown prepared text waits until its existing resolution
boundary. Each report sample carries `seeding`, the statements and rows written by
`grow` (every pool, `admin` included), the time of `grow`, the ANALYZE settle after it (`vacuumMs`), and total settling
time for that scale (`settleMs`); when `GROWTH_PROFILE` names a file, `checkGrowth` appends one JSON line per check
with the test file, check name, scales and each scale's `seeding`.
`trackGrow` drains statements already submitted on instrumented pools, including connection setup, before it copies
those counts and ends seeding, on success and on failure, and keeps the grow error as the primary failure. Seed
production-write concurrency inside `grow` is unchanged.
Native plan trees are bounded to 10,000 nodes and depth 256 (root depth 0); cycles, sparse children and invalid child
collections fail with their plan location. One cost or report traversal of a capture shares a 20,000-node envelope
with retained capture evidence entries and refuses a child collection before it would exceed remaining capacity.
These are evidence input limits, not growth verdicts.
Measured-run write discovery uses those same admitted EXPLAIN document envelopes and the native plan walk; a
ModifyTable without Relation Name fails at that node path, a missing Schema defaults to public, and malformed
documents fail at their location instead of omitting writes. Each write target keeps its schema, relation name and
the physical database of the captured plan as a relation identity; settlement quotes those components independently
and deduplicates exact identities. Ordinary `schema.name` callers remain on an explicit compatibility path. Strings
with quotes or more than one dot are refused as ambiguous rather than guessed. Native SQL text is not parsed to
recover names, and PostgreSQL's accepted identifiers are not narrowed.
The line also carries every repetition, relation sizes, the selected-rule `verdicts`, a shadow whole-series verdict and
any `settleFailures` recorded on samples. Each repetition may include `limitations` from that run; when any scale has
them, a parallel `limitations` array is the union across that scale's repetitions so a median-selected run is not
treated as the only source. The reader retains both fields and does not treat older records that omit them as corrupt.
Calibration uses only the numeric repetition series.
The line records terminal `eligibility` after background-growth, attempt-ledger and
counted-unit guards: `{ "status": "eligible" }`, or `{ "status": "ineligible", "reason" }` with that guard's message.
Inclusive growth-bound failures remain eligible. A missing field is eligible, so older profiles stay in calibration.
For a step check, the shadow verdicts are diagnostic; for a baseline check,
all three passing requires deleting its entry.
Each report sample also carries `repetitions`, the cost of every measured run in order, and `relationSizes`, the
`reltuples` and `relpages` of every relation the measured plans read at that scale.
`seed` skips settling inside `grow`, since `checkGrowth` settles right after.

Use `assertGrowthAccessPaths(checkName, report.samples, ['content.report', 'content.report_target'])` when checking
those Content report paths. The helper evaluates every repetition against the measured PostgreSQL relation pages
after settle. A sequential scan requires another path only when the observed relation footprint is strictly greater
than eight pages; at eight pages or fewer, the existing growth series remains authoritative for rows, blocks and
statements. This path rule does not discard repetitions, pin a fixed plan or exempt any measured cost. The helper
checks only requested relations observed in captured costs; it does not prove SQL capture completeness. Keep the
growth bounds, retained-plan coverage and usable-index requirements independent of this helper.

Declare the check's growth model by naming the relations, partitions and keys that grow with N in production
(subjects, content, history, receipts, outbox, write basis and the Access rows its authorization reads). Seed fixtures
with production row shapes, key distributions and fan-out so they exercise each declared axis at every scale, and
report their measured relation footprints. Do not inflate cardinality merely to force a plan. A relation whose
production size does not grow with N, such as definitions, roles or configuration, may stay at fixture size. Use
measured relation pages for the access-path rule; do not infer a footprint from rows, buffers or fixture width.
Relation evidence carries database, schema and relation identity; familiar keys remain when unique, and ambiguous
access-path requests require an explicit identity.
Relation metadata lookups use parameterized measured identities in chunks of at most 128; unrelated catalog entries
are not transferred.
Injected planner statistics do not replace seeding: they change only a plan's estimates, while a growth check
measures executed work (`docs/research/growth-check-plan-stability.md`).

Every scale is measured on backends already seen in a warm-up or earlier measured repetition; a repetition that
reaches a new backend is discarded as a warm-up up to four times per scale. If later runs still use new backends,
recovery stops: those runs keep their actual costs, occurrences and backend IDs and the sample records
`coldBackendExhaustion` with their accepted-repetition indexes. They are not warmed evidence. Selected verdicts use the
remaining warmed runs. When any scale has no warmed accepted run, every metric is inconclusive with reason `backends`
and one `GROWTH_REVIEW` line; that series neither fails nor passes as compatible. A warmed-only series that still
violates remains a `GrowthBoundError`.
Keep the default `warmups`. When the operation uses up the state it measures, pass
`warmup`, which runs the same code path on spare state (another probe, a fresh key) so the measured run is not the
backend's first. `checkGrowth` refuses fewer than one warm-up per scale. Every periodic job step needs its own growth
check on rows, blocks and statements. After each scale's `grow`, it settles the whole database
with ANALYZE, so planner statistics do not depend on autovacuum; seed in `grow`, not `operation`. Admission snapshots
the configuration and caps aggregate sampling work at 64 units before any hook:
`scales.length * (1 grow + warmups + repetitions + 4 possible cold-backend discards)`. A scale's `grow`, each
warm-up, each requested measured run and each possible cold-backend discard count once; `prepare` accompanies each
measured attempt. Existing callers peak at 45 units (three scales, five warm-ups, five measured runs and four
possible discards per scale, including one `grow` per scale). Defaults remain admitted even at five scales (55 units).
Excess requests fail as a `RangeError`; the harness never truncates requested samples. A `GrowthDatabase`
has one active capture: measured captures reject same-database nesting before the child callback runs. Explicit
`captureWarmup` captures record warm-up writes and permit nested captures within that warm-up, but cannot replace an
active measured capture. Captures on different databases can still nest. `checkGrowth` holds ownership of its database
across every scale and hook: another check on the same database rejects before its hooks run, while checks on
independent databases can run concurrently. Each settle waits until no other connection in that database holds a
transaction ID or snapshot older than the starting horizon, then runs
`VACUUM (INDEX_CLEANUP ON)` on target relations and verifies every nonempty relation page is all-visible. If pages remain
not all-visible, it repeats the horizon wait and vacuums up to two more times; later rounds use `FREEZE` and
`DISABLE_PAGE_SKIPPING`. The last round uses `VERBOSE` and retains PostgreSQL INFO and WARNING notices. If verification
still fails, the infrastructure error includes those notices, prepared transactions, replication slot horizons,
relation owners, and diagnostic details for non-visible blocks. A failing VACUUM reports the physical database from the
held connection or the admin URL and the target relation, without another admin checkout or a `current_database` query;
the original error is the cause, and a later client release failure stays subordinate. Settle enforces one absolute
`timeoutMs` deadline, defaulting to 30 seconds; it does not poll and rejects the legacy `pollMs` option. Expired work
retires only its checked-out admin connection, and a late checkout is retired when it arrives. Opening a growth database
disables autovacuum on non-catalog tables; an unscoped settle does the same for all such tables, including those created
after opening. Prior to each measured repetition, the harness captures writes from each warm-up, prepare hook, or
preceding run's ModifyTable targets, including nested trigger and foreign-key statements, and settles those exact identities without ANALYZE
in every database that run measured. Same-named relations in separate databases stay separate. Explicit settle targets inspect autovacuum and TOAST options only
for those relations and ALTER only tables that still require it. An empty target list still rejects a measured
transaction left open and does not inspect or write unrelated relation metadata. A missing explicit target still fails
at VACUUM with database and relation context. It also settles `dbos.workflow_status` when present. The optional `prepare(db,
scale, repetition)` hook runs as unmeasured capture after that settle and before every measured repetition, never
before warm-ups. Nested captures inside it inherit that custody. The harness tracks its writes and open transactions,
including on other instrumented databases, and settles the same boundary before measuring; prepare SQL is not product
cost. After every completed warmup and measured sample, including the last sample and related databases, it rejects
the check if that run's own transaction tokens remain open. The check does not depend on observing a ModifyTable. A
later unrelated snapshot on the same backend is a different token. The harness does not commit or roll back the
caller's work. A fixture that writes during warm-up, `prepare`, or a direct capture settles after that write and immediately
before the capture. Work captured inside `grow` is never settled. A fixture that measures outside `checkGrowth` calls
the exported `settle` API instead of issuing a bare VACUUM: bare VACUUM neither waits for older snapshots nor verifies
visibility
([growth bare VACUUM sites](../../docs/research/growth-bare-vacuum-sites.md)).

When a settle fails, moving table counters classify a concurrent writer, which the check must stop outside the
operation under the background-statements decision; static counters with a newer `backend_xmin` classify a snapshot
held during VACUUM, which the harness must release.

When a bound fails, `GrowthBoundError` identifies each failing three-sample window and its actual constant peak or
second-step comparison, with the observed and allowed growth. Relation and repetition context comes from that window
and labels each scale; each list shows at most five entries and marks omissions. The growth report also includes the
statements with the largest first-to-last-scale growth for each failing metric. Each statement line shows its normalized
first line, its value at every scale, and the plan node that used the most buffers (including its relation or index when
present). Statements that appeared in only some repetitions are listed as intermittent with their repetition
numbers. SQL literals, dollar-quoted strings, escaped string constants and `$n` parameters are replaced with `?` so
literal variants group together; quoted identifiers and leading SQL comments stay intact so comments can identify a
tagged statement. Unclosed quotes, unclosed dollar quoting, or a backslash in a non-`E` string stay as captured so
unsupported syntax is not treated as equivalent.
Set `GROWTH_PROFILE` to a file inside the workspace to collect profiles on local and remote check runs. Remote stack
runs forward its workspace-relative path and return the file with the result; earlier local lines are retained when the
returned profile is merged. Write failures are best-effort by default: `checkGrowth` warns once per destination and still
returns the growth report, so the growth verdict is unchanged. Each destination keeps its own warning.
Set `GROWTH_PROFILE_REQUIRED=1` when calibration must have the artifact; any other set value is a configuration error.
Required export applies only when `GROWTH_PROFILE` names a destination, and then a missing, oversized or incomplete JSONL
record fails as `GrowthProfileExportError` with that destination and the original error. Each appended line is encoded in
one pass before write: at most 64 nested containers, 1,048,576 visited objects and enumerable slots, and 2 MiB of UTF-8
including the trailing newline, matching the reader's physical line limit. Getters and `toJSON` run once; over-budget,
cyclic or unsupported values fail without a partial line.
The `GROWTH_PROFILE` JSON line includes `statements`, with each scale's complete statement list and median rows,
blocks and count across measured repetitions.
Newly exported lines carry `measurement` `{version, indexProbes, source}`: version 1, the check's index-probe
declaration (0 when omitted), and the local `git rev-parse HEAD` revision. Git is the only source identifier; it is
omitted when unavailable. No runtime pricing or external attestation service is used.
The reader admits at most 64 MiB of total UTF-8 input, 250,000 physical lines, and 50,000 nonblank records per read;
each physical line is limited to 2 MiB. It rejects excess input and reports the source and line where a limit is crossed.
Incomplete-check missing-run diagnostics admit at most 8,192 check×run pairs (calibration's 256 checks × 32 runs) before
those lists are allocated, counting empty sources as runs; excess expansion is refused with the check identity and that
capacity. Ordinary complete groups and smaller omitted groups keep their identities, occurrence, ordering and missing
runs.
The importer then admits at most 256 repetitions per point and 3,145,728 expanded scalar/footprint values (calibration's
4,096 points × 256 repetitions × 3 metrics) before mapping repetition groups, relation footprints or per-metric tensors.
It counts every parsed entry, including later-omitted checks, against one budget rather than resetting per metric, and
refuses excess work with the run, line and scale. Supported native sampling (at most 15 repetitions, three to five
scales) and valid 256-repetition points within that aggregate remain admitted. Calibration retains model fitting.
Calibration then admits at most 256 checks, 32 runs per check, 256 repetitions per point, 4,096 check×run×scale points
and 2,048 leave-one-run-out folds, covering the documented five-run sample and the harness sampling maximum of 15
repetitions with headroom. Classification uses the same per-point repetition capacity. It indexes per-run medians and
spreads without spreading values into engine argument lists, and refits each omitted run from those statistics instead
of rescanning repetitions. Excess work is refused with the check or series size and the supported capacity before
traversing, copying or sorting oversized numeric evidence; it does not return a partial fit. Profile byte, line and
importer expansion admission stay with the importer.
Calibration CLI loading applies that same total-byte budget to observed file sizes before retaining contents, counts a
file that grows after its size is observed against the budget, and closes every opened profile on failure; file-level
budget and change errors use line 1 of the run basename because loading does not parse JSONL.
Calibration combines a file/check/occurrence only when every run is identified v1 with the same source revision,
indexProbes, growth bounds and scales. Unidentified legacy lines and mismatched identities are omitted with per-run
diagnostics and keep their raw shadow and relation records.
Ineligible runs are also omitted and report each run and its reason.

Each measured repetition starts from a settled state. Warm-ups and repetitions may write rows, including through
triggers; the harness settles every relation written by the previous run before measuring the next one. An operation
that leaves its own transaction open fails the check at that sample, including the last. Checks should use fresh keys
where production does, and declare any intentional repeated writes in their growth model.

A module README cites a growth check by its test file and test title and says what grows and what stays fixed. A
source-only scan matches generated titles iteratively against their fixed text, requires at least 12 fixed Unicode
characters and nonempty substitutions, and never executes test code. It does not restate the scales, which the test
owns and may change. Test titles do not name scales either, so a scale change does not break a citation.

Each Cost-table validation admits one source and title snapshot per canonical cited path. It reads at most 1 MiB
per source and 8 MiB of unique cited source bytes in total, before allocating the snapshot, and names a source
that is missing, unreadable, changed during the read, or larger than those limits. Ordinary test sources stay
within those limits. Snapshots are not kept across validations.

Product code sets no planner method settings (`enable_seqscan`, `enable_bitmapscan` or any other `enable_*`).
PostgreSQL documents them as a crude, temporary way to influence a plan. A sequential scan of a small relation is
bounded by that relation's size, and the planner moves to an index as statistics follow growth. A pin would make
a growth check measure the pin instead of the declared growth model. When a check sees a scan of a relation that
grows in production, seed that relation in the check; when a production plan is wrong, fix statistics, indexes or
the query shape.

## Native growth capture memory

Decision: keep the shared capture cap at 32 MiB; folded captures release each eight-times notice reservation only
after bounded cost and provenance summaries are charged, while raw captures retain native documents.

Each capture has hard caps of 20,000 evidence entries and 32 MiB of charged bytes shared by foreground and background
evidence. Entries count statement text, retained statement error messages, native notice envelopes and plan nodes
visited by the bounded plan walker. Statement and error strings use their UTF-8 byte size; native plan notices are
charged at eight times their UTF-8 size to account for parsed-object expansion. A native notice is limited to 1 MiB,
and its byte charge is reserved before JSON parsing. A focused capture may tighten these caps but cannot raise them.
Exhaustion fails the capture after its operation and tracked queries drain, so no partial capture or cost is returned.
