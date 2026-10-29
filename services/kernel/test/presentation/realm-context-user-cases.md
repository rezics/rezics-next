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

## Additive seventeen-case verification

The formatted seventeen-case file retains the complete previous thirteen cases byte for byte, including the
A-to-B schedule. The frozen Global aggregate-authority file is unchanged. Only the three declared files changed.
The tests remain specification evidence awaiting full review; no runtime currentness or growth pass is claimed.

### Initial root typecheck output

Command: `bun scripts/worker-check.ts -- bun run typecheck`. Exit status: 1.
Kernel and Auth typechecking completed; web route generation failed because the Lix service did not open within
its native timeout. This infrastructure failure is retained in full; a bounded unchanged-command retry follows.
Local log: `.temp/goal/checks/worker-check-2026-10-29T11-18-39.515Z-9b4e36cd.log`.

```text
remote-check: slot wait 211.688 s on b

Number of files: 5,306 (reg: 4,977, dir: 328, link: 1)
Number of created files: 38 (reg: 36, dir: 2)
Number of deleted files: 0
Number of regular files transferred: 153
Total file size: 57,483,512 bytes
Total transferred file size: 2,541,157 bytes
Literal data: 748,532 bytes
Matched data: 1,792,625 bytes
File list size: 196,584
File list generation time: 0.415 seconds
File list transfer time: 0.000 seconds
Total bytes sent: 474,703
Total bytes received: 37,767

sent 474,703 bytes  received 37,767 bytes  1,513.94 bytes/sec
total size is 57,483,512  speedup is 112.17
remote-check: rsync 338.357 s on b
remote-check: running on b
bun install v1.4.4-canary.1 (a0cc096ce)
Resolving dependencies
Resolved, downloaded and extracted [1]

+ @types/bun@1.4.4
+ bun@1.4.4-canary.20261027.1
+ oxfmt@0.74.0
+ oxlint@1.89.0
+ typescript@7.1.0-beta

896 packages installed [3.70s]
remote-check: bun install 3.796 s on b
$ bun scripts/typecheck.ts
Workspace @rezics/auth-contract finished in 0.86s
$ bun run typecheck  (packages/auth-contract)

Workspace @rezics/filter finished in 1.29s
$ bun run typecheck  (packages/filter)

Workspace @rezics/document finished in 1.47s
$ bun run typecheck  (packages/document)

Workspace @rezics/composition finished in 1.64s
$ bun run typecheck  (packages/composition)

Workspace @rezics/ui finished in 3.44s
$ bun run typecheck  (packages/ui)

Workspace @rezics/importer finished in 4.79s
$ bun run typecheck  (services/importer)

Workspace @rezics/client finished in 5.40s
$ bun run typecheck  (packages/client)

Workspace @rezics/conversion finished in 6.37s
$ bun run typecheck  (packages/conversion)

Workspace @rezics/definitions finished in 7.98s
$ bun run typecheck  (packages/definitions)

Workspace @rezics/auth-pages finished in 147.14s
$ bun run typecheck  (apps/auth)

Workspace @rezics/auth finished in 532.51s
$ bun run typecheck  (services/auth)

Workspace @rezics/kernel finished in 603.34s
$ bun run typecheck  (services/kernel)

Workspace @rezics/web finished in 132.60s
$ bun run typecheck  (apps/web)
vite v8.3.5 building client environment for development...
ℹ [paraglide-js] Please check your translation files for syntax errors.
✓ 0 modules transformed.
$ bun run generate && bun run generate:routes && bun check --no-script -p tsconfig.json
$ bun scripts/generate.ts
$ vite build --config vite.config.ts --mode development --emptyOutDir false
(!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, which is planned to become the default in a future major version of Vite:
  - import "../project.inlang/paraglide.config" without a file extension (scripts/generate.ts:2:21). Add the file extension
Set `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` to suppress this warning.
(!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, which is planned to become the default in a future major version of Vite:
  - import "../project.inlang/paraglide.config" without a file extension (scripts/generate.ts:2:21). Add the file extension
Set `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` to suppress this warning.
(!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, which is planned to become the default in a future major version of Vite:
  - import "../project.inlang/paraglide.config" without a file extension (scripts/generate.ts:2:21). Add the file extension
Set `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` to suppress this warning.

 ERROR  [paraglide-js] Failed to compile project: Lix open did not settle within 30000ms

✗ Build failed in 1m 25s
error during build:
Build failed with 1 error:

[plugin unplugin-paraglide-js]
LixError: Lix open did not settle within 30000ms
    at Timeout.<anonymous> (file:///srv/rezics-check/runs/mvtgehgi-72134fe4/node_modules/.bun/@lix-js+sdk@0.20.1/node_modules/@lix-js/sdk/dist/worker/client.js:750:56)
    at listOnTimeout (node:internal/timers:685:17)
    at process.processTimers (node:internal/timers:618:7)
    at aggregateBindingErrorsIntoJsError (file:///srv/rezics-check/runs/mvtgehgi-72134fe4/node_modules/.bun/rolldown@1.2.15/node_modules/rolldown/dist/shared/error-D0SD8_tL.mjs:49:18)
    at unwrapBindingResult (file:///srv/rezics-check/runs/mvtgehgi-72134fe4/node_modules/.bun/rolldown@1.2.15/node_modules/rolldown/dist/shared/error-D0SD8_tL.mjs:19:128)
    at #build (file:///srv/rezics-check/runs/mvtgehgi-72134fe4/node_modules/.bun/rolldown@1.2.15/node_modules/rolldown/dist/shared/rolldown-CMhwwZPA.mjs:145:34)
    at async buildEnvironment (file:///srv/rezics-check/runs/mvtgehgi-72134fe4/node_modules/.bun/vite@8.3.5+77d67c083a359184/node_modules/vite/dist/node/chunks/node.js:34849:66)
    at async Object.build (file:///srv/rezics-check/runs/mvtgehgi-72134fe4/node_modules/.bun/vite@8.3.5+77d67c083a359184/node_modules/vite/dist/node/chunks/node.js:35270:19)
    at async buildStartViteEnvironments (file:///srv/rezics-check/runs/mvtgehgi-72134fe4/node_modules/.bun/@tanstack+start-plugin-core@1.171.55+c8d6ea6b3663e5c1/node_modules/@tanstack/start-plugin-core/dist/esm/vite/planning.js:85:23)
    at async Object.buildApp (file:///srv/rezics-check/runs/mvtgehgi-72134fe4/node_modules/.bun/@tanstack+start-plugin-core@1.171.55+c8d6ea6b3663e5c1/node_modules/@tanstack/start-plugin-core/dist/esm/vite/plugin.js:114:8)
    at async Object.buildApp (file:///srv/rezics-check/runs/mvtgehgi-72134fe4/node_modules/.bun/vite@8.3.5+77d67c083a359184/node_modules/vite/dist/node/chunks/node.js:35262:6)
    at async CAC.<anonymous> (file:///srv/rezics-check/runs/mvtgehgi-72134fe4/node_modules/.bun/vite@8.3.5+77d67c083a359184/node_modules/vite/dist/node/cli.js:790:3) {
  errors: [Getter/Setter]
}
error: script "generate:routes" exited with code 1
error: script "typecheck" exited with code 1

error: script "typecheck" exited with code 1
remote-check: command 609.570 s on b
remote-check: run used 347.088 CPU seconds over 615.148 s (0.56 cores), peak memory 3376 MiB on b
worker-check: bun run typecheck peak 3.3 GiB (weight 4)
check: exit status 1
check: failure summary
Total bytes received: 37,767
sent 474,703 bytes  received 37,767 bytes  1,513.94 bytes/sec
ℹ [paraglide-js] Please check your translation files for syntax errors.
ERROR  [paraglide-js] Failed to compile project: Lix open did not settle within 30000ms
✗ Build failed in 1m 25s
error during build:
Build failed with 1 error:
LixError: Lix open did not settle within 30000ms
at aggregateBindingErrorsIntoJsError (file:///srv/rezics-check/runs/mvtgehgi-72134fe4/node_modules/.bun/rolldown@1.2.15/node_modules/rolldown/dist/shared/error-D0SD8_tL.mjs:49:18)
at unwrapBindingResult (file:///srv/rezics-check/runs/mvtgehgi-72134fe4/node_modules/.bun/rolldown@1.2.15/node_modules/rolldown/dist/shared/error-D0SD8_tL.mjs:19:128)
errors: [Getter/Setter]
error: script "generate:routes" exited with code 1
error: script "typecheck" exited with code 1
check: log .temp/goal/checks/worker-check-2026-10-29T11-18-39.515Z-9b4e36cd.log
```

### Native acceptance infrastructure failure

Command: `bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/presentation/realm-context-user-cases.test.ts`.
Final exit status: 1. The original run stopped growing its log for ten minutes; the wrapper performed its single
automatic rerun. That rerun failed during dependency installation with
`ENOENT: No such file or directory: failed to link package: check-error@2.1.3 (open)`.
This is a tool blocker after the automatic rerun. No additional native run was started. These runs did not supply
a seventeen-case native result; the earlier thirteen-case missing-wire and lifecycle reds remain previous evidence
only. No passing currentness, growth, full-review freeze or runtime delivery is inferred.

Full original run output:

```text
remote-check: slot wait 208.216 s on b

Number of files: 5,306 (reg: 4,977, dir: 328, link: 1)
Number of created files: 38 (reg: 36, dir: 2)
Number of deleted files: 0
Number of regular files transferred: 153
Total file size: 57,483,512 bytes
Total transferred file size: 2,541,157 bytes
Literal data: 748,532 bytes
Matched data: 1,792,625 bytes
File list size: 196,584
File list generation time: 1.226 seconds
File list transfer time: 0.000 seconds
Total bytes sent: 474,711
Total bytes received: 37,767

sent 474,711 bytes  received 37,767 bytes  1,425.53 bytes/sec
total size is 57,483,512  speedup is 112.17
remote-check: rsync 358.808 s on b
remote-check: running on b
bun install v1.4.4-canary.1 (a0cc096ce)
Resolving dependencies
Resolved, downloaded and extracted [1]

+ @types/bun@1.4.4
+ bun@1.4.4-canary.20261027.1
+ oxfmt@0.74.0
+ oxlint@1.89.0
+ typescript@7.1.0-beta

896 packages installed [3.77s]
remote-check: bun install 3.876 s on b
$ bun scripts/check.ts test/presentation/realm-context-user-cases.test.ts
stack-run: kernel check local, already on a check host
```

Full automatic rerun output:

```text
remote-check: skipped b: load 103.56 exceeds limit 22.5
remote-check: skipped c: load 63.46 exceeds limit 36
remote-check: every check slot is busy; waiting for a free one (a 0/1 free); skipped b: load 103.56 exceeds limit 22.5; c: load 63.46 exceeds limit 36
remote-check: every check slot is busy; waiting for a free one (a 0/1 free); skipped b: load 92.35 exceeds limit 22.5; c: load 41.84 exceeds limit 36
remote-check: every check slot is busy; waiting for a free one (a 0/1 free); skipped b: load 37.7 exceeds limit 22.5; c: load 88.69 exceeds limit 36
remote-check: slot wait 173.193 s on b

Number of files: 5,306 (reg: 4,977, dir: 328, link: 1)
Number of created files: 12 (reg: 12)
Number of deleted files: 0
Number of regular files transferred: 65
Total file size: 57,491,343 bytes
Total transferred file size: 1,620,462 bytes
Literal data: 370,945 bytes
Matched data: 1,249,517 bytes
File list size: 196,584
File list generation time: 0.432 seconds
File list transfer time: 0.000 seconds
Total bytes sent: 363,200
Total bytes received: 30,205

sent 363,200 bytes  received 30,205 bytes  15,427.65 bytes/sec
total size is 57,491,343  speedup is 146.14
remote-check: rsync 35.768 s on b
remote-check: running on b
bun install v1.4.4-canary.1 (a0cc096ce)
Resolving dependencies
Resolved, downloaded and extracted [1]
ENOENT: No such file or directory: failed to link package: check-error@2.1.3 (open)

+ @types/bun@1.4.4
+ bun@1.4.4-canary.20261027.1
+ oxfmt@0.74.0
+ oxlint@1.89.0
+ typescript@7.1.0-beta

895 packages installed [3.34s]
Failed to install 1 package
remote-check: bun install 3.383 s on b
remote-check: run used 1.014 CPU seconds over 3.386 s (0.30 cores), peak memory 63 MiB on b
worker-check: bun run --cwd services/kernel check test peak 0.1 GiB (weight 5)
check: exit status 1
check: failure summary
Total bytes received: 30,205
sent 363,200 bytes  received 30,205 bytes  15,427.65 bytes/sec
ENOENT: No such file or directory: failed to link package: check-error@2.1.3 (open)
Failed to install 1 package
check: log .temp/goal/checks/worker-check-2026-10-29T11-40-01.828Z-8008a984.log
```

### Root typecheck retry output

The single unchanged-command retry of `bun scripts/worker-check.ts -- bun run typecheck` exited 0.
Local log: `.temp/goal/checks/worker-check-2026-10-29T11-41-43.875Z-9573bcf2.log`.
The earlier Lix timeout is not a passing check; this completed retry supplies root typecheck evidence for the
unchanged formatted test file. Native acceptance remains blocked by dependency installation after its automatic
rerun. All started checks have finished. No additional acceptance run, whole-kernel check or full web gate was run.

```text
remote-check: skipped b: load 44.37 exceeds limit 22.5
remote-check: skipped c: load 49.43 exceeds limit 36
remote-check: every check slot is busy; waiting for a free one (a 0/1 free); skipped b: load 44.37 exceeds limit 22.5; c: load 49.43 exceeds limit 36
remote-check: slot wait 49.124 s on b

Number of files: 5,306 (reg: 4,977, dir: 328, link: 1)
Number of created files: 12 (reg: 12)
Number of deleted files: 0
Number of regular files transferred: 65
Total file size: 57,491,343 bytes
Total transferred file size: 1,620,462 bytes
Literal data: 370,945 bytes
Matched data: 1,249,517 bytes
File list size: 196,584
File list generation time: 2.563 seconds
File list transfer time: 0.000 seconds
Total bytes sent: 363,176
Total bytes received: 30,205

sent 363,176 bytes  received 30,205 bytes  29,139.33 bytes/sec
total size is 57,491,343  speedup is 146.15
remote-check: rsync 13.649 s on b
remote-check: running on b
bun install v1.4.4-canary.1 (a0cc096ce)
Resolving dependencies
Resolved, downloaded and extracted [1]

+ @types/bun@1.4.4
+ bun@1.4.4-canary.20261027.1
+ oxfmt@0.74.0
+ oxlint@1.89.0
+ typescript@7.1.0-beta

896 packages installed [562.00ms]
remote-check: bun install 0.613 s on b
$ bun scripts/typecheck.ts
Workspace @rezics/auth-contract finished in 0.51s
$ bun run typecheck  (packages/auth-contract)

Workspace @rezics/filter finished in 0.52s
$ bun run typecheck  (packages/filter)

Workspace @rezics/document finished in 0.64s
$ bun run typecheck  (packages/document)

Workspace @rezics/composition finished in 0.84s
$ bun run typecheck  (packages/composition)

Workspace @rezics/ui finished in 1.35s
$ bun run typecheck  (packages/ui)

Workspace @rezics/definitions finished in 2.44s
$ bun run typecheck  (packages/definitions)

Workspace @rezics/client finished in 2.66s
$ bun run typecheck  (packages/client)

Workspace @rezics/conversion finished in 2.66s
$ bun run typecheck  (packages/conversion)

Workspace @rezics/importer finished in 2.83s
$ bun run typecheck  (services/importer)

Workspace @rezics/auth-pages finished in 18.43s
$ bun run typecheck  (apps/auth)

Workspace @rezics/web finished in 27.48s
$ bun run typecheck  (apps/web)

Workspace @rezics/auth finished in 134.38s
$ bun run typecheck  (services/auth)

Workspace @rezics/kernel finished in 177.75s
$ bun run typecheck  (services/kernel)

remote-check: command 183.707 s on b
remote-check: run used 300.679 CPU seconds over 184.576 s (1.63 cores), peak memory 3667 MiB on b
remote-check: could not remove /srv/rezics-check/runs/mvth4o94-a1d624e9 on b
worker-check: bun run typecheck peak 3.6 GiB (weight 4)
check: exit status 0
check: log .temp/goal/checks/worker-check-2026-10-29T11-41-43.875Z-9573bcf2.log
```

## Completed seventeen-case native verification

The resumed native acceptance reached all seventeen cases on the unchanged formatted test file above.
The earlier dependency-installation blocker is resolved for this run; its output remains historical evidence.
Command: `bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/presentation/realm-context-user-cases.test.ts`.
Exit status: 1. Native result: **1 pass, 16 failures, 255 assertions across 17 tests**; no load reruns.

The first failure remains expected 200 versus actual 400 `invalid_request`, with `/target/realm` reported as
`unknown_field`. Both original Context deletion cases still fail at native DELETE, expected 200 versus actual
404, before their deletion-dependent page assertions. The genuine suspended-bearer case passes. All four added
schedules complete their native setup and fail immediately on missing Realm page wire, before any claimed
barrier or currentness proof. No barrier timeout, fabricated success or infrastructure failure replaces those
assertions. This is the required additive red specification evidence, not passing runtime acceptance.

The test file remains SHA-256 `c408aa576fede18fa7dea6fec842f2c834891cd779df711ad23975be9df2b95d`.
The original thirteen cases, original A-to-B schedule and frozen Global aggregate-authority suite are unchanged.
Only the three declared files differ from the specification's starting revision. No external reference project
was required, no file outside those paths was changed, and no runtime growth or lifecycle delivery is claimed.
Current code still exports the sticky public audience boundary and still lacks Context DELETE; the duplicate
board-scheme reader remains pending cleanup. The source receipt and required owner bindings above still apply.

### Full seventeen-case native output

Local log: `.temp/goal/checks/worker-check-2026-10-29T14-08-55.413Z-8eb9fb4b.log`.

```text
remote-check: every check slot is busy; waiting for a free one (b 0/6 free, c 0/3 free, a 0/4 free)
remote-check: every check slot is busy; waiting for a free one (b 0/6 free, a 0/4 free, c 0/3 free)
remote-check: every check slot is busy; waiting for a free one (b 0/6 free, a 0/4 free, c 0/3 free)
remote-check: every check slot is busy; waiting for a free one (a 0/4 free, b 0/6 free, c 0/3 free)
remote-check: every check slot is busy; waiting for a free one (a 0/4 free, c 0/3 free, b 0/6 free)
remote-check: every check slot is busy; waiting for a free one (a 0/4 free, c 0/3 free, b 0/6 free)
remote-check: every check slot is busy; waiting for a free one (a 0/4 free, c 0/3 free, b 0/6 free)
remote-check: every check slot is busy; waiting for a free one (b 0/6 free, a 0/4 free, c 0/3 free)
remote-check: slot wait 467.211 s on b

Number of files: 5,324 (reg: 4,993, dir: 330, link: 1)
Number of created files: 12 (reg: 12)
Number of deleted files: 0
Number of regular files transferred: 52
Total file size: 57,651,227 bytes
Total transferred file size: 938,673 bytes
Literal data: 248,364 bytes
Matched data: 690,309 bytes
File list size: 196,592
File list generation time: 1.118 seconds
File list transfer time: 0.000 seconds
Total bytes sent: 316,619
Total bytes received: 23,870

sent 316,619 bytes  received 23,870 bytes  40,057.53 bytes/sec
total size is 57,651,227  speedup is 169.32
remote-check: rsync 9.023 s on b
remote-check: running on b
bun install v1.4.4-canary.1 (a0cc096ce)
Resolving dependencies
Resolved, downloaded and extracted [1]

+ @types/bun@1.4.4
+ bun@1.4.4-canary.20261027.1
+ oxfmt@0.74.0
+ oxlint@1.89.0
+ typescript@7.1.0-beta

896 packages installed [420.00ms]
remote-check: bun install 0.438 s on b
$ bun scripts/check.ts test/presentation/realm-context-user-cases.test.ts
stack-run: kernel check local, already on a check host
test/presentation/realm-context-user-cases.test.ts: FAIL; peak database connections 0
test/presentation/realm-context-user-cases.test.ts: bun test ./test/presentation/realm-context-user-cases.test.ts failed:
bun test v1.4.4-canary.1 (a0cc096ce)

test/presentation/realm-context-user-cases.test.ts:
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-1e74-76aa-b805-2520f7f024fd","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at <anonymous> (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:416:3)
(fail) Realm subject page selects only the current authorized published Context with unchanged caller and public candidate audience [128.96ms]
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-1eb3-779f-958c-bc7fa59c3b73","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at <anonymous> (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:470:5)
(fail) Realm selector preserves Global agent candidate audience without publisher-private candidates or related ids while standalone hydration stays private [55.43ms]
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-1f89-7773-9f58-8e7838fc26a0","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at fallback (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:498:3)
(fail) readable unpublished Realm falls back to independently authorized labelled Global without revealing Realm data [214.64ms]
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-20a7-771a-aae2-e8f5e4bc73a4","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at fallback (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:498:3)
(fail) readable withdrawn Realm uses independently authorized labelled Global without Realm disclosure [286.19ms]
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-21d6-77be-b021-772771dfbe50","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at fallback (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:498:3)
(fail) readable rejected Realm uses independently authorized labelled Global without Realm disclosure [302.34ms]
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-2255-7090-8f40-ae001703799d","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at <anonymous> (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:553:7)
(fail) Realm contextA toB change cannot publish staleA success [127.96ms]
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-2258-74c6-9f58-6006b3423e5a","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 404
Received: 400

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at <anonymous> (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:590:3)
(fail) unknown denied and currently banned protected Realms conceal even over an independent read grant [2.07ms]
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/not_found","title":"Not Found","status":404,"code":"not_found","retryable":false,"effect_status":"not_applied","request_id":"01a18807-22e9-747d-bcf6-aa3512bcf4c7"}

Expected: 200
Received: 404

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at <anonymous> (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:619:3)
(fail) current subject hiding and Context deletion conceal selected Realm facts and fallback cannot revive a hidden subject [144.19ms]
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/not_found","title":"Not Found","status":404,"code":"not_found","retryable":false,"effect_status":"not_applied","request_id":"01a18807-237d-7239-8ebe-50a7690d4fa8"}

Expected: 200
Received: 404

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at <anonymous> (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:643:3)
(fail) Realm read grant and publication pointer never replace current Context authority [147.79ms]
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-2449-7377-af96-83cb0ac9ea01","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 404
Received: 400

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at <anonymous> (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:667:3)
(fail) current subject takedown and candidate moderation remain authoritative on published Realm pages [204.59ms]
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-245c-74a0-9870-d351e81e4362","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at <anonymous> (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:713:3)
(fail) Realm selector validates the existing single target family and rejects raw Context and unknown fields [18.40ms]
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-256b-76d6-a0f5-b805d59c2127","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at <anonymous> (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:725:3)
(fail) agent Realm selectors retain canonical Global redirects and old Global reads retain their response shape [274.89ms]
.
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-25f2-709a-bbd8-a1083a1367fe","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 404
Received: 400

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at <anonymous> (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:775:7)
(fail) protected ban after the first actual Realm read conceals publication not_found without Global fallback [127.86ms]
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-27b1-75d0-ad4e-d28bf0952c96","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at lateAuthority (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:863:7)
(fail) publication withdraw after selected subject and links cannot survive an unchanged Realm head guard [447.48ms]
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expect(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-2981-70ea-bc74-b91f3f193539","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at lateAuthority (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:863:7)
(fail) publication reject after selected subject and links cannot survive an unchanged Realm head guard [463.83ms]
76 | let digest: string;
77 | const localA = 'https://example.test/selected-context-a';
78 | const localB = 'https://example.test/selected-context-b';
79 |
80 | function status(response: HttpResponse, expected: number) {
81 |   expectPostgreSQL connections: peak 26/500 max_connections; highest file peaks: test/presentation/realm-context-user-cases.test.ts=0
(response.status, JSON.stringify(response.body)).toBe(expected);
                                                              ^
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-2b06-7608-ba45-d0b1f6cbcc64","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}

Expected: 200
Received: 400

      at status (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:81:58)
      at lateAuthority (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/test/presentation/realm-context-user-cases.test.ts:863:7)
(fail) protected ban after selected subject and links conceals despite an unchanged Realm head and independent grant [388.15ms]


1 pass
16 fail
255 expect() calls
Ran 17 tests across 1 file. [37.32s]

Load reruns: 0 files, 0 s alone (0 passed alone)
Reylo analyses written: 619
671 |   }
672 |   if (reyloDirectory) rmSync(reyloDirectory, { recursive: true, force: true });
673 | }
674 |
675 | function fail(message: string): never {
676 |   throw new Error(message);
                  ^
error: Kernel tests failed for 1 file(s):
test/presentation/realm-context-user-cases.test.ts
      at fail (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/scripts/check.ts:676:13)
      at main (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/scripts/check.ts:904:27)

error: script "check" exited with code 1
remote-check: command 120.691 s on b
remote-check: run used 142.737 CPU seconds over 121.264 s (1.18 cores), peak memory 3060 MiB on b
worker-check: bun run --cwd services/kernel check test peak 3.0 GiB (weight 6)
check: exit status 1
check: failure summary
ield"}]}
Expected: 404
(fail) unknown denied and currently banned protected Realms conceal even over an independent read grant [2.07ms]
error: {"type":"https://rezics.com/problems/not_found","title":"Not Found","status":404,"code":"not_found","retryable":false,"effect_status":"not_applied","request_id":"01a18807-22e9-747d-bcf6-aa3512bcf4c7"}
Received: 404
(fail) current subject hiding and Context deletion conceal selected Realm facts and fallback cannot revive a hidden subject [144.19ms]
error: {"type":"https://rezics.com/problems/not_found","title":"Not Found","status":404,"code":"not_found","retryable":false,"effect_status":"not_applied","request_id":"01a18807-237d-7239-8ebe-50a7690d4fa8"}
(fail) Realm read grant and publication pointer never replace current Context authority [147.79ms]
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-2449-7377-af96-83cb0ac9ea01","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}
(fail) current subject takedown and candidate moderation remain authoritative on published Realm pages [204.59ms]
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-245c-74a0-9870-d351e81e4362","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}
(fail) Realm selector validates the existing single target family and rejects raw Context and unknown fields [18.40ms]
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-256b-76d6-a0f5-b805d59c2127","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}
(fail) agent Realm selectors retain canonical Global redirects and old Global reads retain their response shape [274.89ms]
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-25f2-709a-bbd8-a1083a1367fe","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}
(fail) protected ban after the first actual Realm read conceals publication not_found without Global fallback [127.86ms]
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-27b1-75d0-ad4e-d28bf0952c96","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}
(fail) publication withdraw after selected subject and links cannot survive an unchanged Realm head guard [447.48ms]
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-2981-70ea-bc74-b91f3f193539","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}
(fail) publication reject after selected subject and links cannot survive an unchanged Realm head guard [463.83ms]
(response.status, JSON.stringify(response.body)).toBe(expected);
error: {"type":"https://rezics.com/problems/invalid_request","title":"Invalid Request","status":400,"code":"invalid_request","retryable":false,"effect_status":"not_applicable","request_id":"01a18807-2b06-7608-ba45-d0b1f6cbcc64","errors":[{"pointer":"/target/realm","code":"unknown_field"}]}
(fail) protected ban after selected subject and links conceals despite an unchanged Realm head and independent grant [388.15ms]
16 fail
675 | function fail(message: string): never {
676 |   throw new Error(message);
error: Kernel tests failed for 1 file(s):
at fail (/srv/rezics-check/runs/mvtmmx8z-c09f7897/services/kernel/scripts/check.ts:676:13)
error: script "check" exited with code 1
check: log .temp/goal/checks/worker-check-2026-10-29T14-08-55.413Z-8eb9fb4b.log
```
