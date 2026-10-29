# CLI to native Auth and Access integration

The native test is `services/kernel/test/imports/cli-native-auth.test.ts`. It retains the existing local CLI and
native identity suites and adds one journey at their missing composition boundary. No production, helper, identity
fixture or frozen acceptance file changes are part of this slice.

## Journey and decisions

The test uses `openApiRuntime` and `openApiObserver`. It generates its own extractable ES256 pair for the fixture's
actual automated account. The same staged credential effect, real operator approval and bound application used by
`installKey` install its public JWK. Only this test-owned private JWK is exported, into a mode 0600 file on `/dev/shm`.
The test does not expose the existing helper's private key. SQLite lives in `os.tmpdir()`; both directories and all
native runtime resources are released in `finally`.

`runImportCli` receives HTTPS origins, the actual account/client/key and a one-record Bangumi JSON-lines dump with
an identifier, type and title. This deliberately excludes summary and cover so the separate metadata writer ABI,
media/provider fetches and source content are unnecessary. Injected fetch routes requests to the native Auth handler
or the kernel's actual `app.handle` through `runtime.replay`. It returns their responses unchanged. The CLI's normal
private-key assertion, signin session and token acquisition run without fake tokens, synthetic 401s or clock patches.
Every kernel request asserts the actual bearer subject, client and default six scopes and excludes cookies. An exact
route allowlist excludes website/BFF/media completion and privileged alternative writes. The runtime's normal Access
configuration verifies issued JWTs against native Auth JWKS; the test also checks that real JWKS endpoint responds.

A successful initial run must leave a bound subject, persisted candidates and exact command receipts, with public
subject disclosure. Reopening the same CLI state with identical input must consume that input once, report unchanged,
keep the subject and leave all observed native effects identical. Revocation uses the fixture's real grant management
API after renewing management authority. Changed input must be denied, leave the prior source baseline and native
effects intact, retain pending durable work and never print completion. Restoring the actual grant must finish those
same saved command keys with unchanged command payloads, keep the subject and persist the changed title. Each CLI
invocation must close its handles. VNDB's existing seven-scope suite remains separate.

The fixed record is a normal minimal Bangumi source shape, consistent with `specs/imports-cli.test.ts`; it contains
no external provider plaintext. There is no new discovery/word fixture or crypto/permission matrix.

## Cost

### Fixed CLI lifecycle and native effect observations

- Touches: one supplied Bangumi record, one newly generated key, one staged/approved/applied credential effect,
  four CLI invocations and two changes to the actual bulk grant. Reads use the current source state, one current
  pending page, the exact subject route/id, at most 100 current candidates and exact command receipt keys.
- Bound: input work follows the supplied bytes. Observations are bounded by this fixed input and the commands it
  actually emits; receipt lookups include partition, principal, command kind and idempotency key. No catalogue,
  account, receipt or revision history scan is used.
- Growth check: no growth claim is made. Existing growth suites own scale evidence. This slice checks fixed
  transitions and current durable points only.

## Verification

Base revision: `fb7ffaca82ead9baaa84e18992aae8644aa9ae78`.
Retry starting revision: `a5996dd528b886896a31f8cbc91da5e701c6de8e` (the carried test and report).
The test is unchanged from that revision. The delivery commit changes only this evidence report; the native test
source tested below is therefore identical in the delivery commit.

Commands from the worktree root:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-native-auth.test.ts
bun scripts/worker-check.ts -- bun run typecheck
bun scripts/worker-check.ts -- test -s docs/research/imports-audit/cli-native-auth.md
```

The first focused execution failed: **0 pass, 1 fail, 10 expectations**. Log:
`.temp/goal/checks/worker-check-2026-10-28T18-55-32.902Z-cf4bd470.log`.
Its first outcome failure was `expect(first.code).toBe(0)`: received `4` at line 175 of the initially tested file.
No token or kernel write was reached. The carried diagnostic records unsuccessful native Auth status and body
without altering the request or response.

The retry's single focused execution also exited **1: 0 pass, 1 fail, 10 expectations, one file**. Log:
`.temp/goal/checks/worker-check-2026-10-28T19-04-03.942Z-fbdf37e6.log`.
Its first assertion is `expect(first.code).toBe(0)` at line 185, received `4`. The actual native response is
**POST `/signin/key`: HTTP 403, `{"error":"authentication_denied"}`**. Real stage/approve/apply key provisioning
completed before this request. No token was issued and no kernel write was attempted. The slot was queued for
182.647 seconds and ran once, with no load rerun. The remote runner also warned that Git timing metadata was
unavailable (`fatal: not a git repository`); it continued and reached the native outcome assertion above.

The unchanged base explains the failure: `services/importer/src/credentials.ts:192` builds Auth request headers with
only `content-type` (and a cookie on token requests), while `services/auth/src/service.ts:1576` requires an exact
`Origin` match for all Auth mutations, including `/signin/key`. The fixture's existing `request` helper adds that
header; the actual CLI does not. The new test deliberately routes its unmodified real CLI request, exposing this
previously hidden boundary. No Origin is added by the test transport. The producer blobs are identical to the base:

- Auth service: `01ac55b6ce81c54c3e00eb6ce46832cbdc7d9932`.
- CLI credentials: `ee93d1788e54323f86a668eb64a459d78c5eab84`.

No separate base execution was needed: the rejecting Origin guard and the CLI header construction have identical
blobs on the contract base and the tested revision, and neither file changed in this attempt. This establishes the
same failure path on the base by source comparison, rather than claiming a second test run.

This is a pre-existing product integration defect, rather than a missing legitimate key-provisioning seam. The
stage/approve/apply path completed. The contract explicitly excludes product/helper/identity-fixture edits, so this
specification delivery retains the failing success assertion and records the defect. Reopen, native writes, bulk
grant denial and recovery assertions are written but remain **unexecuted evidence** until CLI signin is corrected.
There is no claim that the later revocation returns a particular stale-auth problem: its actual problem will be
printed when that transition can run. The expected 403 on bulk revocation is provisional until then.

The native test does not pass on this base; the artifact acceptance can pass independently. The artifact command is specification delivery;
the focused native command establishes whether the actual journey passed. An actual pass is retained, rather than
manufacturing a red test for the contract's initial `failing: true` label.

The required root typecheck exited **0**, covering all **13 workspaces** (no test cases). Log:
`.temp/goal/checks/worker-check-2026-10-28T19-05-29.712Z-399ff617.log`.
The artifact acceptance is **one nonempty-file predicate**, exit **0**; it does not execute native cases.
Only the listed focused file, root typecheck and artifact predicate were run in this retry. No full kernel, root
or web gate was run. The test was preserved exactly as carried; the only retry edit records this evidence.

## Sources read

- `services/kernel/test/imports/identity-fixture.ts`: public support exports, native Auth composition, existing
  `installKey`, management token renewal and actual grant management routes.
- `services/kernel/test/imports/identity-key-credential.test.ts`: current native key test and missing CLI boundary.
- `services/kernel/test/imports/api-runtime.ts`, `api-observer.ts`, `api-fixture.ts`: native runtime ownership,
  public kernel dispatch, public observation and exact receipt locators.
- `services/importer/src/cli.ts`, `credentials.ts`, `import-client.ts`, `import-session.ts`, `run-store.ts` and
  `record-bindings.ts`: CLI invocation, key/scopes, transport, session and durable state observation seams.
- `services/importer/tests/cli-driver.ts` and `specs/imports-cli.test.ts`: existing fake-Auth boundary and minimal
  Bangumi source shape. `specs/imports-api-driver.ts`: native fixture contract and options.
- Importer README, Imports Goal, architecture, scope and workflow verification/delivery/review documents.

No cited contract required reference-project source for this composition-only surface; none was copied or ported.
No files outside the declared paths were changed.

## Origin correction attempt

Implementation revision: `4275a054995cac831494c4d862d437baaa8b7a94`.
`services/importer/src/credentials.ts` now sends the normalized configured Auth origin as the `Origin` header on both
`POST /signin/key` and `POST /token`. `runImportCli` already validates and normalizes `--auth` to an HTTPS origin.
The request body, assertion audience, manual redirect handling, bounds and response/error handling are unchanged.

Checks run through the worker wrapper:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-native-auth.test.ts
bun scripts/worker-check.ts -- bun test services/importer/tests/cli-credentials-outcomes.test.ts
bun scripts/worker-check.ts -- env IMPORT_CLI_CREDENTIALS_DRIVER=/home/edge/projects/rezics/worktrees/37d683a4-21c9-4a9a-a5ae-bb35eddf67b2/services/importer/tests/cli-credentials-driver.ts bun test --timeout 30000 specs/imports-cli-credentials.test.ts
bun scripts/worker-check.ts -- bun run typecheck
```

The native acceptance exited **1** after 1 test and 91 expectations. The first CLI invocation completed with code 0,
and the test reached its actual database effect inspection. It then failed before the same-input reopen because its
frozen query selects `retracted` directly from `semantic.candidate`; that table has no such column in
`services/kernel/db/semantic/schema.sql`. Retraction is represented separately and projected by
`services/kernel/src/semantic/candidates-read-provenance.sql`. The test cannot proceed to the reopen, grant denial or
restoration assertions without changing the frozen test or expanding this credential-only production change. No
Origin rejection, missing producer, or credential error-policy conflict occurred in this execution. The native later
transitions therefore remain unexecuted evidence.

The importer CLI outcome wrapper exited **1** because its nested suite reported
`IMPORT_CLI_CREDENTIALS_DRIVER is required: bind production importer CLI with fake Auth and API`. Running the
credential outcome suite directly with the explicit driver path produced the same missing-environment error; its
cases did not execute. These results do not establish a credential-outcome pass.

Root typecheck exited **0**. Logs:

- Native: `.temp/goal/checks/worker-check-2026-10-28T19-57-40.428Z-5a4fb45d.log`
- CLI outcome wrapper: `.temp/goal/checks/worker-check-2026-10-28T20-10-12.123Z-102a086a.log`
- CLI outcome direct suite: `.temp/goal/checks/worker-check-2026-10-28T20-50-49.868Z-a34b58eb.log`
- Root typecheck: `.temp/goal/checks/worker-check-2026-10-28T20-21-20.807Z-71f3aa11.log`

The implementation commit contains only the credential header change. No test, Auth policy, API behavior or frozen
file was changed. Main or promotion evidence is not claimed.

## Retraction observation correction and resumed native journey

The native test's bounded candidate observation now reads the latest matching revision from
`semantic.retraction` with a lateral point query keyed by the candidate's exact route, subject and candidate IDs,
ordered by descending revision with `LIMIT 1`. It retains the candidate ID, statement, nullable retraction revision,
route/subject anchor, candidate-ID order and limit of 100. The schema has no `semantic.candidate.retracted` column;
the production candidate provenance projection reads this evidence from `semantic.retraction`. No lifecycle
assertions or fixture behavior changed.

The focused native acceptance was run once after that correction:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-native-auth.test.ts
```

The tested code revision, including the correction, is `3acc613122ff6da3c94818bc746b54964d31b254` (the report
was updated afterward; no code changed after the checks).

It exited **1**: 0 passed, 1 failed, 287 expectations. The corrected query succeeded. Native signin, token use,
the initial import, same-input reopen, and bulk grant denial all ran. The denial was an actual API 403 with
`effect_status: "not_applied"`; the test verified that prior effects were unchanged and durable pending work
remained. During grant restoration, the next CLI invocation returned without consuming its 57-byte input, failing
the existing `consumed` assertion (expected 57, received 0) before the recovery code, exact-key restoration, and
final effect assertions. Therefore the later recovery transitions did **not** reach completion. The run did not
capture the recovery CLI result or a recovery request response, so it does not establish a missing producer or a
credential error-policy conflict. It does establish that recovery stopped before input processing after reopening
durable work; diagnosing that path requires evidence beyond this assertion. No test transport header, success
response or fabricated credential was introduced.

The required local CLI credential outcomes command used the parent wrapper so its driver binding was established
on the normal check host:

```sh
bun scripts/worker-check.ts -- bun scripts/stack-run.ts 'CLI credential outcomes' . . -- sh -c 'cd services/importer && exec ../../node_modules/.bin/bun test ./tests/cli-credentials-outcomes.test.ts'
```

It exited **0**. The required root typecheck first failed during route generation with `Lix worker is closed`;
one retry exited **0**. These checks used the standard worker wrapper. No workspace-wide test gate ran.

Logs:

- Native acceptance: `.temp/goal/checks/worker-check-2026-10-29T01-22-18.997Z-df8e807e.log`
- CLI credential outcomes: `.temp/goal/checks/worker-check-2026-10-29T01-28-20.358Z-6c984e10.log`
- Root typecheck, first attempt: `.temp/goal/checks/worker-check-2026-10-29T01-28-40.650Z-27f9b132.log`
- Root typecheck, retry: `.temp/goal/checks/worker-check-2026-10-29T01-34-28.354Z-0646182a.log`

The earlier Origin and retraction evidence above remains historical evidence from its stated attempts. This run
reached the denial transition but did not complete restoration, so it is not main or promotion evidence.

## Frozen resume oracle correction and completed native journey

The authorized frozen resume correction is committed with the exact raw post-amendment bytes: SHA-256
`a38b8c4e06235ecfac7fd72c6ba8bdb2b26e890006ebad0bfc705a9c209f107a`. The correction marks only the fourth
invocation as a resume and asserts it consumes zero bytes; the first three invocations consume their exact inputs,
and input pass/byte counts are asserted against those three inputs. The CLI's result diagnostics are attached to the
existing open-handle, consumption and recovered-code assertions. All lifecycle, identity, body, key, effect,
receipt, denial and cleanup assertions remain intact. No test transport behavior or desired response was added.

The focused native acceptance was run once after this correction:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-native-auth.test.ts
```

It exited **0** on revision `3668a8bfe8b237ef57edc9af4148a9e2dd944c38` (the report update was the only subsequent change). The formatted frozen test
has the same authorized SHA-256 above. The native journey passed: actual key provisioning, four `/signin/key` and
four `/token` calls, native JWKS verification, first import, same-input reopen, bulk grant denial with API 403 and
`effect_status: "not_applied"`, durable pending-key/body preservation, grant restoration, and exact pending-key
replay all completed. The resumed fourth invocation consumed no input. The final effects, receipts and candidate
assertions passed; the test reported 1 pass, 0 failures and 302 expectations. Its evidence line was
`{"inputPasses":3,"inputBytes":155,"commands":7,"subjects":1,"candidates":4,"receipts":7}`.

The acceptance log is `.temp/goal/checks/worker-check-2026-10-29T05-02-03.776Z-791cf607.log`. The local nine-case
CLI credential outcome check and root typecheck had already passed on the preceding attempt; neither shared code
nor type-level code changed in this correction, so they were not repeated. No broad workspace check ran. The
recovery code was zero and every later native transition completed; this evidence identifies no missing producer
or credential error-policy conflict. This native pass is not main or promotion evidence.
