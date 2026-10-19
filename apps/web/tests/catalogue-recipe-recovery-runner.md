# Frozen original Recipe recovery runner

The manager accepted the bounded SSR transport and browser reload equivalence in
`a08-ssr-transport-equivalence.json` on 2026-10-19. This package prepares only the
two original Recipe C31 recovery callbacks at 1440×900 and 390×844. The persona is
an anonymous visitor. No browser, frontend, HTTP request or data mutation ran
during preparation; collection with `--list` is static. Product acceptance and
C17/other C31 coverage remain open.

The prepared package is
`.temp/goal/recipe-recovery-original-v2/` in the existing G-2774 worktree. Its
[freeze manifest](../../../.temp/goal/recipe-recovery-original-v2/runner-freeze.json)
has SHA-256
`7640f8b2d04969155065f2297be2e6c7a12e43c6ffd207b2f2b16a3e126ce66c`.
The manifest freezes 45 files: all 37 guarded V1 files with current V2 paths and
hashes, plus font preparation evidence, V1 custody and the saved setup failure.
V1 remains unmodified.

## Observed setup failure and bounded correction

Root executed V1 at 14:44 UTC on 2026-10-19. Its
[actual receipt](../../../.temp/goal/recipe-recovery-original-v1/run-1792421093448/run-receipt.json)
records native header200 and Recipe200, then four canonical500 setup failures.
Every cell has `reads: []`, no browser result and successful owned-process
cleanup. The frontend logs identify the denied dependency realpath for
`@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2?url` outside
the frozen source root. No original browser assertion was reached; this receipt
establishes a dependency preparation failure without a product recovery verdict.

V2 copies the same tracked product and installed dependencies into a sibling
owned snapshot and rewires its derived workspace links to V2. It copies the
three actual font packages `geist-mono`, `manrope` and `source-serif-4` into
`source/node_modules/@fontsource-variable/`, following the manager's existing
font materialization correction. The 93 files total 2,472,200 bytes. The
[correction receipt](../../../.temp/goal/recipe-recovery-original-v2/dependency-preparation-correction.json)
records every dependency/local SHA-256 and local realpath. The source guard
requires the exact file set, byte counts, hashes and local paths, and compares
each file with its retained dependency byte. The original dependency digest
remains unchanged. Vite configuration, product source, accepted transport,
selected callback, assertion ledger and timeouts remain unchanged.

Preparation took 23.9 seconds. V2 retains the raw V1 failed run receipt and four
frontend logs, and its [custody record](../../../.temp/goal/recipe-recovery-original-v2/v1-custody.json)
confirms the same V1 freeze, all 37 guarded files, tracked source, dependency
links, critical dependency/font bytes and failure receipts before and after.

## Exact runtime bindings

| Binding | Frozen value |
| --- | --- |
| Frontend product | `05c9534e958f0c67de2e5662281ef22c2864fe95` |
| Owned frontend | `http://127.0.0.1:43135`, serial ownership, strict port |
| Existing Main | `http://127.0.0.1:46775` |
| Backend product declared by producer | `4a616b079a364b8f5ac7fe4d4ff56bc99849e766` |
| Backend support declared by producer | `1f1032cc60369a69bb07695b1b37e6a409c0ac56` |
| Existing Accounts | `http://127.0.0.1:43369` |
| Genuine Recipe | `https://rezics.com/id/01a1532a-2e60-7260-9f3a-d6aa69f61c4b` |
| Title | `21. Minestra di passatelli di carne` |
| Structure | `https://rezics.com/id/3eda0717-be08-826b-b86f-f5a69d644d1a` |
| Revision | `https://rezics.com/id/8794fe94-aad8-872c-aad4-cf5ff5ce50aa` |
| Native fault GET | `/v1/recipes/works/01a1532a-2e60-7260-9f3a-d6aa69f61c4b` |
| Recovery/Cook text | `Il filetto pestatelo nel mortaio e passatelo dallo staccio.` |

The text is the retained native first `recipe-step` occurrence's
`qualifier.instructionText.value`, backed by the genuine Artusi source and the
producer's publication receipt. The qualified answer contains eight native step
occurrences; `instructions: []` is preserved. Setup never substitutes instructions
or an empty successful answer. The package saves the original source receipt and
raw qualified answer; root rechecks only this object's native header/Recipe
before the four cases, saving current responses. Backend revisions are declared
producer pins, not a revision independently verified through those reads.

## Literal equivalence and receipts

The original three acceptance files remain byte-identical, as does the accepted
fault relay. The full helper and original lines428–474 are retained. The
[delta](../../../.temp/goal/recipe-recovery-original-v2/literal-delta.patch) and
[assertion ledger](../../../.temp/goal/recipe-recovery-original-v2/assertion-ledger.json)
account for every selected callback assertion: 17 are byte-identical; the
remaining GET-method assertion observes `read.method` instead of
`route.request().method()`. No expected value, matcher or outcome assertion is
changed. The original message prohibition, cookie clearing and 15s action
timeout remain literal. Only the unrelated full corpus loader is omitted, as in
the existing selected-original scaffold.

| Literal | SHA-256 |
| --- | --- |
| Original callback | `17989f3e7941a56341c979670e02741de12c064664af7fc15ec849957a95321e` |
| Adapted callback | `484b2fc125e9080f423077617cefc4f0d8dab784bb2f957cbba38d83fe7ed43b` |
| Original full helper | `6a64ca9e45e3353bd4dd2df53e89d78d859e90a96264f31d785795514c4611e0` |
| Accepted relay | `c92e6e6558e32c8e3e11b20e3665f2d96579d753dded28d513d14b3ec62beb5e` |
| Assertion ledger | `9c055b7eccc070a8b11c04faf4962c9e701bdd2e88d798975413b162e647b264` |

Each case gets a fresh accepted relay and owned frontend. After the original
healthy `publicSubject` and a real healthy Recipe200, the callback arms the
selected native GET fault and reloads the actual browser URL. It retains the
original identity/type/title, alert, no-false-empty, disabled Cook, enabled Retry,
recovered content, cleared alert, same-object identity and exact Cook method
checks. Retry is the existing button and `router.refresh`; recovery requires
completed raw upstream200 reads. Counters are recomputed from actual relay
receipts before the original fault/recovery/bounded-retry assertions. File IPC
only controls that test relay and returns its actual observations; no product
control or route is introduced.

The frontend archive verifies all 9,969 tracked files against the exact pin.
Dependency inputs match digest
`23223c2822cb3c121e46d70fff8a4d490b1e293ed078f8d2c626a1dee58d71eb`.
V1 obtained its matching installed tree from G-2851 read-only after the guard
caught Main's moving install. V2 snapshots those owned dependency bytes and
preserves the digest. Workspace links resolve into V2's frozen frontend; generated
V1 caches are not copied into the source. No install, global configuration change
or network operation was needed. The product Vite configuration is unchanged.
The existing 90s listen and
90s document warm-up limits and 45s test timeout remain unchanged. Root's existing
setup-only Vite pretransform helper can be coordinated if cold client graph
readiness requires it; no new pretransform prerequisite is asserted here.

## Root execution and remaining proof

Root executed the following V2 command from its manager session in the G-2774
worktree. Do not repeat this unchanged run; the
[V2 diagnosis and V3 observations](catalogue-recipe-recovery-diagnosis.md)
record the outcome, precise owner corrections and the successor command:

```sh
GOAL_ID=audit-remediation-20261019 task --taskfile .temp/goal/recipe-recovery-original-v2/Taskfile.yml run
```

The embedded `browser` Task still invokes `bun scripts/goal/admission.ts` before
Playwright. This direct manager invocation preserves ordinary browser admission
and does not attach a new job to an exited worker attempt. V1's runner actually
completed all four setup failures; the later job-watcher classification is not
evidence of a browser outcome.

The runner executes `recipe network failure retries the same object and task`
and `recipe unavailable failure retries the same object and task`, each under
the original `C31 / visitor /` prefix, in both `desktop` and `phone` projects.
There are no report, actor ownership, media, full matrix or old baseline gates.
The already qualified A16 no-write coordinates on Site Main3001 remain separate;
the earlier owned-coordinate request on46775 is not an A16 prerequisite.

Each `run-<timestamp>/<device>-<transport>/` retains raw relay read receipts,
frontend log/readiness HTML, Playwright JSON/trace/screenshots, fault/recovery
screenshots and `assertion-outcomes.json` recording every executed expect step.
The outer receipt records exact pins, source checks, actual outcomes and cleanup
of only owned frontend/browser process groups and relay. Setup errors remain
explicit; they are not asserted to be product failures. Root's subsequent run
`run-1792421869618` reached the original recovered-method assertion in all four
cells and failed at its unchanged 5,000ms limit. Later recovery/Cook assertions
were not reached. Product acceptance remains open.

Recorded job `0ff46d1e-8458-4f2f-8e6e-017d9d4c6a65` passed V2 preparation,
`task goal:type-files -- --project .temp/goal/recipe-recovery-original-v2/tsconfig.json`
(2,787 files) and
`task --taskfile .temp/goal/recipe-recovery-original-v2/Taskfile.yml freeze`:
source/local-font/literal verification, runner/spec builds, exact four-test
collection and the final manifest freeze. The original 18-assertion ledger is
byte-identical to V1. Those checks passed before root's four-cell runtime;
they do not establish a browser outcome.
