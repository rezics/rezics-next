# Search capability acceptance manifest

This is the Search start and closure inventory required by the adopted
[API acceptance gaps workflow](../research/api-acceptance-gaps.md#workflow-change-the-manager-can-adopt).
The original inventory added no product authority, endpoint, fixture implementation or frozen assertion. The
[native account-erasure adoption](#native-account-erasure-participant) below adds its three named native cases.
[Search](search.md),
[first-public scope](../scope.md) and [Filtered lists](../filtered-lists.md) retain their authority.
Source inspection baseline: `a42079db4768720dc6075884b5486bbfef42289c`.
The earlier owner-document adoption ran only formatter acceptance; it supplied no native pass or promotion.
The prior native acceptance ran once and failed inherited default-module startup and the Pages deadline; those
failures remain required capability evidence. The prior root typecheck recorded exit 0. No native, full or root
check was rerun for that earlier adoption; the full main/root gate remains unproven. Native closure still requires every
original case and actual new persona/sign-in receipts, with no skips.

## First-public journey walk

[First-public scope](../scope.md) keeps Search behind its existing grants. This ledger does not open Search,
advanced facets/scopes or rating sorts, public Collection/review/Space discovery, or saved-query authoring.
The granted Search journeys and Search's composition consumers below are the finishing inventory.
Web owns surrounding navigation and Semantic owns static Zone routing. Their Search seams are included here.

PASS requires the complete path on dev through native HTTP and its mounted page, using real seeded identities and
every applicable served persona. Record the full dev revision, observation time, elapsed duration and secret-free
evidence reference. FAIL includes a path not observed because its setup or an earlier step failed; name that step
rather than claiming the unexecuted product is defective. A passing implementation typecheck supplies no walk pass.
The latest observed path result replaces its previous result. Existing broader native acceptance remains separate.

Decision: the six first-public rows remain the walk evidence. Retain the exact authorization test
`every walk-stack process names AUTH_JWKS_URL on the issuer origin that signs tokens` in
`services/auth/test/dev-stack-config.test.ts`, including its issuer-origin and native-port rejection assertions;
retain `local JWKS transport fetches only the issuer JWKS URL from native Auth` and the isolated-stack assertions.
No new authorization behavior is introduced by the census. Native/default-worker and mounted return assertions,
Character local-selection and with-dev-server receiving remain required. A complete path passes only when every
required step has an asserted observation; successful earlier requests never fill an unreached step. Focused
reporting tests pin that distinction, actual first-failure retention and failing-journey timing. They are not native
or mounted acceptance. Each round uses a distinct `.temp/search-walk/<UTC-start>/` directory and writes evidence after
each journey, before later journeys can fail. Setup time remains separate from product time. Independent executable
paths continue after persona, seed or sign-in failure. Receive the creator/provisioning repair before ordinary
admission; do not change permissions or create a separate queue from Search.

Orientation before this reporting change: [scope](../scope.md), this manifest,
[verification](../development/verification.md), [local stack](../development/local-stack.md),
[Search](../../services/kernel/src/search/README.md),
[native Search acceptance](../../services/kernel/test/search/README.md),
[Presentation](../../services/kernel/src/presentation/README.md) and
[Composition](../../packages/composition/README.md).

### Receiving status

The creator/provisioning repair is received: implementation `52503f7f63b1673826a554eda1c8baf1fa3598ae`,
integrated binding `6948a89278c0383165a7ed4ca69f1c99506c74a2`, received here as
`2aa83f1adb21aca8b4718d7ba5193176bf14c521`. Ordinary admission succeeded in the new census below.
The prior permission failure is historical. The complete dependency delivery `452da6ea5f43e26967726283ed2fec7c04d3e8ca`
and Source factory delivery `5db0f76f7fc3e81841541152cb1a471692fa5ff7` are also received.
The installed-producer delivery is received below; its original default-worker assertions remain required on
integrated dev.

The complete producer range `311230ca33..91c91989eb` is now received, together with the cumulative root/custody
and Settings deliveries ending at `1b0a5e366a` and `90fe893300`. This includes deferred startup imports, generator
settlement, Library capabilities around the root shell, normalized test selectors and the Settings browser/worker
split. Conflict resolution follows those complete deliveries; the exact issuer-origin JWKS tests and original
Mapping receipt assertions remain. One identical overlapping source-binding test is deduplicated without removing
an assertion. No second stack is launched by this integration.

Landing decision: retain the complete producer/current-owner integration and require current changed-workspace
typing. Original six-path, native/default-worker, mounted browser, Character local-selection and with-dev-server
acceptance run on integrated dev; they remain unaccepted here. No further broad prelanding selection or second stack
is launched. Unchanged passing compilation and independently passing test files remain valid.

The supported-host delivery `0949130e09dc1be6351d33b1f8f2f9e03fd69b1a` and the complete Imports range
`3df1971c0b..7ba752519e` are now received. Host callers supply current native ports, receipt keys and WorkContext;
Imports consumes served publication heads, ranks and tombstones and composes Library. The overlapping bulk
no-effect fixture uses its explicit test keyring for both receipt lookup and the before-finalization absence
assertion. All original behavior assertions remain. These source repairs do not promote the native failures below
to passes. Home already loads the active release before page reading; its missing anonymous/member
TypeList-versus-standalone assertions belong to original integrated-dev receiving, not another prelanding selection.

The changed-workspace typing command at `0ef8ecb3f3160b77d71e7728b5f4a2f491ca7909` returned exit 1.
Auth service, Auth pages and Importer each returned exit 0. Web's product program passed; its scripts program
reported a missing await for asynchronous message preparation and optional evidence fields supplied as undefined.
The isolated runner now awaits preparation and the walk omits absent optional fields, preserving serialized
evidence. No guard or new behavior selection is added. The complete owned log is
`.temp/goal/checks/worker-check-a51d2b6b-d016-41c7-a48b-a35b6edf2ac4-2026-11-07T16-20-35.425Z-7bfb4207.log`.
Relevant typing is repeated for Web, Kernel, Auth service and Importer after this receiving; unchanged Auth pages
reuse their passing result. Besides the expected walk and manifest paths, this receiving changes Web's isolated
runner and the delivered Search composition, native fixtures, Imports source/tests and stack/check placement
bindings. No second stack is started and no browser or native acceptance pass is inferred from typing.

Current landing typing passed at `17aa104b4f98138af072dfd470e1901f2f819157`: Kernel, Web, Auth service and
Importer each returned exit 0. The command ran on host b in 630.654 seconds, peaking at 6311 MiB. Kernel SQL
analysis, compilation and construction passed; both Web programs passed; Importer checked 509 files. The wrapper
reported cleanup of its artifact staging. Complete owned log:
`.temp/goal/checks/worker-check-5217fded-5770-4eb9-9d6b-a3efb65594f4-2026-11-07T16-38-15.680Z-efde0314.log`.
Exact command:

```sh
bun scripts/worker-check.ts -- bun -e 'let status = 0; for (const workspace of ["services/kernel", "apps/web", "services/auth", "services/importer"]) { console.log("Workspace typing: " + workspace); const child = Bun.spawn(["bun", "run", "--cwd", workspace, "typecheck"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }); const code = await child.exited; console.log("Workspace typing result: " + workspace + " exit=" + code); if (status === 0 && code !== 0) status = code; } process.exit(status);'
```

The newer authorization-binding increment remains with its Semantic owner: this settled typing did not expose the
same stale host contract, so no additional increment or unchanged rerun is selected here. The original broad native
and browser receiving remains on integrated dev. The last measured census remains unchanged below.

Landing retry decision: complete the controller-started rebase onto `d83d857aa1cb986eed483ae7dd9aaf180214fd96`,
preserving current message preparation, process custody, Vite and Library setup behavior together with the original
curated-occurrence assertions and safe HTTP failure diagnostics. The ignored-artifact staging failure reproduced
with `git add -- .temp/search-walk`; narrow `.gitignore` exceptions now retain only the five reviewed evidence files.
This is the additional outside-path change. The retry runs the three prescribed Kernel, Web and scripts selections
once on the rebased source; prior typing remains historical evidence, not a fresh native or mounted pass. No new
assertions or second walk stack are added for conflict resolution. The six-path census stays unchanged.

The retained seventeen-file Kernel command at `cea61c8e7dbf418048ea308a87b37031cb7d08ad` returned exit 1 on host b
in 1722.930 seconds. Compilation passed in 21.101 seconds and eight files passed, including native boot, original
receiving-store custody, bulk no-effect and Members composition. Nine files failed. These are native receiving
measurements, not six-path journey durations. Exact command and file results are retained in
`.temp/search-walk/native-receiving-2026-11-07T15-44-09Z.json`; full owned evidence is
`.temp/goal/checks/worker-check-e3b27aa8-09bc-463d-92fe-0f4209c4b106-2026-11-07T15-44-09.792Z-121e98b4.log`.

| Existing cause owner         | Reached native failure retained for integrated receiving                                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search composition           | `nativePorts.subjectSource` undefined at `rated-source.ts:29` from the outcome supervisor; server fixtures omit `KERNEL_RECEIPT_KEYS` and `addEffects`; both complete default-discovery cases time out at 240 seconds.                                                                 |
| Native public output custody | Original receiving reserve returns `dependency_unavailable` at `collection-native-work.ts:327`; Collection build returns `conflict` at `collection-source-output.ts:119`; projection exceeds its plan at `native-public-output-work.ts:68`; read-only INSERT returns SQLSTATE `25006`. |
| Semantic composition         | Native projector start/drain and relation convergence time out; the direct composition fixture has undefined `nativePorts.createIdentitySourceSupportReader` at `composition/semantic.ts:79`; the layer assertion rejects `typebox` and `@rezics/definitions/contract`.                |

No HTTP endpoint, status or correlation is invented for these native calls. The existing cause owners receive this
packet through Semantic. None of these failures changes the last observed census: **0/6 passing**, all six journeys
unexecuted after setup, with no measured failing journey or slowest journey duration.

The preceding fifteen-file Web selection at `dfad29c91c92f247a0f6b8ff43d79819b2248fa5` returned exit 1 after its
own infrastructure rerun. The first physical run, host b `mw6ekf4h-47d3d1a9`, reached four pre-Vite readiness failures
and then `remote-check: deadline reached after 7200000 ms`; its command ran 6996.010 seconds. The wrapper retried
that transport failure on host c. All fifteen selections then failed before test execution, each waiting approximately
150 seconds for a Vite ready line; the command ran 2308.792 seconds, peaking at 5302 MiB. Its first exact diagnostic:
`dev server ready failed for /en; elapsed 150000.10742100002 ms; last error: Error: phase timed out; last error: Error: Vite ready line has not been printed`.
No selected test, including the log-redaction assertion, passed or failed its product assertions. These are setup
measurements, not journey durations. The original startup owner receives both physical outcomes; unchanged
reruns do not replace the newly delivered class repair. Evidence:
`.temp/goal/checks/worker-check-195d7b92-d55d-43de-85b4-07051749241c-2026-11-07T12-51-05.691Z-ee9a9f5d.log`.

Fixture decision: reconcile the genuine completed Mapping receipt before asserting the control ACK in native Search
receiving. Keep the existing 128-step bound and every original custody, transaction, replay and completion assertion.
Do not increase limits to substitute for receipt reconciliation. Setup evidence is checkpointed before each phase;
the concrete persona `Password:` output is redacted before retaining child logs.

The final single-file reporting selection also failed before its test executed:
`bun scripts/worker-check.ts -- bun apps/web/scripts/focused.ts --private-network -- bun test tests/search-first-public-walk-report.test.ts`.
At revision `e5fd604190034f643a182acd908768d7fa64f831`, host b returned exit 1 after 210.886 seconds. First diagnostic:
`dev server ready failed for /en; elapsed 150000.487164 ms; last error: Error: phase timed out; last error: Error: Vite ready line has not been printed`.
Evidence: `.temp/goal/checks/worker-check-c42a7cbc-ee93-4c1d-907a-eb7a69fc1e3d-2026-11-07T11-24-24.906Z-599a279e.log`.
This repeats the existing startup failure; no reporting, Character or with-dev-server pass is inferred. Subsequent
Semantic worker-fixture repair has one existing owner. Receiving keeps the workspace-import parser explanation and
root-spec scope once, and adopts its 60-second repository-wide assertion deadline without relaxing any import assertion.

The authorized proposal-retry range `6ccd350eae..849c1bee2ca6de9f17be5a8f346bbb47e3b85695` is integrated into this
walk branch. Its four source commits retain command deadlines, actor/receipt identity, sealed importer journals and
safe diagnostics. Native proposal, separate authorized adoption and independent current-fact readback remain
required through the cross-media seed. Content's source-fence repair remains independent. The Importer receiving
command `bun test services/importer/tests/reviewed-catalogue-preflight.test.ts services/importer/tests/reviewed-catalogue-proposal-diagnostics.test.ts`
passed all 11 tests; fixture replay does not establish native convergence or growth.

The focused command
`bun scripts/worker-check.ts -- bun apps/web/scripts/focused.ts --private-network -- bun test tests/search-first-public-walk-report.test.ts tests/character-local-selection.test.tsx tests/with-dev-server.test.ts`
failed on host b before the selected tests. Each file's shared server failed `/en` readiness without a Vite ready
line at approximately 150 seconds; the complete command took 497.418 seconds. Exact first diagnostic:
`dev server ready failed for /en; elapsed 150000.257595 ms; last error: Error: phase timed out; last error: Error: Vite ready line has not been printed`.
Owned evidence is `.temp/goal/checks/worker-check-d515db4b-47a0-4458-82fe-3c5c22149460-2026-11-07T09-44-25.762Z-3b064030.log`.
Performance receives this separable shared-startup failure. None of these timings is product journey time, and none
of the three test files has a pass from this command.

The landing command `bun test scripts/docs-check.test.ts services/auth/test/dev-stack-config.test.ts` returned
42 pass and 1 fail. The existing mounted scope-composition case could not load a SQL statement because
`services/kernel/src/content/community-presentation-rules.sql: Cannot connect to the database at 127.0.0.1:20064/rezics (DATABASE_URL in .env): error connecting to server: Connection refused (os error 111); .reylo has no analysis of this statement, so run reylo generate where the database can be reached.`
The exact issuer-origin, native-port refusal, isolated-stack and native-JWKS-transport assertions passed. The SQL
failure is a configured-stack dependency, not a changed JWKS assertion. No unrelated stack is started to hide it.

The installed Members application/runtime is received through the named dev revision
`863e5266e3ec973617a5c97e7f0d202817b36ff6`, including implementation
`7b57f6bfe8f418d322db9a700861dec97a912982`. Its original intent and 64/512/4096 growth assertions remain required;
source integration does not pass them. The merge also supplies its existing Library public-output dependencies.

The native command
`bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/semantic/batch-write-diagnostics.test.ts test/semantic/bulk-no-effect.test.ts test/search/review-population-readiness.test.ts test/search/second-scope-generations.test.ts test/search/review-discovery-receiving.test.ts test/search/default-discovery.test.ts`
ran on host b at walk revision `b97e6a3082f2dedfc188a913848b797513bac51c`, before the Members integration.
It returned exit 1 after 1029.508 seconds. Batch-write diagnostics passed all 3 tests; review-population readiness
passed all 3 tests. The Collection-producing reconciliation fixture failed coverage with
`DiscoveryProducerCoverageError: Discovery generation is not ready: native producer coverage is incomplete (missing kinds: collection)`
(10 pass / 1 fail). Review receiving still failed with
`RangeError: concurrency must be a positive integer below the pool size` (0 pass / 1 fail).
The fixture declared only Account despite publishing Collection metadata. Its registry and generation kinds now
declare both actual producers; raw frontier, currentness and physical target assertions are unchanged. This fixture
failure does not establish a production missing-kind defect. Default-worker startup exposes
`TypeError: createIdentitySourceSupportReader is not a function. (In 'createIdentitySourceSupportReader(config)', 'createIdentitySourceSupportReader' is undefined)`
at `search/identity-receiving-native.ts:136` during Semantic registration. Both complete discovery cases timed out;
the runner reproduced the failure alone. Source/coverage and readiness retain their existing causes and unchanged
assertions; these results were returned to Semantic with owned evidence
`.temp/goal/checks/worker-check-28c4b0af-09aa-4ba9-8ede-3ba3bdd88c98-2026-11-07T09-58-00.894Z-9da9df64.log`.
The proposal no-effect fixture stopped at `error: KERNEL_RECEIPT_KEYS is required` before its assertions. It now
supplies the existing dedicated `testReceiptKeys()` capability, as the ordinary bulk fixture does; no assertion is
removed or weakened. Native check time is not a six-path journey duration.

The subsequent native receiving at `9eac1f44cbaf5b42a844d527f884d5bb674b5c62` returned exit 1 in 173.046 seconds.
Batch diagnostics passed 3/3 and installed Members composition passed 2/2. Original Members intent passed 3/28;
25 cases, including the 64/512/4096 growth cases, failed after mounted Collection admission at native
`library.membersPreparation.reserve` or `library.membersPreparation.touch` with `ProblemError: Not Found`, code
`not_found`. There is no HTTP status or correlation for these native calls. Semantic receives this cause for the
Members owner with unchanged private-denial, intent, replay, retirement and growth assertions. Owned server evidence:
`.temp/goal/checks/worker-check-82772a82-ef7d-41b9-ba80-612ca65c83c2-2026-11-07T10-20-46.644Z-9db9684c.log`.
Bulk no-effect passed 2/3: its remaining failure exposed a fixture lookup still using the raw command key rather
than the executor's derived receipt key. Both the before-finalization and after-commit fixture queries now use the
existing native receipt-key reader; exactly-one receipt, replay, authorization and no-effect assertions stay intact.

The expanded root landing selection returned 106 pass / 4 fail in 86.96 seconds. Signup, step-up, Importer and
page-data receiving passed except for the retained challenge-reset assertion at `turnstile-lifetime.test.tsx:877`
(expected one reset, received zero). Workspace-import receiving reported ten undeclared imports, including Auth's
Operations test import and Importer's Playwright import; its repository scan also exceeded its five-second timeout.
The configured SQL connection refusal above remained. The fresh-stack test failed before startup with
`Bind for 127.0.0.1:54329 failed: port is already allocated`; its `finally` cleanup removed its UUID-owned container,
volume and source copy. These are receiving failures, not journey measurements or permission to change unrelated
authorization and dependency owners. The exact root selection is the landing command supplied with this walk;
all original assertions remain in place.

The eight-file native landing selection at `73b3712c88270d8e81a6fa17f53665ba61f47500` returned exit 1 in
296.254 seconds on host a. Account discovery passed 7/7, copy construction 3/3, Members composition 2/2,
batch diagnostics 3/3 and the corrected bulk no-effect fixture 3/3. Collection source-output (1/10) and canonical
public-output capture (1/16) stopped at Collection creation, expected 201 but received 503. The Subject fixture now
composes the full Library domain in `onAccessReady`, matching the installed server. Boot (1/2) reached its independent
native account synchronization but lacked ReceiptKeys on that newly constructed Pool; the fixture now supplies its
dedicated keys. No original output, disclosure, receipt or startup assertions are weakened. Owned evidence:
`.temp/goal/checks/worker-check-83e6cc48-d843-4b1d-b2ec-17db91b9a9f2-2026-11-07T10-33-45.521Z-e7b3ddbd.log`.
Installed Members authority, Source process-root installation and Pool-aware relay lifecycle remain repairs of their
existing owners. This walk receives their delivered integrations rather than creating another producer.

The nine-file native selection at `7d4f8fe601856792cfaeff8e46d2bf5a3f1329d6` returned exit 1 in 180.700 seconds
on host b. Account discovery passed 7/7, boot 2/2, copy construction 3/3, Members composition 2/2, second-scope
generations 11/11, batch diagnostics 3/3 and bulk no-effect 3/3. Collection source-output remained 1/10 and canonical
capture 1/16. Full Library composition removed the previous Collection POST 503: curated output fixtures then
reached native `not_found`, while dynamic capture setup received HTTP 403. The historical 503 problem code,
correlation and first native phase were not retained and cannot be reconstructed from the status assertion.
Owned evidence: `.temp/goal/checks/worker-check-e0d75f33-40dc-4e00-9882-1ea59baae08b-2026-11-07T10-43-54.757Z-17f8be25.log`.

Fixture decision: explicit public output uses dynamic membership with the actual `library_entry:list`,
`progress_session:list` and `copy:list` scopes and their ordinary exposure gates. Curated authority remains asserted
on a separate actual curated Collection, including two distinct occurrences of the same Subject; activated output,
independent metadata readback, original holds, rollback and money guards remain asserted. Collection setup now
retains only safe phase/endpoint/status/problem/correlation diagnostics on failure. This corrects fixtures to the
installed contract without adding authorization behavior. The existing Members repair owns
`Native public output projection exceeds its plan` at `native-public-output-work.ts:68` and the following
SQLSTATE `25006`, `cannot execute INSERT in a read-only transaction`; no producer repair is duplicated here.
Bootstrap continuation source `b09b9bb129ae6cdb5f6606612d4a4af3ca28f3ca`, integrated on dev as
`08ac6bbe43eea4859cdf8ec5ab6534f9f660aae7`, is received. Its work-module assertions remain required; integration
alone supplies no runtime pass.

The ten-file receiving run at `e9cd0124304e01b936e48912593cb0da0adcd9fb` failed in 217.742 seconds on host c.
The previous seven files still passed. The new curated occurrence assertion needed a non-null Subject ID type
assertion; that compiler defect is corrected. Dynamic setup now records the actual first failure as
`POST /v1/collections`, phase `create-source-collection`, HTTP 403, problem `forbidden`, no correlation header.
Creation requires the three families' `:read` scopes in addition to the already supplied `:list` scopes, so the
fixture now carries both. Work-module receiving exposed missing History installation before inspecting module
names and missing route-key configuration in direct registration. Its child now decorates the live `startWorker`
module list, and direct registration uses the existing worker environment; lifecycle and registration assertions
are retained. Evidence: `.temp/goal/checks/worker-check-22d6f13b-4b7c-4793-b98f-0eb8ff02e05b-2026-11-07T10-55-21.456Z-31d2dbd7.log`.

Receiving at `90be1ee714927d0681386e12fb12ea13355762c1` passed compiler and quality checks and the same seven native
files; the command failed in 304.105 seconds on host a. The dynamic creation 403 is resolved. Both output suites now
reach native `Conflict` at `collection-source-output.ts:119` from allocation at line 167; the unheld-output case still
reaches the projection-plan failure and the following transfer case SQLSTATE 25006. The separate output-custody
repair owns these observations. Work-module startup did not converge and reproduced alone; direct registration
also reached its fixture's throwing authorization callback. That callback now returns the real mounted worker
authorization, and child stderr is retained during readiness waits so a timeout cannot conceal its first diagnostic.
No timeout or lifecycle assertion is relaxed. Evidence:
`.temp/goal/checks/worker-check-191c3565-91de-46dd-beb0-8961a4fdd8aa-2026-11-07T11-05-47.789Z-cb565bff.log`.

The final ten-file native run at `4d25eec24f11b2ba659fdd1bcc06a093736f7a16` passed compiler and quality checks;
the command returned exit 1 in 286.021 seconds on host a. The same seven files passed. Direct Semantic registration
now passes with bootstrap effects retained; its two original worker lifecycle cases still time out at 30/60 seconds
and fail again alone. No child phase, stdout or stderr was produced before the readiness failure, so no hidden
endpoint, status or correlation is inferred. Collection output remains 1/10 and canonical capture 1/16 with the
same allocation Conflict, projection-plan error and subsequent read-only transaction failure. Their original
assertions remain required after the existing output-custody, Source-installation and startup repairs integrate.
Owned evidence: `.temp/goal/checks/worker-check-d2764b95-6e78-4d35-83a8-b70604fa688a-2026-11-07T11-16-04.644Z-7181afbe.log`.
The remote runner recorded cleanup of its databases, process group and artifact staging. No walk stack was admitted
or started by this receiving round.

The focused native receiving command after Mapping fixture reconciliation was
`bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/search/identity-receiving-native.test.ts`.
At `6efbbf6073f15a333f7a1e622b94204c8445f37b`, compiler and quality checks passed. The suite returned
**1 pass / 7 fail, 66 assertions, 22.55 seconds**. Mapping completion and its genuine receipt reconciliation are now
observed. All seven remaining cases fail at `collection-native-work.ts:327` `reserve`, through
`identity-search-receiving-work.ts:168`, with `dependency_unavailable`. Their intended interruption and receiving
completion assertions remain unreached; no expected failure was weakened to accept this refusal.
One retained failure reports native points 1 and statements 3, other axes zero; the SQL footprint is unretained.
The existing finite-work/output-custody owner receives this failure separately from startup.

The command also returned an independent cleanup failure after 240.207 seconds:
`spawnSync docker ETIMEDOUT ["docker","rm","-f","-v","0603c5d8049b690ca6f5f4eba12359652f1af2f10b9febb813be9f40ef04ac0a"]`.
The original check runner retains cleanup custody; no unrelated Docker resources are changed. Whole command exit 1,
319.226 seconds on host b. Evidence:
`.temp/goal/checks/worker-check-c93c0287-7474-46b3-97ed-f4f12771a817-2026-11-07T12-40-21.558Z-35896e8b.log`.

### Last observed dev census

Observed revision: `2aa83f1adb21aca8b4718d7ba5193176bf14c521`. One ordinary admitted walk used
`bun services/auth/scripts/dev-stack.ts walk -- bun apps/web/scripts/search-first-public-walk.ts`.
The script's round began **2026-11-07 12:26:23.118 UTC**. No terminal UTC timestamp survived the memory kill;
the check returned **exit 137**. Slot 1/6 was admitted in **1.006 seconds**. That is setup time, not product time.
The previous round was archived before this run. No second Search stack was launched.

Native persona setup completed for `developer@rezics.test`, Account `99e7b230-90dd-83ae-b5dc-932fcb45ae35`.
Cross-media seed then failed with the retained diagnostic
`Import transport failed phase=response method=unknown target=unknown-origin status=503 problem=none network=none correlation=none`.
Its exact endpoint, problem code and correlation were not retained; none is inferred. Setup continued to frontends.
Web printed Vite ready in **214061 ms**, then the check host terminated the command:
`remote-check: check exceeded its memory limit (6 GiB) while running the check command`.
No bearer/sign-in, browser launch, native Search request or mounted journey observation was saved.

| Journey               | Result                                   | Unexecuted complete path                                                                                 |
| --------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Mixed Search          | FAIL — setup; journey elapsed unmeasured | Submit, open permitted result, return query, phone 390 results, continue, current visibility.            |
| Refine and continue   | FAIL — setup; journey elapsed unmeasured | Type/filter operands, current facets, continuation, restart, mounted facets, reader/resource retirement. |
| Multilingual names    | FAIL — setup; journey elapsed unmeasured | Original-language name, current alias, suggestion, Subject, locale/query/language order.                 |
| Search recovery       | FAIL — setup; journey elapsed unmeasured | Invalid input, corrected native request, mounted correction, lost generation, useful restart.            |
| Configured reading    | FAIL — setup; journey elapsed unmeasured | Selected profile, Subject lists, static-Zone lists, document order, continuation/retry, usable siblings. |
| Published composition | FAIL — setup; journey elapsed unmeasured | Publish A, working B, public A over B, lost/refused response, reconciliation, mounted public A.          |

The result is **0/6 passing**. There is **no slowest measured failing journey**, because no journey began.
Planned operands were `Steins;Gate`, book text `The`, `シュタインズ・ゲート`, alias `CLANNAD`, invalid text `"unclosed`,
Types `wd:Q689445` and `schema:Book`; desktop 1280, phone 390 and `en`/`zh-Hant`/`ja` visits remain unexecuted.
Seed 503 and frontend memory termination are separable setup failures, not measured Search product failures.
The existing startup owner receives the memory diagnostic; the existing seed/source-fence owner receives the 503
with unavailable endpoint/correlation explicitly marked. No heap, deadline, pool or permission change is made here.

Secret-free retained evidence:
`.temp/search-walk/2026-11-07T12-26-23-118Z/census.json`, `persona.log`, `seed.log` and `stack.redacted.log`.
The census was reconstructed only from returned artifacts, not a completed walk report. Persona passwords are redacted.
The full owned check log is
`.temp/goal/checks/worker-check-ef268857-9864-46fb-ab95-2656f01f54d9-2026-11-07T12-13-33.053Z-f3dcd568.log`.
The remote runner reported artifact staging cleanup. No walk-specific container/lease cleanup receipt was retained,
so this ledger does not independently assert that cleanup completed.

### Scope of this census and handoff

The earlier permission failures at 07:33/07:34 UTC (0.887/0.711 seconds, revision
`93eb7908d8e983998d4b280ea275b131aaa444a1`) are superseded by successful ordinary admission.
Native/default-worker receiving and mounted Character/with-dev-server assertions remain required. Compiler,
fixture and reporting passes cannot fill any of the six unexecuted paths. Existing output-custody, installed-producer,
WorkModule lifecycle and frontend startup repairs retain their current owners.

### Additional owner-requested acceptance

Owner-requested Kernel cells ran through the owning runner on this attempt (host b, 2026-11-07 07:35–07:48 UTC,
rev `93eb7908d8e983998d4b280ea275b131aaa444a1`). They are not mounted-journey evidence and do not pass any of the six
rows.

| File                                              | Actual result                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/search/review-population-readiness.test.ts` | PASS (3 tests). Executed 2026-11-07 07:35 UTC through the Kernel runner.                                                                                                                                                                                                                                                                                                                          |
| `test/search/second-scope-generations.test.ts`    | FAIL: `DiscoveryProducerCoverageError: Discovery generation is not ready: native producer coverage is incomplete (missing kinds: collection)` at `generations.ts` `assertDiscoveryProducerCoverage`; case “a later metadata reconciliation step resumes the committed raw frontier before indexed cleanup” (10 pass / 1 fail). The injected setup already has a collection producer.              |
| `test/search/review-discovery-receiving.test.ts`  | FAIL: `RangeError: concurrency must be a positive integer below the pool size` at `events/relays.ts` `startRelays` from `search/runner.ts:414` (`concurrency: options.concurrency ?? 2`) during `runner.refresh()`; case “default mixed supervisor applies current reviews and recovers exact journal progress” (0 pass / 1 fail). Prior `unknown-resource-action` catalogue error did not recur. |
| `test/search/default-discovery.test.ts`           | FAIL: both cases `OutcomeRpcError: init did not complete within 90000 ms`, then `Worker did not drain: {"code":null,"signal":"SIGKILL"}` (0 pass / 2 fail, 477.19 s). Child stdout in the drain error was empty.                                                                                                                                                                                  |

**Receiving coverage repair, Source/publication owner `bf195aa3`:** the failing metadata-reconciliation case already
injects a `collection` producer (`owner: commerce`) in `metadataProducers`; the injected registry/target kinds are
account-only. Reconcile that registry/target/producer contract in existing receiving, then rerun the same case. Do not
install a new producer, drop the coverage assertion, or open deferred metadata. Commerce remains owner of Collection
records.

**Review relay concurrency repair, readiness owner `7a3f2fc9`:** `startRelays` refuses `concurrency >= pool.options.max`.
`runner.ts` defaults `concurrency` to 2. Size the Review discovery fixture pool above 2, or pass
`relayConcurrencyForPool(options.pool)` instead of 2. Keep the existing coverage assertions. Do not loosen
`startRelays`. The prior Content/Accounts catalogue fixture error did not recur on this product.

**Default-worker init repair, readiness owner `7a3f2fc9`:** both default-discovery cases failed at
`startOutcomeWorkerProcess` `rpc.request('init')` (`timeoutMs: 90_000`). Child `outcome-worker.ts` `startWorker` never
replied; `close()` awaits that `ready` then SIGKILLs at 90 s (`Worker did not drain: {"code":null,"signal":"SIGKILL"}`).
The drain error carried empty child stdout. Capture child stdout in the 90 s init window. Keep the existing assertions.
This is not a new Imports outcome. Receive those integrated changes in the sole walk; no second native producer.

Web Character local-selection and with-dev-server cells were retried 2026-11-07 07:48 UTC after `95e3fac9` became an
ancestor: focused Web again returned `Web check unavailable: the selected Performance snapshot is not integrated into
canonical dev`. Commerce 401f58 assertions remain required. Loans query/read stay Commerce-owned.

## Evidence rules and common boundaries

Each capability records five separate stages: **specification validated red**, **native driver registered**,
**implementation exposed**, **user-case native pass at named revision**, **promoted**. A source-present assertion
is not a measured red result. A formatter, missing-driver verifier, helper, registration, source inspection or old
focused green supplies no native pass. Promotion requires main evidence covering the named revision and every
applicable cell. REQUIRED NOT YET FROZEN/BOUND means an obligation remains open, not a successful rejection.
Commands in the original inventory identify evidence entry points for later owner checks. The native
account-erasure section separately records its actual focused check and root typecheck results.
Exact original titles and declared counts are in [the suite ledger](#original-suite-ledger).

Every six-cell table covers public/private/unlisted source visibility and anonymous, editor, owner (Alice), other
owner (Bob), delegated actor, unscoped actor, the suspended account's pre-suspension bearer and revoked/invalid
credentials. Existing SearchDriver exposes only anonymous/editor/acceptor/suspended; PagesDriver adds curator instead
of acceptor.
The other personas require real native fixture extensions; a public grant cannot stand in for them. Public output
never borrows an editor's private authority. A grant on a Collection or Zone grants nothing in its sources.
Bans beat independent grants. The [Search supervisor](../../services/kernel/test/search/support/outcome-supervisor.ts)
calls `createSemanticDriver` in the [Semantic outcome driver](../../services/kernel/test/semantic/outcome-driver.ts).
That driver creates its own named `suspended` account, issues an ordinary Auth bearer, then calls the real
`createSuspensionCommands.suspend` with an authenticated governor and native Access
([suspension](../../services/kernel/src/access/suspension.ts),
[authentication floor](../../services/kernel/src/access/authenticate.ts)). The
[Pages outcome driver](../../services/kernel/test/presentation/outcome-driver.ts) wraps that Semantic driver.
None calls `createPersonas`; the canonical [personas.ts](../../services/kernel/test/support/personas.ts) demonstrates
the same native suspension contract with a separate builder and account instance. These drivers do not synthesize
SQL suspension state or tokens. Accounts suspension advances the authentication floor before session revocation.
The pre-suspension bearer is rejected as JSON `401 invalid_credentials` with
`WWW-Authenticate: Bearer error="invalid_token"`; revoked credentials remain a separate 401 control, and neither
downgrades to anonymous. Auth mints active accounts only; correct-password sign-in for a suspended account returns
`403 ACCOUNT_SUSPENDED` without a session, while wrong-password sign-in remains ordinary 401. Accounts owns that
sign-in producer case; its native acceptance receipt is pending. A kernel `403 account_suspended` for a hypothetical
verified suspended bearer is defensive only.

Shared producer/consumer boundaries: Semantic owns released meanings, complete selected-public projections,
original/terminal identity and Zones; Imports owns reviewed provider mappings; Commerce owns common Collections,
owner facts and owner-query admission; Content owns public rating figures and native private populations; Accounts
owns Auth/Access and consent; Search owns public plans, indexing and presentation aggregation; Web owns publication;
Performance owns budgets and capture. This inventory covers Search participation in every relevant In scope row;
other owners retain accounts, checkout, notices, moderation and content commands. Articles/hosted works remain
closed behind grants; feeds, algorithmic recommendations, saved personal queries, Realm rating sorts and points
remain deferred. Curated rankings, Global rating order and Collection export remain relevant consumers.

## Released fixture definitions and logical records

The [report's definitions and fixtures](../research/api-acceptance-gaps.md#definitions-and-fixtures-the-missing-cases-require)
are shared producer requirements, not independent test-only releases. Inspection of the bundled
[release](../../packages/definitions/release/rezics.json), [Book](../../packages/definitions/catalogue/book.yaml),
[Recipe](../../packages/definitions/catalogue/recipe.yaml), [classification](../../packages/definitions/catalogue/classification.yaml)
and [game](../../packages/definitions/catalogue/game.yaml) does not supply the complete builder or its pins.
Semantic/Imports must supply a versioned native fixture builder mapping logical records to actual created IDs,
released property/Concept identities, release digests and reviewed import provenance. None is invented here.

| Fixture                | Required logical records and controls                                                                                                                                                                                       | Current producer gap                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Genuine words          | B-long=1200001, B-edge=1000000, B-short=999999; B-unknown absent/somevalue; B-characters has characters-only1400000; edition-page control                                                                                   | Semantic must release nonnegative integer `schema:wordCount`, unit `1`, Book facet and native data. Pages, characters and reading-time estimates cannot fill words.                                                          |
| Form and tag           | B-long, B-edge, B-characters are LN+HAREM; B-short LN without HAREM; B-unknown HAREM with unknown form; B-tag-only different form; B-form-only no HAREM                                                                     | Real public adopted LN/HAREM Concepts with scheme/labels/attribution and a released FORM property/mapping are missing as a pinned native fixture. FORM/LN/HAREM are logical names, never placeholder CURIEs or exported IDs. |
| Diet and duration      | R-quick vegetarian25, R-edge vegetarian30, R-slow vegetarian31, R-meat nonveg20, R-unknown unknown-diet20, R-cooked vegetarian20, R-other-cooked vegetarian20; unknown cookTime excluded; authored ingredients/instructions | `schema:cookTime` integer minutes (`wd:Q7727`) exists; Semantic must release diet representation/vegetarian Concept mapped to VegetarianDiet. No private label or ingredient heuristic supplies diet.                        |
| Completion             | Alice completed R-cooked; only Bob completed R-other-cooked; all four quick vegetarian recipes have Alice support                                                                                                           | Commerce must adopt the owner-query wire and absence-of-own-live-completed-cooking-session semantics. Clearing state cannot erase completed history.                                                                         |
| Releases               | Actual Switch/Japanese and PC/English crossed statement qualifiers, dates, work/release distinction, compact/expanded storage                                                                                               | Semantic/Imports own native released tuples; Switch+English must not combine statements, Switch+Japanese must match. Aggregate work platforms invent no releases.                                                            |
| Owner support and pins | Alice state-only, label-only, session-only, completed-history-only and holding-only subjects, overlap, empty shell and follow-only; Bob independent; two immutable releases and renamed/retired choices                     | Bundled library profiles/type bindings and native released pin fixture are missing. Alice label/holding-supported B-long must exist without state or entry. Unprofiled Person cannot gain a fresh state.                     |
| Sources                | C-public contains all controls, duplicate occurrence with separate note and B-long alias; distinct private/unlisted Collections and published dynamic generation; Z-public overlapping mount+scope                          | Commerce/Semantic must bind real common members and canonical union consumers, not a fake response.                                                                                                                          |
| Reductions             | Newly withheld HAREM on readable subject, hidden tag target, local/foreign source/consent/target loss, hidden original/readable terminal, invalid public generation                                                         | Semantic/Accounts must provide native reductions and deterministic barriers; Search must bind repair/ACK and current consumers.                                                                                              |
| Rating and traversal   | Real independent Global voters, threshold/prior controls, extreme private Realm producer, paged credits/claims, unpublished Realm work, global agent, late board loss                                                       | Existing Global native fixture is reusable; Content owns the missing private population, Semantic/Content/Web own composed context and traversal fixture pins.                                                               |

## catalogue-jobs

**User job:** find words>1000000, light-novel+harem (LN+HAREM), both, vegetarian+cookTime≤30 and platform releases with qualifiers
on one statement. **Personas:** all common personas, plus native acceptor. **Released fixtures:** words/form/tag,
diet/duration/completion, release tuples, owner support/pins and sources above. Book range uses existing inclusive
`gte:1000001`, unit `1`; minute storage and request units must agree.

| Surface                  | Required consumer result                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CATALOGUE                | Anonymous words and combined exact {B-long}; LN+HAREM exact {B-long,B-edge,B-characters}; diet/time exact {R-quick,R-edge,R-cooked,R-other-cooked}; crossed release tuple excluded. Private completion predicate unavailable anonymously. |
| CURATED                  | Same catalogue predicates intersect eligible canonical C-public membership; occurrence editor separately preserves duplicates/notes/order. Alice personalization only where Commerce admits it.                                           |
| EVERYTHING WITHOUT STATE | Intersect each exact set with Alice's support union, including label/holding-only B-long with no state; no fabricated entry. Own not-completed set {R-quick,R-edge,R-other-cooked}.                                                       |
| OWN STATE                | Same catalogue predicates intersect Alice's selected accepted state; Bob's state irrelevant. Adopted completion predicate includes supported no-entry subjects where applicable; it is not `state != cooked`.                             |
| MOUNTED ZONE             | Same exact sets over eligible mount+scope canonical union, all pages without duplicate subjects; public results never read Alice history. Private personalization remains pending explicit owner admission.                               |
| configured TYPELIST      | Configured Book/Recipe/game lists agree with the predicates and eligible population. Subject detail projects words/unit/form/tag/diet/time/release tuples factually; no new filtered detail-object API.                                   |

**Frozen scenarios and binding:** reuse original “Statement filters use adopted Global values and positive roots
admit bounded negation” and relation “qualified relation facet filters are refused without changing unqualified
author semantics” from the ledger. These author cases do not prove the required catalogue jobs. Reuse dynamic
“shared cursors bind Collection identity, the effective filter, and the admitted sort” in
[dynamic outcomes](../../specs/dynamic-collections-outcomes.test.ts); its concrete query serialization does not
mount common route admission. Current [members route](../../services/kernel/src/library/collection-routes.ts)
admits view/cursor/limit, not the full shared query. Required six-cell named scenarios: REQUIRED NOT YET FROZEN/BOUND.
More-than-preview facet values and properties must be reachable through an actual owner API; current facet size≤20
and properties≤8 do not supply a continuation schema. Owner adoption is pending, not silently dropped.

**Native wrapper/command:** [Search wrapper](../../services/kernel/test/search/outcomes.test.ts) and
[relation wrapper](../../services/kernel/test/search/relation-facet-outcomes.test.ts), with the Search driver;
`bun run --cwd services/kernel check test/search/outcomes.test.ts test/search/relation-facet-outcomes.test.ts`.
Path 7 tagged-work admission, remaining-predicate kind proof, same-statement quantity matching and cursor
traversal are `test/search/tagged-work-plan.test.ts`, `test/search/tagged-work-query.test.ts` and
`test/search/type-facet-kind.test.ts`; native direct/prepared agreement, measured retained raw progress/frontier,
bounded resume and generation retirement are `test/search/tagged-work-native.test.ts`; the mounted Concept list and Search weight control are
`apps/web/tests/concept-tagged-works.test.ts`. Direct tagged-work walks `min(600, 6s+3)` raw rows; prepared serving
walks at most 600 retained superset rows because concept statements stay a property-superset until current proof. Released meaning IDs come from Definitions; LN/HAREM Concept
UUIDs and crossed platform/language tuples stay Semantic `classification()`/`platform` prerequisites.
No complete six-surface catalogue command is registered. Semantic/Imports first supply released definitions and
builder/pins; Commerce adopts owner query, then consumers reuse those records. Unsupported required requests remain
failures of the job; typed422 only passes deliberately unsupported controls. No title matching or fake release. Seeded
browser proof of the mounted Concept list stays held until existing stack releases land.

| Stage                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| specification validated red             | Original assertions present; measured red receipt not recorded here; new jobs REQUIRED NOT YET FROZEN.                                                                                                                                                                                                                                                                                                                                                                                          |
| native driver registered                | Original Search/relation wrappers registered; required released cross-surface jobs unbound.                                                                                                                                                                                                                                                                                                                                                                                                     |
| implementation exposed                  | Search/facets exist; Collection directory capability, recency/popularity order, occupancy bound 600 and selected public A over working B are mounted on the Search consumer (`collection-directory.ts`, `catalogue-publication.ts`) with focused native directory/publication tests. Lookup reads stored A from the pinned generation; HTTP `renderSelected` fills those identities. Required definitions, owner query and generic members admission remain incomplete. Browser/main stay held. |
| user-case native pass at named revision | None recorded for this capability. Directory/publication focused native evidence is current, not six-surface catalogue closure.                                                                                                                                                                                                                                                                                                                                                                 |
| promoted                                | No main closure evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## query-privacy

**User job:** search/refine safely during paused indexing, including positive/NOT HAREM, order, facet value/label,
requested field and confidential consumed cursor. **Personas:** all common personas with local and foreign
source/consent/target reductions. **Released fixtures:** reductions, books, Concepts and sources above; no private
values/IDs may enter public projections.

| Surface                  | Required consumer result                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CATALOGUE                | Native current filter/order-key narrowing protects exclusions and order, own-row reductions protect emitted fields; no public Search totals at all, including rating. |
| CURATED                  | Reauthorize source and originals/terminals at disclosure, including unlisted/private sources; public curator authority never bypasses a reduction.                    |
| EVERYTHING WITHOUT STATE | Current Alice authority and owner-row checks plus public catalogue dependency safety; labels/holdings remain private.                                                 |
| OWN STATE                | Same safety for own state/completion predicates; another principal, withdrawn delegation or consent cannot use the cursor.                                            |
| MOUNTED ZONE             | Zone grant does not grant mount/source/subject rights; local AND foreign dependent reductions protect union exclusions/order.                                         |
| configured TYPELIST      | Same Search safety in page aggregate, with requested facts/labels and final barrier; no aggregate cache becomes authority.                                            |

**Frozen scenarios and binding:** originals for paused hide/takedown and relation target hide in the ledger;
[deletion/count outcomes](../../services/kernel/test/search/deletion-count-outcomes.test.ts) declares four expanded
cases: “hidden source deletion immediately withholds hidden-only search totals and type/code/item facet counts”,
“hidden source deletion immediately withholds mixed visible/source search totals and type/code/item facet counts”,
“taken_down source deletion immediately withholds hidden-only search totals and type/code/item facet counts”, and
“taken_down source deletion immediately withholds mixed visible/source search totals and type/code/item facet counts”.
They check contributing sources, not just bucket target labels, but still assert totals and need owner reconciliation.
[Live facets](../../services/kernel/test/search/live-facets.test.ts) has “live facet counts include only current
disclosed source matches and values” and “repeated facts and duplicate hits contribute once per source and value”;
these helper cases are internal accounting evidence, not public count permission or complete API binding.
[Confidentiality outcomes](../../services/kernel/test/search/cursor-confidentiality-outcomes.test.ts) declares two:
“real API cursor confidentiality after a rejected hidden lookahead” and “real API cursor confidentiality after a
rejected taken_down lookahead”. They resume from rejected consumed keys through real HTTP with indexing paused
for anonymous and editor; the suspended pre-suspension bearer stays 401 and pages omit totals.

**Native wrapper/command:** the owning [native query-privacy cell](../../services/kernel/test/search/query-privacy-user-cases.test.ts)
reuses released Book, Concept, owner and transport fixtures for positive/NOT membership, requested fields,
name/rating order, local/foreign reductions, permission changes, final-observation races and ordinary relay recovery.
`bun run --cwd services/kernel check test/search/query-privacy-user-cases.test.ts test/search/query-privacy.test.ts test/search/query-privacy-page.test.ts test/search/query-privacy-aggregate.test.ts test/search/owner-current-disclosure.test.ts`.
Decision: preserve the exact native page opener through request/continuation handles; an irrelevant excluded-key
reduction must leave useful anonymous/editor pages during Search-only pause, while returned-subject blocks and
suspended credentials retain their independent checks. Initial/final owner hydration batches at 100 identities
also cover a full 200-candidate window. Unit cases distinguish admitted cursors, positive kind lower bounds and
independent whole-query aggregate proof. Native passage must be observed; seeded browser and promoted-main closure
remain held separately. The older deletion/count wrappers need reconciliation of their public-total expectations;
they are not the owning acceptance cell. Reuse the
[Semantic producer contract](../../services/kernel/src/semantic/public-filter-source-contract.md):
same-transaction lossless reductions, complete routing/registration, all4096-home logical coverage through
behind/changed access paths, actual refresh-visible local AND dependent foreign repair before contiguous ACK.
ACK binds physical target/incarnation, consumer/projection generation and meaning/read definition; checkpoint/alias
is insufficient. Late registration, old snapshots, lost CAS, ambiguous sink result and pruning must not advance ACK.
Start/final validation detects a relevant reduction even if repaired/ACKed between observations. Unknown routing
prepares; query key narrowing never replaces Access or own-row checks. No estimate, zero or row-length fallback.

| Stage                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| specification validated red             | Existing cases present; measured red receipt not recorded; full race matrix REQUIRED NOT YET FROZEN.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| native driver registered                | Deletion/confidentiality outcomes registered; complete producer/repair/ACK binding missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| implementation exposed                  | Query-privacy capture/query/repair/refresh-visible acknowledgement consumes Source blocking as the relevant barrier. Trusted stale unacknowledged or changed heads recover ordinary permitted pages while indexing is paused; relevant blocking and incomplete routing prepare. Current native disclosure still governs membership, exclusion, order and displayed fields after nested facet or label reads. An admitted cursor, a positive kind witness and an exact aggregate stay distinct proofs; sampled hits never certify totals. Public Search totals remain omitted. Native persona/lag cells and seeded browser stay unaccepted. |
| user-case native pass at named revision | None recorded for this capability. Native persona cells are recorded separately from promotion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| promoted                                | No main closure evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## freshness-and-recovery

**User job:** see ordinary edits within60s healthy, readiness beyond5m actual source-to-searchable lag, and owner
writes on the next read; reach useful full/final sparse/deep pages or explicit preparation. **Personas:** all common
personas through interruption/restart. **Released fixtures:** growing sparse sources, independent owner writes,
foreign repairs and retained finite build input using the shared records/pins.

| Surface                  | Required consumer result                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| CATALOGUE                | Measure whole relay/dependency/preparation/refresh path; finite retained progress fills sparse/deep/final pages. |
| CURATED                  | Filtered canonical members fill or exhaust; source revocation is immediate or explicit readiness.                |
| EVERYTHING WITHOUT STATE | Alice label/holding/session writes appear next read even with public index lag.                                  |
| OWN STATE                | State/completion write cannot hide behind stale owner preparation.                                               |
| MOUNTED ZONE             | Union consumer retains progress over every source and survives crash/replay without empty-success chains.        |
| configured TYPELIST      | Aggregate propagates honest preparation/unavailable and useful pages; no permanent preparing.                    |

**Frozen scenarios and binding:** retain original “New subjects become searchable and suggestible within fifteen
seconds with current as_of”, the original unavailable/rebuild cases and
[real-source composition](../../services/kernel/test/search/real-source-composition.test.ts) “Search pause drains its
runner while real semantic relation events converge, and resume owns one replacement”. Fifteen-second original
assertions remain intact; the shared healthy60s/max5m contract also needs pipeline/owner coverage. Dynamic
“bounded Collection filters advance opaque prefixes through hidden and filtered candidates without joins” in
[dynamic outcomes](../../specs/dynamic-collections-outcomes.test.ts) explicitly expects empty success and an old
candidate multiplier. Commerce/Search/Performance own reconciliation; it is not blessed as useful-page acceptance.

**Native wrapper/command:** original Search wrapper plus real-source composition imports the driver client;
`bun run --cwd services/kernel check test/search/outcomes.test.ts test/search/real-source-composition.test.ts`.
Full retained preparation crash/owner-read-after-write matrix: REQUIRED NOT YET FROZEN/BOUND. Reuse interruption
controls; expose actual admitted plans/frontiers, not an in-memory result or endless preparation.

| Stage                                   | Evidence                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| specification validated red             | Original assertions present, measured red not recorded; full recovery matrix not frozen. |
| native driver registered                | Search/default-worker slice registered; owner/prepared cross-surface binding missing.    |
| implementation exposed                  | Ordinary indexing exposed; complete useful-page/preparation pipeline not established.    |
| user-case native pass at named revision | None recorded for this capability.                                                       |
| promoted                                | No main closure evidence.                                                                |

## canonical-keysets-and-generation

**User job:** traverse unique canonical subjects across pages/merges/identity epochs with private bound cursors,
and restart409 on generation change, including empty results. **Personas:** all common personas; hidden originals
with readable terminals, last eligible original in actual4096-original group. **Released fixtures:** sources, aliases,
two releases, identity epochs and real large groups; stored personal originals remain unchanged.

| Surface                  | Required consumer result                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| CATALOGUE                | Canonical cross-page uniqueness and epoch readiness/restart; original AND terminal access, no arbitrary representative. |
| CURATED                  | Canonical browsing unique across pages; curation retains each occurrence's order/note and duplicate identity.           |
| EVERYTHING WITHOUT STATE | Union support by canonical subject without losing original grants or owner conflict/pins.                               |
| OWN STATE                | Latest owner state with visible conflict, union labels, separate sessions/copies; no fabricated access via terminal.    |
| MOUNTED ZONE             | Overlapping sources/aliases produce one canonical traversal; current source authorization on continuation.              |
| configured TYPELIST      | Same canonical cursor/epoch/generation contract even when underlying query returns zero hits.                           |

**Frozen scenarios and binding:** original name paging/rebuild cases; [bounded generation readiness](../../services/kernel/test/search/bounded-generation-readiness.test.ts)
“an alias switch after readiness pins the verified physical generation including zero-hit queries”; and
[query generation](../../services/kernel/test/search/query-generation.test.ts) “zero native hits retain the explicitly
selected generation for every nonrating sort”. The latter is a query seam, not a complete HTTP capability.
[Bounded name outcomes](../../services/kernel/test/search/bounded-name-cursor-outcomes.test.ts) has “legal compatibility
ligature names page through the real API with native null sort keys and confidential bounded cursors”.
[Canonical coverage](../../services/kernel/test/search/canonical-coverage.test.ts) retains adversarial witnesses,
but helper/certificate scaffolding is not the adopted epoch lifecycle. Actual4096-original HTTP controls across
these surfaces: REQUIRED NOT YET FROZEN/BOUND; no per-page alias sweep or raw256 protocol is adopted.

**Native wrapper/command:** Search wrapper and bounded-name outcome driver client;
`bun run --cwd services/kernel check test/search/outcomes.test.ts test/search/bounded-name-cursor-outcomes.test.ts test/search/bounded-generation-readiness.test.ts test/search/canonical-executed-recovery.test.ts test/search/canonical-keyset.test.ts`.
Search binds confidential principal/request/operation/generation/epoch cursors; Semantic supplies maintained
identity access paths, Commerce supplies occurrence versus canonical read boundaries.
Focused native HTTP recovery (`canonical-executed-recovery.test.ts`) pins unique traversal, generation restart and
terminal pages separately from browser and promoted-main proof.
Decision: those four native HTTP cases are the fewest user-visible recovery pins; canonical self is admitted only from
a published mapped-self row supplied by revision-1 creation or bounded original recovery, while absent mappings stay
in the existing preparation path.
Decision: identity receiving stores the resolved public-filter definition, not a release digest; OLD/NEW/first-apply
follow published mappings and retained copies. Native suites wire searchIdentityReceivingComposition and the Source
maintenance frame. Library cutover fixtures include collection:delete so Access compiles the collection owner role,
compose the Library domain through composeLibraryDomain before Collection source setup, keep Collection create on the
owner account through own-account Collection commands and JWT scopes, and mount follow:create/delete as own-account.
Administering collection:* onto the owner-account resource through access.grant is denied because collection:create is
typed to library.collection.

| Stage                                   | Evidence                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| specification validated red             | Existing assertions present; measured red not recorded; complete4096-original matrix not frozen. |
| native driver registered                | Existing HTTP slices registered; large-group cross-surface binding missing.                      |
| implementation exposed                  | Cursor/generation seams exist; executed-request HTTP is canonical-executed-recovery.test.ts.     |
| user-case native pass at named revision | None recorded for this capability.                                                               |
| promoted                                | No main closure evidence.                                                                        |

## global-rating-order

**User job:** sort by Content's safe Global standard-question score with correct threshold/prior, zero/null, ties,
order, cursor, epoch and generation behavior. **Personas:** all common personas and independent real voters;
private Realm producer adds private-rating-isolation only. **Released fixtures:** reuse actual native voter builder,
21 legal subjects, five independent voters, threshold5, genuine50/100-answer prior changes; new extreme private
Realm population belongs to Content, not seeded public score rows.

| Surface                  | Required consumer result                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| CATALOGUE                | Real vote→default worker→public figures→index→HTTP ordering; no population/question override and no public total.              |
| CURATED                  | Same admitted rating order over eligible canonical Collection members; editor occurrences retain their own ordering.           |
| EVERYTHING WITHOUT STATE | Same public rating order over Alice support, including no-state subjects; private facts do not affect public scores.           |
| OWN STATE                | Same rating consumer intersect Alice accepted state; no private Realm score substitution.                                      |
| MOUNTED ZONE             | Same order over eligible canonical union with current rating/subject disclosure.                                               |
| configured TYPELIST      | Same default Global score population/order; composed subject cards identify honest population and insufficient/updating state. |

**Frozen scenarios and binding:** RETAIN [native rating outcomes](../../services/kernel/test/search/native-rating-outcomes.test.ts),
“real native votes publish Global scores through the default worker, relay and Search with current disclosure”
(one declared case). It covers actual votes, threshold fall5→4→0 while paused, prior growth/end, zero ahead of null,
name/id ties, order, old cursor epoch/generation409, tamper, hide/takedown, override rejection and the suspended
pre-suspension bearer 401.
RETAIN four [rating API outcomes](../../services/kernel/test/search/rating-api-outcomes.test.ts):
“Global rating null ties page by normalized name then id for anonymous and editor; suspended fails”; “Real signed
rating cursors bind the entire request and principal and reject a reconciled generation change”; “Current hide and
takedown suppress stale rating hits and refill pages with Search paused”; “Ordinary Global rating search rejects
population and question body overrides as unknown fields”. Do not replace these with another fake-positive/null-tie suite.

**Native wrapper/command:** native rating uses createDriverClient/nativeVoter/nativeVote; rating API uses SearchDriver;
`bun run --cwd services/kernel check test/search/native-rating-outcomes.test.ts test/search/rating-api-outcomes.test.ts`.
Actual [route](../../services/kernel/src/search/http/routes.ts) sort union still lacks rating and requires total:
exposure gap, not absence of native acceptance. Internal unique-disclosed accounting/engine budgets are separate
from wire omission. New private-rating-isolation: REQUIRED NOT YET FROZEN/BOUND; existing controls reject private
inputs rather than produce an extreme private Realm. Reuse Global suite; Content adds genuine private producer,
Search public consumer. Other surfaces remain required binding gaps.

| Stage                                   | Evidence                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| specification validated red             | Native assertions present; measured red not recorded; private producer job not frozen.        |
| native driver registered                | Native Global producer and API consumers registered; private Realm producer missing.          |
| implementation exposed                  | Public sort admission and no-total transport incomplete; do not infer pass from registration. |
| user-case native pass at named revision | None recorded for this capability.                                                            |
| promoted                                | No main closure evidence.                                                                     |

## typeahead-and-invalid-requests

**User job:** get bounded public suggestions and typed failures for closed text syntax, strict filters,
unsupported422, unavailable503 and cursor restart409. **Personas:** all common personas; editor sees public source
projection; no private owner-specific suggestions. **Released fixtures:** original multilingual names/aliases,
public/hidden/taken-down controls, request budget boundaries and opaque cursors.

| Surface                  | Required consumer result                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| CATALOGUE                | Actual suggest q≤64 code points, limit1–10, public disclosure; closed text/filter admission and typed failures.                                   |
| CURATED                  | Shared generic list request admission remains required; a Collection search box consumes public suggest, with no separate private suggestion API. |
| EVERYTHING WITHOUT STATE | Shared owner list filters/cursors remain required; typeahead supplies public subjects only, never Alice labels/history.                           |
| OWN STATE                | Same public suggest boundary; owner predicate admission belongs to Commerce, not a hidden suggest parameter.                                      |
| MOUNTED ZONE             | Shared union list admission remains required; mounted SearchBox uses public suggest without inheriting source grants.                             |
| configured TYPELIST      | Shared list filters/order/cursor validation plus public SearchBox consumer; no separate members API for typeahead itself.                         |

**Frozen scenarios and binding:** reuse original typeahead, text admission, filter admission, unavailable and rebuild
scenario titles in the ledger, plus source privacy originals. Search public service and HTTP admission must agree;
400 malformed envelope and422 unsupported plan are distinct. The native pre-suspension bearer returns JSON
401 `invalid_credentials` with `WWW-Authenticate: Bearer error="invalid_token"`; the verified-suspended403 branch is
defensive only. Delegated/unscoped/revoked fixture coverage remains REQUIRED NOT YET FROZEN/BOUND where the existing
driver cannot express it.

**Native wrapper/command:** SearchDriver via Search wrapper;
`bun run --cwd services/kernel check test/search/outcomes.test.ts test/search/native-recovery.test.ts test/search/canonical-executed-recovery.test.ts`.
No new suggest suite is needed for already frozen prefixes/operators/budgets; extend only missing persona/source
outcomes after owner adoption. Shared consumer acceptance is catalogue-jobs and composition-and-profile-governance.
Focused Web adapter tests pin installed Search/suggest/facet/Realm native HTTP families; they are not a native pass.
In-budget invalid HTTP keeps pointers; over-budget authored JSON restarts without echoing the payload.

| Stage                                   | Evidence                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| specification validated red             | Original assertions present; measured red not recorded; expanded persona coverage remains unbound. |
| native driver registered                | Original Search wrapper registered; expanded personas unbound.                                     |
| implementation exposed                  | Suggest canonical-admits after identity; in-budget invalid HTTP keeps pointers.                    |
| user-case native pass at named revision | None recorded for this capability.                                                                 |
| promoted                                | No main closure evidence.                                                                          |

## index-and-default-runtime

**User job:** operate documented OpenSearch/ICU analysis and observe converged public HTTP after real source events,
outage/recovery and safe rebuild. **Personas:** operator, editor/acceptor and all common read personas.
Decision: retained-stack multilingual acceptance reuses its existing source identities, node volume and native
publication lifecycle. Isolated analyzer checks and unavailable page walks supply no positive journey evidence.
Walk stacks prove that journey: checks stay on hosts a/b, while `dev-stack.ts walk` stays on the worker host so
`GOAL_ACCEPTANCE_REQUIRES` is not stripped. The worktree docker wrapper omits `--cgroup-parent` for walk containers.
Readiness probes TCP before a remaining-window first-compile fetch. Walk `start` stays up until SIGTERM and restarts
children, so a host registration timeout or worker database blip cannot tear down a ready Web.
Retry-After waits preserve identical server and initial hydration markup even when the deadline expires in transit;
the mounted clock enables manual retry without dispatching a request.
Decision: this increment's accepted cells are native CJK title/alias projection with locale-independent alias
languages, review-producer readiness omission, Web alias-locale fallback and Retry-After hydration, and walk
slot/cgroup/first-compile regressions. Walk regressions assert `walkStackNames(task, slot)` container names. Stack-run fixtures emit the current probe fields, including `DISK_FREE` and `MEMORY_RECLAIMABLE`. The seeded multilingual native/API/browser matrix stays unaccepted: local Web
never listened on 20010 within 20 minutes. Shared host placement/headroom remains with the supermanager.
Decision: multilingual names receive Semantic labels, aliases and schema:name/alternateName languages as-is, including `und`. The ordinary writer `applySubjectKeys` publishes them into the production mapping with stored offsets on the documented OpenSearch 3.9.0 `analysis-icu` image (`db/search/opensearch/Dockerfile`). Isolated matcher tests stay local. Native source-to-query/evidence is `test/search/cjk-engine.test.ts` plus the retained analyzer cases; CJK ngram overlap may highlight additional current aliases, so that case pins the queried original-language name rather than exclusive reason lists; current-text disclosure analyzes the queried generation with those same installed analyzers, including prefix matching and the 32 KiB scan bound; malformed analyzer replies stay `SearchUnavailableError`; seeded browser remains unaccepted. Observed engine: OpenSearch 3.x with `analysis-icu` as required by `requireDevelopmentAnalyzer`. Source checkpoint: Names `f0718c51f8e5f6848c2bfedf59855a7cbfadf3cf` (released labels, language-preserving aliases and schema:name/alternateName).
**Released fixtures:** original Chinese/Kana/Latin cases, real Semantic source keys/routeKey, source chunks256 EACH
including tails, exact source snapshot versions, checkpoints and actual physical indices.

| Surface                  | Required consumer result                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| CATALOGUE                | Default registrations actually start Semantic/Search; real source events and rebuild become searchable.                                    |
| CURATED                  | Shared runtime feeds catalogue facts and public listing sources used by canonical members; consumer proof remains catalogue-jobs.          |
| EVERYTHING WITHOUT STATE | Public catalogue dependency uses runtime; private owner facts stay PostgreSQL. Shared owner consumer proof remains freshness-and-recovery. |
| OWN STATE                | Same dependency boundary, with owner next-read authority independent of index lag.                                                         |
| MOUNTED ZONE             | Real union/page consumer observes runtime recovery and source restrictions; Zone CRUD alone is insufficient.                               |
| configured TYPELIST      | Real default Search-backed reads inherit analysis/generation/recovery. Infrastructure has no separate per-surface members API.             |

**Frozen scenarios and binding:** originals first three analyzer cases and outage/rebuild ledger entries;
[index definition](../../services/kernel/test/search/index-definition.test.ts) “cjk_bigram_v2 produces the legacy tokens”;
[CJK engine](../../services/kernel/test/search/cjk-engine.test.ts) “the documented development analyzer is OpenSearch 3.x with analysis-icu and owner CJK tokens” and “released names go through the ordinary writer into the physical index and keep current evidence across locales”;
[source batching native](../../services/kernel/test/search/source-batching-native.test.ts) “native event anchors use
exact chunk snapshots through later transport failure and replay”; [bulk visibility](../../services/kernel/test/search/bulk-visibility.test.ts)
“a same-version conflict proves independent winning data searchable before successful return”; [source fences](../../services/kernel/test/search/rebuild-source-fences.test.ts)
“the real rebuild command uses the configured route key for current imported-source fences”; [auto-create](../../services/kernel/test/search/subject-auto-create.test.ts)
“actual native late bulk cannot implicitly recreate a retired subject generation while explicit creation works”.
These native seams are retained, without claiming complete runtime closure.

**Native wrapper/command:** original Search/relation wrappers use
[outcome-driver](../../services/kernel/test/search/outcome-driver.ts)→[driver client](../../services/kernel/test/search/support/driver-client.ts)
→[supervisor](../../services/kernel/test/search/support/outcome-supervisor.ts)→[worker child](../../services/kernel/test/search/support/outcome-worker.ts).
Worker invokes startWorker with a decorator of the live `createKernelWorkModules` list (Content ambient included), original registrations and observed real starters;
pause/resume captures only Search, rebuild uses real rebuildSubjects/subjectSource and runner refresh. Current
source has progressed beyond [harness README](../../services/kernel/test/search/README.md)'s older captured-starter
status; neither source nor that stale status supplies a native pass.
`bun run --cwd services/kernel check test/search/real-source-composition.test.ts test/search/source-batching-native.test.ts test/search/rebuild-source-fences.test.ts test/search/subject-auto-create.test.ts test/search/cjk-engine.test.ts test/search/index-definition.test.ts`.
Operator command is `bun run --cwd services/kernel search rebuild`, documented in
[kernel README](../../services/kernel/README.md), plus actual public search/suggest evidence; no rebuild HTTP route.

Remaining gaps: complete identified keys/physical UUID/source versions and per-partition replay/reconciliation
before alias, including missing/extra keys (equal counts insufficient); keyed sink results and actual winning
refresh/shard success before checkpoint; competing workers/lost CAS/ambiguous response/crash; late old writes after
actual delete-version pruning; no accidental recreation; default writer normalization and real outage/recovery.
The separate64-envelope batch remains. Superseded coverage certificates and coverage/coverage-projection exports
that throw index_not_ready do not bind the replacement. Reuse real-source composition rather than helper-only completion.

| Stage                                   | Evidence                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| specification validated red             | Native assertions present; measured red not recorded; complete pruning/reconciliation matrix not frozen/bound.                                                                                                                                                                  |
| native driver registered                | Real default-worker source chain registered; missing scenarios require binding to it.                                                                                                                                                                                           |
| implementation exposed                  | Documented 3.9.0+analysis-icu image, offset-stored `cjk_bigram_v2` mapping and ordinary writer publish released multilingual names; default worker decorates live createKernelWorkModules with rebuild/alias recovery. Complete producer/generation guarantees remain unproven. |
| user-case native pass at named revision | None recorded for this capability.                                                                                                                                                                                                                                              |
| promoted                                | No main closure evidence.                                                                                                                                                                                                                                                       |

## composition-and-profile-governance

**User job:** publish safe immutable profiles with explicit grants/CAS, resolve every released vertical, and read
pages with standalone authority, at most16 distinct descriptors/128 output slots and bounded joined sessions.
**Personas:** anonymous/editor/curator plus all common personas. **Released fixtures:** bundled release/platform
profile; Book/Recipe/visual novel/anime/manga/game/series/character/agent configurations, two immutable profiles,
malicious input and shared public sources. Synthetic Book-with-author alone is not all-vertical proof.

| Surface                  | Required consumer result                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| CATALOGUE                | Registry plans public reads with standalone Search authority.                                                                  |
| CURATED                  | Configured Collection consumers use common members and source grants; no aggregate-specific permission.                        |
| EVERYTHING WITHOUT STATE | Private hydration for Alice separated from public composition; owner support independent of entry/state.                       |
| OWN STATE                | Current owner reads and joined-session bounds; no private state in anonymous page/cache/JSON-LD.                               |
| MOUNTED ZONE             | Routed common composition and mount reads obey same registry/admission/authority; starter data is not runtime proof.           |
| configured TYPELIST      | Every released vertical has a real admitted list and resolved route/type/base/generic fallback; actual HTTP consumer required. |

Decision: the fewest Web tests pin publish/read, TypeList raw-limit admission, mixed sibling Retry-After and public
ReactionSummary totals; Members keep recorded native duplicates; no extra page stories. Auth website tests pin malformed
native metadata, non-object token errors and revocation JSON at the protocol boundary. Driver following, entry-review and
Board consumers type-check with those six existing suites; History README keeps one Foreign Kernel introduction and the
Zone cleanup paragraph in the Zone receiving section.

**Frozen scenarios and binding:** all six original pages titles in the ledger. Preserve registry limits64KiB,
256 nodes, depth8,16 reads/128 slots; profile1MiB/128 templates; executable HTML/script/links rejected with pointers.
[presentation reads](../../services/kernel/test/presentation/reads.test.ts) “each read runs through its standalone
route with only the caller's credentials”, “session tokens from every read are merged with the caller's”, and
“a page holds at most sixteen valid reads, runs at most four at a time and dispatches identical reads once” are
helper-dispatch evidence (fakeKernel), not native composed cost. Joined session work remains bounded by16×32 components.

**Native wrapper/command:** [pages wrapper](../../services/kernel/test/presentation/outcomes.test.ts)→
[pages driver](../../services/kernel/test/presentation/outcome-driver.ts)→real Semantic fixture; PAGES_DRIVER sets
createPagesDriver. `bun run --cwd services/kernel check test/presentation/outcomes.test.ts`.
Actual [Workers host tests](../../apps/web/tests/pages-workers.host.test.ts) separately declare “the real Workers SSR
path renders the Puck composition before client JavaScript” and “Workers HTML and JSON-LD use the same aggregate
public subject representation”. These are real served HTTP renderer evidence with recorded upstream fixture, not
all-type native producer proof. [JSON-LD serializer tests](../../apps/web/tests/pages-jsonld.test.ts) alone are helper
proof. Web owns publication command/evidence; none run/claimed here. Bind released verticals and native upstream
composition before closing; keep Puck render and aggregate-derived JSON-LD evidence separate.

| Stage                                   | Evidence                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| specification validated red             | Six original assertions present; measured red not recorded; all-vertical/native cost expansion not frozen.                                                                                       |
| native driver registered                | Six-case native pages wrapper registered; Workers publication tests separately present.                                                                                                          |
| implementation exposed                  | Profile publish/activation/page read, Workers renderer, TypeList raw-limit admission, ReactionSummary public totals and mixed sibling Retry-After exist; full native consumer matrix incomplete. |
| user-case native pass at named revision | None recorded for this capability, including publication.                                                                                                                                        |
| promoted                                | No main closure evidence.                                                                                                                                                                        |

## subject-context-and-traversal

**User job:** read Global/Realm selected subject facts and rating/review population, traverse every relation/edition/
credit/claim continuation and public metadata. **Personas:** all common personas, Realm member/outsider and acceptor.
**Released fixtures:** differing Global/Realm facts, unpublished fallback, private/unpublished rating populations,
globally resolved agents, more than a preview of editions/credits/claims with qualifiers/spoilers/provenance.

| Surface                  | Required consumer result                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| CATALOGUE                | Public discovery remains Global; subject factual projection exposes only eligible metadata and traversal links.                                |
| CURATED                  | Members open current subject/detail views without borrowing curator's Realm rights.                                                            |
| EVERYTHING WITHOUT STATE | Personal hydration stays Alice-only while public facts/traversal retain source context.                                                        |
| OWN STATE                | State/rating hydration distinct from public/Realm population and disclosed facts.                                                              |
| MOUNTED ZONE             | Realm-routed subject context/population and unpublished fallback require adopted Source/presentation boundary; agents always resolve globally. |
| configured TYPELIST      | Lists link to factual detail/continued views; no arbitrary filtering of a detail object. Composed context/read continuation remains required.  |

**Frozen scenarios and binding:** original pages public/hidden cases; [context relations](../../services/kernel/test/semantic/context-relations.test.ts)
“a community Context's relation pages show its accepted, replaced and suppressed relations over Global's”;
[uncapped relations](../../services/kernel/test/semantic/relations-uncapped.test.ts) “A forward relation page orders,
filters, counts and continues across all relations”; [subject-page HTTP](../../services/kernel/test/semantic/subject-page-http.test.ts)
“independent real HTTP traversal needs only native store and source primitive”. They prove separate boundaries,
not the full composed credit/claim/publication journey. Source/presentation participation in realm-subject-context,
subject-rating-context and subject-traversal is REQUIRED NOT YET FROZEN/BOUND as a complete job.

**Native wrapper/command:** pages driver plus existing Semantic native files;
`bun run --cwd services/kernel check test/presentation/outcomes.test.ts test/semantic/context-relations.test.ts test/semantic/relations-uncapped.test.ts test/semantic/subject-page-http.test.ts`.
[Actual pages target](../../services/kernel/src/presentation/http/pages.ts) admits subject/route/account and view,
not a Realm context-bearing schema. Research example context and plural Zone route spellings are proposals, not
mounted endpoints; Semantic/Content/Search/Web must adopt the concrete boundary first. Existing standalone relation
routes/native pagination are retained. Web separately owes served HTML/redirect/canonical/metadata for every launch
vertical and agent kind, instructions/diet/cookTime25→PT25M and cache-safe public JSON-LD. No serializer or kernel
response closes publication, and no native context schema is invented here.

| Stage                                   | Evidence                                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| specification validated red             | Existing separate route assertions present; composed context/claim journey not frozen.                                                        |
| native driver registered                | Pages and Semantic route slices registered; complete context/publication binding missing.                                                     |
| implementation exposed                  | Standalone relations/views exist; rating order/population restart as one executed pair in canonical-executed-recovery. Realm-context pending. |
| user-case native pass at named revision | None recorded for this capability or its publication stage.                                                                                   |
| promoted                                | No main closure evidence.                                                                                                                     |

## composed-cost-and-progress

**User job:** receive useful bounded direct/prepared lists and a common16/128 page as populations, depth and privacy
traffic grow. **Personas:** all common personas, including denied/empty paths. **Released fixtures:** shared native
records/pins,64/512/4096 scales, independent population/matches/sparse/history/owner pools/aliases/depth/privacy
arrival axes; actual4096 originals at largest scale. Old1000/10000/100000 report example yields to current budgets.

| Surface                  | Required consumer result                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| CATALOGUE                | Search owns direct catalogue and prepared-public native HTTP/growth, first/deep/sparse/final pages.                |
| CURATED                  | Common canonical member plans with growing duplicates/history and all owner pools counted.                         |
| EVERYTHING WITHOUT STATE | Commerce direct-owner/prepared-owner captures grow labels/holdings/sessions independently; no entry prerequisite.  |
| OWN STATE                | Same owner plans with growing state/completion history, current writes and bounded preparation.                    |
| MOUNTED ZONE             | Semantic owns actual composed readPage consumer,16 distinct reads/128 slots across eligible sources.               |
| configured TYPELIST      | Actual aggregate execution shares fixed work, disclosure and summaries; helper descriptor counts are insufficient. |

**Frozen scenarios and binding:** [dynamic outcomes](../../specs/dynamic-collections-outcomes.test.ts) “first and deep
native pages stay bounded with sparse catalog filters and hidden candidates at three scales” is retained but not
an established native factory. Existing [growth query](../../services/kernel/test/search/growth-query.test.ts),
[growth rating](../../services/kernel/test/search/growth-rating-query.test.ts) and
[growth pages](../../services/kernel/test/presentation/growth-pages.test.ts) are slice evidence, not complete
current filtered-list plans. Full native composed-cost-and-progress matrix: REQUIRED NOT YET FROZEN/BOUND.

**Native wrapper/command:** no complete capability wrapper/factory/command registered. Existing slice command:
`bun run --cwd services/kernel check test/search/growth-query.test.ts test/search/growth-rating-query.test.ts test/presentation/growth-pages.test.ts`.
Performance owns harness/budgets; Search public plans, Commerce owner plans, Semantic Zone composed consumer.
A missing-factory sample or old256-proof check is not growth evidence.

Capture actual engine iterator next_doc_count+advance_count across tree/shards, candidates/discards/lookahead,
Access/dependency points, examined/removed rows, blocks, bytes, statements and connections in every backend pool.
[Current budgets](../filtered-lists.md#budgets) apply without slack: direct c≤min(600,6s+3),≤3 refill
rounds,≤6 engine searches/3 owner seeks per read; prepared c≤2s+2 and≤2 index reads. Common16/128 all-direct page
ceilings816 candidates,6784 points,14080 examined rows,72 statements per backend,96 engine searches,one connection
per backend. Share query privacy observation,≤2 statements and64+2×(behind+changed homes) examined rows; logical
all4096-home coverage cannot hide a full-head scan. Preparation steps≤1000 inputs/writes,one frontier write,
≤16 statements/4 engine searches/one connection per backend,≤4MiB response; retain finite progress and reread at
most one interrupted step. Grow privacy arrival rate with actual repair/ACK latency; served share must not fall
between scales. Permanent preparing, small output hiding unbounded engine work and sparse empty-success chains fail.

| Stage                                   | Evidence                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| specification validated red             | Native plan/budget matrix REQUIRED NOT YET FROZEN; existing slice assertions are not its red receipt. |
| native driver registered                | Slice suites present; complete native factory/HTTP/growth binding missing.                            |
| implementation exposed                  | Full admitted direct/prepared/composed plans and captures not established.                            |
| user-case native pass at named revision | None recorded for this capability.                                                                    |
| promoted                                | No main closure evidence.                                                                             |

## Original suite ledger

These exact source titles are retained, including superseded words in titles. No title is a claim of current native
pass. The Search and relation wrappers count `^test(` declarations dynamically, require that exact pass count,
zero failures and zero skips/todos; pages does the same. Inspection counts are **13 Search,6 relation,6 pages**.
All three run their untouched specification as a child and return actual product responses through the drivers.

### Search originals

[specs/search-outcomes.test.ts](../../specs/search-outcomes.test.ts): 13 declared scenarios;
[wrapper](../../services/kernel/test/search/outcomes.test.ts), [driver](../../services/kernel/test/search/outcome-driver.ts).
Native command: `bun run --cwd services/kernel check test/search/outcomes.test.ts`.

- Traditional and Simplified Chinese match without matching a different title or an extended phrase
- Kana voicing and width fold with case and full width Latin names
- Aliases and descriptions are searchable but adopted statement values are not free text
- Search is public for editor and anonymous while suspended credentials fail on both routes
- New subjects become searchable and suggestible within fifteen seconds with current as_of
- Statement filters use adopted Global values and positive roots admit bounded negation
- Committed takedown and hiding remove stale hits immediately and refill pages while indexing is paused
- Name paging has exact totals stable ties and request principal and signature bound tokens
- Rebuild invalidates old page tokens and preserves all visible subjects while excluding takedowns
- Typeahead matches word prefixes in Latin Chinese and aliases and rejects invalid query parameters
- Text admission rejects malformed syntax and budgets while all operators produce observable matches
- Filter admission rejects excessive budgets unknown facets and malformed search bodies
- Unavailable index returns retryable problems on both routes while subject reads keep working

### Relation originals

[specs/search-relation-facets.test.ts](../../specs/search-relation-facets.test.ts): 6 declared scenarios;
[wrapper](../../services/kernel/test/search/relation-facet-outcomes.test.ts), [driver](../../services/kernel/test/search/outcome-driver.ts).
Native command: `bun run --cwd services/kernel check test/search/relation-facet-outcomes.test.ts`.

- an adopted author beyond the bounded relation sample matches positive and negated filters
- overflowing author facet counts stay honest lower bounds
- overflow rechecks keep hidden and taken-down source subjects out while indexing is paused
- a declared author relation update refreshes its source subject
- hiding a relation target suppresses positive source hits before the rebuild
- qualified relation facet filters are refused without changing unqualified author semantics

### Pages originals

[specs/pages-outcomes.test.ts](../../specs/pages-outcomes.test.ts): 6 declared scenarios;
[wrapper](../../services/kernel/test/presentation/outcomes.test.ts), [driver](../../services/kernel/test/presentation/outcome-driver.ts).
Native command: `bun run --cwd services/kernel check test/presentation/outcomes.test.ts`.

- anonymous reads a public subject's page in one aggregate read
- an unknown, a hidden and a taken-down subject answer the same not_found
- publishing a profile needs the presentation grant
- activating a profile changes the template a page uses
- a profile with HTML, script or an executable link is refused with pointers
- a route template answers a route target and other routes fall back to generic

## Remaining owner reconciliations and smallest followups

- Semantic/Imports release the missing genuine words, form/Concepts, diet and library bindings, then supply one
  versioned native fixture builder with real release/identity pins. Reuse ordinary contribution/adoption/import
  boundaries and existing reviewed provider fixtures; absent imported words remain unknown. No recipe-site import.
- Commerce adopts owner-query/completion semantics and common members admission, binds existing dynamic/profile/
  label suites, then reuses released records for each explicit surface/job. No shelf-only query path or private
  facts in public facets. Bulk methods that throw are not a bound consumer or performance factory.
- Search/Semantic/Accounts bind narrowed native privacy routing, late barrier/ACK and actual foreign repair to the
  existing real-worker driver, then add only the missing discriminatory six-surface cases. Reuse current native
  source chunks, sink visibility, generation and confidentiality tests before adding equivalent assertions.
- Content adds the genuine extreme private Realm producer for private-rating-isolation and joins subject context
  figures; retain the existing Global vote-to-worker-to-HTTP suite in full. Search admits its existing public sort
  and omits totals, including rating; internal accounting never becomes public totals.
- Search/Commerce/Performance reconcile the frozen dynamic empty-success scenario with useful-page requirements
  through the owning acceptance process. Accounts still owes its native correct-password suspended sign-in
  acceptance receipt; Search's native old-bearer cases are 401 and the kernel verified-suspended 403 remains
  defensive only.
  Search owns reconciliation of original exact-total/lower-bound assertions with current no-public-total transport;
  source contributor accounting remains useful internal evidence. Frozen files stay untouched in this inventory.
- Search/Content/Semantic/Web adopt the context-bearing Source/presentation boundary and connect existing native
  relation/edition/credit APIs to composed continuation, claims/history and public metadata. Retain real Workers
  Puck-render and aggregate-derived JSON-LD HTTP cases separately; extend native released-vertical publication
  evidence rather than count fake upstream serialization as closure.
- Performance binds the missing current plan factories/capture matrix with Search, Commerce and Semantic. Run each
  registered capability at owner integration/promotion, deduplicated by revision, with exact scenario counts and no
  skips/todos. Record specification-red, registration, exposure, named-revision native pass and main promotion
  independently; none of these followups is already complete by this document's formatter acceptance.

## native-account-erasure-participant

[Search's Deletion lifecycle](../../services/kernel/src/search/README.md#deletion-lifecycle) adopts the exact
inventory and participant boundary under [Deletion items 1–8](../deletion.md#account-erasure) and
[Access Erasure consumers](../../services/kernel/src/access/README.md#erasure-consumers). The integrated coordinator
is not owner cleanup. This specification implements no participant, purge, acknowledgement, locator/Source/ACK
ABI or private fact store.

**Frozen native titles** (SHA-256 `e4dd21c428131480703cb5c2e4f0562f4a84c05580c37c82916b9af15ec43a17`), all in
[erasure-participant.test.ts](../../services/kernel/test/search/erasure-participant.test.ts):

- `default Search registers the native account-tombstoned participant even without per-account data`
- `Search cannot acknowledge erasure before all affected live-generation copies and delayed writes are resolved`
- `native Search erasure follows fresh Auth confirmation and records its immutable acknowledgement only after actual cleanup`

**Binding:** canonical `nativeFixture` → `testKernel`/`createPersonas`; the same actual `PersonasOptions` →
`deletePersona` (fresh human sign-in, Auth `/account-operations/approve` and `/account-operations/execute`). Actual
`drainEffects(pool, partition, { deadlineMs? })` observes the effects checkpoint; real `readErasureStatus` separately
observes Search's acknowledgement. The child calls `startWorker` with every imported default module in order,
observing the real Search `addEffects` registration and forwarding original starters/effects. No-config registration
is an executable missing-effect assertion. One runner-owned kernel database supplies real Access/accounts/grants,
production subject/source edits, exact native engine copies and public APIs. Grace generation 1, active generation
2 and rebuilding generation 3 are physically populated by the default worker. Personal-name canaries, selected
public facts, an actual private candidate, withdrawn copies, retained contribution/provenance, delayed native bulk
dispatch/response, native pruning and immutable real-effect replay retain their future assertions.

**Command:** `bun run --cwd services/kernel check test/search/erasure-participant.test.ts`; root
`bun run typecheck` covers shared specification imports. No full kernel/web/gate acceptance is claimed.

| Stage                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| specification validated red             | Not measured. All three frozen cases ran but failed in shared definition bootstrap before executing their participant assertions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| native driver registered                | Source-bound to the canonical helper and actual default composition; runtime registration is unmeasured. No synthetic tombstone, event or erasure row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| implementation exposed                  | Default Search registers both tombstone effects. Copy inventory is live OpenSearch subject generations; empty settings attest no-data after the Semantic source proof. Discovery Account copies stay on their own purge. Identity52 command-evidence is Access's production binder plus native History preload; Search consumes that path and does not add a competing fixture writer. Account-agent erasure and Zone command producers import the public History facade so the moved contract typechecks. The fewest default-worker lifecycle proofs stay the named coverage, public-runtime, rating, generation-metadata and erasure cases. |
| user-case native pass at named revision | None. Neither effects checkpoint nor pending status proves cleanup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| promoted                                | No main launch-gate closure evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Check evidence:** committed test/runtime inputs at `f243d801136965df4d9d35f11e2e8dea9b7ca972`; the frozen
test hash above is unchanged. Both required commands ran once through `bun scripts/worker-check.ts --`, and both
wrappers finished. No extra full kernel/web/gate check or diagnostic rerun was started.

- Focused native command: exit 1, three failures with `error: Invalid definition release` at
  `semantic/definitions.ts:29`, called by `bootstrapRelease` in the shared fixture initialization at
  `erasure-participant.test.ts:37`. No participant registration, fresh deletion, cleanup or acknowledgement
  assertion was reached. This is a shared bootstrap refusal, not the intended missing-participant red.
  Log: `.temp/goal/checks/worker-check-2026-10-29T03-08-51.201Z-0f086cdf.log`.
- Root typecheck: exit 0 across every workspace, including Kernel, Auth and Web. The prior mapper/generation
  failures did not recur in this run.
  Log: `.temp/goal/checks/worker-check-2026-10-29T03-10-59.169Z-b65f81f0.log`.

**Shared prerequisite requiring research:** the runner elides the bootstrap violation object. The existing
[definition validation research](../research/definition-validation-cpu-deep.md#new-controlled-phase-evidence)
independently records the bundled release refusal at
`/properties/wdt:P1114/value/properties/unit/pattern` with `unsafe_pattern`: the generated wildcard quantity-unit
pattern enters the checker's forbidden fuzz fallback. The current validator blob
`a25838bee6bd178da18c07fa34122b52e2bedded` and checker blob
`654caa91ae2d7fb3aad5bbbe869d12f78d431a66` match that report. This finding predates this acceptance; the native
command above does not independently expose its exact violation pointer.

Research needed: how can the existing immutable wildcard quantity-unit schema receive a valid proof under the
unchanged structural-only safety policy, preserving published schema bytes and hostile-pattern refusals? That
generator/checker repair is not supplied by the existing research. The frozen acceptance and fail-closed validator
remain unchanged. Participant assertions still need measured red evidence.

**Concrete open prerequisites:** no native all-role affected-subject/dependency locator or minimized-source
completion export; `accountAgentId` alone is incomplete, including verified terminals and foreign provenance.
Source/queried-observation closure supplies neither live cleanup nor foreign-drain capability. All-role,
private/unlisted and foreign dependency cases still need the real producer binding; no new ABI or test callback
is adopted here. The independent late-write-pruning suite's four physical-resurrection reds remain open despite
current API suppression. Delayed effects must really settle before Search acknowledges; disabled configuration
cannot prove no history. Actual three-scale locator, cleanup and shared-store costs follow those native ports.
This is participant acceptance, not the seeded coordinator proof or the whole launch gate; backup expiry,
restore, legal-hold and retention engines remain outside this adoption.
