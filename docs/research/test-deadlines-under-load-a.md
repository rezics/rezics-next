# Integration-test deadlines under CPU contention

Research inspected on 2026-10-28. This is evidence and a proposed policy for adoption, not a change to production contracts.
Source links pin inspected revisions; kernel observations refer to base `cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f`.
Reference repositories were read without installing, building or running their code. No load experiment was performed here.

## Recommendation

Adopt three complementary checks: longer **configured execution budgets** for ordinary database integration tests,
deterministic deadline-semantics tests with an execution clock and controllable timers, and an **unscaled latency gate**
on reserved capacity. Keep production defaults and security freshness windows unchanged. This combines the environment
allowances in PostgreSQL and Chromium, clock control in CockroachDB and Go, and resource admission in Bazel and nextest;
it is an inference from those mechanisms, not a claim that they all multiply production request deadlines. [TAP timeout guidance][P1],
[Chromium factors][C1], [clock and timer interface][R3], [synctest clock and isolation][G2], [Bazel resource and flaky policy][B2], [weighted test admission][N2]

Use one startup setting, proposed as `KERNEL_TEST_DEADLINE_MULTIPLIER`, default **1**. Trial **4** in the ordinary
integration-test profile, subject to the measurement and rejection criteria below. Those values are a kernel proposal,
not numbers established by another project's results. A test passing with factor 4 establishes functional behavior
within its enlarged budget; it does not establish the production latency target. Bazel explicitly distinguishes runner
timeout classes from resource estimates, and nextest distinguishes a slow warning from termination. [Bazel time classes][B1], [slow and hard timeouts][N1]

## Verified mechanisms and their boundaries

### PostgreSQL: adjustable test waits and bounded parallelism

The TAP documentation explicitly identifies slow-host, load-induced failures and recommends raising
`PG_TEST_TIMEOUT_DEFAULT` from its 180-second default. `PostgreSQL::Test::Utils` reads the environment in its `BEGIN`
initialization block. This is an absolute test-wait setting, not a universal production-timeout multiplier. In particular,
`poll_query_until` derives a bounded attempt count from it; the allowance is not a strict whole-test watchdog.
Traditional parallel regression tests separately support `MAX_CONNECTIONS` to reduce concurrent scripts. [TAP timeout guidance][P1],
[TAP startup configuration][P2], [TAP query polling][P3], [regression concurrency][P4]

The distinction matters: PostgreSQL's production `statement_timeout` measures command arrival through server completion,
and applies separately to statements as documented. Raising TAP wait allowances does not change that SQL setting.
Consequently, this is evidence for configurable harness patience and admission, not evidence that a larger Bun timeout
alone would fix the kernel's internal SQL or request deadlines. [SQL timeout semantics][P5], [SQL guards and command deadline][K4]

### Chromium: centralized allowances, initialization once, and mock time

`TestTimeouts` is expressly a common **test** timeout service, initialized once by the suite. Its implementation uses
environment/build-specific factors: ordinary ASan or TSan gets 2, non-ChromeOS MSan gets 6, and profiling gets 3; platform
branches differ. It applies these while initializing named timeout values, enforces ordering between allowances, and
supports command-line overrides. The comments attribute sanitizer factors to instrumentation overhead and identify
startup overhead under parallel ASan/macOS tests. [Chromium factors][C1], [timeout initialization][C2], [test-only timeout API][C5]

Chromium also provides `TaskEnvironment::MOCK_TIME`: clock reads and managed delayed tasks share virtual time, with
`FastForwardBy` running due work in order. It explicitly warns that some platform waits remain real. Its launcher has
bounded retries. These are separate facilities: increasing a launcher watchdog is not the same as controlling the
clock that code uses to decide whether a deadline expired. [Chromium mock time][C3], [virtual task advancement][C6], [Chromium retries][C4]

### CockroachDB: eventual assertions, selected stress allowances, and injectable time

`SucceedsSoon` repeatedly evaluates an assertion with backoff instead of assuming readiness after a fixed sleep. Its
normal limit is 45 seconds; race or deadlock builds use five times that limit. `SucceedsWithin` accepts an explicit
allowance and records a goroutine dump on failure. This retries an eventual-state assertion, not an arbitrary mutation
or an operation whose contract is to finish by a particular deadline. [SucceedsSoon][R1]

Stress scaling is **selective**, not a multiplier inferred from `SucceedsSoon`: the latter checks race/deadlock flags,
not the stress flag. `skip.Duress()` includes race, stress and deadlock configurations; one lease test changes its run
allowance from 20 seconds to two minutes under duress. Another explicitly skips duress configurations while enforcing
a real 30-second duration bound. `UnderStressWithIssue` and `UnderDuressWithIssue` expose conditional exclusions with
an issue reference. This demonstrates both allowances and exclusions, not permission to disable all slow tests. [SucceedsSoon][R1],
[duress and exclusions][R2], [lease-test allowances][R4], [unscaled lease-test bound][R7]

For clock injection, `TimeSource` covers clock reads, timers and tickers, and `ManualTime` implements it with explicit
advance operations. A separate `CPUStopWatch` measures the current goroutine's CPU use; its documented purpose is
measurement, not replacing the preceding test or request deadlines. The inspected revision is source-available under
the CockroachDB Software License, not an assumption of an unrestricted open-source licence. [clock and timer interface][R3], [manual clock][R5],
[CPU stopwatch][R6], [CockroachDB licence][RL]

### Kubernetes: named e2e operation budgets

The e2e framework has a `TimeoutContext`, including a two-second poll interval and distinct normal, short and slow pod
startup allowances. `NewTimeoutContext` copies settings after command-line parsing; selected startup allowances have
flags, and `NewFrameworkWithCustomTimeouts` overrides nonzero fields. Framework initialization also sets explicit
Eventually/Consistently defaults. This is per-operation harness configuration, not evidence of a global multiplier
or CPU-time accounting for all Kubernetes deadlines. [e2e timeout context][U1], [timeout snapshot][U2], [startup timeout flags][U3], [custom e2e budgets][U4], [eventual assertion defaults][U5]

### Bazel: timeout classes, resource scheduling, and explicit flakiness

Bazel allocates 60/300/900/3600 seconds to short/moderate/long/eternal **test targets**, with defaults selected by size;
these are not per-method production budgets. Size also informs local CPU/RAM scheduling, and `cpu:n` can request more
CPU reservation. The specification cautions that CPU performance is unspecified and that a reservation exceeding
machine capacity does not prevent execution. These are scheduling estimates, not proof of isolation. [Bazel time classes][B1],
[Bazel resource and flaky policy][B2], [CPU reservation limits][B3]

`flaky` defaults to false. When enabled, the runner normally allows three attempts, succeeding if any attempt passes;
the documentation discourages relying on it. Bazel also recommends choosing the tightest nonflaky timeout and can warn
about overgenerous classes. These facilities can preserve diagnostics, but a retry pass alone cannot distinguish host
contention from an intermittent product race. [Bazel resource and flaky policy][B2], [Bazel retry implementation][B4], [Bazel time classes][B1]

### Go: the runner deadline is distinct from application deadlines

`testing.T.Deadline()` exposes the test binary's `-timeout` deadline; the runner alarm is created from `time.Now()` and
`time.AfterFunc`. It is useful as a ceiling for helper work and cleanup, not a mechanism for silently extending an
application context deadline. In a synctest bubble, querying that real runner deadline deliberately panics. [Go runner deadline][G1], [real runner alarm][G4]

`testing/synctest` gives each bubble a fake clock that advances when its goroutines are durably blocked. Its guidance
excludes real network and external-process dependencies. The official context example checks immediately before and
at a timeout using virtual time. Thus fake-clock tests prove temporal logic; they do not measure PostgreSQL latency.
[synctest clock and isolation][G2], [virtual context-boundary example][G3]

### cargo-nextest: slow reporting, hard limits, weighted admission, and visible retries

Nextest's slow threshold defaults to 60 seconds; termination is optional and configured separately through
`terminate-after`. Its source models the period and termination count separately. Timeouts fail by default; the
documented opt-in to treat a fuzz-test timeout as success should not be adopted for finite kernel integration tests.
[slow and hard timeouts][N1], [slow-timeout model][N5]

`threads-required` assigns heavier tests more scheduling weight and explicitly covers integration tests that launch
services. Test groups provide separate concurrency limits for subsets sharing a constrained service. Retries mark a
later pass as flaky; `flaky-result = "fail"` can retain a failing verdict even after a successful retry. These mechanisms
address admission, observability and verdict policy independently of how long an operation is allowed to run.
[weighted test admission][N2], [test-group admission][N3], [retry and flaky verdicts][N4]

### CPU-time deadlines: not the recommendation

None of the deadline/wait implementations above establishes CPU time as a replacement for elapsed request time.
Bazel even specifies an unlimited `RLIMIT_CPU`, separately from its test-target timeout, while CockroachDB exposes
CPU accounting as a stopwatch. This is a bounded finding about inspected sources, not a claim that no project uses
CPU limits. [Bazel CPU limit][B5], [CPU stopwatch][R6], [Go runner deadline][G1]

For this kernel, charging only Bun CPU time would omit PostgreSQL execution and time waiting for connections or locks;
it could allow a stalled database operation to wait without consuming that budget. That conclusion follows from the
separate client pool and server-side SQL execution shown here. Keep elapsed deadlines and collect CPU usage as a
diagnostic. Neither CPU accounting nor a monotonic elapsed clock removes scheduling delay from a wall-duration test.
[pool guards and defaults][K3], [SQL guards and command deadline][K4], [SQL timeout semantics][P5]

### Patterns shared by the sources

The recurring pattern is to configure how long a test waits for progress, separately from resource admission and from
the behavior being asserted. PostgreSQL, Chromium and Kubernetes centralize allowances; CockroachDB, Chromium and Go
offer a way to test time-dependent behavior separately; Bazel and nextest expose resource weights and bounded retry
policies. None of these examples makes a larger allowance sufficient evidence of production latency. The kernel
recommendation therefore pairs additional patience with independent checks of deadline semantics and unscaled latency.
[TAP startup configuration][P2], [timeout initialization][C2], [timeout snapshot][U2], [clock and timer interface][R3],
[synctest clock and isolation][G2], [Bazel resource and flaky policy][B2], [weighted test admission][N2]

## Apply the distinction to the kernel

The current kernel shares an absolute request deadline through async context; outside a live request `deadlineFor(b)`
returns `Date.now() + b`. Commands default to 2000 ms, Auth barriers to 3000 ms, commerce steps to 5000 ms and membership
work to 30000 ms. Commerce checkout recording deliberately creates an independent work deadline after the provider
effect. A request cannot acquire a fresh budget at every nested call. [shared deadline helper][K1], [production request default][K2], [Auth barrier budget][K5], [independent commerce root][K6],
[commerce execution budget][K7], [membership execution budget][K8]

The following choices are recommendations. “Scale” means allow more **real elapsed time** when constructing a selected
default in ordinary functional tests, never slowing a process clock or multiplying an absolute timestamp.

| Budget or invariant                                               | Ordinary integration profile                                                                                                                                                                                                            | How to retain regression detection                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default HTTP/command request budget, 2 s                          | Scale once at the root where the configured default becomes an absolute deadline.                                                                                                                                                       | Exercise unchanged 2 s defaults in the reserved unscaled gate; test propagation and expiry independently. [shared deadline helper][K1], [production request default][K2], [HTTP default][K23], [HTTP deadline root][K24]                                                                 |
| Auth barrier operational budget, 3 s                              | Scale the fallback only outside an existing request; preserve the caller's deadline.                                                                                                                                                    | Unscaled barrier latency checks plus exact fail-closed expiry tests; proof expiry remains unchanged. [Auth barrier budget][K5], [caller Auth deadline][K19], [proof expiry validation][K20]                                                                                              |
| Commerce 5 s steps and membership 30 s work                       | Scale each independent operational root once. Audit the direct checkout-recording root as well as `deadlineFor` users.                                                                                                                  | Unscaled job/step latency and retry-count checks; deterministic tests prove the whole retry loop shares one deadline. [independent commerce root][K6], [commerce execution budget][K7], [membership execution budget][K8]                                                                |
| Pool acquisition                                                  | Keep the existing explicit 2000 ms functional-test setting initially; production stays 200 ms. Do not multiply the test override again.                                                                                                 | Separately test production/default configuration, saturation refusal, queue size and release behavior at factor 1. [pool guards and defaults][K3], [per-file startup environment][K9]                                                                                                    |
| SQL statement and lock guards                                     | Scale the internal 200 ms preflight-read and lock defaults and the 5 s idle-transaction guard in the functional profile. Derive statement/lock limits as `min(effective guard, remaining request time)`; retain finite idle protection. | Keep their production values in the unscaled SQL cancellation/lock/idle tests. Explicit test overrides stay literal. Increasing only the root leaves these smaller bottlenecks active. [pool guards and defaults][K3], [SQL guards and command deadline][K4], [bounded read guard][K22]  |
| Caller-supplied absolute deadlines and explicit timeout overrides | Preserve exactly, including already-expired values. Never rebase on entry to a helper or on retry.                                                                                                                                      | Run exact boundary, nested-deadline and concurrent-context tests; add factor-4 propagation coverage. [shared deadline helper][K1], [deadline arithmetic acceptance][K10]                                                                                                                 |
| Evidence freshness, proof/credential expiry and domain time       | Keep their contractual durations and clock meanings. The one-second evidence TTL remains `min(callerDeadline, now + 1000)`.                                                                                                             | Boundary tests with controlled clocks and real integration tests at factor 1; fresh evidence is obtained when required. Multiplying execution patience cannot authorize stale evidence. [evidence freshness contract][K11], [proof expiry validation][K20], [domain clock boundary][K12] |
| Runner/hook watchdogs and readiness waits                         | Give a separate finite envelope covering enlarged work, fixtures and cleanup; poll for readiness instead of fixed sleeps.                                                                                                               | Report slow tests below the kill threshold; fail on exhaustion. These watchdogs do not replace internal deadline checks. [timeout initialization][C2], [SucceedsSoon][R1], [slow and hard timeouts][N1]                                                                                  |

There is already a separate allowance in test composition: `testApp` and `testKernel` request 30 seconds. Do not turn
that into 120 seconds by indiscriminately multiplying every number; keep explicit overrides literal. Likewise,
`deadlineFor(5000)` has an existing exact arithmetic test, and source-shape acceptance tests constrain commerce's
named budget and independent root. Preserve these tests and frozen files; a blanket change to the meaning of every
numeric argument is not the proposed design. [test composition override][K13], [deadline arithmetic acceptance][K10], [commerce source-shape acceptance][K14]

## Concrete adoption design

1. **Snapshot one policy at process startup.** Add a small execution-budget configuration module, separate from the
   domain clock. Parse `KERNEL_TEST_DEADLINE_MULTIPLIER` once before constructing the app, pools or workers, freeze the
   resulting policy, and pass it to independent default-budget creation sites. Accept integers 1–10; absent means 1;
   reject malformed/out-of-range settings. Require a trusted test entrypoint's construction mode for a value other than 1 and reject it
   in production startup. Do not read the environment on requests, retries or timer callbacks. This follows Chromium's
   once-per-suite initialization and PostgreSQL's early environment snapshot. The setting name and bounds are proposed.
   [timeout initialization][C2], [TAP startup configuration][P2]
2. **Resolve named defaults, not arbitrary arithmetic.** Retain raw production constants and the contract of
   `deadlineFor`, `withRequestDeadline`, caller deadlines and explicit overrides. Resolve an opted-in default through
   the frozen policy before it becomes a deadline; scale duration once with `ceil(base * factor)`. Wire the HTTP root,
   standalone command/Auth defaults and independent job roots explicitly. The direct commerce root needs its own seam;
   changing only `deadlineFor` misses it. Preserve existing source-shape assertions when choosing those seams; do not
   edit acceptance tests to make a broad rewrite fit. Include named preflight-read, lock and idle-transaction defaults
   in the audited policy; do not scale retry counts, concurrency, work limits or security durations.
   [shared deadline helper][K1], [independent commerce root][K6], [commerce source-shape acceptance][K14], [bounded read guard][K22], [pool guards and defaults][K3]
3. **Set the profile in the harness.** `fileEnvironment` is the existing place that supplies each file's pool override.
   Extend that startup environment for ordinary functional files with the trial factor 4. Run deadline-semantics and
   production-latency files in fresh factor-1 processes; maintain an explicit, reviewed classification rather than
   matching error messages. Log profile, factor and effective named defaults in each file result. Verify imported code
   and child workers receive the same startup policy. Retain the pool's explicit 2000 ms override without compounding it.
   [per-file startup environment][K9], [deadline arithmetic acceptance][K10], [bounded load-sensitive retries][K15]
4. **Inject execution time for new deterministic tests.** Provide an internal `ExecutionTime` port with an epoch-ms
   `now()` compatible with current absolute deadlines and a cancelable timer/sleep facility. Default to real time;
   supply a manual implementation for isolated deadline logic. Keep it distinct from `KernelClock`: that clock is
   explicitly domain time and must not control execution/authentication freshness. Replace all participating reads
   and timers within the tested operation together; do not globally mock `Date.now` while a real PostgreSQL server or
   driver continues on real time. CockroachDB's complete time-source interface and Chromium's warning about remaining
   real waits establish why mocking only the clock read is insufficient. [clock and timer interface][R3], [manual clock][R5], [Chromium mock time][C3], [domain clock boundary][K12]
5. **Control contention before adding more patience.** Keep the current two-processor slot accounting, then measure
   total lanes across admitted checks and CPU used by PostgreSQL/search/analysis work as well as Bun. Weight heavy
   suites or reduce lanes if the complete stack does not fit its quota. Scheduling permits do not by themselves prove
   CPU isolation. Do not grant more lanes just because longer deadlines make them pass. [processor admission][K16], [slot processor cost][K21], [CPU reservation limits][B3], [weighted test admission][N2],
   [test-group admission][N3]
6. **Keep retries diagnostic and bounded.** The existing harness retries classified load-sensitive failures once alone,
   and preserves failures that recur. Keep both attempt records and report retry passes as load-sensitive; do not call
   them proof of the cause. Deadline correctness and latency-gate failures must retain a failing verdict even if a
   diagnostic retry passes. This is analogous to nextest's selectable flaky-failure policy, rather than making all
   first-attempt deadline errors harmless. No new quarantine is recommended; any later exclusion needs ownership,
   expiry and coverage in an unscaled profile. [bounded load-sensitive retries][K15], [retry and flaky verdicts][N4], [duress and exclusions][R2]

### Deterministic semantics and the real database boundary

Add tests that hold work behind an explicit barrier, advance manual time to one unit before and exactly at the
deadline, flush due callbacks, and verify the expired result and absence of subsequent work. Cover expiration before
admission, during queued acquisition/lock waiting, between retries, and after a callback becomes runnable. Assert
timer cleanup, connection release and isolation of concurrent request contexts. Use fake ports only for these isolated
clock/state-machine tests; retain real database integration for SQL rollback/cancellation and post-deadline effects.
This follows the Go context-boundary example and CockroachDB timer interface without claiming that fake time can
advance a real PostgreSQL server. [virtual context-boundary example][G3], [clock and timer interface][R3], [SQL timeout semantics][P5], [SQL guards and command deadline][K4]

Run all existing deadline acceptance tests unchanged at factor 1. Add separate factor-4 process tests proving default
budgets scale once, an inherited deadline stays identical, explicit expired/short deadlines remain literal, and security
TTL/production constants do not scale. Verify changing the environment after initialization cannot change the policy.
Existing real-database semantic tests already warm setup before short budgets and assert statement timeouts against
remaining request time; retain that coverage, admitting it on reserved capacity. A manual-clock test's runner watchdog
must still use real time so a deadlock in the test is bounded. [deadline arithmetic acceptance][K10], [evidence freshness contract][K11], [real SQL deadline acceptance][K17], [Go runner deadline][G1]

## Evidence required before enabling the profile

The following is a proposed experiment, not measurements obtained in this report.

- Run the same revision, fixtures, database size, warmup and cache policy at factors 1 and 4, first with one file and
  then with six lanes under the normal admitted host load. Interleave baseline/candidate runs on the same host class;
  also run reduced-lane configurations. Start with 20 complete runs per configuration and report the sample count and
  uncertainty instead of claiming that zero observed flakes proves reliability. Weighted admission can trade throughput
  for reliability, which nextest explicitly says to benchmark. [weighted test admission][N2]
- Record first-attempt outcomes, every deadline/overload reason and phase, retry outcomes, wall-clock suite duration,
  admission queue time, per-operation p50/p95/p99 with counts, and time spent acquiring, executing SQL, waiting on locks
  and awaiting callbacks. Record the actual configured factor and budgets; do not divide observed latency by the factor.
  PostgreSQL measures statement completion on the server, whereas the kernel maps both SQL and pool errors into refusal
  categories, so the final error label alone is insufficient attribution. [SQL timeout semantics][P5], [refusal classification][K18]
- Capture effective cgroup `cpu.max`, CPU usage, `nr_periods`, `nr_throttled`, `throttled_usec`, and CPU pressure for the
  test and database/service cgroups and their limiting ancestors where accessible. Record memory, connection counts,
  event-loop delay and active lanes alongside them. Interpret throttling counters at their documented scope; absence
  of local throttling is not proof that a parent or host imposed no delay. [Linux CPU interface files][linux-cpu]
- Require a reduction in **first-attempt** functional deadline/overload failures at the same admission, with no
  unexplained CPU/query-count growth. If factor 4 still produces failures or significant tail growth, fix admission or
  the operation rather than automatically raising the factor. Preserve existing work/SQL growth bounds; a timeout
  multiplier is not a tolerance for more work. The raw kernel SQL guards and nextest's separate slow reporting motivate
  reporting budget headroom instead of judging only the final pass bit. [SQL guards and command deadline][K4], [slow and hard timeouts][N1]
- Make the unscaled gate a landing requirement: reserved effective CPU/database capacity, warmed setup, production
  factor 1, production pool/default deadlines, representative request/Auth/commerce/membership cases, and fixed workload
  and growth assertions. Freeze baselines and variance thresholds before comparing a candidate; retain production
  budget failures as failures. Test this gate with controlled injected SQL/callback delays and pool saturation, and
  confirm that removing an expiry check fails semantics tests. These are proposed checks of the detector itself,
  motivated by the separate server timeout and virtual boundary examples. [SQL timeout semantics][P5], [virtual context-boundary example][G3], [pool guards and defaults][K3]

## Risks and decisions

An operation regressing from one second to three could pass a factor-4 functional budget while violating a two-second
production default. That is why unscaled latency checks and unchanged growth bounds are required, not optional future
monitoring. A retry pass can conceal an intermittent race; distinguish it in reports and preserve failing performance
verdicts. Large multipliers also increase worst-case failure time and can leave transactions/connections occupied longer;
keep finite subordinate guards and cleanup coverage. These are consequences of the proposed allowances and the kernel's
pool/transaction boundaries, not measured effects in this study. [production request default][K2], [pool guards and defaults][K3], [SQL guards and command deadline][K4], [retry and flaky verdicts][N4]

Decisions proposed for adoption: keep elapsed time; default the policy to 1 and trial 4 only for functional tests;
scale audited configured defaults once; keep explicit deadlines, security windows and existing pool overrides literal;
separate execution time from domain time; retain all existing acceptance tests; require deterministic semantics plus an
unscaled landing gate. Prefer admission changes if real one-second evidence windows are expiring under starvation:
enlarging execution budgets cannot make stale security evidence valid. These decisions preserve the kernel's caller
deadline and freshness contracts while adopting the sources' separation of test patience, clock semantics and resources.
[shared deadline helper][K1], [evidence freshness contract][K11], [domain clock boundary][K12], [timeout initialization][C2], [weighted test admission][N2]

## Retained sources and licences

Paths below are relative to `/home/edge/projects/rezics/rezics-next/.reference/`; the registry is `.reference/INDEX.md`.
Only the listed ideas are recommended for reimplementation in TypeScript/Bun/PostgreSQL; no source files or substantial
passages are proposed for copying. Licence links identify the inspected project licence, not a licence for this report.

| Project       | Retained repository                           | Inspected revision                         | Licence                                     |
| ------------- | --------------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| PostgreSQL    | `library-shelf-maintenance/postgres` (reused) | `700b422af7e26cf310caf3fb76d78f4c8ca39c1f` | [PostgreSQL License, COPYRIGHT][PL]         |
| Chromium      | `test-deadlines-under-load/chromium`          | `d3de019a49646d2d6ff086c10fabb4e3d1a8c698` | [BSD-3-Clause, LICENSE][CL]                 |
| CockroachDB   | `test-deadlines-under-load/cockroach`         | `d30c905fff79ef825adc96bcc647f1872a90f2ff` | [CockroachDB Software License, LICENSE][RL] |
| Kubernetes    | `test-deadlines-under-load/kubernetes`        | `53db21f676b21f64a3d0b343cf0714eadffa90b3` | [Apache-2.0, LICENSE][UL]                   |
| Bazel         | `test-deadlines-under-load/bazel`             | `b7a7fa1b357ad8813b0d2bac64f76e9152126e8a` | [Apache-2.0, LICENSE][BL]                   |
| Go            | `test-deadlines-under-load/go`                | `68d3532baa075e665e349f75c932b5a3fb9deca9` | [BSD-3-Clause, LICENSE][GL]                 |
| cargo-nextest | `test-deadlines-under-load/nextest`           | `2dc813284e32fc9637649cfad193ca0022b9eb71` | [MIT][NL1] OR [Apache-2.0][NL2]             |

[P1]: https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/doc/src/sgml/regress.sgml#L1002-L1007
[P2]: https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/test/perl/PostgreSQL/Test/Utils.pm#L109-L182
[P3]: https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/test/perl/PostgreSQL/Test/Cluster.pm#L2771-L2813
[P4]: https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/doc/src/sgml/regress.sgml#L81-L94
[P5]: https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/doc/src/sgml/config.sgml#L10777-L10801
[C1]: https://github.com/chromium/chromium/blob/d3de019a49646d2d6ff086c10fabb4e3d1a8c698/base/test/test_timeouts.cc#L58-L107
[C2]: https://github.com/chromium/chromium/blob/d3de019a49646d2d6ff086c10fabb4e3d1a8c698/base/test/test_timeouts.cc#L113-L167
[C3]: https://github.com/chromium/chromium/blob/d3de019a49646d2d6ff086c10fabb4e3d1a8c698/base/test/task_environment.h#L102-L123
[C4]: https://github.com/chromium/chromium/blob/d3de019a49646d2d6ff086c10fabb4e3d1a8c698/base/test/launcher/test_launcher.cc#L2251-L2278
[C5]: https://github.com/chromium/chromium/blob/d3de019a49646d2d6ff086c10fabb4e3d1a8c698/base/test/test_timeouts.h#L11-L20
[C6]: https://github.com/chromium/chromium/blob/d3de019a49646d2d6ff086c10fabb4e3d1a8c698/base/test/task_environment.h#L269-L304
[R1]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/testutils/soon.go#L20-L90
[R2]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/testutils/skip/skip.go#L127-L194
[R3]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/util/timeutil/time_source.go#L10-L31
[R4]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/sql/catalog/lease/lease_test.go#L1684-L1692
[R7]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/sql/catalog/lease/lease_test.go#L2220-L2228
[R5]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/util/timeutil/manual_time.go#L18-L85
[R6]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/util/timeutil/cpustopwatch.go#L14-L38
[U1]: https://github.com/kubernetes/kubernetes/blob/53db21f676b21f64a3d0b343cf0714eadffa90b3/test/e2e/framework/timeouts.go#L21-L62
[U2]: https://github.com/kubernetes/kubernetes/blob/53db21f676b21f64a3d0b343cf0714eadffa90b3/test/e2e/framework/timeouts.go#L119-L134
[U3]: https://github.com/kubernetes/kubernetes/blob/53db21f676b21f64a3d0b343cf0714eadffa90b3/test/e2e/framework/test_context.go#L425-L427
[U4]: https://github.com/kubernetes/kubernetes/blob/53db21f676b21f64a3d0b343cf0714eadffa90b3/test/e2e/framework/framework.go#L259-L272
[U5]: https://github.com/kubernetes/kubernetes/blob/53db21f676b21f64a3d0b343cf0714eadffa90b3/test/e2e/framework/test_context.go#L469-L477
[B1]: https://github.com/bazelbuild/bazel/blob/b7a7fa1b357ad8813b0d2bac64f76e9152126e8a/docs/reference/test-encyclopedia.mdx#L100-L173
[B2]: https://github.com/bazelbuild/bazel/blob/b7a7fa1b357ad8813b0d2bac64f76e9152126e8a/docs/versions/9.3.0/reference/be/common-definitions.mdx#L98-L100
[B3]: https://github.com/bazelbuild/bazel/blob/b7a7fa1b357ad8813b0d2bac64f76e9152126e8a/docs/reference/test-encyclopedia.mdx#L616-L624
[B4]: https://github.com/bazelbuild/bazel/blob/b7a7fa1b357ad8813b0d2bac64f76e9152126e8a/src/main/java/com/google/devtools/build/lib/analysis/test/TestStrategy.java#L275-L294
[B5]: https://github.com/bazelbuild/bazel/blob/b7a7fa1b357ad8813b0d2bac64f76e9152126e8a/docs/reference/test-encyclopedia.mdx#L509-L512
[G1]: https://github.com/golang/go/blob/68d3532baa075e665e349f75c932b5a3fb9deca9/src/testing/testing.go#L2325-L2337
[G4]: https://github.com/golang/go/blob/68d3532baa075e665e349f75c932b5a3fb9deca9/src/testing/testing.go#L2947-L2968
[G2]: https://github.com/golang/go/blob/68d3532baa075e665e349f75c932b5a3fb9deca9/src/testing/synctest/synctest.go#L5-L25
[G3]: https://github.com/golang/go/blob/68d3532baa075e665e349f75c932b5a3fb9deca9/src/testing/synctest/example_test.go#L74-L93
[N1]: https://github.com/nextest-rs/nextest/blob/2dc813284e32fc9637649cfad193ca0022b9eb71/site/src/docs/features/slow-tests.md#L6-L88
[N2]: https://github.com/nextest-rs/nextest/blob/2dc813284e32fc9637649cfad193ca0022b9eb71/site/src/docs/configuration/threads-required.md#L7-L39
[N3]: https://github.com/nextest-rs/nextest/blob/2dc813284e32fc9637649cfad193ca0022b9eb71/site/src/docs/configuration/test-groups.md#L7-L27
[N4]: https://github.com/nextest-rs/nextest/blob/2dc813284e32fc9637649cfad193ca0022b9eb71/site/src/docs/features/retries.md#L6-L125
[N5]: https://github.com/nextest-rs/nextest/blob/2dc813284e32fc9637649cfad193ca0022b9eb71/nextest-runner/src/config/elements/slow_timeout.rs#L8-L30
[K1]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/request/deadline.ts#L14-L47
[K2]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/command/command.ts#L1
[K3]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/database/pool.ts#L5-L41
[K4]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/command/command.ts#L418-L442
[K22]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/command/command.ts#L262-L280
[K5]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/access/auth-barriers.ts#L21-L30
[K19]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/access/auth-barriers.ts#L190-L195
[K20]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/access/auth-barriers.ts#L84-L94
[K6]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/commerce/commands.ts#L272-L299
[K7]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/commerce/commands.ts#L36-L100
[K8]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/access/membership-work-config.ts#L1-L6
[K9]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/scripts/check.ts#L247-L258
[K10]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/test/request-deadline.test.ts#L27-L75
[K11]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/access/evidence-deadline.ts#L1-L11
[K12]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/clock.ts#L1-L4
[K13]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/test/support/test-kernel.ts#L105-L164
[K14]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/test/commerce/request-deadlines.test.ts#L13-L32
[K15]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/scripts/test-lanes.ts#L116-L189
[K16]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/scripts/remote-check.ts#L515-L519
[K21]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/scripts/remote-check.ts#L59-L63
[K17]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/test/semantic/request-deadline-reads.test.ts#L44-L101
[K18]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/access/unavailable.ts#L22-L49
[PL]: https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/COPYRIGHT#L1-L22
[CL]: https://github.com/chromium/chromium/blob/d3de019a49646d2d6ff086c10fabb4e3d1a8c698/LICENSE#L1-L27
[RL]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/LICENSE#L1-L25
[UL]: https://github.com/kubernetes/kubernetes/blob/53db21f676b21f64a3d0b343cf0714eadffa90b3/LICENSE#L1-L16
[BL]: https://github.com/bazelbuild/bazel/blob/b7a7fa1b357ad8813b0d2bac64f76e9152126e8a/LICENSE#L1-L16
[GL]: https://github.com/golang/go/blob/68d3532baa075e665e349f75c932b5a3fb9deca9/LICENSE#L1-L27
[NL1]: https://github.com/nextest-rs/nextest/blob/2dc813284e32fc9637649cfad193ca0022b9eb71/LICENSE-MIT#L1-L21
[NL2]: https://github.com/nextest-rs/nextest/blob/2dc813284e32fc9637649cfad193ca0022b9eb71/LICENSE-APACHE#L1-L16
[linux-cpu]: https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#cpu-interface-files
[K23]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/http/app.ts#L40-L66
[K24]: https://github.com/rezics/rezics-next/blob/cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f/services/kernel/src/http/app.ts#L313-L318
