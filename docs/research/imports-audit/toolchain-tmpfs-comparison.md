# Importer deadline comparison with tmpfs SQLite

This corrects the verification environment in [the historical report](toolchain-compatibility.md), which is
preserved unchanged. That report explicitly put SQLite temporary files on Btrfs under `.temp`. The adopted
imports precondition requires fsync-heavy SQLite files in `os.tmpdir()` on tmpfs. Its same-tree timing differences
do not isolate a canary defect.

## Captured inputs and continuation

The completed measurements used product revision `34a2a6e6815f455d5179ebefcd8d6cb303676c04`, tree
`6308c34a7c1369c40b8d2880f980006a93eab04e`. Original identities and clean status are retained in
`.temp/toolchain-tmpfs-comparison/source.txt` and `source-status.txt`.

On continuation, the checkout is already at `ef2a1f3e3fc42b7ea2580e2ca8aaa16c1483835a`, tree
`2b214bfc5488e0ab80d15d6210b5ac8f938ae61b`, with a clean worktree. This is not a report-only difference:
`packages/definitions/src/index.ts` and `compile.ts`, generated client declarations, kernel source, lockfile and
check tooling changed. Importer source/tests themselves have no diff. Running the remaining commands directly
here would mix product inputs; no such commands have been admitted. The remaining pairs require the captured
source, including its workspace dependencies, before execution. This continuation has not restored product files
or constructed a substitute dependency/placement environment: its contract permits only the new report and
requires the same original package cwd and options. Remaining commands are withheld rather than measuring
changed product bytes and presenting them as the captured tree.

The four retained result records were revalidated as `finished`, exit 0. PIDs 4095808, 4095814 and 1693512 are
absent. No completion is inferred from elapsed time, and none of those four commands is rerun.

## Runtime and storage identities

The original `.temp/toolchain-tmpfs-comparison/runtime.jsonl` records both executable identities:

| Runtime | Resolved executable | Full revision |
| --- | --- | --- |
| Pinned `bun@1.4.4-canary.20261027.1`, `Bun.version` 1.4.4, banner `1.4.4-canary.1` | checkout `node_modules/.bun/bun@1.4.4-canary.20261027.1/node_modules/bun/bin/bun.exe` | `a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b` |
| Previous supported Bun 1.4.3 | `/home/edge/.bun/bin/bun` | `c6da4a4d3010e5553438c60f6bd76d981976867c` |

The checkout prefix is `/home/edge/projects/rezics/worktrees/5a2cb6b8-abf0-4f7d-9ce9-7a220507de0a`.
Both runtime probes resolved `os.tmpdir()` to `/tmp` and filesystem type `1021994` (hexadecimal tmpfs magic).
Continuation independently confirms `/tmp` with `stat -f`: `tmpfs 1021994`. Database storage is not redirected
under `.temp`; logs, identities and result records are retained there. Runtime identity and tmpfs must be checked
again before any remaining suite child is invoked.

## Completed pairs

Each outer invocation used normal worker-check admission from the checkout root, with command arguments:

```sh
sh -c 'cd services/importer && exec "$@"' comparison "$RUNTIME" test ./tests/NAME.test.ts
```

No test-name filter or timeout override was supplied. Outcome wrappers retain their 120,000 ms deadline and
launch their original child specifications with `process.execPath` and `--timeout 30000`, requiring exact child
pass counts, zero failures and no skips/todos. A passing binding wrapper proves all five child cases even though
it prints child output only on failure. The following paths are relative to `.temp/goal/checks/`.

| Suite | Previous exit / scenarios | Canary exit / scenarios | Previous log | Canary log |
| --- | --- | --- | --- | --- |
| `bindings-growth` | 0; 5 pass, 0 fail, 27 expectations | 0; 5 pass, 0 fail, 27 expectations | `worker-check-2026-10-28T20-07-47.268Z-1a528c10.log` | `worker-check-2026-10-28T20-18-55.797Z-98cebcc1.log` |
| `bindings-outcomes` | 0; outer 1 pass, 0 fail, 5 expectations; child 5 pass, 0 fail | 0; outer 1 pass, 0 fail, 5 expectations; child 5 pass, 0 fail | `worker-check-2026-10-28T20-56-19.033Z-1597fbdc.log` | `worker-check-2026-10-28T20-31-21.057Z-f53206a3.log` |

Growth scenarios are binding lookup, candidate page, media projection, binding write and media write staying
within their growth bounds. All five pass in both runtimes. Outcome scenarios cover durable public-result
bindings, media journals, hostile JSON rejection, capped candidate pages and indexed fixed binding operations
against growing same-source SQLite history;
all five are required by the unchanged wrapper. Neither completed suite has a failure identity.

Retained check IDs in execution order are `66c6c995-a3fc-4b2e-9456-6f7705f0b727`,
`7e46935a-fb6c-41a2-8c30-8ef4ec8f0784`, `57aefcc3-3666-4edd-bef7-1c5ba27c79b3`,
`ac3abd57-e86d-4cb3-8ac9-3fa10f09073c`. Exact commands, exits and status are in
`.temp/goal/checks/results/<id>.json`; original order is `.temp/toolchain-tmpfs-comparison/order.txt`.

## Continuation source conflict

The first partial report was committed as `3e493d9b0ddd82c2848e50683774dd13466196b5` before any further
check admission. Revalidation found the source conflict above before invoking a remaining suite. The supplied
checkout and the required captured product tree differ in executable workspace dependencies, while the contract
forbids product/dependency changes and rerunning completed measurements. The remaining four pairs cannot be
claimed on that captured source using the supplied normal package setup. A checkout/setup containing the captured
product bytes is needed to continue all six pairs coherently. This is unavailable evidence, not a runtime failure,
a passing comparison, or an elapsed-time diagnosis. No remaining pair was started; `order.txt` still has four entries.

## Remaining pairs and accounting correction

| Suite | Previous | Canary | Required scenarios |
| --- | --- | --- | --- |
| `cli-credentials-outcomes` | UNEXECUTED | UNEXECUTED | 1 outer, 9 child |
| `cli-outcomes` | UNEXECUTED | UNEXECUTED | 1 outer, 13 child |
| `importer-reconciliation-growth` | UNEXECUTED | UNEXECUTED | 2 direct |
| `pipeline-outcomes` | UNEXECUTED | UNEXECUTED | 1 outer, 14 child |

The original loop overrode `GOAL_CHECK_WAIT_FILE` with `.temp/toolchain-tmpfs-comparison/check-wait`.
The control plane monitors `runs/<task>/<attempt>.check-wait` through `launch.ts` checkWaitMs, so that override
left no wait file at the monitored location. This is a wait-accounting error, not evidence that a queued process
was stuck. The inherited continuation variable must remain intact; there is no fabricated accounting, admission
bypass or limit change. The existing comparison wait file is preserved as historical evidence.

## Comparison limits and inspected sources

Under the supported storage precondition, the earlier four canary binding-growth deadlines and both binding
outcome wrapper deadlines disappear in these observations. The earlier report used a different product revision
(`123ef44b951e531012ddcb6a999ae83198854e4d`); this correction does not isolate storage as the sole causal variable.
The remaining four tmpfs pairs are unavailable evidence, never passes. Equivalence for all six suites is not
proved. Equal deadline failures could be load-sensitive; elapsed times alone cannot diagnose runtime behavior.
Native API/discovery/main verification remains separate. Compiler/pure converter checks, Bangumi product-red
assertions and the deterministic growth-cap mismatch were not repeated. No new creator/compiler diagnostic arose.

Inspected: historical report; retained source/runtime/order/result records and four logs; development entry point,
architecture, scope, Goal definitions, workflow verification/review and maintenance instructions; worker-check,
stack-lease preload, check routing runbook, importer and definitions manifests, outcome wrappers and source scenario
names, plus the definitions source diff needed to validate captured inputs. No reference-project implementation is
required for this verification-environment correction. Only this report is a tracked change; no outside-path files
are changed. Final acceptance is artifact presence only; the continuation explicitly excludes root/kernel/web gates.

## Captured measurement checkout continuation

The retained four receipts were revalidated as finished exit 0; the three historical PIDs remain absent.
No additional original order entry exists. The assigned branch now starts at `c6e09111af650fe19f1e53ef0c480205d93bab85`;
its product files are not used for the remaining measurements.

A detached measurement checkout was created at
`.temp/toolchain-tmpfs-comparison/measurement`, HEAD `34a2a6e6815f455d5179ebefcd8d6cb303676c04`,
tracked tree `6308c34a7c1369c40b8d2880f980006a93eab04e`, clean after installation.
This changes the absolute checkout prefix from the first two pairs; package cwd remains `services/importer`.
`env TMPDIR=/tmp TMP=/tmp TEMP=/tmp bun install --frozen-lockfile` exited 0, installing 885 packages
with Bun 1.4.3; log: `.temp/toolchain-tmpfs-comparison/dependency-install.log`.
The checkout owns its dependency installation. Its `node_modules/@rezics/definitions` resolves into its own
`packages/definitions`; no current workspace dependencies were transplanted.

Both exact executable revisions were resolved again: the captured checkout's installed
`node_modules/.bun/bun@1.4.4-canary.20261027.1/node_modules/bun/bin/bun.exe` is
`a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b` (1.4.4), and `/home/edge/.bun/bin/bun` is
`c6da4a4d3010e5553438c60f6bd76d981976867c` (1.4.3).
Both probes with `TMPDIR=TMP=TEMP=/tmp` report `os.tmpdir()=/tmp`, filesystem `1021994` (tmpfs).
These verified storage variables will be passed to each wrapper; inherited `GOAL_CHECK_WAIT_FILE` is unchanged.

The measurement uses its original worker-check and preload, not replacement tooling. SHA-256:
worker-check `b441b923ff37fd0a7a53ac8c5b1dcd978c771bfe8e936d01660637cf8dbf22df`;
stack-lease-preload `04d94e46e48d9d85ec34fd4f371903f2bd72139034d31e607f662a2391783f20`;
lockfile `aad3bf47b7bfa11c8bbe68e356fa3ca0974099c4be148f763b2392ebc1945c79`.
All four remaining pairs are still UNEXECUTED at this checkpoint. The next admission is previous
`cli-credentials-outcomes`, with the original shell/package cwd and exact test arguments above.
