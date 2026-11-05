# Conversion and importer toolchain verification

Verified on 29 October 2026 (Asia/Shanghai). Both package checks and the differential below used the unchanged
source revision `123ef44b951e531012ddcb6a999ae83198854e4d`, tree
`e7055ec0efbe2d12d3ef1c263e14e5f3f42290f7`. This report is the only tracked change.

**Both native typechecks completed without diagnostics, and both package scripts reached their test suites.**
The checks exited 1. Conversion failures match the documented missing Bangumi scope implementation. Importer
has those missing outcomes, an inherited growth-harness mismatch, shared deadline failures, and additional
canary deadline failures whose exact suites pass under the previous runtime. Importer runtime equivalence is
therefore **not established**. File-presence acceptance establishes only delivery of this report.

## Commands and installed tools

The inspected change `7b4a70e6f81e9202695b7a11d0d1a7d46a66a0c6` changes both package checks from
`tsc --noEmit -p tsconfig.json && bun test` to `bun check --no-script -p tsconfig.json && bun test`, and adds
`typecheck: bun check --no-script -p tsconfig.json`. Neither test command was removed or filtered.
`bd8674aa2e29445801b1298d9089df21033384ea` makes the root typecheck use `resolveBunCommand` from
`scripts/gate.ts`, resolving the installed executable before spawning a workspace command.

Root `packageManager`, dependency and lockfile select `bun@1.4.4-canary.20261027.1`. The installed executable is
`node_modules/.bin/bun`, resolving inside this checkout to
`node_modules/.bun/bun@1.4.4-canary.20261027.1/node_modules/bun/bin/bun.exe`.
Its installed package metadata includes release suffix `+9b8347a`; that suffix is separate from the binary revision:

- `Bun.version`: `1.4.4`; `bun --revision`: `1.4.4-canary.1+a0cc096ce`.
- Full `Bun.revision`: `a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b`.
- Previous available executable: `/home/edge/.bun/bin/bun`, version `1.4.3`, full revision
  `c6da4a4d3010e5553438c60f6bd76d981976867c`.
- Installed `tsc --version`: `7.1.0-beta`. It was identified, but neither changed check invokes it.
  `--no-script` selects Bun's built-in checker; both tsconfigs include `src` and `tests`.

With `B` set to the absolute checkout-local `node_modules/.bin/bun`, the two actual invocations were:

```sh
"$B" scripts/worker-check.ts -- "$B" run --cwd packages/conversion check
"$B" scripts/worker-check.ts -- "$B" run --cwd services/importer check
```

Each ran once, sequentially, before any tracked edit. PATH also started with this checkout's `node_modules/.bin`.
The test banners identify `a0cc096ce`; `/proc` additionally confirmed that the live importer `bun test` executable
was the installed canary. Outcome wrappers spawn `process.execPath`, preserving that executable for their children.
No reliance on bare `Bun.spawn('bun')` was needed. No new runtime-selection defect was established.

To keep writes inside the checkout, both runs and the baseline set `TMPDIR` to
`.temp/toolchain-compatibility/tmp` and `REZICS_TEST_ESTIMATES_DIR` to `.temp/toolchain-compatibility/estimates`,
using absolute paths. This temporary directory is on Btrfs; the host's default `/tmp` is tmpfs. This materially limits
wall-time comparisons with earlier reports. Check routing/admission was not disabled or replaced, deadlines were
not enlarged, and no dependency installation, cache modification or host-binary change was performed.

## Exact package evidence

Counts below are outer runner counts: successful child specification suites are additional executions, not extra
outer tests. Logs are local, untracked evidence retained under `.temp/`.

| Package    | Native checker output                    | Outer test result                                                      | Script exit |
| ---------- | ---------------------------------------- | ---------------------------------------------------------------------- | ----------- |
| Conversion | `No type errors in 51 files [454.28ms]`  | 65 pass, 3 fail; 68 tests, 24 files; 5,668 expectations; 5.38 s        | 1           |
| Importer   | `No type errors in 120 files [613.92ms]` | 182 pass, 14 fail; 196 tests, 54 files; 406,668 expectations; 921.31 s | 1           |

Conversion log: `.temp/goal/checks/worker-check-2026-10-28T17-35-25.000Z-b0ca3b3f.log`.
Importer log: `.temp/goal/checks/worker-check-2026-10-28T17-35-30.916Z-c6bf1661.log`.
Commands and exact exits: `.temp/toolchain-compatibility/results.json`; runtime identity:
`.temp/toolchain-compatibility/runtime.json` and `process-evidence.json` in the same directory.

The first conversion failures are excluded types 3 and 6 at `tests/bangumi-scope.test.ts:103`:
`Expected path: "outcome"`, `Expected value: "ignored"`, `Unable to find property`.
The third is line 131: `Expected: not "bangumi@2"`. The first importer failure is
`tests/bangumi-scope.test.ts:108`: missing `skipped: 2`. Initial mixed acquisition and both recovery cases fail
there; the CLI case at line 265 receives `Import complete: new=5 changed=0 unchanged=0 vanished=0\n`, missing
`/\bskipped=2\b/`. These exact seven product assertions are already documented as intentionally red in
[Bangumi scope evidence](bangumi-scope.md). Later assertions in each failing case remain unproved.

## Same-tree previous-runtime comparison

After the package runs finished and no test child remained, one comparison executed these eight exact affected
files from working directory `services/importer`, using the absolute previous executable with `test` and eight
`./tests/<name>` arguments, through the installed-runtime worker-check wrapper:

```text
bangumi-scope.test.ts                 bindings-growth.test.ts
bindings-outcomes.test.ts             cli-credentials-outcomes.test.ts
cli-outcomes.test.ts                  importer-growth.test.ts
importer-reconciliation-growth.test.ts pipeline-outcomes.test.ts
```

Result: **exit 1; 9 pass, 7 fail; 16 tests across 8 files; 523 expectations; 377.93 s**.
Log: `services/importer/.temp/goal/checks/worker-check-2026-10-28T17-51-25.350Z-11a92708.log`.
Full invocation: `.temp/toolchain-compatibility/baseline-corrected-result.json`.
An initial launch placing `--cwd services/importer` before `test` returned `error: Script not found "test"`
before discovery; setting the subprocess working directory corrected that invocation once. Its log is
`.temp/goal/checks/worker-check-2026-10-28T17-51-04.520Z-dc3191d9.log`; it supplies no test evidence.

| Exact affected scenario/file                                                         | Canary observation                                                           | Previous runtime on the same tree                           | Classification                                                      |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `bangumi-scope`: mixed dump, remote-success resume, finalization resume, CLI summary | Four failures above; remote-success resume also reports 5,000 ms timeout     | Same four missing-field/summary assertions; no timeout      | Missing product work; additional canary timing diagnostic           |
| `bindings-growth`: candidate page, media projection, binding write, media write      | All four exceed 5,000 ms; 7,385.12 / 7,382.76 / 25,206.61 / 10,470.99 ms     | All four pass; 1,824.23 / 2,815.25 / 3,857.47 / 3,212.25 ms | Canary-only deadline failures in this observation                   |
| `bindings-outcomes`                                                                  | Wrapper times out at 120,000 ms and reports a dangling child killed          | Same wrapper deadline and child termination                 | Reproduced deadline; neither run completes all five child scenarios |
| `cli-credentials-outcomes`: long-import renewal                                      | Child times out at 30,000 ms; child summary 8 pass/1 fail; wrapper fails     | Wrapper passes, requiring all nine child scenarios          | Canary-only deadline failure                                        |
| `cli-outcomes`: fixed changes/indexed costs/streaming                                | Child times out at 30,000 ms; child summary 12 pass/1 fail; wrapper fails    | Wrapper passes, requiring all thirteen child scenarios      | Canary-only deadline failure                                        |
| `importer-growth`: Kernel call stays within its bound as R grows                     | `TypeError: The largest growth scale must be no greater than 4096`           | Identical diagnostic and stack location                     | Existing test/harness mismatch, not compiler rejection              |
| `importer-reconciliation-growth`: actual coordinator fixed work                      | 120,000 ms deadline; reported 148,669.58 ms                                  | Same deadline; reported 146,226.65 ms                       | Reproduced deadline; acquisition/EOF scenario passes in both        |
| `pipeline-outcomes`: ordered completion/concurrency                                  | Child case exceeds 30,000 ms; wrapper exceeds 120,000 ms and kills its child | Wrapper passes, requiring all fourteen child scenarios      | Canary-only deadline failures and incomplete child execution        |

This compares named scenarios and diagnostics, not just failure totals. Load and caches were uncontrolled, and
only failing files were selected for the baseline. The previous runtime even reports a passing binding lookup
at 6,924.52 ms against the nominal 5,000 ms default. These observations do not isolate runtime timeout behavior,
SQLite cost or competing load. They establish concrete differences requiring follow-up, not a proven cause or
a successful equivalence result. No assertion, timeout or product code was changed, and no suite was retried to green.

Performance owns toolchain compatibility in `docs/development/verification.md`; imports owns these package tests.
Minimal reproduction for each deadline difference is the absolute pinned executable running
`test ./tests/<affected-file>` from `services/importer`, with the temporary-directory settings above.
For the deterministic growth mismatch, that file is `importer-growth.test.ts`: its `[500, 4000, 32000]` scales
conflict with the 4096 cap in performance's `services/kernel/test/support/growth-bound.ts:75`.
These existing defects and compatibility questions are recorded for their owners; this report changes neither surface.

## Coverage retained and limits

All 24 conversion and 54 importer tracked `*.test.ts` files were discovered. No test-name filter, bail flag,
`test.skip` or `test.todo` was added; inspection found no such skip/todo declarations in these suites.
The four converter outcome wrappers bind the real Bangumi, VNDB, Open Library and Wikidata converters through
local drivers, validate actual proposals and spawn the unchanged source specifications. They require exact child
pass counts and zero failures/skips/todos. All four passed: respectively 14, 7, 17 and 13 source scenarios.
The Open Library semantic validator is a local structural consumer, not native API execution.

Importer drivers retain real `bun:sqlite` storage: `RunStore` constructs the database; `ImportSession` shares it
with `RecordBindings`; the binding driver forwards the supplied probed handle. CLI uses `runImportCli`, pipeline
uses `Importer`, source registration and production media resolution, and transport exports `createImportTransport`
from the generated-client adapter. Fake HTTP boundaries do not replace local SQLite with an in-memory model.
Nine outcome wrappers passed, enforcing 187 child scenarios across archive, dumps, HTTP bounds, ledger, media
resolver, reader bounds, run plans, run store and transport. Session ownership, dead-process recovery, uncertain
request replay, deferred-cover recovery, fences, Retry-After layering, logical retry budgets and adaptive write-width
cases also have explicit passes in the importer log.

Coverage is retained in the scripts and executable assertions, but successful completion is incomplete: binding
and pipeline wrappers visibly fail rather than silently accepting missing child cases. Bindings prints four of
five child passes before termination; pipeline prints six passes and one timeout before termination, without a
complete fourteen-case summary. CLI failures remain visible. No claim is made for assertions after an early failure.
These package suites **do not prove native API/discovery capability closure**, Auth/Access integration, production
media fetching, complete source-statistic integration, or promotion/main verification. No kernel, web or root gate
was run. The earlier verification document's paired zero-diagnostic compiler measurements do not supply that proof;
this attempt did not repeat a tsc differential because no new compiler diagnostic arose.

## Delivery decisions and inspected sources

The required root typecheck ran once with the absolute pinned executable and
`TYPECHECK_CHANGED=docs/research/imports-audit/toolchain-compatibility.md`: exit 0,
`Checking 0 of 13 workspaces the change can affect.` This uses the existing Markdown exclusion and proves no
additional workspace compatibility. Log: `.temp/goal/checks/worker-check-2026-10-28T17-57-49.802Z-e1b29820.log`.
The report-only contract authorizes no new tests or product/package/script repairs. Only this declared report is
changed; there are no files outside declared paths to justify or separately test. Final artifact acceptance is
`test -s docs/research/imports-audit/toolchain-compatibility.md`.

Inspected sources: repository instructions, development workflow and Goal definitions; both package READMEs,
manifests and tsconfigs; root manifest/lockfile, verification toolchain evidence, `scripts/toolchain.test.ts`,
`gate.ts`, `typecheck.ts`, worker-check, admission/preload and estimate helpers; source outcome specifications,
converter drivers/wrappers and scope tests; importer outcome drivers/wrappers, SQLite storage/session code and
relevant CLI, transport, retry, recovery and growth tests; the Bangumi scope and API-boundary evidence reports.
The read-only reference index was inspected. No reference-project implementation was designed, copied or executed.

### Verify the affected toolchain commands

- Touches: two existing package checks, their actual source/local outcome suites, and eight affected baseline files.
- Bound: one complete check per changed package; one executed previous-runtime comparison of eight named files;
  one corrected pre-discovery launch error, one documentation-scoped root typecheck and artifact presence acceptance.
- Growth check: existing suites supply their recorded successes and failures above. No production operation or new
  growth claim is introduced, and these elapsed times are not an isolated performance benchmark.
