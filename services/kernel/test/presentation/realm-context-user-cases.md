# Native Realm subject page acceptance

Owner receipt: the [subject-page contract](../../../../docs/subject-pages.md#realm-context) was adopted and
committed before this test file. It consumes the approved Root, Search and Community request/response boundary.
The specification and acceptance are review inputs; manager freeze still requires the full actual output and
co-owner review. No production implementation or resolver export is included.

## Fixture and authority

Use the existing `createSemanticDriver(compose, options)` with its actual kernel, Auth host, bearer issuance,
Access, native grants, available lifecycle routes and production link relay. There is one fixture and one graph shared by the cases.
Public Book work, `bf:Instance` edition and Person author/pen-name subjects, Context A/B, protected readable Realms
and publications are created
through native routes. The existing native account-agent setup supplies the private statement target. No second
world, API engine, shared-database clone or invented fixture option is added.

Context A selects its URL, inherits language and suppresses the Global author and edition relation; B selects its
own URL and inherits the author and edition. A genuine edition session binds the standalone B-links control;
the race also requires inherited B links on every successful B response. Standalone controls establish those facts before the first page
assertion. The public-candidate controls use the same actual pen-name candidate and related account agent for both
publisher and reader. A pen name is an agent, so that Realm-selector control retains its canonical Global
subject read and old response shape; standalone publisher hydration remains permitted. The existing aggregate-authority suite is
unchanged, including its Global leak acceptance.

The race composes the real Access through `deriveAccess`, delegates every native decision with unchanged evidence
and opaque time, and pauses after the first actual `realm:read` decision. A second real native request updates the
Realm's Context and head before release. No fabricated allow, evidence, result or clock is supplied. If the page
finishes before that observation, its actual response must first satisfy expected 200, then prove the observation;
there is no successful missing-wire branch, skip or permanent missing-port throw.

The driver's send helper does not expose PATCH; that one update uses the same composed kernel and genuine bearer
directly. The multi-scenario fixture uses the existing native write limiter's documented new-account write-budget
override, following Community's native HTTP setup. Access, request deadlines and read/retry allowances are unchanged.

## Acceptance titles and formatted file hash

SHA-256 of the formatted test file:

```text
c408aa576fede18fa7dea6fec842f2c834891cd779df711ad23975be9df2b95d  realm-context-user-cases.test.ts
```

- Realm subject page selects only the current authorized published Context with unchanged caller and public candidate audience
- Realm selector preserves Global agent candidate audience without publisher-private candidates or related ids while standalone hydration stays private
- readable unpublished Realm falls back to independently authorized labelled Global without revealing Realm data
- readable withdrawn Realm uses independently authorized labelled Global without Realm disclosure
- readable rejected Realm uses independently authorized labelled Global without Realm disclosure
- Realm contextA toB change cannot publish staleA success
- unknown denied and currently banned protected Realms conceal even over an independent read grant
- current subject hiding and Context deletion conceal selected Realm facts and fallback cannot revive a hidden subject
- Realm read grant and publication pointer never replace current Context authority
- current subject takedown and candidate moderation remain authoritative on published Realm pages
- Realm selector validates the existing single target family and rejects raw Context and unknown fields
- agent Realm selectors retain canonical Global redirects and old Global reads retain their response shape
- native suspended pre-suspension bearer is invalid on Realm page reads with the standard Bearer challenge
- protected ban after the first actual Realm read conceals publication not_found without Global fallback
- publication withdraw after selected subject and links cannot survive an unchanged Realm head guard
- publication reject after selected subject and links cannot survive an unchanged Realm head guard
- protected ban after selected subject and links conceals despite an unchanged Realm head and independent grant

## Decisions and required owner bindings

- A readable Realm and null publication produce independently authorized Global output with exactly Global
  metadata. Neither a publication null nor a token's missing subject scope is a denial certificate. The native
  public-read floor remains effective; current hidden-subject controls separately require concealment on fallback.
- Native subject hide/takedown routes supply current lifecycle controls; no subject-delete route is invented.
  Context deletion is NOT YET FROZEN as a native lifecycle binding: the composed `semantic/http/contexts.ts`
  exposes create/read only. The existing native Context lifecycle acceptance also requires DELETE; this suite
  retains that genuine expected-200 operation, which currently returns 404 before its later page assertions.
  The eventual runtime acceptance depends on actual lifecycle code: a native deletion command and HTTP DELETE
  dispatch in `semantic/context.ts` and `semantic/http/contexts.ts`, with read and public-eligibility SQL honoring
  current deletion. Those bindings are absent from this checkout; the separate lifecycle producer must deliver
  actual code before full lifecycle acceptance. No fake deletion, missing-port guard, skip or production
  implementation substitutes for that owner surface.
  Current Context lifecycle authority remains independent of Realm grants and publication pointers: after actual
  deletion, a readable Realm, current publication and readable Global subject must not authorize the selected page.
- Agents retain canonical Global behavior even when a Realm selector is supplied. Account and route targets reject
  that selector. No raw Context, profile-persisted choice or permission-carrying header is accepted.
- Subject and links must carry the same current Context through the actual probe, deduplication, wire and session.
  Native authorization observations retain the caller; session evidence comes only from genuine native tokens.
- Read work retains the existing 16 distinct reads, 128 slots and deadline. This specification does not claim a
  growth measurement or invent another retry allowance.
- `semantic/statement-disclosure.ts` actually exports sticky `withPublicStatementReader`; nested
  `withStatementReader` and `readStatementAs` preserve that public audience. `presentation/reads.ts` applies it
  around `readPage` workers for both subject probes and planned reads. This delivered boundary retains caller
  authority; it supplies neither Realm wire nor Context grants. No second audience helper is needed.
- Realm figures, reviews, discussion and lists each remain NOT YET FROZEN until their actual owners export explicit
  question/Context/population and authority bindings. Global figures and Content's independent Global previews
  are not relabeled or duplicated. No Source safety, identity acknowledgment, defaults or main deployment is claimed.

## During-read authority schedules

The original thirteen assertions and A-to-B schedule remain unchanged. Four additional cases share their one
native fixture, Access delegation and observations. The early ban pauses the first delegated actual `realm:read`,
then commits a native ban on that same independently granted reader before initial publication completion. Native
readability and publication controls require current 404. `readRealm` catches its internal denial into null;
`readPublication` delegates `realmReadEligibility`, whose protected ban throws `ProblemError(not_found)` through
snapshot rollback/rethrow. A thrown `not_found` from either reader conceals the whole page, never Global fallback.
Other native failures keep their typing. Genuine null publication alone can attempt independent Global authority.

The three late schedules record actual selected subject and links responses and hold links completion before it
returns to the aggregate. The subject probe is never blocked waiting for links. Both responses must already be
successful native Context A results with the same bearer and genuine session components. Withdrawal and rejection
use the adopted publication's actual head in If-Match; the ban keeps the independent read grant. Writes run outside
page capture. Governor Realm reads before and after prove unchanged Context and head. A head-only final guard is
therefore insufficient. Late publication changes permit only exact independently authorized current Global subject,
links and metadata, or a typed 503 without result and standard Retry-After, followed by healthy current Global 200.
Late bans require standard whole-page 404 and native banned-reader 404, never fallback or 503. Existing hidden Global
concealment remains unchanged. Cleanup always releases barriers and drains pending requests without replacing an
original setup error with a cleanup rejection. Missing wire remains immediately red.

All native points and final currentness work remain inside the existing 16 distinct reads, 128 slots, concurrency
and deadline. These schedules add no product requests, permission, clock or retry allowance. This specification
provides no runtime growth pass: full runtime observation must include final authority work at existing geometric
scales and current owner populations, with inclusive costs.

The duplicate `board-scheme.ts` reader still exists on this checkout; its cleanup remains pending for the runtime
owner. Only `realm.ts` owns native page readability. Realm figures, reviews, discussion and lists still lack their
explicit owner population bindings.

## Source receipt

Read both complete local review reports through their exact read-only main-checkout paths because the worktree
copies were absent. Read the complete subject-page owner contract and the native presentation `http/pages.ts` and `reads.ts` target,
probe, deduplication, request and session paths; composition's `registry.ts` and `reads.ts`; the unchanged
`aggregate-authority-user-cases.test.ts`; and the existing native presentation page cases and Semantic outcome driver.
Authority references are Community's `realm.ts`, `publication.ts`, `routes.ts` and `ban.ts`, with native Realm,
Realm Context, publication HTTP/publication and protected-ban cases. Semantic references are `context.ts`, Context
HTTP reads, public Context eligibility SQL, Context lifecycle and Context relation cases, subject reads and links,
and statement disclosure. Existing `specs/semantic-outcomes.test.ts` Context assertions and
`specs/content-user-cases-outcomes.test.ts` Realm/Global rating assertions retain authority. No external reference
project was named for this surface or used.

## Previous thirteen-case check evidence

The previous thirteen-case test hash `d904b026900fa1c54a8b73e6aa42186881f1bfec24f239b6ebd0040537061678` was checked
with both required commands. The full previous output below is retained as provenance; it is not a check of the
additive seventeen-case file above. No existing assertion or frozen aggregate-authority file was changed. No file outside the declared
paths was changed. Earlier authoring runs exposed and corrected test typing, edition type and proposal-reference
setup errors before these final results.

- Native acceptance: `bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/presentation/realm-context-user-cases.test.ts`, exit 1, one pass and twelve failures across thirteen tests.
- Root typecheck: `bun scripts/worker-check.ts -- bun run typecheck`, exit 0.
- The first raw native red is expected 200 versus actual 400 `invalid_request`, with `/target/realm` reported as
  `unknown_field`. Real fixture setup and standalone Context controls completed first. This exposes the missing
  native Realm page wire rather than treating 400 or a missing driver as success.
- Two lifecycle cases independently expose the missing native Context DELETE surface, expected 200 versus actual 404. Those later deletion-dependent page assertions remain unverified. All other page reds report the missing
  Realm selector wire; the genuine suspended-bearer 401 and challenge case passes.
- The run reached native execution despite the nonfatal missing-git timing warning in the remote checkout.
  No production completion, co-owner review or manager acceptance is inferred from these results.

### Full native acceptance output

Local log: `.temp/goal/checks/worker-check-2026-10-28T23-40-07.673Z-47644b7d.log`.
Wrapper exit status: 1.

```text
$ bun scripts/check.ts test/presentation/realm-context-user-cases.test.ts
remote-check: slot wait 1.323 s on b

Number of files: 4,973 (reg: 4,653, dir: 319, link: 1)
Number of created files: 19 (reg: 19)
Number of deleted files: 0
Number of regular files transferred: 98
Total file size: 53,889,028 bytes
Total transferred file size: 9,174,524 bytes
Literal data: 439,419 bytes
Matched data: 8,735,105 bytes
File list size: 196,582
File list generation time: 3.599 seconds
File list transfer time: 0.000 seconds
Total bytes sent: 346,604
Total bytes received: 56,773

sent 346,604 bytes  received 56,773 bytes  62,058.00 bytes/sec
total size is 53,889,028  speedup is 133.59
remote-check: rsync 5.953 s on b
remote-check: running on b
stack-run: kernel check on b
bun install v1.4.3 (c6da4a4d3)
Resolving dependencies
Resolved, downloaded and extracted [1]

+ @types/bun@1.4.4
+ bun@1.4.4-canary.20261027.1
+ oxfmt@0.74.0
+ oxlint@1.89.0
+ typescript@7.1.0-beta

885 packages installed [861.00ms]
remote-check: bun install 0.874 s on b
stack-run: kernel check local, already on a check host
Check timings are not recorded: git rev-parse failed: fatal: not a git repository (or any of the parent directories): .git

test/presentation/realm-context-user-cases.test.ts: FAIL; peak database connections 0
test/presentation/realm-context-user-cases.test.ts: bun test ./test/presentation/realm-context-user-cases.test.ts failed:
bun test v1.4.4-canary.1 (a0cc096ce)

test/presentation/realm-context-user-cases.test.ts:
74 | let digest: string;
75 | const localA = 'https://example.test/selected-context-a';
76 | const localB = 'https://example.test/selected-context-b';
77 |
78 | function status(response: HttpResponse, expected: number) {
79 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a184f4-7c74-7301-b2e0-5c71876a59a3","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:79:58)
      at <anonymous> (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:394:3)
(fail) Realm subject page selects only the current authorized published Context with unchanged caller and public candidate audience [265.02ms]
74 | let digest: string;
75 | const localA = 'https://example.test/selected-context-a';
76 | const localB = 'https://example.test/selected-context-b';
77 |
78 | function status(response: HttpResponse, expected: number) {
79 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a184f4-7ce7-7360-bb58-4b537429b907","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:79:58)
      at <anonymous> (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:448:5)
(fail) Realm selector preserves Global agent candidate audience without publisher-private candidates or related ids while standalone hydration stays private [104.72ms]
74 | let digest: string;
75 | const localA = 'https://example.test/selected-context-a';
76 | const localB = 'https://example.test/selected-context-b';
77 |
78 | function status(response: HttpResponse, expected: number) {
79 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a184f4-7ea3-7421-9d0a-d3875c25c94a","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:79:58)
      at fallback (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:476:3)
(fail) readable unpublished Realm falls back to independently authorized labelled Global without revealing Realm data [448.19ms]
74 | let digest: string;
75 | const localA = 'https://example.test/selected-context-a';
76 | const localB = 'https://example.test/selected-context-b';
77 |
78 | function status(response: HttpResponse, expected: number) {
79 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a184f4-80c9-7129-a951-4edc638eeba6","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:79:58)
      at fallback (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:476:3)
(fail) readable withdrawn Realm uses independently authorized labelled Global without Realm disclosure [546.25ms]
74 | let digest: string;
75 | const localA = 'https://example.test/selected-context-a';
76 | const localB = 'https://example.test/selected-context-b';
77 |
78 | function status(response: HttpResponse, expected: number) {
79 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a184f4-82af-710b-a08c-3c43918fa34c","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:79:58)
      at fallback (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:476:3)
(fail) readable rejected Realm uses independently authorized labelled Global without Realm disclosure [487.78ms]
74 | let digest: string;
75 | const localA = 'https://example.test/selected-context-a';
76 | const localB = 'https://example.test/selected-context-b';
77 |
78 | function status(response: HttpResponse, expected: number) {
79 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a184f4-839a-7723-94cc-a3a0af9f32ed","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:79:58)
      at <anonymous> (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:531:7)
(fail) Realm contextA toB change cannot publish staleA success [234.52ms]
74 | let digest: string;
75 | const localA = 'https://example.test/selected-context-a';
76 | const localB = 'https://example.test/selected-context-b';
77 |
78 | function status(response: HttpResponse, expected: number) {
79 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a184f4-839e-72b2-8328-9dd2644e6020","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 404
Received: 400

      at status (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:79:58)
      at <anonymous> (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:568:3)
(fail) unknown denied and currently banned protected Realms conceal even over an independent read grant [4.85ms]
74 | let digest: string;
75 | const localA = 'https://example.test/selected-context-a';
76 | const localB = 'https://example.test/selected-context-b';
77 |
78 | function status(response: HttpResponse, expected: number) {
79 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/not_found","title":"Not Found","status":404,"code":"not_found","retryable":false,"effect_status":"not_applied","request_id":"01a184f4-84a6-7415-b6a9-961c83b08563"}

Expected: 200
Received: 404

      at status (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:79:58)
      at <anonymous> (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:597:3)
(fail) current subject hiding and Context deletion conceal selected Realm facts and fallback cannot revive a hidden subject [260.66ms]
74 | let digest: string;
75 | const localA = 'https://example.test/selected-context-a';
76 | const localB = 'https://example.test/selected-context-b';
77 |
78 | function status(response: HttpResponse, expected: number) {
79 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/not_found","title":"Not Found","status":404,"code":"not_found","retryable":false,"effect_status":"not_applied","request_id":"01a184f4-8595-7768-a46d-fc0cb520e76f"}

Expected: 200
Received: 404

      at status (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:79:58)
      at <anonymous> (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:621:3)
(fail) Realm read grant and publication pointer never replace current Context authority [238.88ms]
74 | let digest: string;
75 | const localA = 'https://example.test/selected-context-a';
76 | const localB = 'https://example.test/selected-context-b';
77 |
78 | function status(response: HttpResponse, expected: number) {
79 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a184f4-8779-770b-9672-496a83414d4c","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 404
Received: 400

      at status (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:79:58)
      at <anonymous> (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:645:3)
(fail) current subject takedown and candidate moderation remain authoritative on published Realm pages [488.15ms]
74 | let digest: string;
75 | const localA = 'https://example.test/selected-context-a';
76 | const localB = 'https://example.test/selected-context-b';
77 |
78 | function status(response: HttpResponse, expected: number) {
79 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a184f4-8798-7543-bd05-952628253679","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:79:58)
      at <anonymous> (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:691:3)
(fail) Realm selector validates the existing single target family and rejects raw Context and unknown fields [27.78ms]
74 | let digest: string;
75 | const localA = 'https://example.test/selected-context-a';
76 | const localB = 'https://example.test/selected-context-b';
77 |
78 | function status(response: HttpResponse, expected: number) {
79 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a184f4-892f-731f-8a04-93afc08a0f8c","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:79:58)
      at <anonymous> (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/test/presentation/realm-context-user-cases.test.ts:703:3)
(fail) agent Realm selectors retain canonical Global redirects and old Global reads retain their response shape [407.76ms]
(pass) native suspended pre-suspension bearer is invalid on Realm page reads with the standard Bearer challenge [5.82ms]

 1 pass
 12 fail
 171 expect() calls
Ran 13 tests across 1 file. [56.59s]

PostgreSQL connections: peak 26/500 max_connections; highest file peaks: test/presentation/realm-context-user-cases.test.ts=0
Load reruns: 0 files, 0 s alone (0 passed alone)
Reylo analyses written: 592
609 |   }
610 |   if (reyloDirectory) rmSync(reyloDirectory, { recursive: true, force: true });
611 | }
612 |
613 | function fail(message: string): never {
614 |   throw new Error(message);
                  ^
error: Kernel tests failed for 1 file(s):
test/presentation/realm-context-user-cases.test.ts
      at fail (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/scripts/check.ts:614:13)
      at main (/srv/rezics-check/runs/mvsrwy6p-a8d9faff/services/kernel/scripts/check.ts:827:27)

remote-check: command 172.911 s on b
remote-check: run used 232.108 CPU seconds over 173.977 s (1.33 cores), peak memory 3927 MiB on b
error: script "check" exited with code 1
```

### Full root typecheck output

Local log: `.temp/goal/checks/worker-check-2026-10-28T23-40-48.043Z-90c225d5.log`.
Wrapper exit status: 0.

```text
$ bun scripts/typecheck.ts
Workspace @rezics/auth-contract finished in 0.37s
$ bun run typecheck  (packages/auth-contract)

Workspace @rezics/filter finished in 1.21s
$ bun run typecheck  (packages/filter)

Workspace @rezics/composition finished in 1.30s
$ bun run typecheck  (packages/composition)

Workspace @rezics/document finished in 1.40s
$ bun run typecheck  (packages/document)

Workspace @rezics/ui finished in 2.34s
$ bun run typecheck  (packages/ui)

Workspace @rezics/client finished in 2.79s
$ bun run typecheck  (packages/client)

Workspace @rezics/conversion finished in 2.81s
$ bun run typecheck  (packages/conversion)

Workspace @rezics/importer finished in 2.82s
$ bun run typecheck  (services/importer)

Workspace @rezics/definitions finished in 2.94s
$ bun run typecheck  (packages/definitions)

Workspace @rezics/auth-pages finished in 17.93s
$ bun run typecheck  (apps/auth)

Workspace @rezics/web finished in 25.88s
$ bun run typecheck  (apps/web)

Workspace @rezics/auth finished in 64.99s
$ bun run typecheck  (services/auth)

Workspace @rezics/kernel finished in 65.56s
$ bun run typecheck  (services/kernel)

```
