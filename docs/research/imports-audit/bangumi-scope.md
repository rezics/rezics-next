# Bangumi launch scope correction

The first public import accepts type 1 (book), type 2 (anime), and type 4 (game).
Types 3 (music) and 6 (live action) are recognized source inputs that must be
**skipped and counted**, with no subject creation, proposals, or media assets or
intents. Unknown and malformed types still fail. This scope correction supersedes
the scope conflict recorded in [the earlier audit](bangumi.md); it does not
implement the correction.

## Authorized frozen amendment

In `specs/imports-bangumi.test.ts`, the test named `all supported subject types
retain title facts Chinese labels and source references` loses exactly these
array entries:

```ts
      [3, 'MusicAlbum'],
      [6, 'TVSeries'],
```

Every other byte of that file is preserved, including its assertions and the
`unsupported and malformed source types reject clearly` scenario. No other
existing test, driver, frozen file, or product implementation is changed.
The amendment records the approved launch scope; the new focused tests impose
independent ignored-outcome and accounting obligations.

## Executable acceptance

`packages/conversion/tests/bangumi-scope.test.ts` imports and calls the actual
`convertBangumi`. It checks the three supported class mappings, bootstrap labels,
bound title facts and source references, complete decoded summary and its
CC-BY-SA-3.0 rights, and published-image cover assets, intents and available-media
binding. Infobox-only image text remains omitted. Facts do not acquire a rights
body: metadata and summary attribution belongs in subject Sources(source, URL,
licence), with summary rights and separate image credit preserved. The source
inventory wording correction belongs to semantic; this change does not amend it.

For each excluded type the test requires `outcome: 'ignored'`, a bounded safe
`/type` diagnostic, valid identity, native or unversioned revision, SHA-256 digest,
current converter revision, empty proposals and empty media arrays in both phases.
Sanitized normalized input must re-convert deterministically. Unknown/private
fields cannot leak or acquire authority. A separate hostile-getter scenario
checks that unknown/private subtrees are not visited, with fetch, filesystem,
network and subprocess entry points denied. Unknown/invalid types and mismatched
identities still throw `ConversionError`. The previous revision is observed as
`bangumi@2`; acceptance rejects retaining it without prescribing a replacement.

`services/importer/tests/bangumi-scope.test.ts` uses production registration,
`Importer.runDump`, `ImportSession` and real SQLite files under `os.tmpdir()`.
A complete native JSON-lines dump contains 1/2/4/3/6, chunked across record
boundaries. Only the idempotent remote command/media boundaries are simulated.
Acceptance requires three remote subjects and three published cover assets,
zero skipped-record commands or media requests, five present source members,
and `skipped: 2`. It checks unchanged repetition, reopening, a supported-record
change, and durable recovery both after remote success and before finalization.
Recovery must use sealed acquisition without consuming newer input. It then
repeats the original input and requires no additional effects.

The CLI scenario directly executes the exported `runImportCli` (locally named
`runCli`) with real stdin acquisition, generated account key and SQLite state.
Only HTTP responses are fake. Each same-input invocation must consume the dump,
close its handles, preserve three subjects and print `skipped=2`. This fixture
omits covers; media behavior is covered by the coordinator scenario above.
No check-host fixture, kernel service, dependency installation or external
research is needed.

## Decisions and bounded implementation seam

- A recognized excluded type is an ignored conversion, following the existing
  coordinator `outcome === 'ignored'` convention. It is neither an invalid dump
  nor a new bulk operation. Dispatch validates source identity and type before
  doing unnecessary field conversion. A minimal sanitized identity/type projection
  is sufficient if it can be passed back through the same converter; no private
  subtree or discarded media data needs retention.
- `ImportRunResult.skipped` is an additive top-level nonnegative safe integer,
  separate from `counts`. Existing new/changed/unchanged/vanished classifications
  retain their meaning over complete source membership. Thus the first fixture
  run has new=5, an unchanged run unchanged=5, and changing only the book has
  changed=1 and unchanged=4. Every completed fixture run also has skipped=2.
  Skipping is not disappearance and does not remove membership rows.
- Count ignored source inputs once during the existing full acquisition, never
  during bootstrap/bound conversion or planning. Keep one bounded scalar for the
  run, and persist that scalar with run metadata at successful seal. Unsealed
  acquisition has no permitted effects and is already abandoned and reacquired
  on recovery, so it needs no independent durable skipped-ID tracking. The
  scalar must describe successfully staged unique source inputs; malformed or
  duplicate acquisition must not publish a completed count.
- Read that sealed scalar by exact run identity on resume **before** any
  finalization shortcut can delete or finish the run. Reuse it for the completed
  result even when acknowledgement was already durable. This covers unchanged
  reimports (which acquire every input again) and recovery (which must not read
  replacement input). Pass it to the CLI summary as `skipped=N`, including zero.
  No source-wide SQL COUNT, historical scan, retained skipped-ID Set, new kernel
  contract, or additional source pass is needed. The scalar is stored in an
  additive `skipped` column on `run_generations`, written only by a successful
  seal and read by exact `(source,id)` identity before finalization. Existing
  databases migrate with default zero.
- The existing no-effect authority remains responsible for acknowledging ignored
  rows. `ImportRunResult` is declared and constructed in
  `services/importer/src/importer.ts`; the CLI consumes that result. The pipeline
  driver only references the type. No old local `RunResult` literal or kernel/API
  type changes are part of this seam.

## Local execution and evidence limits

The assigned base already contains both focused acceptance files and the exact
authorized frozen amendment. Inspection of that amendment confirms that its
entire diff removes only the two array entries shown above. This attempt leaves
all acceptance files unchanged and revalidates the inherited specification.
The failures below occur on the assigned base; they are the required red
implementation acceptance, not a blocker for this specification-only delivery.

Ran exactly once in this attempt, with exit status 1:

```sh
bun test packages/conversion/tests/bangumi-scope.test.ts services/importer/tests/bangumi-scope.test.ts
```

Observed Bun 1.4.3: **5 pass, 7 fail, 463 expect() calls; 12 tests across 2 files**.
The precise failure observations are:

| Scenario                    | Actual failure                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Excluded type 3             | `Expected path: "outcome"`, `Expected value: "ignored"`, `Unable to find property`               |
| Excluded type 6             | `Expected path: "outcome"`, `Expected value: "ignored"`, `Unable to find property`               |
| Revision changes            | `Expected: not "bangumi@2"`                                                                      |
| Mixed acquisition           | `Expected path: "skipped"`, `Expected value: 2`, `Unable to find property`                       |
| Resume after remote success | Same missing `skipped` property                                                                  |
| Resume before finalization  | Same missing `skipped` property                                                                  |
| CLI summary                 | Expected `/\bskipped=2\b/`; received `Import complete: new=5 changed=0 unchanged=0 vanished=0\n` |

All three supported-type scenarios, invalid-type rejection and the pure hostile
subtree/I/O scenario passed. The failing scope and accounting scenarios stop at
the first unmet assertion: later zero-effect, repeat, membership and recovery
assertions are executable requirements, not observed successes. The coordinator
runs did reach committed status before the missing-count assertions, and both
fault scenarios reached their expected initial failure and committed recovery.
The CLI acquired its input and returned code zero before failing its summary
assertion. These are local client observations against an idempotent fake API,
not proof of real server authorization, persisted kernel subjects, image download
or production HTTP behavior. The I/O spies cover named entry points, not all
possible operating-system calls; source inspection supplies additional evidence
of a pure bounded projection.

Ordinary assertions inspected: the unchanged malformed/unknown-type,
identifier, title, privacy, rights, cover and consumer scenarios in
`specs/imports-bangumi.test.ts`; production registration forwarding/rebinding in
`services/importer/tests/source-registry.test.ts`; and the Bangumi growth/purity
assertions in `packages/conversion/tests/bangumi-growth.test.ts`. No additional
frozen assertion requiring correction was discovered on these surfaces.
The existing `bangumi.yaml` prose still says infobox image keys feed covers;
this known inventory mismatch remains for semantic and is not an authorization
to expand cover parsing or change another frozen assertion.

Source reads for the implementation surface: conversion `src/bangumi.ts`,
`src/index.ts`, relevant `src/wikidata.ts` outcome code, and `README.md`; importer
`src/source-registry.ts`, `src/import-contract.ts`, `src/importer.ts`, `src/cli.ts`,
`src/dumps.ts`, and `README.md`; the existing local session, deferred-cover and CLI
tests/drivers and CLI specification interface; `packages/definitions/sources/bangumi.yaml`
(scope/cover prose); and the earlier Bangumi audit. No external reference project
or legacy implementation was used for the new specification.

The artifact acceptance command is `test -s docs/research/imports-audit/bangumi-scope.md`.
Root/typecheck, kernel, remote and check-host checks were not run: the task's
specific specification-only instruction permits only the two new local tests
and prohibits root checks. No product defect was fixed to make the intended red
acceptance green. No file outside the four declared paths was changed; temporary
execution output is kept under `.temp/` and is not committed.

## Cost

### Dispatch a source record

- Touches: source identity and numeric type, then the existing bounded per-record
  projection only for supported types. Exclusions produce no command or media work.
- Bound: constant identity/type dispatch plus O(M) existing conversion for a
  supported record of bounded size M; no catalogue or historical-record reads.
- Growth check: the focused tests establish outcomes and named I/O interception,
  not measured growth. Existing Bangumi growth assertions were inspected only;
  no three-scale performance run was performed in this specification attempt.

### Account for skipped acquisition inputs

- Touches: each input already visited by full acquisition, one in-memory scalar,
  and the exact run metadata at seal and resume.
- Bound: O(S) scalar updates over S acquired inputs, O(1) additional retained
  state, and constant additional metadata accesses by run identity. The existing
  staging/pages retain their bounds; no historical scan or skipped-ID Set.
- Growth check: unchanged and durable-resume scenarios require the same count
  without another input pass. These are currently red functional requirements;
  native statement and examined-row measurements remain implementation evidence
  to collect, independently growing unrelated source history.
