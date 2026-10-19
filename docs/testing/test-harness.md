# Executable test harness

Use `task test` for a changed slice and `task qa` for a complete tier or
qualification run. The [toolchain](../development/toolchain.md) lists commands
and versions; the [case declarations](../../scripts/qa/cases/) own acceptance
scenarios. The harness writes evidence under `.artifacts/qa/<run-id>/`.

## Backend-only Goal scope

For an ordinary backend batch, run `task test -- --affected [<base>]`, then
relevant static checks. Restore a prepared fixture when needed; preparation,
startup and readiness share a 600-second ceiling under the [data preparation
policy](../storage/workload-budgets.md#data-preparation-and-import). Do not
reconstruct a full corpus for each batch. Final acceptance uses a fresh source
and the complete retained backend scope.

## Commands

| Task | Use |
| --- | --- |
| `task test -- <files> [-t <ID>]` | Run explicit test files. Files from several registered tiers stay in tier order; each tier keeps its own admission, budget and stack. |
| `task test -- --affected [<base>] [--list]` | Run or preview tests selected from the changed tree. |
| `task qa -- --tier <name>` | Diagnose one tier in its QA environment. |
| `task qa -- --only-failed <run-id>` | Recheck prior failures; this is partial evidence. |
| `task qa -- --backend [--record]` | Run the frozen backend inventory; `--record` requires complete passing coverage and clean source. |
| `task qa:replay -- --seed <seed> <file> -t <ID>` | Repeat a fast-check test that reads `REZICS_QA_SEED`. |
| `task api:fuzz -- [options]` | Diagnose the public OpenAPI contract in an isolated stack. |

Unscoped `task qa` includes the browser tier. `--record` never certifies a
selected tier or failure rerun. See the [QA selector](../../scripts/qa/test.ts),
[argument checks](../../scripts/qa/core.ts) and [tier runner](../../scripts/qa/cli.ts)
for the exact routing and gates.

### Affected-test selection

Preview with `--list` before a batch. Selection includes uncommitted and
untracked files, follows imports and literal file references, and widens when
an input cannot be traced safely. Documentation changes require
`task docs:check`; load and live-network tests are listed as deferred for an
explicit run. The [rules](../../scripts/qa/affected.ts) and
[regressions](../../tests/qa/unit/affected.test.ts) are authoritative.
Selected tests never substitute for the final complete run.

### Schema-driven API fuzzing

`task api:fuzz` tests generated public OpenAPI responses against its reviewed
[baseline](../../tests/qa/api-fuzz/baseline.json). Inspect
`.artifacts/api-fuzz/<run-id>/` for the JUnit failure and curl reproduction.
`--update-baseline` replaces accepted failures after review; seeded exploratory
passes cannot update it. Protected operations receive unauthenticated rejection
coverage only. Authenticated fuzzing remains pending.

## Tiers and budgets

The [tier registry](../../scripts/qa/core.ts) and [runner](../../scripts/qa/cli.ts)
own the tier list, time limits and isolation. A time limit includes the tier's
test work; inspect slow files before changing it. The overall full-run objective
is 30 minutes on the development host. `task qa -- --backend` omits the browser
tier and uses backend static checks.
The load cap reflects three sequential phase D passes at 214–237 seconds.

## Environment and isolation

Stack tiers create disposable `rezics-qa-<run>` projects. The harness prepares
template databases, assigns fresh file-level databases and Fuseki datasets,
and resets projects unless `--keep` is requested. Tests within one file share
state, so each case creates its own identities and cannot rely on test order.
Fault, recovery, load and browser tests use their registered isolation paths;
do not reset another file's project. For background data, restore a stopped,
compatible backup into a separate project rather than reseeding online.

### Retained untracked QA history

New QA Access and relay bootstraps use the same migration receipts and lock as
owner upgrades. A retained backup made by the untracked bootstrap at
`759244e365ad64bcb97fac0ea7d7b9caebe144b2` needs an explicit transition before
`task dev:prepare` can apply later SQL. Ordinary startup never adopts history.

Restore the original backup into a distinct disposable persistent QA project
under normal Goal admission. Keep its original engines, stop all owner clients
and retain the independent source pin and backup SHA-256. Within the same
600-second preparation budget, verify the copy:

```sh
task goal -- slot -- bun scripts/qa/history-transition.ts verify \
  --stack .temp/stack/rezics-qa-<restored-run> \
  --backup .temp/<retained-input>/backup.json \
  --backup-sha256 <independently-recorded-backup-sha256> \
  --source 759244e365ad64bcb97fac0ea7d7b9caebe144b2 \
  --receipt .temp/<evidence>/qa-history-verified.json
```

The command checks the retained manifest's complete byte inventory against the
pinned Git source, checks the owned PostgreSQL container and compares both
owner schemas and frozen bootstrap templates against a fresh pinned SQL replay.
The [schema dump](https://www.postgresql.org/docs/18/app-pgdump.html) includes
owners, grants, functions, triggers, constraints and indexes; separate template
row and populated-copy seed checks verify data effects. Missing templates,
unknown or partial history, changed bytes, schema drift and missing data effects
refuse adoption. A manifest's SQL filenames alone cannot prove completion.

After successful verification, use `adopt` in place of `verify` with a fresh
receipt output. Both owners are verified before either gains receipts. Only
migration metadata is written in the restored owners; temporary empty reference
databases are removed. The original backup and all application rows remain
unchanged. Retrying recognizes committed per-owner evidence, including an
interrupted cross-database commit. Apply later SQL through the usual owner
runner, then continue the original proof. Retain the credential-free JSON
receipts with that proof; they contain pins, project identities, migration names
and schema/effect digests. A successful tooling test does not certify a retained
copy that has not run this verification.

## Writing tests

Name tests `<ID>: <behavior>` using an owner case ID. Exercise the real owner
boundary, compute expected results from an independent oracle or the test's
own writes, and seed random data for replay. A partial assertion does not
complete an ID. Keep fault fixtures explicit and retain run artifacts instead
of writing narrative evidence files. Oracle models and fixture inputs live in
[`tests/qa/oracles/`](../../tests/qa/oracles/) and
[`tests/qa/fixtures/`](../../tests/qa/fixtures/).

## Load

`task qa -- --tier load` runs the bounded mixed public-query gate and registered
case probes on isolated fixture copies. Inspect its summary and
`.artifacts/qa/<run-id>/load/` for request and correctness evidence.
`task load` runs the separate host workload profile; its results live in
`.artifacts/load/<run-id>/`. A smaller diagnostic run does not qualify the
[deployment objective](../operations/deployment.md#practical-load-objective).
For cost claims, follow [complexity verification](complexity.md).

## Recording

Read `.artifacts/qa/<run-id>/summary.md`, then failing logs and
`acceptance.json`. The latter records scope, source fingerprint, inventory,
excluded cases, per-test outcomes and uncovered or partial IDs. A test name
alone gives partial evidence; complete-case declarations must cover the whole
scenario and pass on the same clean, stable full run. Unselected tests are
unverified. `--record` writes a qualification artifact only after these gates
pass; failed runs retain their diagnostics without replacing qualification.
The artifact stays with its run; record the run ID and tested source commit in
the [plan's current state](../plan/README.md#current-state) rather than copying
the generated page into documentation.
