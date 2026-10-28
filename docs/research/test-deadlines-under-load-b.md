# Integration-test deadlines under CPU contention

Research date: 2026-10-28. Kernel reviewed: `cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f`.
This report is evidence and an implementation recommendation, not an adopted kernel contract.
Sources were read without installing, building or executing reference-project code.

## Recommendation

Adopt three complementary controls: a bounded, startup-only multiplier for **ordinary functional-test execution
budgets**; an independent clock-and-timer interface for deterministic deadline logic; and a reserved, unscaled
PostgreSQL test group plus latency checks. Keep admission control and retain one diagnostic rerun with its initial
failure visible. These choices combine the environment-specific allowances in PostgreSQL and Chromium, the clock
interfaces in CockroachDB, and nextest's resource scheduling and explicit flaky results. They do not establish that
any upstream project globally multiplies its production request deadlines. [PostgreSQL slow-host guidance][P1] [Chromium multipliers][C1] [TimeSource][R3] [nextest weighted tests][N2] [nextest strict flaky results][N3]

Proposed configuration: `KERNEL_TEST_DEADLINE_MULTIPLIER`, default **1**, accepted integer range **1–10**. Have the
kernel check explicitly select **4** for ordinary database-backed functional tests, and **1** for deadline semantics,
configuration assertions and latency tests. Four is a starting experiment, not a measured capacity guarantee or a
number inherited from another project. Production must use factor 1; reject a non-1 test policy outside the explicit
test bootstrap. Adopt the experiment only with the controls and measurements below. Chromium's once-only timeout
initialization is the relevant precedent; its particular sanitizer multipliers are not a calibration for Bun. [Chromium multipliers][C1] [TestTimeouts initialization][C2]

## Verified mechanisms and their limits

| Mechanism                             | Primary-source findings                                                                                                                                                                                                                                                                                                                                                            | Meaning for the kernel                                                                                                                                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configurable test wait allowance      | PostgreSQL documents raising `PG_TEST_TIMEOUT_DEFAULT` above 180 seconds on slow hosts to prevent load-induced timeouts. TAP utilities initialize the default from the environment. [PostgreSQL slow-host guidance][P1] [TAP initialization][P2]                                                                                                                                   | A test environment can need more waiting time without changing a production service objective.                                                                                                                                                                                  |
| Regression/isolation watchdogs        | PostgreSQL's isolation runner waits 360 seconds by default; it cancels a blocked step after twice `PG_TEST_TIMEOUT_DEFAULT`, and exits after four times if cancellation fails. [isolation cancellation][P3] [isolation default][P5]                                                                                                                                                | Distinguish completion allowance, cancellation and final watchdog. This is not evidence that every SQL regression or server `statement_timeout` uses the variable.                                                                                                              |
| Known-environment multipliers         | Chromium's `TestTimeouts` uses 1 normally, 2 for generic ASan/TSan, 6 for non-ChromeOS MSan, and 3 for coverage; platform branches differ. The comments identify instrumentation and startup overhead. Initialization applies the multiplier to test timeout values and command-line overrides. [Chromium multipliers][C1]                                                         | Centralize a documented test policy; do not sprinkle changed literals throughout production code.                                                                                                                                                                               |
| Condition polling with race allowance | CockroachDB `SucceedsSoon` polls a condition with exponential backoff: 45 seconds normally, five times that with race detection or deadlock detection. Failure captures a goroutine dump. [SucceedsSoon][R1]                                                                                                                                                                       | Poll readiness rather than sleep a guessed duration. Retrying a condition does not authorize retrying a non-idempotent command or discarding a functional assertion failure.                                                                                                    |
| Race/stress runner policy             | CockroachDB's Bazel race profile sets 1200/6000/18000/72000-second target timeouts, 20 times Bazel's normal classes. Its stress path repeats tests, defaulting locally to 1000 runs; CI stress selects the CI timeout profile and lower remote-execution priority. [CockroachDB race profile][R2] [CockroachDB stress runs][R5] [CI stress policy][R6] [Bazel timeout classes][B1] | Race scaling, repeated stress and priority are separate controls. The inspected `SucceedsSoonDuration` checks race/deadlock, not the stress flags; these sources do not establish a universal stress multiplier for production deadlines. [SucceedsSoon][R1] [stress flags][R7] |
| Named operation budgets               | Kubernetes e2e has a `TimeoutContext`: for example 2-second polling, 5-minute pod start and 15-minute slow pod start. It copies configured defaults after flag parsing and uses them to configure Eventually/Consistently; selected startup waits have CLI flags. [e2e operation budgets][K1] [e2e polling configuration][K2] [copied timeout context][K3] [e2e startup flags][K4] | Keep readiness budgets named and scoped to operations; do not use a single giant sleep everywhere or infer a global production timeout multiplier.                                                                                                                              |
| Runner size/timeout classes           | Bazel assigns whole test targets short/moderate/long/eternal limits of 60/300/900/3600 seconds, with defaults from small/medium/large/enormous size. Timeout and resource size are independently selectable. It allows `--test_timeout` for known slow conditions and warns about overly generous allowances. [Bazel timeout classes][B1] [Bazel warnings and retries][B2]         | A test watchdog is separate from the application's 2-second request budget. Raising the watchdog alone cannot prevent the application rejecting the request.                                                                                                                    |
| Outer deadline exposed to tests       | Go `go test -timeout` defaults to ten minutes per test binary. `T.Deadline()` exposes that binary deadline; the alarm uses `time.Now().Add` and `time.AfterFunc`. [Go test timeout][G1] [T.Deadline][G2] [Go alarm][G5]                                                                                                                                                            | An outer timeout can bound setup and cleanup. It is not a per-request allowance or a reason to renew a request's remaining time.                                                                                                                                                |
| Slow reporting and final termination  | Nextest can mark a test slow at one period and terminate after a configured number of periods; the example is 30 seconds and four periods, with an additional termination grace period. [nextest slow timeouts][N1]                                                                                                                                                                | Record a slow operation before its hard limit. Keep a finite outer watchdog that accounts for setup, the largest scaled work budget and cleanup.                                                                                                                                |
| Admission and resource weighting      | Nextest `threads-required` reserves multiple scheduler slots for heavy tests; groups can serialize or bound tests sharing a service. Bazel supports a `cpu:n` reservation tag, with documented capacity limitations. [nextest weighted tests][N2] [nextest test groups][N4] [Bazel CPU reservation][B3]                                                                            | Count demand from the test process and PostgreSQL together; database isolation alone does not reserve CPU. A scheduler slot is admission accounting, not physical CPU isolation.                                                                                                |
| Quarantine/disabled-test inventory    | Chromium supports disabling flaky or broken tests through framework skips and expectation/filter files, with inventories to retain visibility. [Chromium disabled tests][C4]                                                                                                                                                                                                       | This can unblock a gate by dropping coverage; do not use it for required deadline semantics.                                                                                                                                                                                    |
| Explicit rerun/flaky policy           | Bazel retries can report `FLAKY` while counting the target passed; nextest marks successful retries flaky and can instead fail them with `flaky-result = "fail"`. Nextest defaults to zero retries. [Bazel warnings and retries][B2] [nextest strict flaky results][N3] [nextest defaults][N5]                                                                                     | A rerun can classify load sensitivity, but a green rerun is not proof that the first failure was harmless. Preserve both outcomes.                                                                                                                                              |

The shared pattern is to name the layer being protected: readiness/action waits, the whole test's watchdog,
application execution, and resource admission are separate controls. PostgreSQL and Chromium accommodate known slow
environments; Bazel and nextest keep outer limits and resource policies explicit; CockroachDB separates condition
polling from its clock abstraction. This supports a kernel policy with visible scope and independent regression
checks, rather than treating one larger number as evidence of acceptable latency.
[PostgreSQL slow-host guidance][P1] [TestTimeouts initialization][C2] [Bazel timeout classes][B1]
[nextest weighted tests][N2] [SucceedsSoon][R1] [TimeSource][R3]

### Clock injection and CPU time are different mechanisms

CockroachDB exposes a `TimeSource` with `Now`, `Since`, `Until`, timers and tickers, and a `ManualTime` implementation
whose advancement controls timers. Chromium's `TaskEnvironment::MOCK_TIME` controls delayed tasks and clock reads;
its documentation explicitly lists platform waits that remain real. These are concrete clock injection/virtual-time
mechanisms, rather than longer timeouts. [TimeSource][R3] [ManualTime][R4] [Chromium mock time][C3]

Go's `testing/synctest` advances fake time when all bubble goroutines are durably blocked and demonstrates checking
both sides of a context timeout. Its guidance excludes real networks and external processes; socket I/O is not a
durably blocking operation. `T.Deadline()` rejects use inside that fake-time bubble. Therefore a kernel test talking
to an actual PostgreSQL process cannot simply move all its clocks into virtual time. [synctest isolation][G3] [synctest timeout example][G4] [T.Deadline][G2]

**CPU-time deadline budgets were not found in the inspected timeout mechanisms.** Go's alarm and PostgreSQL's
isolation runner use elapsed-time machinery; Chromium scales durations rather than substituting CPU consumption.
Bazel's test environment even specifies unlimited `RLIMIT_CPU` alongside its separate test timeout. CockroachDB does
have `CPUStopWatch`, but it measures CPU on the current goroutine between Start/Stop, not the `SucceedsSoon` deadline.
This is a bounded finding about the cited implementations, not a claim that no project ever uses CPU limits.
[isolation elapsed time][P4] [Go alarm][G5] [Chromium multipliers][C1] [Bazel CPU limit][B4] [CPUStopWatch][R8] [SucceedsSoon][R1]

Inference: CPU accounting is useful to diagnose starvation, but is the wrong replacement for a kernel request
budget: a client awaiting PostgreSQL or a lock can consume almost no client CPU while its user waits indefinitely.
A monotonic elapsed clock would still count scheduler delays; it is not a CPU clock. Keep finite elapsed deadlines
and real database cancellation; use CPU measurements and resource admission to explain or prevent contention.
The recommendation follows the distinction between the real alarm, local CPU stopwatch and external-I/O fake-clock
limitations above. [Go alarm][G5] [CPUStopWatch][R8] [synctest isolation][G3]

Quarantine is also distinct from rerunning: it removes a known failure from a required gate. Chromium documents
skipping flaky or temporarily broken tests with `DISABLED_`, annotations or expectation/filter files, and discusses
collecting disabled-test inventories. That is concrete quarantine machinery, not evidence that suppressing deadline
tests preserves deadline coverage. [Chromium disabled tests][C4] Recommendation: do not quarantine kernel deadline tests; keep their unscaled
coverage required and report investigated failures separately. Nextest's option to fail even after a passing retry
is a useful model for visibility without suppressing execution. [nextest strict flaky results][N3]

## Kernel inventory and policy by deadline

The current implementation fixes an HTTP deadline at entry, propagates it through async context, and returns that
same value from `deadlineFor` while the request is live. Outside a request it creates `Date.now() + budgetMs`.
The README explicitly separates deadline time from the injectable domain/business clock. Preserve those semantics.
[kernel deadline scope][L1] [HTTP entry deadline][L2] [kernel time contract][L3] [domain clock][L21]

| Deadline or duration                                              | Functional-test policy proposed                                                                                                                                                                                                                                                                                                                                                                           | Required unscaled/deterministic coverage                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default command/request budget, 2000 ms; HTTP `requestDeadlineMs` | Scale a newly created workload budget once: 8000 ms at factor 4. HTTP entry must apply the policy too; changing only `deadlineFor` misses the entry path. Preserve the original absolute deadline in nested calls. [kernel deadline scope][L1] [HTTP entry deadline][L2] [production request constant][L4]                                                                                                | Factor-1 configuration tests plus fake-runtime exact boundary, propagation and exhausted-budget tests; reserved real-DB latency checks under the production 2000 ms budget.                                                                                                  |
| Auth barrier execution budget, 3000 ms                            | Scale execution allowance, to 12000 ms at factor 4, when starting work outside an existing request. Under a request, inherit its deadline; carry the absolute value across the Auth boundary. [kernel deadline scope][L1] [kernel time contract][L3] [barrier expiry][L5] [barrier execution deadline][L5b]                                                                                               | Expired-request denial and unchanged evidence/credential expiry. Never multiply JWT expiry, proof TTL or security freshness to make execution pass. The barrier separately checks proof expiry against authoritative/domain time. [barrier expiry][L5]                       |
| Commerce work steps, 5000 ms; membership authorization, 30000 ms  | Scale new work execution budgets to 20000/120000 ms. Preserve one deadline across each attempt/retry scope. Audit commerce's fresh post-provider recording budget, which currently constructs `Date.now() + WORK_STEP_DEADLINE_MS` directly and would bypass a helper-only change. [commerce recording deadline][L6] [commerce step budgets][L6b] [membership work deadline][L7] [membership budget][L7b] | Factor-1 cancellation/retry/rollback tests, plus real work latency measurements; business validity and durable schedule dates retain their original meaning.                                                                                                                 |
| Explicit absolute deadlines from callers/tests                    | Never multiply or replace an already formed timestamp. A deliberately expired deadline stays expired; a supplied 300 ms cancellation budget stays 300 ms. [kernel deadline scope][L1] [production request constant][L4] [real deadline tests][L8]                                                                                                                                                         | Existing exact assertions and new before/at/after checks, at factor 1; fake-runtime tests can exercise identical logic without waiting.                                                                                                                                      |
| Pool acquisition                                                  | Keep the existing independent `KERNEL_POOL_ACQUIRE_TIMEOUT_MS`: production 200 ms, test runner 2000 ms, valid range 50–10000. Do not multiply the 2000 ms again. Explicit pool options retain precedence. [pool configuration][L9] [test pool override][L10]                                                                                                                                              | Existing default/range/override assertions plus a reserved real saturation/release test at production settings; measure acquire latency and refused work separately from query time.                                                                                         |
| SQL `statement_timeout` derived from remaining deadline           | Recompute remaining duration from the one scaled parent; never multiply it again and never set zero to mean expired. Current command code clamps remaining to at least 1 ms. [bounded SQL read][L11] [command transaction deadlines][L11b]                                                                                                                                                                | Real PostgreSQL cancellation and rollback remain required at factor 1; fake database ports alone cannot verify server enforcement.                                                                                                                                           |
| Fixed SQL sublimits                                               | Initially keep the current 200 ms bounded read, 200 ms lock timeout and 5000 ms idle-transaction timeout. A larger outer budget does not lengthen these. [bounded SQL read][L11] [command transaction deadlines][L11b] [pool configuration][L9]                                                                                                                                                           | Keep exact SQL-setting assertions and report failures at these sublimits separately. Reduce contention first if they fire; do not silently sweep every database limit into the multiplier. [SQL-setting assertions][L12]                                                     |
| Test harness watchdogs and readiness                              | Use a separate finite watchdog policy; the present runner passes Bun a 60000 ms per-test timeout. A scaled 30-second operation can now last 120 seconds, so that watchdog must be reviewed independently. [Bun watchdog][L13]                                                                                                                                                                             | Keep semantic files' existing bounds; for functional files propose a 300-second per-test watchdog initially, with slow-operation reporting. Measure and tighten it; this is not a production latency threshold. [nextest slow timeouts][N1] [Bazel warnings and retries][B2] |

A deadline that bounds execution is not a domain TTL. The existing kernel `clock` is explicitly trusted domain time,
so do not reuse it as a fake execution clock or globally patch `Date.now()` in database integration tests. That would
couple authorization validity to scheduling and leave PostgreSQL running on a different clock. [kernel time contract][L3] [synctest isolation][G3]

## Concrete implementation shape for adoption

1. **Initialize once before importing application modules.** Put environment parsing in a test bootstrap such as
   `test/support/deadline-policy.ts`, loaded by the kernel check before each file's application imports. Snapshot and
   validate `KERNEL_TEST_DEADLINE_MULTIPLIER` once per process, install an immutable execution-budget policy, and log
   factor, test group and runner revision. Default to 1 when absent; reject empty, fractional, negative, infinite or
   out-of-range input. Application deadline helpers consume that policy, not `process.env` on every request. The
   production policy is fixed at 1 and cannot be replaced after startup. Chromium's exactly-once initialization and
   Kubernetes' copied configuration support this structure. [TestTimeouts initialization][C2] [copied timeout context][K3]
2. **Multiply durations only when creating a new budget.** Add one shared budget constructor used both by HTTP
   arrival and by `deadlineFor` outside a live request, plus the direct commerce recording path. Conceptually:
   `newDeadline(baseMs) = runtime.now() + baseMs * policy.factor`; inside a request, return its stored deadline before
   applying any scaling. An explicit `options.deadline` bypasses construction. Keep base constants equal to production
   values. Do not change request-context lifetime handling or refresh the deadline on retries. These are necessary
   integration points in the current code, not a proposal to double-scale nested work. [kernel deadline scope][L1] [HTTP entry deadline][L2] [production request constant][L4] [commerce recording deadline][L6]
3. **Select policy by test purpose before process launch.** Ordinary functional files get factor 4; deadline/latency/
   configuration files get factor 1 and adequate admission. Start the audit with `test/request-deadline.test.ts`,
   `test/command.test.ts` and `test/database-pool.test.ts`. The command file asserts statement timeout at most 2000 ms,
   lock 200 and idle 5000, so applying factor 4 to every file would contradict existing coverage. Keep whole mixed
   files at 1 initially. Do not edit, loosen or delete existing assertions to accommodate the new policy. [real deadline tests][L8] [SQL-setting assertions][L12] [request-deadline tests][L14] [pool policy tests][L20]
   Inventory direct `Date.now() + ...` timestamps in tests too: the multiplier cannot retroactively extend them.
   Such files need unscaled admission initially; a factor-4 run is not coverage of every supplied test deadline.
   The existing command tests demonstrate this bypass explicitly. [real deadline tests][L8]
4. **Inject an execution runtime into deadline logic.** A small `now(): number` and cancellable `sleep(ms)`/timer port
   should serve creation, expiry checks, retry backoff and remaining-budget calculations. Production uses actual
   epoch milliseconds and real timers. Tests instantiate a local manual runtime and controlled pool/transaction ports;
   do not expose a mutable global clock setter or route this through domain time. Advance through exact boundaries,
   flush pending continuations, and observe outcomes. CockroachDB's time-and-timer interface and Go's timeout example
   are the applicable patterns; Chromium documents why a clock alone does not virtualize all waits. [TimeSource][R3] [ManualTime][R4] [synctest timeout example][G4] [Chromium mock time][C3]
5. **Keep real integration enforcement and admission.** Run deadline-sensitive PostgreSQL files serially in an
   admitted group, with enough reserved capacity for both the client and its server; coordinate that reservation
   across check jobs, not just within a file list. The existing host capacity calculation already divides slice CPU
   capacity by 2 processors per slot; lane concurrency defaults to six but drops to one for an inherited stack slot.
   Nextest's weighted tests and service groups are the useful precedent. A two-processor accounting slot does not
   guarantee a sub-second observation on a shared, throttled host. [host admission][L15] [slot CPU cost][L15b] [inherited-slot lanes][L16] [default lanes][L16b] [nextest weighted tests][N2] [nextest test groups][N4]
6. **Preserve reruns as evidence.** Today's shared lane runner recognizes deadline/overload patterns, reruns selected
   failed files alone once, and labels those that pass load-sensitive. Keep that bounded diagnostic behavior for
   functional files during rollout, retaining original logs and both timings. Deadline-semantics and latency groups
   should have no pass-on-retry promotion: keep their first failure required. Do not broaden classification to all
   assertion failures. A success alone establishes a difference in execution conditions, not causation. [lane rerun selection][L17] [load failure patterns][L17b] [rerun outcomes][L17c] [nextest strict flaky results][N3]

Suggested new tests for the implementation: parser/default/production-policy rejection; immutability after startup;
factor 1 and factor 4 duration construction; HTTP and detached-work construction; no double scaling through nested
request scopes; exact propagation across the Auth boundary; expired explicit deadlines untouched; and cancellation,
retry exhaustion, no further work, rollback and connection release at the boundary. Existing tests remain unchanged.
These proposals target the current creation/checking paths and the timer interface described above. [kernel deadline scope][L1] [HTTP entry deadline][L2] [real deadline tests][L8] [TimeSource][R3]

For manual-runtime tests, check at `deadline - 1`, `deadline`, and `deadline + 1`; gate a pending fake operation with
an explicit readiness signal before advancing time. Assert no next attempt or success publication after expiry, and
assert the requested SQL timeout/abort action. For actual PostgreSQL, retain the existing `pg_sleep(2)` cancellation
case with its explicit 300 ms deadline and under-1000 ms observation assertion. Run it with factor 1 on reserved
capacity, and retain its zero committed-position assertion. Virtual time proves boundary logic; the PostgreSQL case
proves real server cancellation. Neither substitutes for the other. Real-clock database assertions still have
scheduling variance: they require sufficiently isolated capacity, not a claim of deterministic virtual time. If that
capacity is unavailable, wait for admission or report an infrastructure-invalid latency sample; do not increase the
asserted deadline or promote a failed semantic test through a retry. [synctest timeout example][G4] [synctest isolation][G3] [real deadline tests][L8]

## Measurements needed before and after

No kernel load experiment was run for this report; factor 4 is not validated here. The existing runner records test
case timings, reports load-sensitive reruns, and the remote checker reports CPU seconds, elapsed time, average cores
and peak memory. Extend those measurements rather than using the final green count alone. [rerun outcomes][L17c] [remote resource metrics][L18] [case timing capture][L18b]

Run the same revision, database seed, quotas and test selection in a matrix: factor 1 versus 4; quiet/admitted versus
shared-load six-lane conditions; and before/after any admission change. Do not change factor and lane count in one
undifferentiated comparison. Use at least 30 matched suite runs per cell initially, sample different busy periods,
and report first-attempt failure rates with confidence intervals and host identity. The sample size is a proposed
starting protocol, not proof that rare flakes have disappeared. Resource weighting can slow total completion even
when it improves reliability, as nextest explicitly cautions. [nextest weighted tests][N2]

Record the following separately for every group and factor:

- First-attempt deadline, pool-overload and fixed-SQL-sublimit failures; reruns requested, pass-alone count, repeated
  failures and total retry cost. Preserve the original error category and affected operation, not only its test title.
  These extend the categories and retry visibility already present. [pool configuration][L9] [bounded SQL read][L11] [lane rerun selection][L17]
- Request/step and pool-acquisition elapsed p50/p95/p99/max; configured production budget, effective budget and
  remaining budget at each refusal; attempts/backoff, rows/statements and pool waiting/active counts. Keep all
  reported elapsed times unscaled: never divide observed latency by four and call it production latency. The
  separate creation, remaining-time and pool paths make those measurements meaningful. [kernel deadline scope][L1] [pool configuration][L9] [bounded SQL read][L11]
- Host and job CPU quota, active admitted slots/lanes, CPU use, throttling and event-loop delay; PostgreSQL CPU and
  lock/query waits. Include database clone/setup and cleanup time separately from request execution. The current
  capacity admission and aggregate remote resource report provide a starting point, not per-operation attribution.
  [host admission][L15] [inherited-slot lanes][L16] [remote resource metrics][L18]
- On a quiet reserved host, factor-1 end-to-end request/step latency against the production deadline and a pinned
  pre-change baseline, with the same workload/concurrency and cold/warm pool cases. Keep database cost checks
  independent; the kernel already uses statement/row/buffer growth bounds without timing assertions. [database cost bounds][L19]

The adoption evidence should show a lower first-attempt false-failure rate under representative contention, bounded
suite completion/retry cost, and unchanged factor-1 semantic and latency results. Explicitly identify tests that pass
only at factor 4. For each, compare a factor-1 reserved run: fail the latency gate if the operation is now slower under
comparable conditions, even if the larger functional allowance hides it. Bazel's warning about generous timeouts and
nextest's first-failure visibility explain why final pass rate is insufficient. [Bazel warnings and retries][B2] [nextest strict flaky results][N3]

Validate the detectors with controlled defects in an isolated experiment: remove an expiry check, renew a deadline
on retry, disable SQL cancellation, and add latency exceeding a production budget. Boundary tests must detect the
first two, real PostgreSQL cancellation/rollback coverage the third, and factor-1 latency coverage the fourth.
Restore these mutations before any implementation lands. If only the multiplier-bearing run passes a deliberately
slow operation, that is expected functional tolerance; if the unscaled detector also passes, the rollout is incomplete.
These checks exercise the actual deadline, retry and cancellation behavior already under test. [real deadline tests][L8] [bounded SQL read][L11] [SQL-setting assertions][L12]

## Risks and decisions for the manager

- **Hidden production latency:** a request taking 6 seconds can fit an 8-second functional allowance while violating
  its 2-second production budget. Keep production defaults, unscaled measurements and a required reserved latency
  group; do not claim the multiplied suite verifies that service objective. [production request constant][L4] [Bazel warnings and retries][B2]
- **False confidence from reruns or polling:** intermittent deadlocks, leaked connections or contention regressions
  can also pass alone. Do not retry arbitrary mutations inside Eventually-style checks; preserve first failures and
  make semantic/latency groups strict. This separates CockroachDB's condition polling from runner retries. [SucceedsSoon][R1] [nextest strict flaky results][N3]
- **Mixed clocks and stale security evidence:** fake client time does not move the database, and scaling an expiry
  would alter authorization. Keep domain/security time separate; manual execution time stays local to controlled
  tests. [kernel time contract][L3] [barrier expiry][L5] [synctest isolation][G3]
- **Amplified pressure and late hangs:** a larger allowance holds resources longer; fixed SQL sublimits and the outer
  watchdog can still fail first. Keep caps finite, measure acquisition and retry behavior, and improve admission
  before increasing the factor again. No multiplier can bound arbitrary host starvation. [pool configuration][L9] [bounded SQL read][L11] [Bun watchdog][L13] [nextest weighted tests][N2]

Decisions made here: distinguish functional execution allowance from latency acceptance; default the policy to 1
and trial 4 explicitly in the check; leave existing pool policy and fixed SQL sublimits independent; preserve explicit
absolute deadlines and all current assertions; use an independent execution runtime; keep real PostgreSQL enforcement
and latency checks required. These are recommendations pending adoption into the owning kernel/check documents,
not changes to production behavior. [kernel deadline scope][L1] [kernel time contract][L3] [real deadline tests][L8] [pool configuration][L9] [bounded SQL read][L11]

## Source snapshots, paths and licences

All links below are pinned to the inspected commits. Local clone paths are relative to
`/home/edge/projects/rezics/rezics-next/.reference/`; existing clones were reused and their entries recorded in
`INDEX.md`. The source links identify exact files and line ranges; licence links cover the repository-level terms.
CockroachDB's inspected revision is source-available under its restricted Software License, not an assertion of an
OSI-approved open-source licence. [CockroachDB Software License][RL] Recommend the patterns above in TypeScript/Bun; copy no implementation passages.

| Project       | Local reference clone                   | Inspected commit                           | Licence source                     |
| ------------- | --------------------------------------- | ------------------------------------------ | ---------------------------------- |
| PostgreSQL    | `search-canonical-coverage/postgres/`   | `227de22095c8101905ce41e1ebf425239feed079` | [PostgreSQL License][PL]           |
| Chromium      | `test-deadlines-under-load/chromium/`   | `d3de019a49646d2d6ff086c10fabb4e3d1a8c698` | [BSD-3-Clause][CL]                 |
| CockroachDB   | `test-deadlines-under-load/cockroach/`  | `d30c905fff79ef825adc96bcc647f1872a90f2ff` | [CockroachDB Software License][RL] |
| Kubernetes    | `test-deadlines-under-load/kubernetes/` | `53db21f676b21f64a3d0b343cf0714eadffa90b3` | [Apache-2.0][KL]                   |
| Bazel         | `test-deadlines-under-load/bazel/`      | `b7a7fa1b357ad8813b0d2bac64f76e9152126e8a` | [Apache-2.0][BL]                   |
| Go            | `test-deadlines-under-load/go/`         | `68d3532baa075e665e349f75c932b5a3fb9deca9` | [BSD-3-Clause][GL]                 |
| cargo-nextest | `test-deadlines-under-load/nextest/`    | `2dc813284e32fc9637649cfad193ca0022b9eb71` | [MIT][NL1] or [Apache-2.0][NL2]    |

[P1]: https://github.com/postgres/postgres/blob/227de22095c8101905ce41e1ebf425239feed079/doc/src/sgml/regress.sgml#L1002-L1007
[P2]: https://github.com/postgres/postgres/blob/227de22095c8101905ce41e1ebf425239feed079/src/test/perl/PostgreSQL/Test/Utils.pm#L180-L182
[P3]: https://github.com/postgres/postgres/blob/227de22095c8101905ce41e1ebf425239feed079/src/test/isolation/README#L133-L149
[P4]: https://github.com/postgres/postgres/blob/227de22095c8101905ce41e1ebf425239feed079/src/test/isolation/isolationtester.c#L933-L981
[C1]: https://github.com/chromium/chromium/blob/d3de019a49646d2d6ff086c10fabb4e3d1a8c698/base/test/test_timeouts.cc#L58-L107
[C2]: https://github.com/chromium/chromium/blob/d3de019a49646d2d6ff086c10fabb4e3d1a8c698/base/test/test_timeouts.h#L19-L50
[C3]: https://github.com/chromium/chromium/blob/d3de019a49646d2d6ff086c10fabb4e3d1a8c698/base/test/task_environment.h#L106-L123
[R1]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/testutils/soon.go#L20-L90
[R2]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/.bazelrc#L62-L70
[R3]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/util/timeutil/time_source.go#L10-L31
[R4]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/util/timeutil/manual_time.go#L83-L120
[R5]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/cmd/dev/test.go#L335-L369
[R6]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/build/github/maybe-stress-impl.sh#L45-L67
[R7]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/testutils/skip/stress.go#L10-L29
[R8]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/util/timeutil/cpustopwatch.go#L14-L38
[K1]: https://github.com/kubernetes/kubernetes/blob/53db21f676b21f64a3d0b343cf0714eadffa90b3/test/e2e/framework/timeouts.go#L18-L57
[K2]: https://github.com/kubernetes/kubernetes/blob/53db21f676b21f64a3d0b343cf0714eadffa90b3/test/e2e/framework/test_context.go#L469-L476
[B1]: https://github.com/bazelbuild/bazel/blob/b7a7fa1b357ad8813b0d2bac64f76e9152126e8a/docs/reference/test-encyclopedia.mdx#L100-L172
[B2]: https://github.com/bazelbuild/bazel/blob/b7a7fa1b357ad8813b0d2bac64f76e9152126e8a/docs/docs/user-manual.mdx#L1548-L1585
[B3]: https://github.com/bazelbuild/bazel/blob/b7a7fa1b357ad8813b0d2bac64f76e9152126e8a/docs/reference/test-encyclopedia.mdx#L616-L624
[B4]: https://github.com/bazelbuild/bazel/blob/b7a7fa1b357ad8813b0d2bac64f76e9152126e8a/docs/reference/test-encyclopedia.mdx#L509-L512
[G1]: https://github.com/golang/go/blob/68d3532baa075e665e349f75c932b5a3fb9deca9/src/cmd/go/internal/test/test.go#L348-L351
[G2]: https://github.com/golang/go/blob/68d3532baa075e665e349f75c932b5a3fb9deca9/src/testing/testing.go#L2325-L2337
[G3]: https://github.com/golang/go/blob/68d3532baa075e665e349f75c932b5a3fb9deca9/src/testing/synctest/synctest.go#L10-L93
[G4]: https://github.com/golang/go/blob/68d3532baa075e665e349f75c932b5a3fb9deca9/src/testing/synctest/synctest.go#L155-L181
[N1]: https://github.com/nextest-rs/nextest/blob/2dc813284e32fc9637649cfad193ca0022b9eb71/site/src/docs/features/slow-tests.md#L26-L100
[N2]: https://github.com/nextest-rs/nextest/blob/2dc813284e32fc9637649cfad193ca0022b9eb71/site/src/docs/configuration/threads-required.md#L7-L39
[N3]: https://github.com/nextest-rs/nextest/blob/2dc813284e32fc9637649cfad193ca0022b9eb71/site/src/docs/features/retries.md#L105-L125
[N4]: https://github.com/nextest-rs/nextest/blob/2dc813284e32fc9637649cfad193ca0022b9eb71/site/src/docs/configuration/test-groups.md#L7-L26
[N5]: https://github.com/nextest-rs/nextest/blob/2dc813284e32fc9637649cfad193ca0022b9eb71/nextest-runner/default-config.toml#L14-L30
[L1]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/request/deadline.ts#L14-L47
[L2]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/http/app.ts#L313-L329
[L3]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/README.md#L356-L360
[L4]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/command/command.ts#L1-L15
[L5]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/access/auth-barriers.ts#L30-L113
[L6]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/commerce/commands.ts#L274-L299
[L7]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/community/membership.ts#L423-L427
[L8]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/test/command.test.ts#L203-L238
[L9]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/database/pool.ts#L5-L41
[L10]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/scripts/check.ts#L247-L258
[L11]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/command/command.ts#L262-L290
[L12]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/test/command.test.ts#L43-L55
[L13]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/scripts/test-lanes.ts#L540-L542
[L14]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/test/request-deadline.test.ts#L27-L75
[L15]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/scripts/remote-check.ts#L515-L519
[L16]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/scripts/test-lanes.ts#L561-L566
[L17]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/scripts/test-lanes.ts#L648-L659
[L18]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/scripts/remote-check.ts#L367-L373
[L19]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/README.md#L200-L203
[PL]: https://github.com/postgres/postgres/blob/227de22095c8101905ce41e1ebf425239feed079/COPYRIGHT#L1-L22
[CL]: https://github.com/chromium/chromium/blob/d3de019a49646d2d6ff086c10fabb4e3d1a8c698/LICENSE#L1-L27
[RL]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/LICENSE#L1-L40
[KL]: https://github.com/kubernetes/kubernetes/blob/53db21f676b21f64a3d0b343cf0714eadffa90b3/LICENSE#L1-L20
[BL]: https://github.com/bazelbuild/bazel/blob/b7a7fa1b357ad8813b0d2bac64f76e9152126e8a/LICENSE#L1-L20
[GL]: https://github.com/golang/go/blob/68d3532baa075e665e349f75c932b5a3fb9deca9/LICENSE#L1-L27
[NL1]: https://github.com/nextest-rs/nextest/blob/2dc813284e32fc9637649cfad193ca0022b9eb71/LICENSE-MIT#L1-L22
[NL2]: https://github.com/nextest-rs/nextest/blob/2dc813284e32fc9637649cfad193ca0022b9eb71/LICENSE-APACHE#L1-L20
[P5]: https://github.com/postgres/postgres/blob/227de22095c8101905ce41e1ebf425239feed079/src/test/isolation/README#L50-L53
[K3]: https://github.com/kubernetes/kubernetes/blob/53db21f676b21f64a3d0b343cf0714eadffa90b3/test/e2e/framework/timeouts.go#L119-L126
[K4]: https://github.com/kubernetes/kubernetes/blob/53db21f676b21f64a3d0b343cf0714eadffa90b3/test/e2e/framework/test_context.go#L425-L427
[G5]: https://github.com/golang/go/blob/68d3532baa075e665e349f75c932b5a3fb9deca9/src/testing/testing.go#L2947-L2970
[L5b]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/access/auth-barriers.ts#L190-L194
[L6b]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/commerce/commands.ts#L36-L100
[L7b]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/community/membership.ts#L51-L56
[L11b]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/command/command.ts#L418-L442
[L15b]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/scripts/remote-check.ts#L63-L63
[L16b]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/scripts/test-lanes.ts#L455-L460
[L17b]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/scripts/test-lanes.ts#L174-L189
[L17c]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/scripts/test-lanes.ts#L120-L155
[L18b]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/scripts/test-lanes.ts#L314-L320
[L20]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/test/database-pool.test.ts#L42-L61
[L21]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/clock.ts#L1-L4
[C4]: https://github.com/chromium/chromium/blob/d3de019a49646d2d6ff086c10fabb4e3d1a8c698/docs/testing/on_disabling_tests.md#L1-L56
