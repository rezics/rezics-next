# Bangumi native launch scope verification

The corrected converter and durable skipped accounting pass all five unchanged
native Bangumi cases: **5 pass, 0 fail, 0 skipped, 0 todo, 424 expect() calls**
across one file. This verifies the combined implementation through the existing
native API runtime, including the genuine `ImportRunResult.skipped` value.
The earlier [native specification receipt](bangumi-native-scope.md) remains the
historical 2-pass/3-fail/403-assertion result against the pre-correction code.

## Admitted code and frozen test

Tested revision: `bf56a2d2201ddd0d306e28e7509418dcdcebf3d0`. The worktree was
clean at admission and after execution. Both changed dependencies were present
and inspected before the single focused command was admitted:

- Converter correction: `496f04de1f4998d5163bd46d239425f4351a1c9e`.
  [Bangumi conversion](../../../packages/conversion/src/bangumi.ts) uses
  `bangumi@3`, maps only 1/2/4, and returns ignored identity/type projections
  with empty proposals and media arrays for 3/6 before visiting discarded fields.
- Durable accounting: `32d6f17768506960a88ea91c02999a9a8e5a6126`, with formatting
  in `f12b117e78b0b9a73a5dc9942f036d03163040a9`.
  [Importer](../../../services/importer/src/importer.ts) counts ignored inputs
  during acquisition, seals the count, and reads it before resumed finalization.
  Its existing ignored path prevents bootstrap and acknowledges no effects.
  [RunStore](../../../services/importer/src/run-store.ts) adds the default-zero
  column and seals/reads it by exact run identity.
  [CLI](../../../services/importer/src/cli.ts) consumes `run.skipped` in summaries;
  this suite does not execute that CLI surface.

The [native test](../../../services/kernel/test/imports/bangumi-launch-scope.test.ts)
has Git blob `8fc0cadb8c32871dde4ce6e29e22186c7d49e3ce`, identical to the
original frozen receipt. Both `git rev-parse HEAD:<test-path>` and
`git hash-object <test-path>` returned that hash at admission; the working-file
hash remained identical after execution.
No test, helper, runtime, product, README or manifest was edited.

Relevant tested implementation blobs:

| File                                          | Git blob                                   |
| --------------------------------------------- | ------------------------------------------ |
| `packages/conversion/src/bangumi.ts`          | `c121c6bafea8238d562446fbcc17e44ba523c424` |
| `services/importer/src/importer.ts`           | `d9b03da0bded03eb407701970a60c2a9a5750e35` |
| `services/importer/src/run-store.ts`          | `b935858a2e7ae9e4a68adeaafe4e8b6d92404507` |
| `services/importer/src/cli.ts`                | `d5d7a530cda37524a644342d1e52d338017c8258` |
| `services/kernel/test/imports/api-runtime.ts` | `6cd4f6bee03c5eccbd8d97c829e111054b7f0a75` |

## Execution and environment

Executed once through normal admission, from the worktree root:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/bangumi-launch-scope.test.ts
```

Wrapper exit status: **0**. Receipt:
[native log](../../../.temp/goal/checks/worker-check-2026-10-28T19-55-22.210Z-bb5d19af.log);
SHA-256 `af17db1e66c9ce94bf5d7e41b4d663870090e73440cd3f09affb0e5d8eeff7d4`.
No separate control-plane receipt was supplied for reuse. No duplicate command,
old-base replay or diagnostic rerun was launched; the runner reports
`Load reruns: 0 files`.

The worker memory admission waited **532.865 seconds**, followed by **1.104
seconds** of remote slot wait on check host **a**. These are queue times, not
execution failures. Test execution took **73.31 seconds**; the remote command
took **145.222 seconds**, including the normal kernel check setup and checks.
The remote run reported peak memory 3870 MiB and PostgreSQL peak 38/500
connections. There was no transport, startup, timeout or environment failure.

The test process banner is `bun test v1.4.4-canary.1 (a0cc096ce)`.
The pinned package is `bun@1.4.4-canary.20261027.1`, executable
`node_modules/.bin/bun` → `../bun/bin/bun.exe`, resolving inside
`node_modules/.bun/bun@1.4.4-canary.20261027.1/node_modules/bun/bin/bun.exe`.
The local installed executable reports full revision
`a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b`, matching the provisioning pin and
native banner. The ephemeral remote absolute executable path/full revision was
not separately instrumented. The outer local wrapper and remote install used
Bun 1.4.3 (`c6da4a4d3010e5553438c60f6bd76d981976867c`); their versions do not
describe the pinned native test process.

A read-only SSH observation of host a after execution confirmed `TMPDIR` unset,
`os.tmpdir()` `/tmp`, and `/tmp` mounted as
`tmpfs rw,nosuid,nodev,nr_inodes=1048576,inode64`. The unchanged
[runtime](../../../services/kernel/test/imports/api-runtime.ts) opens actual
`bun:sqlite` at `/tmp/import-api-*/state.sqlite`, reusing that file on restart.
[RunStore](../../../services/importer/src/run-store.ts) configures WAL,
`busy_timeout=5000` and `synchronous=NORMAL`. This is tmpfs SQLite evidence,
not disk persistence or crash/power-loss durability evidence.

## Exact native outcomes

| Frozen scenario                                                                               | Observed result                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| mixed complete JSON-lines import creates only three native subjects and no skipped output     | Pass: only 1/2/4 have bound, publicly readable subjects; three media imports target those subjects; no 3/6 commands or private sentinel in captured bodies; real persisted receipts and five present acknowledged members.     |
| supported native public types and proposals preserve real identity and absent revision        | Pass: Book/TVSeries/VideoGame, original and Chinese labels, bounded native title candidates, source/external identity, SHA-256 digest, current converter revision and `unversioned` record revision.                           |
| reopen unchanged and change book preserve identity and all five members without disappearance | Pass: reopened unchanged input causes no POST or subject change; changing only the book yields new title proposals/digest, stable subject IDs, unchanged other subjects, no 3/6 bindings, five members and zero disappearance. |
| unsupported and malformed types reject complete acquisition before native effects             | Pass: 0, 5, 7, string `1`, null, 1.5 and missing type all reject after a preceding valid record with zero exchanges/POSTs, no new binding, and unchanged baseline/public subjects.                                             |
| existing native importer seam returns genuine skipped count on unchanged complete membership  | Pass: direct `runRecords` returns committed, `counts={new:0,changed:0,unchanged:5,vanished:0}`, `vanished=[]`, `skipped=2`, no writes and complete five-member baseline/acknowledgement.                                       |

There is no native first failure. The log contains a timing-recorder warning
about missing remote Git metadata and a `pg` client-query deprecation warning;
neither prevented execution of any case or changed the exit status.

## Boundaries and decisions

The specific verification contract prohibits a root gate/unrelated compiler
check, overriding the general root-typecheck instruction. No separate root
typecheck, whole-kernel gate, all-source suite or full discovery/CLI/publication
matrix was run. The focused kernel command includes its ordinary selected-file
checks. This receipt establishes Bangumi launch/accounting behavior only; it
does not establish main promotion or the full imports Goal.

Source reads covered the unchanged native test and prior reports; converter and
registration; dump reader; importer acquisition, planning and result; session;
RunStore migration/seal/lookup; CLI result formatting; native runtime and public
observer; conversion/importer READMEs; and worker/remote/check placement and
toolchain configuration. The read-only reference `INDEX.md` was inspected; no
reference-project source was needed for this existing verification surface.
Only this report changes; there are no outside-path changes or product repairs.

### Verify the fixed launch neighbourhood

- Touches: five input identities 1/2/4/3/6, seven malformed-type controls, exact
  membership/receipt keys and bounded public subject/title-candidate reads.
- Bound: the unchanged finite fixture and native assertions; no source-wide
  scan, new input growth, helper or producer is introduced.
- Growth check: none added or executed. These results are functional native
  evidence for the fixed neighbourhood, not a new scalability measurement.
