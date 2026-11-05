# Bangumi native launch scope

This extension freezes the launch correction in [Bangumi scope](bangumi-scope.md)
through `services/kernel/test/imports/bangumi-launch-scope.test.ts`. It preserves
existing pure conversion and fake-remote importer/CLI acceptance unchanged.
This is specification work; a reached red assertion records missing implementation.

The fixed complete JSON-lines input has five controlled real-shaped subjects in
order 1/2/4/3/6. Titles and published `images.large` follow the existing converter
surface; private posts carry a sentinel. The registered native media boundary
serves image bytes. Only three supported subjects, their proposals and their
media may exist. Types 3/6 remain present in the five-member complete baseline.
Input has no native revision; envelopes and persisted source rows must say
`unversioned`. The dump snapshot is explicitly a fixture label, never a revision.
No source metadata producer or new source-record write ABI is simulated.

## Native boundary and decisions

The test uses the existing `openApiRuntime`, actual `Importer`, SQLite under
`os.tmpdir()`, native Auth account-key credentials, Access and public batch APIs.
Requests dispatch through the real kernel handler; no successful HTTP response,
permission seed, server command output or import result is fabricated. Existing
`openApiObserver` supplies an ordinary authenticated public reader. Public subject
and bounded title-candidate reads prove types, identity and traceable proposals;
actual captured writes and point `core.receipt` observations prove effects.
No editor adoption is needed to inspect these selected facts. This suite does not
repeat the import-to-discovery filter, word, form or platform matrix.

Independent test cases share one isolated runtime so scope failures do not prevent
supported records, lifecycle, invalid acquisition and native accounting from being
exercised. Lifecycle reopens SQLite, imports unchanged bytes without a POST or
subject change, then changes only the book and requires new title proposals with
unchanged subject identity and zero disappearance. Invalid controls place a valid
record before each bad type, proving that acquisition seals before effects.

The final case uses the existing exposed `runtime.importer.runRecords` seam after
an unchanged reopen. It retains the genuine `ImportRunResult` and asserts complete
five-member accounting and `skipped: 2`. It requires no writes, so it needs no
runtime exchange adaptation. CLI `skipped=2` remains separate local fake-remote
acceptance; this native file does not claim to execute the CLI.

Cost is fixed at five records and seven invalid-type controls. Reads use maintained
source counts, five exact membership keys, bounded public subject/candidate reads,
and exact receipt keys. No history, whole-source enumeration, growth experiment,
Concept identifiers, runtime edits or timeout changes are introduced.

## Execution

Tested against base revision `fb7ffaca82ead9baaa84e18992aae8644aa9ae78`
with the new native test blob `8fc0cadb8c32871dde4ce6e29e22186c7d49e3ce`.
No product code or inherited acceptance changed. The final focused native command:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/bangumi-launch-scope.test.ts
```

On check host a, Bun `1.4.4-canary.1 (a0cc096ce)` executed **5 tests in one file:
2 pass, 3 fail, 403 expect() calls**, in 81.27 seconds of test execution.
The wrapper exited 1. Slot admission waited 232.710 seconds; that was queueing,
not a tool failure or case execution. The first actual failure was line 104:
`expect(native.filter(Boolean)).toHaveLength(3)`, **Expected length: 3;
Received length: 5**. Real public reads disclosed five native subjects after a
complete import, with persisted point receipts and five present source members.

| Exact test name                                                                               | Observed result                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mixed complete JSON-lines import creates only three native subjects and no skipped output     | Failed at native subject count 5 versus 3. Later skipped command/media/sentinel assertions were not reached.                                                                                                                                                                                       |
| supported native public types and proposals preserve real identity and absent revision        | Passed: Book/TVSeries/VideoGame, actual labels, title candidates, source identity, digest, converter revision and unversioned source revision.                                                                                                                                                     |
| reopen unchanged and change book preserve identity and all five members without disappearance | Failed at line 170: type 3 still had a bound subject. Earlier assertions passed for unchanged reopen without POSTs, unchanged public subjects, five present members, changed-book proposals/digest, stable identities and zero disappearance. The following type 6 null assertion was not reached. |
| unsupported and malformed types reject complete acquisition before native effects             | Passed for 0, 5, 7, string `1`, null, 1.5 and missing type: invalid-input, zero batch exchanges or POSTs, no binding for 99, unchanged baseline and public subjects.                                                                                                                               |
| existing native importer seam returns genuine skipped count on unchanged complete membership  | Failed at line 213: `Expected path: "skipped"`, `Expected value: 2`, `Unable to find property`. The genuine result was committed with new=0, changed=0, unchanged=5, vanished=0; no writes or false disappearance; five present baseline/acknowledged members.                                     |

This retains both real passing cases and missing launch-scope/accounting behavior.
It does not label the native suite green. The product converter still includes
3/6 and the native result has no skipped field, consistent with the already
recorded local scope evidence. No separate base replay was run. These red
implementation requirements do not block this specification artifact acceptance.

Final scoped root typecheck, exit 0 (one of thirteen workspaces, kernel):

```sh
bun scripts/worker-check.ts -- env TYPECHECK_CHANGED=services/kernel/test/imports/bangumi-launch-scope.test.ts bun run typecheck
```

Native log: `.temp/goal/checks/worker-check-2026-10-28T19-02-18.139Z-16ae2cbb.log`.
Typecheck log: `.temp/goal/checks/worker-check-2026-10-28T19-02-23.036Z-ec0ac30f.log`.
The remote timing recorder warned `git rev-parse failed: fatal: not a git
repository (or any of the parent directories): .git`; execution still reached
all five cases. This warning is not the assertion failure or an environment-only
result.

An earlier diagnostic run reached 2 pass/3 fail with 391 assertions; its lifecycle
case overconstrained changed-book commands to proposals only. Ordinary importer
refresh also retracts superseded proposals. The final test permits that existing
contract while requiring every changed command to belong to the book and actual
new proposals. That justified the final focused rerun and scoped typecheck; no
inherited acceptance was edited. Earlier logs end in `2afd5e56.log` (native) and
`5731c978.log` (passing typecheck).

Artifact acceptance, exit 0:

```sh
bun scripts/worker-check.ts -- test -s docs/research/imports-audit/bangumi-native-scope.md
```

File presence alone is never evidence of native success. No full root/kernel gate
was run.

## Source reads and boundaries

Read the existing local Bangumi scope tests/report; conversion `src/bangumi.ts`,
`src/support.ts` revision/envelope surface and README; importer dump reader,
registration, importer/session, RunStore/RecordStore and README; the existing
native API runtime, observer, fixture, unversioned test and published API driver
schemas. The read-only reference index was inspected; no reference-project source
or legacy implementation is needed for this existing native surface. No external
research or source rights policy is added. No file outside the two assigned paths
is changed.
