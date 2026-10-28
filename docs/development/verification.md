# Verification

Verify the promised outcome through the real boundary that owns it.

API acceptance covers the relevant personas, each permission operand, invalid and hidden resources, lifecycle changes,
replay and dependency unavailability. Use native Access and production contracts. A permissive stub cannot prove
authorization or disclosure.

Keep specified, implemented, exposed, tested and promoted distinct. Report unavailable evidence as unavailable.

Run the acceptance command once after the last relevant edit, plus the root typecheck (`bun scripts/typecheck.ts`).
Write missing acceptance tests named by the contract. Preserve existing frozen acceptance. Add focused checks for
concrete risks, naming at most twelve nearby test files per discretionary check. Run a whole-workspace or full web
check only when the contract requires it; do not repeat a passing acceptance to obtain a success summary. Broaden checks when shared
contracts or unresolved failures require it. Use the full kernel check for a change to a runtime contract that every module's tests rely on.
Use the control plane's own gate for executable control-plane changes. Documentation alone does not require either. Judge commands by their exit status.

For every operation, document one Cost entry with Operation, Touches, Bound and Growth check. Use one operation
subsection with the bullets `Touches:`, `Bound:` and `Growth check:`; its heading supplies Operation. Existing Cost
tables remain readable evidence; migrate them when touched rather than introducing a competing new format. Derive the bound before
implementation. Measure native examined rows, buffers, statements and other relevant work at three seeded scales.
Grow unrelated data and history independently while holding the selected neighbourhood fixed.

Include authorization, denied and empty paths, deep pages, projections and cleanup. Charge rereads, lookahead and
discarded work to the shared budget. A bounded returned array or request count does not prove bounded engine work.
The control plane follows the same rule.

Do not weaken a growth bound to fit a failure. Distinguish an algorithm defect, a fixture defect and a classifier
question; route each to its owner.

Review interfaces in the running product. Compare phone and desktop, both themes, representative content and important
empty, loading and failure states. Compare shared components across surfaces. Fix the defect class. Automated tests
support this review; they do not establish visual quality.

Review screenshots after interface landings. During active interface work, publish reviewed evidence after each round
and at least every three hours through the configured channel. Check within an hour that a requested visible fix is
actually running.

Admit heavy checks through shared resource controls. A check waiting for a slot is queued; let it run. Park workers until completion or meaningful output instead of
waking the model for “still running”. Worker admission and heavy-check admission are separate controls.
Diagnostic reruns remain visible. A load-sensitive diagnostic rerun may address an actual load signal in a mixed
failure; cleanup failures are not eligible. Do not scale security TTLs, explicit deadlines or work budgets to hide
failures. A proposed test deadline multiplier is not evidence of deployment. Distinguish a reproducible
product failure from an infrastructure failure; never count an unverified baseline as a pass.

Verify tooling fixes against the actual operating condition before reporting them fixed.

# Verification toolchain

Use the exact `bun@1.4.4-canary.20261027.1` npm distribution pinned in the root
`packageManager`, development dependencies and lockfile. Its Linux x64 binary reports
`1.4.4-canary.1+a0cc096ce` with `bun --revision` (full revision
`a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b`). `bun --version` reports only `1.4.4`, so it
cannot distinguish this canary from the stable release.

`bun install --frozen-lockfile` installs this runtime into `node_modules/.bin`.
The remote runner puts that directory first on `PATH` after installation. The root gate and root typecheck
invoke the installed executable by path, because `Bun.spawn("bun")` selects its caller
even when `PATH` points to a newer Bun;
an older host Bun can bootstrap the install without selecting the runtime used for checks.
The check-host provisioner pins the same distribution and checks its full build revision.
Provision hosts with `scripts/provision-check-host.sh` as described in
[the check-host operations guide](../../scripts/README.md). No shared host runtime needs
to be changed while evaluating a candidate checkout.

Run `bun scripts/gate.ts` for the landing gate and `bun run typecheck` for the root
typecheck. The gate also runs `scripts/toolchain.test.ts` and `scripts/toolchain-workspaces.test.ts`, which check formatter
compatibility, all six configured lint rules and their options, TypeScript diagnostics,
and the SQL mapper fallback, every workspace's checker selection and the declaration compiler.
Declaration generation continues to use tsc. The npm `latest` and `canary` tags were rechecked on
28 October 2026: stable is 1.4.4 and the canary remains the exact distribution pinned above.

## Switch decisions

### Formatting

Keep oxfmt 0.74.0 for `bun run format`, `bun run format:check` and workspace gates.
On a temporary copy of the base tree, oxfmt formatted all 3,170 eligible files in the completed comparison. Then
`bun fmt --check` used the same `.oxfmtrc.json` and reported exactly two differences:

| File                                         | Difference from oxfmt output                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `docs/research/throughput-audit-high.md:546` | Bun escapes the leading `=` before a code span as `\=`.                                   |
| `specs/imported-field-driver.ts:139`         | Bun puts `coverReference(key: string): Promise<{` on one line; oxfmt wraps the parameter. |

This is the formatter swap decision: two differences prevent the switch. The existing
configuration and source files stay intact. Representative TS, TSX, JSON, CSS and
Markdown fixtures match; the two exceptions have a regression check. Existing
formatting issues elsewhere in the base tree were normalized only in the temporary
comparison copy, never in the checkout or frozen files.

### Type checks

Use `bun check --no-script -p tsconfig.json` in the eleven workspaces below, both in
their check commands and their root-invoked typecheck scripts. `--no-script` is required
because each workspace defines a `check` script. Keep generation before checking the
websites. Both checkers reported zero errors for every workspace in the paired run.
The regression fixture also compares diagnostic locations, error codes and messages
for incompatible imported types, exact optional properties and indexed access, and
checks that the corrected source passes both tools.

| Workspace                | tsc seconds | Bun seconds | Diagnostics            |
| ------------------------ | ----------: | ----------: | ---------------------- |
| `apps/auth`              |       2.429 |       6.346 | Identical: zero errors |
| `apps/web`               |      13.259 |       6.975 | Identical: zero errors |
| `packages/auth-contract` |       0.374 |       0.263 | Identical: zero errors |
| `packages/client`        |      19.357 |       4.879 | Identical: zero errors |
| `packages/composition`   |       0.966 |       0.684 | Identical: zero errors |
| `packages/conversion`    |       3.784 |       8.238 | Identical: zero errors |
| `packages/definitions`   |       3.307 |       1.725 | Identical: zero errors |
| `packages/document`      |       0.611 |       0.350 | Identical: zero errors |
| `packages/filter`        |       0.458 |       0.467 | Identical: zero errors |
| `packages/ui`            |       5.786 |       2.663 | Identical: zero errors |
| `services/importer`      |       3.240 |       1.539 | Identical: zero errors |

Keep tsc 7.1.0-beta for kernel and auth, which use Reylo `contentMappers` to type SQL
imports against a migrated PostgreSQL database. The pinned Bun rejects
`--runExternalCode` with `Unknown flag "--runExternalCode"`. Without that flag, the
auth project reports 885 errors (655 unresolved SQL imports), and kernel reports
1,266 errors (900 unresolved SQL imports), while tsc passes both against the compiler
database. Bun is not applying the content mappers. Declaration emit, including
the kernel client's declaration generation, stays on tsc. The generic root typecheck
fallback also stays on tsc for workspaces that do not explicitly select a checker.

### Lint

Use `bun lint --no-script --config .oxlintrc.json` in the root lint script and the
kernel/auth check runners. Keep oxlint 1.89.0 installed as the differential reference.
`bun lint --doctor` reports six native rules and zero JavaScript fallback rules. Against
the whole tree, Bun and oxlint reported exactly the same 80 JSON diagnostic objects,
including rule, severity, source position and message, after sorting. These existing errors were
not hidden or fixed as part of a toolchain switch. The regression fixtures require
each configured rule to reject a witness, compare diagnostic spans and severity, and
check the configured null comparison, unused argument, rest sibling and underscore
exceptions. No permissive unsupported-rule flag is used.

## Wall-time measurements

Measured on 28 October 2026 on this machine: Linux x64, AMD Ryzen Threadripper 3970X,
32 cores / 64 logical CPUs, 64 GiB RAM. Baseline runtime: Bun 1.4.3. Candidate runtime:
the pinned canary above. Times are elapsed wall seconds, one observation per command,
including startup. The paired workspace table runs tsc then Bun per workspace. The
machine also runs other workers; caches and load are uncontrolled, so these observations
are evidence of this attempt, not isolated benchmark guarantees.

Full checks use the loopback check host through the normal admission protocol, with
all other hosts excluded from this attempt's local hosts file. Queueing, synchronization,
installation and browser setup are included in their end-to-end times. No busy slot is
bypassed. The gate's per-workspace times are reported separately from admission wait.

| Check                                                                     | Before seconds | After seconds | Result / interpretation                                                              |
| ------------------------------------------------------------------------- | -------------: | ------------: | ------------------------------------------------------------------------------------ |
| Tree format check                                                         |          0.882 |         2.552 | oxfmt retained; both detect existing base formatting issues.                         |
| Eleven non-SQL type checks, sequential sum                                |         53.571 |        34.129 | Identical diagnostics; 1.57 times faster in this paired observation.                 |
| Root typecheck, including generation, compiler DB and kernel construction |        302.044 |       150.699 | Both passed; includes database and generator costs.                                  |
| Tree lint                                                                 |          1.290 |         0.195 | Identical 80 JSON diagnostics; 6.62 times faster in this observation.                |
| Full kernel check                                                         |    Unavailable |   Unavailable | Local comparison cancelled after the gate proved incompatible acceptance assertions. |
| Full web check                                                            |    Unavailable |   Unavailable | Local comparison cancelled on the same specification conflict.                       |

The candidate formatter also took 0.615 seconds to check the oxfmt-normalized 3,170-file
temporary copy and rejected the two files above. An initial canary lint observation
under heavier load took 3.086 seconds; the final installed-runtime observation is in
the table. The retained formatter's slower observation likewise illustrates load
variation rather than a formatter implementation change. On the unchanged checkout, the final
paired formatter observation was 2.638 seconds for oxfmt and 0.324 seconds for Bun;
the two output differences still prevent adoption. The component and per-workspace
typecheck observations are complete; full-check comparisons are not. The focused
toolchain and root-typecheck regression run passed all 27 tests across three files.

The root gate's kernel check completed in 4,298.43 seconds on host a and failed;
that remote observation is separate from the requested local comparison. In that run,
`test/commerce/http.test.ts` passed and `test/commerce/exposure.test.ts` failed.
The former requires `summary` among the exact keys returned by `POST /v1/offers`;
the latter forbids that key for the same input shape (an unseeded target subject,
title `Book`, USD 1,200 minor units and the same tax code). Their public offer reads
also require different shapes: the former replaces `summary` with `subject`, while
the latter requires the creation response unchanged. Both assertions already exist
on the pre-migration commit. Changing runtime tools cannot satisfy both fixed
response contracts, and existing acceptance tests were preserved. The remaining
checks started by this attempt were cancelled after establishing this conflict;
queue time and cancelled runs are not reported as completed benchmark times.

## Sources and reproduction

The [Bun 1.4.4 release notes](https://bun.com/blog/bun-v1.4.4) describe the formatter,
checker improvements and canary-only lint command. Exact npm metadata and tarballs
were read from `registry.npmjs.org/bun/canary` and `@oven/bun-linux-x64`. A preliminary
GitHub canary download reported an older `11c367163` revision; only the newer npm
canary is pinned and used for final compatibility checks. No reference-project code
was ported.

For future upgrades, repeat the formatter comparison on an oxfmt-normalized disposable
copy, compare each workspace's diagnostics, exercise the SQL content mappers and
compare lint diagnostics before changing a command. Run the equivalence tests and
root typecheck, then the root gate. Preserve the fallback when the comparison differs;
do not suppress diagnostics or reformat frozen files to make a replacement pass.
