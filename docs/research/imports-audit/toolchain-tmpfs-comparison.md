# Importer deadline comparison with tmpfs SQLite

All six named suites complete successfully under both exact runtimes on captured product revision
`34a2a6e6815f455d5179ebefcd8d6cb303676c04`, tree `6308c34a7c1369c40b8d2880f980006a93eab04e`.
These observations establish matching scenario outcomes for **these six suites only** under the supported tmpfs
storage precondition. All twelve commands finished exit 0, with no failed scenarios. None was rerun.

This corrects the verification environment in [the historical report](toolchain-compatibility.md), preserved
unchanged. That report explicitly put fsync-heavy SQLite temporary files under `.temp` on Btrfs, violating the
adopted imports precondition: SQLite files use `os.tmpdir()` on tmpfs. Its same-tree timing differences do not
isolate a canary defect. This report changes no product/runtime policy, assertion, timeout or growth bound.

## Source and setup

The first two pairs ran at the assigned checkout root:
`/home/edge/projects/rezics/worktrees/5a2cb6b8-abf0-4f7d-9ce9-7a220507de0a`.
Original source identity and clean status remain in `.temp/toolchain-tmpfs-comparison/source.txt` and
`source-status.txt`. The four retained receipts were revalidated as finished exit 0 before continuation;
PIDs 4095808, 4095814 and 1693512 were absent. No command's death was inferred from elapsed time.
Original `order.txt`, logs, result records and comparison state are untouched.

The earlier continuation found integration revision `ef2a1f3e3fc42b7ea2580e2ca8aaa16c1483835a`, tree
`2b214bfc5488e0ab80d15d6210b5ac8f938ae61b`, had changed executable Definitions dependencies, generated client,
kernel dependencies and `bun.lock`. Importer source equality alone was insufficient; no remaining suite was
started there. Partial evidence was committed in `3e493d9b0ddd82c2848e50683774dd13466196b5` and retained in
`ffe5ac67dc`. The current continuation began at `c6e09111af650fe19f1e53ef0c480205d93bab85` and likewise did
not measure that integration product tree.

Following the captured-checkout ruling, the remaining eight commands ran in one detached measurement checkout:
`.temp/toolchain-tmpfs-comparison/measurement` under the assigned worktree. Its HEAD is exactly the captured
revision above, with tracked tree `6308c34a7c1369c40b8d2880f980006a93eab04e`, clean after installation and again
before the final measurement. Report commits on the assigned branch never changed measured product bytes.
The absolute checkout prefix differs from the first two pairs; relative package cwd and suite arguments do not.

The measurement checkout installed its **own** dependency graph normally:

```sh
env TMPDIR=/tmp TMP=/tmp TEMP=/tmp bun install --frozen-lockfile
```

Exit 0 with Bun 1.4.3, 885 packages installed; log:
`.temp/toolchain-tmpfs-comparison/dependency-install.log`. No lockfile change, transplanted workspace files,
symlinked current `node_modules`, dependency edit or host/global binary mutation occurred.
`node_modules/@rezics/definitions` resolves to the measurement checkout's own `packages/definitions`.
The original worker-check and placement tooling is retained. SHA-256 identities in that checkout:

| File                             | SHA-256                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `scripts/worker-check.ts`        | `b441b923ff37fd0a7a53ac8c5b1dcd978c771bfe8e936d01660637cf8dbf22df` |
| `scripts/stack-lease-preload.ts` | `04d94e46e48d9d85ec34fd4f371903f2bd72139034d31e607f662a2391783f20` |
| `bun.lock`                       | `aad3bf47b7bfa11c8bbe68e356fa3ca0974099c4be148f763b2392ebc1945c79` |

## Runtime, storage and command identity

| Runtime                                                                            | Resolved executable                                                                                   | Full revision                              |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Pinned `bun@1.4.4-canary.20261027.1`; `Bun.version` 1.4.4, banner `1.4.4-canary.1` | Each measured checkout's `node_modules/.bun/bun@1.4.4-canary.20261027.1/node_modules/bun/bin/bun.exe` | `a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b` |
| Previous supported Bun 1.4.3                                                       | `/home/edge/.bun/bin/bun`                                                                             | `c6da4a4d3010e5553438c60f6bd76d981976867c` |

Original probes are retained in `.temp/toolchain-tmpfs-comparison/runtime.jsonl`. Both exact runtimes were resolved
and probed again after captured-checkout installation, before invoking children. Both reported `os.tmpdir()=/tmp`
and actual `statfsSync` filesystem type `1021994` (hexadecimal tmpfs magic); `stat -f` independently reported
`tmpfs 1021994`. Every continuation command explicitly sets `TMPDIR=TMP=TEMP=/tmp`, replacing inherited `.temp`
settings. SQLite uses tmpfs; logs, receipts, installation and report artifacts remain under `.temp` or the declared
report path. No `.temp` SQLite override was used.

From the relevant checkout root, each invocation used normal admission and these exact options:

```sh
env TMPDIR=/tmp TMP=/tmp TEMP=/tmp bun scripts/worker-check.ts -- \
  sh -c 'cd services/importer && exec "$@"' comparison "$RUNTIME" test ./tests/NAME.test.ts
bun scripts/worker-check.ts --wait ID
```

`RUNTIME` is the fully resolved executable in the table, never an implicit host replacement. Receipts contain the
literal argv and absolute cwd. The wrapper launcher was available Bun 1.4.3; test banners confirm the selected
subject. Each same check ID was waited to terminal status. Normal shared admission and inherited
`GOAL_CHECK_WAIT_FILE` were preserved; no class, deadline, slot or admission limits changed. No placement defect
or raw unbound specification invocation occurred in this continuation.

The original loop incorrectly overrode `GOAL_CHECK_WAIT_FILE` with a comparison-local path. The real control
plane monitors `runs/<task>/<attempt>.check-wait` through `launch.ts` checkWaitMs; no file existed there for that
loop. This was a wait-accounting error, not proof of a stuck queued process. Its old comparison wait file remains
historical evidence. This continuation left the inherited variable intact and fabricated no wait accounting.

## Exact scenario results

Every cell below has exit 0 and no failure identity. Outcome wrappers retain their 120,000 ms deadline and spawn
`process.execPath test --timeout 30000` with the original bound driver. Their five assertions require a positive
scenario count, child exit 0, the exact child pass count, zero failures and no skips/todos. Passing wrappers prove
all named child cases even though child output is printed only on failure.

| Suite (`tests/*.test.ts`)        | Previous                                            | Canary                                              |
| -------------------------------- | --------------------------------------------------- | --------------------------------------------------- |
| `bindings-growth`                | 5 direct pass, 0 fail; 27 expectations              | 5 direct pass, 0 fail; 27 expectations              |
| `bindings-outcomes`              | 1 outer pass, 0 fail; 5 expectations; 5 child pass  | 1 outer pass, 0 fail; 5 expectations; 5 child pass  |
| `cli-credentials-outcomes`       | 1 outer pass, 0 fail; 5 expectations; 9 child pass  | 1 outer pass, 0 fail; 5 expectations; 9 child pass  |
| `cli-outcomes`                   | 1 outer pass, 0 fail; 5 expectations; 13 child pass | 1 outer pass, 0 fail; 5 expectations; 13 child pass |
| `importer-reconciliation-growth` | 2 direct pass, 0 fail; 177 expectations             | 2 direct pass, 0 fail; 177 expectations             |
| `pipeline-outcomes`              | 1 outer pass, 0 fail; 5 expectations; 14 child pass | 1 outer pass, 0 fail; 5 expectations; 14 child pass |

The execution-order receipts and log paths below distinguish each exact measurement. First four log paths are
relative to the assigned checkout; remaining eight are relative to the measurement checkout. Result records are
alongside each log under `.temp/goal/checks/results/<id>.json` and contain status `finished`, exitCode 0.

| Suite                            | Runtime  | Check ID                               | Log path                                                               |
| -------------------------------- | -------- | -------------------------------------- | ---------------------------------------------------------------------- |
| `bindings-growth`                | previous | `66c6c995-a3fc-4b2e-9456-6f7705f0b727` | `.temp/goal/checks/worker-check-2026-10-28T20-07-47.268Z-1a528c10.log` |
| `bindings-growth`                | canary   | `7e46935a-fb6c-41a2-8c30-8ef4ec8f0784` | `.temp/goal/checks/worker-check-2026-10-28T20-18-55.797Z-98cebcc1.log` |
| `bindings-outcomes`              | canary   | `57aefcc3-3666-4edd-bef7-1c5ba27c79b3` | `.temp/goal/checks/worker-check-2026-10-28T20-31-21.057Z-f53206a3.log` |
| `bindings-outcomes`              | previous | `ac3abd57-e86d-4cb3-8ac9-3fa10f09073c` | `.temp/goal/checks/worker-check-2026-10-28T20-56-19.033Z-1597fbdc.log` |
| `cli-credentials-outcomes`       | previous | `57e628fb-1451-4813-a1e8-a0267e948ce8` | `.temp/goal/checks/worker-check-2026-10-29T05-01-20.531Z-9c940427.log` |
| `cli-credentials-outcomes`       | canary   | `7245f589-abf2-48c1-8e37-6457f72d761a` | `.temp/goal/checks/worker-check-2026-10-29T05-01-34.952Z-f2fd68fa.log` |
| `cli-outcomes`                   | canary   | `73164a74-d59b-4372-8e14-ab1c9662ad3b` | `.temp/goal/checks/worker-check-2026-10-29T05-01-45.049Z-3af3a6d5.log` |
| `cli-outcomes`                   | previous | `137dd644-1fc6-49e6-8124-ba47fa760910` | `.temp/goal/checks/worker-check-2026-10-29T05-01-55.673Z-0e8ce797.log` |
| `importer-reconciliation-growth` | previous | `9c72e449-a74c-47dd-80b2-511303ad9811` | `.temp/goal/checks/worker-check-2026-10-29T05-02-04.608Z-94c892ec.log` |
| `importer-reconciliation-growth` | canary   | `162b84f4-6fee-48dd-b7ed-ad0559d9c94f` | `.temp/goal/checks/worker-check-2026-10-29T05-02-15.938Z-093afc71.log` |
| `pipeline-outcomes`              | canary   | `97ae0653-cb63-4fa6-8838-d105f42bca19` | `.temp/goal/checks/worker-check-2026-10-29T05-02-30.769Z-cb22af27.log` |
| `pipeline-outcomes`              | previous | `40d28e53-77cd-44f1-9b85-39673f51fc57` | `.temp/goal/checks/worker-check-2026-10-29T05-03-02.126Z-ac6e671d.log` |

## Comparison with Btrfs observations

| Earlier exact failure identity                                                                            | Observation under verified tmpfs, both runtimes                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bindings-growth`: candidate page, media projection, binding write, media write exceed 5,000 ms on canary | All four pass; binding lookup also passes, five total                                                                                                                                |
| `bindings-outcomes`: both 120,000 ms wrapper deadlines, dangling children                                 | Both complete all five child cases: durable public-result bindings, media journals, hostile JSON rejection, capped candidate pages, indexed fixed operations against growing history |
| `cli-credentials-outcomes`: canary long-import renewal exceeds 30,000 ms                                  | Long-import renewal passes, as do all nine child cases                                                                                                                               |
| `cli-outcomes`: canary fixed changes/indexed costs/streaming exceeds 30,000 ms                            | That exact scenario passes, as do all thirteen child cases                                                                                                                           |
| `importer-reconciliation-growth`: both actual coordinator fixed-work 120,000 ms deadlines                 | Coordinator growth passes in both; acquisition/EOF-before-effects also passes, two total                                                                                             |
| `pipeline-outcomes`: canary ordered completion/concurrency child deadline and wrapper deadline            | That exact scenario and all fourteen child cases complete in both                                                                                                                    |

None of these earlier deadline failure identities remains in this bounded comparison. Matching success is proved
for the six named suites on the captured source with its frozen dependency graph; broader runtime equivalence,
performance equivalence and runtime-specific causality are not proved. The Btrfs report used another product
revision (`123ef44b951e531012ddcb6a999ae83198854e4d`), load/caches were uncontrolled, and the continuation prefix
changed. Storage alone is not isolated as the causal variable. Equal deadline failures can be load-sensitive;
elapsed times alone are not a runtime diagnosis. No suite was rerun until green.

## Delivery and limits

The first setup report was committed before further admission, and the report was committed before each following
check and after every completed pair. Earlier UNEXECUTED checkpoints are preserved in commit history; all four
remaining pairs are now complete. No compiler/pure converter check, known Bangumi product-red assertion,
deterministic growth-cap mismatch, full package, root, kernel or web gate was repeated. No new unknown creator
or compiler diagnostic arose to route to manager/performance. Native API/discovery/main verification remains
separate. Final declared acceptance is artifact presence only, run from the assigned branch after this report commit.

Inspected: historical and partial reports, retained identities/order/receipts/logs, development entry point,
architecture, scope and Goal definitions, workflow verification and maintenance instructions; captured manifest,
lockfile, worker-check, admission/preload/placement helpers and runbook; importer outcome wrappers, child scenario
names and workspace dependency resolution. No reference implementation is named for this verification correction,
and no reference-project source was needed. Only this declared report is a tracked change; no outside-path product
file changed. The detached checkout, installation and evidence are authorized temporary measurement setup.
