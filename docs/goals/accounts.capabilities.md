# Accounts capability acceptance

This manifest maps the accounts capabilities to native acceptance; product documents own behaviour.

Decision: capability rows record source-backed native coverage and its evidence limits; source presence alone does not claim execution, release, promotion or browser qualification. It covers [Agents and public profiles](../scope.md), [Follows](../scope.md), [Accounts, authentication, preferences and deletion](../scope.md), [Realms and Spaces (membership and Access)](../scope.md), [Notifications (preferences)](../scope.md), and [platform gates](../scope.md).

## First-public journeys

### Post-seed API capture

Decision: API capture requires the admitted runtime and its bound credential paths; catalogue seed completion and
result bytes are observations, never J03/J04/J10 prerequisites.

Decision: authority loss qualifies only on Auth `401 authentication_denied` or Kernel `401 invalid_credentials`;
explicit overload codes, transport and setup outcomes stay unknown and never count as denial or PASS. Status alone
never attributes overload; a generic 503 remains unclassified unknown.

Decision: J04 uses the registered management client with only `account:manage` for its fresh same-subject step-up. The host-created `login` client stays empty-scoped; widening it would grant sessions authority that the native formula requires callers to prove explicitly.

Adopt the [capture research](../research/accounts-post-seed-api-capture-codex.md) as the acceptance contract for
the original recovery, credential replacement and website refresh-family revocation API journeys. Reuse the
original runner functions and assertions with three independent newly registered ordinary humans on one admitted
runtime. Each case records its result independently and continues after a sibling failure. This isolated capture
leaves the complete nineteen-journey census and browser evidence separate.

The existing visual runtime owner supplies the durable service and slot, lease/stack process identities, explicit
Web/issuer/native/Kernel origins, full runtime revision, and matching private key, binding and local recovery-delivery
paths. Capture records the source revision, runtime revision, service/slot, lease and stack process IDs, origins and
the seed completion/state values actually supplied. Catalogue seed state does not gate these independent account
operations; capture does not read or require seed-result bytes and records no seed-result hash. A missing or invalid
runtime handoff establishes only an unmet prerequisite; it supplies no result for an unreached API phase.

| Original journey | Required reached phases and independent readback |
| --- | --- |
| Recovery | Sign up and sign in; start recovery; receive the actual private local delivery; complete recovery; try both old and new passwords; read with the original session. |
| Credential replacement | Sign up and sign in; stage, approve and apply the original effect with the same subject/session binding; independently prove old-password refusal, replacement-password sign-in and a current session in the sessions readback. |
| Website refresh-family revocation | Sign up and obtain website OAuth authority; prove a Kernel read with the original bearer; send the original six form fields with their client, resource, issuer and token-kind bindings; independently repeat the Kernel read with that same bearer after revocation. |

Record elapsed time, reached phase, first failing operation, allowlisted public response codes/shapes, request-field
names and presence, authority relationships and native readbacks. Qualify stale-password and stale-session loss only
on Auth HTTP 401 `authentication_denied`; qualify the formerly admitted bearer loss only on Kernel HTTP 401
`invalid_credentials`. Explicit overload codes such as `503 overloaded`, transport, OAuth/runtime setup and other
unqualified responses are unknown, never denial evidence or PASS. Preserve a causal assertion failure separately
from an unknown outcome and continue collecting siblings. Keep passwords, credentials, proofs, assertions, raw private keys and fixture contents
private. Trusted internal diagnostics become causal evidence only when the runtime owner supplies an actual request
correlation; nearby log lines supply none. The Website revocation boundary validates the original resource before
invalidating a refresh family. A response status alone does not locate a service defect. In particular,
a successful revocation response does not establish the original family or Kernel-authority consequence without the
formerly admitted bearer readback.

Decision: an idempotent website client registration reads for existing coverage before inserting it; PostgreSQL's
`BEFORE INSERT` guard runs before `ON CONFLICT DO NOTHING`, so replaying an unchanged registration must not be
classified as a new client-coverage authority mutation.

The focused `apps/web/tests/accounts-api-capture.test.ts` regression pins exact denial codes, overload uncertainty,
sibling continuation, seed-independent runtime admission and secret redaction. The API capture, native acceptance,
browser evidence and whole Goal stages remain separate.

[Guarded recovery](../../services/auth/README.md#guarded-human-recovery),
[trusted account effects](../../services/auth/README.md#trusted-account-effects),
[website endpoints](../../services/auth/README.md#endpoints) and
[source diagnostics](../../services/auth/README.md#source-diagnostic-emission) retain native behaviour and authority.
The [seeded-walk owner](../development/local-stack.md#seeded-journey-walks) retains runtime startup and seed custody.
Collect all three results before briefing one causal repair batch: capture owns setup ordering, the runtime owner
owns startup, and Auth/Access own demonstrated service defects. Read-only reference research supplies no replacement
Auth implementation or permission exception.

Focused fixtures, source integration and preflight records do not complete these API journeys. Actual API capture,
original browser receiving, whole Auth acceptance and whole-Goal completion remain distinct evidence stages.

### Original journey census

Decision: retain all nineteen original outcomes and assertions. Receive Auth catalogue/lifetime producers `31f519929c` and `9fc8c4745a`, boot receipt binding `e18772206f`, the complete selector producer at integrated `1cfb9ccec1cbf3afb5032dbca273cef0d4e1083f`, and the paid root composition from `64fd7d5011`. The selector formatting tip requires its integrated selection implementation; receive that coherent producer delta rather than the formatting hunk alone. The root delta moves the existing Recent Search binding around shell and outlet inside the real Library boundary, retaining one actual QueryClient/session host. Preserve the original driver, exact fixture-owned server selection and Bun leader/adopted-descendant custody. Under the authenticated final-typing decision, worker completion uses changed-workspace Web typing only; unchanged ten-file fixtures, Auth thirty-case acceptance and original nineteen native/browser/growth journeys remain dev verification. No money paths changed. Complete receiving evidence and the accepted reference union remain in `.temp/continuation/accounts-walk-receiving.md`.

Completed check `b45c3404-50ba-4903-8400-a5b77b6f3b27`, submitted 2026-11-07T13:47:17.747Z on `21217b31231741818fb70fe17892dcb25002b030`, exited 1. The full log records 76 passing and seven failing fixture cases: placement 19/3, placement custody 6/0, focused runner scripts 5/1, message preparation 8/1, Storybook startup 7/0, journey table 7/0, focused-runner tests 6/1, root shell 0/1, custody 14/0 and wrapper 4/0. Web typing passed (workspace 59.63s; batch 67.41s). Placement fixture assumptions, incomplete generator fixture, generator-group cancellation, wrapper expectation and root router-context/browser-global setup remain causal owner repairs; exact diagnostics and original assertions are retained in the continuation. These results precede the newly received producers and establish no runtime recovery. The owner supersedes another unchanged broad worker run with final Web typing. Latest actual ordinary evidence remains 12/19 API-stage passes on `70f7c7e9c7fc6ff08025044be46763221763f9d3`; Chromium was unlaunched, pages empty, and full native/browser/growth and promotion acceptance remain open.

Final changed-workspace typing: `bun scripts/worker-check.ts -- bun run --cwd apps/web typecheck`, check `f5d5d36d-1918-4eb8-a66c-74835e8ff7ff`, submitted 2026-11-07T13:59:35.061Z on `b03080178076580b26d594e2878528956276f566`, passed with exit0 (Web102.27s; batch111.42s). The retained custody implementation already satisfies the final owner decision: Bun alone owns leader status; both adopted-child reapers exclude that leader; interrupted143, nonzero exit7 after settled close and original descendant/group-absence assertions remain. No new code or test is needed for that repeated request. Original Auth, boot, selector/root fixtures and native/browser/growth verification remain dev obligations with unchanged assertions; their exact commands and causal repairs are in the continuation. This typing pass supplies no additional journey, browser or promotion pass.

This is the single Accounts Goal environment walk. Source or typecheck presence is not a pass. Each row records the latest walked revision: PASS or FAIL, the reached page or HTTP operation, evidence, elapsed time, first cause and repair owner. A startup or precondition failure marks dependent rows FAIL with that exact cause and a not-reached qualification; independent paths continue. A walk that ends before every row is observed marks remaining rows FAIL with that ending cause. Producer repairs stay with Auth c883, Identity 4ff, Preferences 4776, Authority 89 and SDK e18 where those owners apply. Desktop 1280 and phone 390 are inspected on mounted pages. Strict money authority is unused. Named receive revisions `4a0921248bc`, `cf806226bbc` and `013c1ee6cb` are on this walk base.

Decision: the walk launcher (`bun apps/web/scripts/accounts-goal-walk.ts --launch`) records pre-driver admission failures with their exact first diagnostic, no seeded persona and the causal repair owner (Performance for shared admission, Content for stack startup); the existing table/round-trip check and one EACCES regression pin this concrete failure. Native/browser inspection remains unexecuted when admission fails. Publish this table before stack startup; the walk driver `apps/web/scripts/accounts-goal-walk.ts` fills PASS/FAIL from actual Auth/Access on one admitted walk stack. Fewest checks: the table-shape test plus this walk. An interrupted walk marks leftover unobserved rows FAIL with that ending cause. Census refresh locates the dated census line (`Round` plus an ISO timestamp) by the table-shape marker so a slowest-cause period cannot abort remaining rows. J10 revokes the website refresh family through native transport of issuer `/revoke` (same as `/token`); first-party standing consent is not POST /consent. J03 reads the supported private recovery delivery in `.temp/local-stack/recovery` after HTTP start. Its actual Auth producer must be integrated before recovery execution can pass; the walk does not supply a token or replace that capability. J15 creates a protected Realm and the owner adds the member through `POST /v1/realms/{id}/members`. J18 sends typed confirmation only on execute and omits a top-level management `accountId`. Account operations wait 30s. J13/J14 wait for the public agent Subject after signup. Native and browser evidence stay under `.temp/accounts/` and do not promote. Walk `dev-stack.ts walk` on the worker host so `GOAL_ACCEPTANCE_REQUIRES` is not stripped; do not wrap that command in worker-check. A website-bearer Kernel 401 `invalid_credentials` is a walk precondition: dependent Kernel journeys inherit that cause as not-reached; Auth-only journeys and anonymous public reads continue. Auth issuer/JWKS startup stays with Accounts ce33. Walks consume ce33 canonical `AUTH_ISSUER`/`AUTH_JWKS_URL` same-origin transport; no loopback JWKS exception. J04 uses the registered management client with only `account:manage` as the fresh same-subject step-up; `login` stays empty-scoped. The landing pair `accounts-goal-journeys.test.ts` plus `with-dev-server.test.ts` does not boot Storybook. Hourly refresh receives integrated dev, including Access `3373d3c042` and Search `c563d24620`; ordinary admitted stacks retain the real Kernel worker/relay and the journey driver starts the deferred Auth/Web frontends after native work. Shared lease provisioning belongs to the existing Performance repair. Walk Web uses `dev-stack.ts web` without a heap override. Fewest checks remain the table-shape test plus this walk. Retry decision: reuse the existing admission regression and both required landing test selections; no additional test is needed for the same concrete EACCES input. The current ordinary launch fails before persona creation; the latest dated round gives the actual error, while earlier EACCES evidence is historical. Receive Members construction range `1596f1255501123cbce52114f3f39d2c4229e67c` → `863e5266e3ec973617a5c97e7f0d202817b36ff6` and syntax-based workspace import selection under the original acceptance. Receive Account discovery recovery `034b1fd17cddd0cd642f92e60c08a34130ee3ad7`: same failed home, bounded 1–60 second retries, fresh durable/current authority and safe diagnostics. Empty passes cost eight statements per home (32,768 per 4096 homes); idle costs zero queries. Admission, bootstrap, Auth readiness and source fences retain independent causes. This source receive establishes no journey pass; original Pool/current authority, default worker, Library presentation/preparation, immutable replay and growth obligations remain. Auth startup/database admission stays with its existing urgent producer outcome; see `.temp/continuation/accounts-walk-receiving.md`. Round 2026-11-07T13:45:54Z on `70f7c7e9c7fc6ff08025044be46763221763f9d3` with `REZICS_WALK_DEFER_FRONTENDS=0`: 12/19 PASS (J01, J02, J05, J06, J07, J08, J09, J11, J12, J17, J18, J19). Slowest FAIL J13 32579ms follow target omitted a public agent subject. Next hourly due 2026-11-07T14:20:56Z. Causal repairs: `.temp/continuation/accounts-walk-admission.md`, `auth-website-kernel-bearer.md`, `auth-recovery-and-credentials.md`, `accounts-operations-e18.md`, `accounts-follow.md`, `accounts-walk-browser.md`, `accounts-realm.md`. The table-shape check does not start Storybook. Follow writes the public agent Subject with no body.

Decision: retain every original persona, native/API outcome, current-authority, replay, lifecycle, receiving and growth assertion. Reuse the existing six journey and four server-selection checks, the required Auth selection and final Web workspace typing; no replacement acceptance or screenshots. Auth owns the transferred recovery-delivery helper and its one configuration assertion; only those exact hunks are removed from this walk. The historical scope-correction candidate received async message readiness from `016cc7320e6e0b7ab0690e6f1e7fa3bbb1e12f05`, but still contained the old sequence rename writer. The last executed census below remains historical, not a new observation on this candidate. Receive the integrated allocator, allocated-port/Auth startup and discovery fixture repairs on this sole handle before the next ordinary launch. Complete folded briefs, reference union, first safe operations, retained artifacts and missing evidence are in `.temp/continuation/accounts-walk-receiving.md`. Post-correction check `e2e62721-c664-46c1-85d9-d6318cd60ed5` on `069969f4fcfdf5604609cfb4aec6adb799bce4ff`: Web typing passed; focused journey/server selection passed 10/10. The independent Auth selection returned 28 pass/2 fail: database-bound import without DATABASE_URL (1334.36ms), and fixed-port database admission at 127.0.0.1:54329 already allocated (12824.25ms), before persona creation. Existing Auth fixture ownership retains both repairs. No affected-admission rerun before actual allocator/Auth integration, per the current owner decision. Focused rerun `df0d7bbb-8f48-4649-b454-511876eb26b1` on `03fa1b9834aa09d571df7178e48e9691fb32942f` retained 6/6 journey passes but exposed `ECHILD: unknown error, waitpid` in wrapper cancellation. Repair: runtime owns the spawned leader wait status; shared custody observes the leader without reaping it and still reaps recorded adopted descendants. Additional paths are `apps/web/tests/support/server-custody.ts` and `apps/web/tests/server-custody.test.ts`. Preserve the cancellation assertion and add one exit-status regression. Only the explicit server-custody unit selector joins the server exemption; mixed page selections still require the server. Verify the changed helper and all original focused assertions together; this does not retry native Auth admission. Check `6f14a816-e641-40d9-adf1-bcfe1913ea8b` then passed Web typing and all ten journey/wrapper tests; custody retained 13 passes and exposed one early-settlement failure (process group still present). Custody now waits for Bun’s actual exit promise rather than treating a `/proc` zombie as completed. The original group-absence and adopted-descendant assertions remain unchanged. Dependency receive `452da6ea5f43e26967726283ed2fec7c04d3e8ca` is reviewed source pending controller integration; it establishes no walk or root-gate pass. Native, API, browser, growth, typing and promotion remain separate.

Decision: the current integrated candidate receives Auth `40c038b064c2c2f3ce230a5fc51f284aeda8ac58`, native fixture/authentication mapping `65d59008b401edcc06ff12cfd56231d82cebe4b9`, and allocator `6948a89278c0383165a7ed4ca69f1c99506c74a2` through its base. The earlier missing-database, fixed-port and atomic-rename observations describe older sources. Resume the original nineteen paths and original thirty-case Auth selection on this candidate. Preserve the custody regression and assert exit status 7 again after settled close; this single added assertion pins runtime ownership without replacing cancellation, descendant, authority, replay, lifecycle or growth assertions. No screenshots. Final typing and the named three-file focused selection remain separate from native/browser and promotion. The prior pending check `834fda99-a135-4977-93d3-64c214cd6614` has no delivered result or retained log in this retry and is not counted as passing.

Current ordinary round on `70f7c7e9c7fc6ff08025044be46763221763f9d3` completed supported teardown at2026-11-07T13:45:54Z with exit0:12/19 API-stage passes,7 failures. Actual Auth/Access, selected ports and real Kernel worker/relay were reached. Native observation began2026-11-07T13:27:02.282Z; shared admission succeeded in1134ms. Slowest FAIL J13,32579ms, public agent subject omitted. J03 recovery503, J04 credential sequence403, J10 revoke400, J13/J14 public Subject omission and J15 protected member404 retain their existing repair owners; J16 was not reached. Auth pages and Web generation became ready, then root SSR failed with `Recent Search requires a mounted host` through `useRecentSearchOperation` → `useRecentHistory` → `ShellSearch`. The received Library exception did not recur in this trace, but Web never became ready within ten minutes. Chromium was not launched; pages=[], desktop1280/phone390 controls and hydration uninspected. No screenshots. Broader original send-time eligibility, consumer erasure, replay and growth obligations remain unexecuted where the retained packets require them. Safe evidence is archived under `.temp/accounts/rounds/70f7c7e9c7fc6ff08025044be46763221763f9d3/`; the preceding source archive is retained separately. Authoritative next hourly due2026-11-07T14:20:56Z belongs to this launcher; provisional inner14:44:06Z is not another schedule. Causal complete-outcome briefs remain in `.temp/continuation/accounts-walk-receiving.md` and companions. Native/API, browser, growth, typing and promotion remain separate.

| ID  | Journey                                                                                                 | Result | Reached                                                                      | Revision                                 | Observed (UTC)           | Elapsed | First cause                                                                                                                                                                                                                                          | Repair owner     | Persona                                                                                                    | Evidence                         |
| --- | ------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- | ---------------------------------------- | ------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------- |
| J01 | signup → callback → authenticated Home                                                                  | PASS   | POST /signup → GET /authorize → GET /auth/callback → GET /en/                | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:27:04.461Z | 1870ms  | signup j019617edb754; callback /auth/callback                                                                                                                                                                                                        | Auth c883        | j019617edb754 (b1c6dc15-12e5-81f6-a8b0-b98997b37f40), account b1c6dc15-12e5-81f6-a8b0-b98997b37f40         | .temp/accounts/journeys.json#J01 |
| J02 | sign in → refresh/session review → sign out                                                             | PASS   | POST /signin → GET /sessions → POST /sessions/revoke                         | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:27:04.577Z | 115ms   | revoked FYl2rntdketQgeI3IGZs4bRJZujyPUlO                                                                                                                                                                                                             | Auth c883        | account b1c6dc15-12e5-81f6-a8b0-b98997b37f40                                                               | .temp/accounts/journeys.json#J02 |
| J03 | recover access → sign in → old credential/session loses authority                                       | FAIL   | POST /recovery/start → POST /recovery/complete → POST /signin                | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:27:06.554Z | 1976ms  | recovery complete returned HTTP 503: {"error":"authentication_denied"}                                                                                                                                                                               | Auth c883        | j039d76a3af7a (416f2240-850c-8cc3-adbb-3f3c150f7eca), account 416f2240-850c-8cc3-adbb-3f3c150f7eca         | .temp/accounts/journeys.json#J03 |
| J04 | security → fresh step-up → manage and revoke credentials/tokens                                         | FAIL   | POST /credential-effects → GET /sessions → POST /sessions/revoke             | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:27:08.947Z | 2392ms  | credential effect HTTP 403: {"error":"credential_effect_denied","effect_status":"not_applied"}                                                                                                                                                       | Auth c883        | j04532beb6154 (adba91cb-e80f-831f-aee1-ce2b1e918f1d), account adba91cb-e80f-831f-aee1-ce2b1e918f1d         | .temp/accounts/journeys.json#J04 |
| J05 | own profile → edit/save → independent public readback                                                   | PASS   | PATCH /v1/accounts/{id} → GET /v1/accounts?handle=                           | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:27:09.149Z | 199ms   | independent handle readback matched                                                                                                                                                                                                                  | Identity 4ff     | account b1c6dc15-12e5-81f6-a8b0-b98997b37f40                                                               | .temp/accounts/journeys.json#J05 |
| J06 | accounts → create organization → manage memberships/roles                                               | PASS   | POST /account-operations organization → membership                           | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:27:20.304Z | 11154ms | organization org864aca9b17                                                                                                                                                                                                                           | Accounts         | dsta923ef652d (6ba786e1-f5f3-89c0-a721-9c60f1d136d6), outd7ca4cd06f (084bc156-bffe-8771-9859-f747fda092d0) | .temp/accounts/journeys.json#J06 |
| J07 | managed organization → transfer control → new owner manages it                                          | PASS   | POST /account-operations membership role=owner → management read             | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:27:21.848Z | 1543ms  | dest owner role owner                                                                                                                                                                                                                                | Accounts         | account 6ba786e1-f5f3-89c0-a721-9c60f1d136d6                                                               | .temp/accounts/journeys.json#J07 |
| J08 | managed account → rename → new address works/old address retires                                        | PASS   | POST /account-operations rename → GET /v1/accounts?handle=                   | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:27:24.934Z | 3085ms  | renamed to ren2453da629b                                                                                                                                                                                                                             | Accounts         | j08e81f3c6e07 (4fe607cf-c44b-8bba-b2da-15e841876853), account 4fe607cf-c44b-8bba-b2da-15e841876853         | .temp/accounts/journeys.json#J08 |
| J09 | accounts → create software agent → operator/delegated caller uses held permissions                      | PASS   | POST /account-operations automated → POST /operator-sessions/open            | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:27:26.930Z | 1995ms  | software 070e4a30-9bf9-81d7-9b54-496ecc61075f; outsider open HTTP 403                                                                                                                                                                                | Accounts         | account 084bc156-bffe-8771-9859-f747fda092d0                                                               | .temp/accounts/journeys.json#J09 |
| J10 | consent → grant requested authority → revoke → next operation reflects it                               | FAIL   | GET /authorize grant → POST /revoke → GET /v1/accounts/{id}/profile          | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:27:27.143Z | 212ms   | website revoke returned HTTP 400: {"error":"invalid_request"}                                                                                                                                                                                        | Auth c883        | account b1c6dc15-12e5-81f6-a8b0-b98997b37f40                                                               | .temp/accounts/journeys.json#J10 |
| J11 | account verification → verify/unverify address → independent publication readback                       | PASS   | POST /v1/accounts/{id}:requestVerification → POST :withdrawVerification      | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:27:27.413Z | 269ms   | requested then withdrawn; public b1c6dc15-12e5-81f6-a8b0-b98997b37f40                                                                                                                                                                                | Identity 4ff     | account b1c6dc15-12e5-81f6-a8b0-b98997b37f40                                                               | .temp/accounts/journeys.json#J11 |
| J12 | public person/organization/agent page → identity without private data                                   | PASS   | GET /v1/accounts?handle= person/organization/agent                           | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:27:27.419Z | 5ms     | person, organization and agent omit private fields                                                                                                                                                                                                   | Identity 4ff     | anonymous public reader                                                                                    | .temp/accounts/journeys.json#J12 |
| J13 | public eligible target → follow → Following → unfollow, including stored unavailable target             | FAIL   | PUT /v1/follows/{id} → GET /v1/follows → DELETE /v1/follows/{id}             | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:27:59.998Z | 32579ms | follow target omitted a public agent subject                                                                                                                                                                                                         | Accounts         | j13b726c09e424 (6291a6c9-48b9-8129-b7b8-9fb3181c5078), account b1c6dc15-12e5-81f6-a8b0-b98997b37f40        | .temp/accounts/journeys.json#J13 |
| J14 | own follow counts → current count; unrelated reader lacks the private aggregate                         | FAIL   | GET /v1/followCounts/outgoing → stranger GET /v1/followCounts/{type}/{id}    | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:28:30.527Z | 30528ms | count target omitted a public agent subject                                                                                                                                                                                                          | Accounts         | account b1c6dc15-12e5-81f6-a8b0-b98997b37f40, account 084bc156-bffe-8771-9859-f747fda092d0                 | .temp/accounts/journeys.json#J14 |
| J15 | Realm/Space → join → protected read → leave → next read reflects authority                              | FAIL   | POST /v1/spaces → POST /v1/realms → POST /v1/realms/{id}/membership → DELETE | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:29:01.167Z | 30633ms | protected member read returned HTTP 404: {"type":"https://rezics.com/problems/not_found","title":"Not Found","status":404,"code":"not_found","retryable":false,"effect_status":"not_applicable","request_id":"01a1b632-bced-76a7-95f5-1fac1b7aa07b"} | Authority 89     | account 6ba786e1-f5f3-89c0-a721-9c60f1d136d6                                                               | .temp/accounts/journeys.json#J15 |
| J16 | membership management → ban/revoke → affected reads change before cleanup; authorized readmission works | FAIL   | not reached: J15 realm                                                       | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:29:01.169Z | 0ms     | protected member read returned HTTP 404: {"type":"https://rezics.com/problems/not_found","title":"Not Found","status":404,"code":"not_found","retryable":false,"effect_status":"not_applicable","request_id":"01a1b632-bced-76a7-95f5-1fac1b7aa07b"} | Authority 89     | not reached: no persona used                                                                               | .temp/accounts/journeys.json#J16 |
| J17 | Settings → per-kind preference save/reopen → actual notice send-time eligibility                        | PASS   | PATCH /v1/accounts/{id}/preferences → GET reopen                             | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:29:01.813Z | 643ms   | reply disabled at reopen; stranger denied                                                                                                                                                                                                            | Preferences 4776 | account b1c6dc15-12e5-81f6-a8b0-b98997b37f40, account 084bc156-bffe-8771-9859-f747fda092d0                 | .temp/accounts/journeys.json#J17 |
| J18 | delete account → fresh confirmation → terminal erasure and retained attribution across consumers        | PASS   | POST /account-operations delete → GET /v1/accounts/{id}                      | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:29:10.973Z | 9159ms  | erased de0d5f6c-4185-8b9a-ad70-e969cb3dbaf1; attribution HTTP 200                                                                                                                                                                                    | Accounts         | j1870e3627df1 (de0d5f6c-4185-8b9a-ad70-e969cb3dbaf1), account de0d5f6c-4185-8b9a-ad70-e969cb3dbaf1         | .temp/accounts/journeys.json#J18 |
| J19 | operator grants → open/revoke product capability → viewer operation discovery and actual access agree   | PASS   | POST /v1/platform/exposure/{group}:open/:close → POST /v1/viewerActions      | 70f7c7e9c7fc6ff08025044be46763221763f9d3 | 2026-11-07T13:29:11.329Z | 354ms   | open access HTTP 200; closed HTTP 403                                                                                                                                                                                                                | Authority 89     | account b1c6dc15-12e5-81f6-a8b0-b98997b37f40                                                               | .temp/accounts/journeys.json#J19 |

Every capability uses the `privacy` fixture contract from `docs/research/api-acceptance-gaps.md`, produced by accounts and each participating producer. It includes a bearer held from before suspension, suspended sign-in, revoked token, unscoped actor and delegated agent. Fixture identities are created by native test support in `services/kernel/test/support/personas.ts`.

## authentication

**User job:** A person or API consumer registers, signs in, maintains a session, recovers access, completes step-up and signs out through real Auth and kernel bearer checks.

**Personas:** Anonymous visitor; active human; automated actor; organization; expired token; revoked token; fenced account (401); suspended account, whose pre-suspension bearer answers every route with HTTP 401, JSON problem code `invalid_credentials` and `WWW-Authenticate: Bearer error="invalid_token"`; correct-password sign-in answers 403 `ACCOUNT_SUSPENDED` and issues no session, cookie or token, while wrong-password sign-in answers as for an active account. The kernel's 403 `account_suspended` is only a defensive branch for a verified bearer of a suspended, unfenced account, reached only by `services/kernel/test/access/suspended-bearer.test.ts`, and is not a persona.

**Implementation choice:** Auth's zero-scope `login` client establishes identity; the configured website client owns requested-scope consent, and Web returns through its registered callback to the bounded destination. Signup requirements and viewer advice load after mount through Auth's same-origin POST BFF. A sign-in without a confirmed response remains unknown, clears the password and requires deliberate current-session review without replay.

**Released fixture data:** `privacy` (accounts produces personas and account states); no catalogue release is needed.

**Surface cells:** Authentication is a shared bearer check, not a list abstraction.

| Cell                       | Acceptance                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue`                | Shared bearer checks in `services/kernel/test/access/` and `services/auth/test/`; catalogue does not add an authentication-specific list surface. |
| `curated`                  | Shared bearer checks in `services/kernel/test/access/` and `services/auth/test/`; curated resources use the same check.                           |
| `Everything without state` | Shared bearer checks in `services/kernel/test/access/` and `services/auth/test/`; no distinct authentication list.                                |
| `own state`                | Shared bearer checks in `services/kernel/test/access/` and `services/auth/test/`; own-state routes use the same check.                            |
| `mounted Zone`             | Shared bearer checks in `services/kernel/test/access/` and `services/auth/test/`; Zone does not define a separate bearer.                         |
| `TypeList`                 | Shared bearer checks in `services/kernel/test/access/` and `services/auth/test/`; no distinct authentication list.                                |

**Frozen scenarios:** Existing: “person registration claims pending handle and authenticates the same immutable account through Better Auth” and “Access commits epoch fence and durable receipt before Auth revokes sessions and stale recovery cannot undo it” (`specs/account-lifecycle-outcomes.test.ts`; native binding: `services/kernel/test/access/account-lifecycle-outcome.test.ts`). Existing: “a person opens a session only with its own credential” (`specs/account-lifecycle-outcomes.test.ts`; native binding: `services/kernel/test/access/account-lifecycle-outcome.test.ts`). `authentication-bearer-personas`: `services/kernel/test/access/suspended-sign-in.test.ts` covers sign-in refusal, the pre-suspension bearer and reinstatement; `services/kernel/test/access/suspended-bearer.test.ts` covers only the defensive branch.

**Native acceptance:** `sh -c 'bun run --cwd services/auth check test/workflows.test.ts && bun run --cwd services/kernel check test/access/account-lifecycle-outcome.test.ts test/access/session-revocation.test.ts test/access/suspension.test.ts test/access/suspended-sign-in.test.ts test/access/suspended-bearer.test.ts'`.

**Evidence limits:** Installed `apps/auth/tests/login.test.ts`, `signup.test.ts`, `recovery.test.ts` and
`step-up.test.ts` exercise mounted pages against fixture issuer HTTP responses. Web's
`apps/web/tests/session.test.ts` covers callback, renewal and sign-out against a fixture OpenID provider.
These separate fixtures do not establish one persisted native registration-to-Home journey, deployed challenge
or recovery delivery, native browser passkey qualification, or desktop/phone evidence of that integrated journey.
`createAuthDeployment` now binds the native host, required delivery/challenge ports, installed callback destinations
and page configuration. `services/auth/test/auth-page-operation-client.test.ts` covers its startup and persisted
client receiving; `website-client.test.ts` covers persisted destinations and refuses the retired callback. These
native checks still do not qualify the controller-held seeded/browser deployment.
Native composition releases DBOS on failed start, waits for that release before a later host launches, copies a once-migrated kernel template under the Auth check, installs Kernel History composition in native Auth fixtures after Reylo registers SQL modules, binds staged provisioning receipts to the locked reservation, terminals expired registration before erase-auth-owner, and runs the Taskfile's Bun commands when neither `go-task` nor `task` is present. Isolated Auth composition installs that History/event catalogue, binds a separate receipt ring on its Access `createPool`, reports original Access errors on the child stream, and cleans up independently; same-process registration still attaches the first actual step failure as `cause`. Focused receiving of registration close/relaunch, native consumer startup/cleanup and the official dev-stack invocation remains the execution evidence; these source repairs do not establish an integrated registration-to-Home completion.
Decision: keep the installed host-lifecycle tests and one first-actual-failure cause regression; isolated helper original-error reporting does not replace that cause or add protocol tests.
Decision: `AccountOperation.operationKey` lives on the shared contract so native bindings and the Auth host keep one port type; isolated hosts persist the workflow request; first actual step failures remain the registration cause. Kernel durable approvals match that host type on revoke and transfer-acceptance instead of intersecting the union again.
The subsequent internal service-factory move passed the architecture check against its landing base. Two
supported remote submissions lost their connection during Auth service typing. Only Auth Pages typing
completed on that revision; service typing and focused native tests have no completed result after the move.

**Lifecycle journey acceptance:** Not accepted. This landing typechecks the written managed-account lifecycle, including OAuth website composition `cdae0566525fbbd87398c5f23dcfc5f2e54bed05` and 433f320a native stack Commerce/Work imports after DATABASE_URL. Decision: `NativePermissionProjection` includes statement-level `live` because policy-core maps `PolicyFacts.deadlineLive` from it; `NATIVE_ERASURE_GROUPS` is invoked as a function. Unchanged assertions stay. Kernel typecheck repairs keep SearchService and PublicSearchPage assertions; duplicate fixture keys and helper stdout encoding are shape updates, not new behaviour tests. Web workers-types typecheck repairs keep those same assertions: duplicate reading/board keys preserve runtime values, ReceivedValue takes the full slot entry, protocol and problem JSON keep response shapes, and no new behaviour tests. Check `fe93067b-b74a-41fb-8f73-88d70dd89801` passed native-ready and developer-token, then organization creation returned HTTP503 `account_operation_denied`/`effect_status:not_applied` at `managed-accounts-seeded-walk.ts:556`. Native lifecycle, focused Auth creation/opening/membership/rename/transfer, and Web management fixtures remain as previously executed. The seeded multi-persona walk uses the stack host persona and public signup, talks to native Auth for HTTP, defers Vite until after native work, serves Kernel HTTP from that host, skips OpenSearch and the Kernel worker, and keeps one Chromium process; it does not run catalogue import or a second persona assemble. Checks 372c5fd6-82e7-4339-b7d8-b86a199f08b1, 9d3d14ee-1fc4-4a6b-b868-b73746a017ec, 40d48ab8-5c90-4290-9925-2e3287750d21 and ec795905-e787-417b-87fe-07d13e8e21b0 exceeded the 6 GiB run memory cap (import, duplicate assemble, Vite plus Chromium beside a second Kernel and OpenSearch).

## credential-session-consent

**User job:** Replace a password, enroll/name/remove a passkey, review and revoke sessions, and explicitly approve
or reduce connected-application scopes without attributing an uncertain response to a later session.

**Implementation choice:** Retain catalogue-derived session/client/consent inventory bounds and fixed Security,
enrollment and registration budgets. Passkey rename changes only the owned label and binds the reviewed account.
Human retirement retains a password or passkey; reviewed consent writes refuse concurrent grant changes.

**Native acceptance:** `bun run --cwd services/kernel check test/access/credential-effect-outcome.test.ts test/access/credential-effect-outcome-security.test.ts test/access/auth-session-capability.test.ts test/access/auth-credential-capability.test.ts test/access/auth-consent.test.ts`.
The Security adapter uses `createAuthHost`, issued clients, migrated isolated Auth/Kernel databases and the production
Kernel HTTP handler. It inspects persisted credentials, sessions and consent and exercises real bearer outcomes.
Auth response and page transport suites pin fixed RP receiving, exact acknowledgements and unknown sends.
Mounted `apps/auth/tests/security.test.ts`, `password-change-page.test.tsx` and `passkey-enrollment.test.ts`
exercise separate page fixtures. They do not connect a real browser review to the native persisted readback,
prove current-session replacement across Auth and Web, or supply desktop/phone evidence of that integrated cycle.
Deployment uses the same native catalogue for Security/session/client/consent bounds and the website ceiling;
installed password, passkey, session and consent command identities retain their existing native/page owners.
The latest supported run passed suspension, suspended sign-in, defensive bearer, consent and ordinary website
consent renewal cases. Session and credential capability fixtures bind the supported test receipt ring on the
command pool and supply `KERNEL_RECEIPT_KEYS` from worker composition when the environment has none. Focused
receiving of those suites is the execution evidence; they do not establish Security review/readback, current-session
replacement across Auth and Web, or desktop/phone qualification. Seeded browser and promoted evidence remain open.

## permission-formula

**User job:** An actor performs an operation only when actor grants, consented client scopes and principal grants all permit it, subject to the anonymous floor and explicit denials.

**Personas:** Anonymous; ordinary human; automated actor; organization; delegated actor and principal; suspended; revoked; callers independently missing each operand. A ban defeats any independent read grant.

**Released fixture data:** `privacy` (accounts and each producer); grant, consent, principal and ban fixtures are produced by native Auth/Access test support.

**Surface cells:**

| Cell                       | Acceptance                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue`                | `services/kernel/test/access/permission-outcome.test.ts` exercises the consumer formula.                                                                                                                                        |
| `curated`                  | `specs/viewer-actions-outcomes.test.ts` (native binding: `services/kernel/test/access/viewer-actions-outcomes.test.ts`) exercises Collection consumers; `services/kernel/test/access/permission-outcome.test.ts` covers Access. |
| `Everything without state` | `services/kernel/test/access/permission-outcome.test.ts` for consumer formula; no distinct Everything-specific formula.                                                                                                         |
| `own state`                | `services/kernel/test/access/permission-outcome.test.ts` for consumer formula; own state uses the same Access formula.                                                                                                          |
| `mounted Zone`             | `services/kernel/test/access/permission-outcome.test.ts` for consumer formula; Zone uses the same Access formula.                                                                                                               |
| `TypeList`                 | `services/kernel/test/access/permission-outcome.test.ts` for consumer formula; no TypeList-specific formula.                                                                                                                    |

**Frozen scenarios:** Existing: “actor grant AND consented scope AND principal grant permit the same action and resource”, “revoking only the actor grant denies”, “revoking only client consent denies an already authenticated request”, “revoking only the principal grant denies”, “active explicit denies override each account grant”, “without a principal actor grants and consent suffice”, “suspended and deleted actors fail closed” (`specs/permission-outcomes.test.ts`; native binding: `services/kernel/test/access/permission-outcome.test.ts`).

**Native acceptance:** `bun run --cwd services/kernel check test/access/permission-outcome.test.ts test/access/current-authority-permission.test.ts`.
The original matrix preserves its assertions and compares each product request against isolated worker composition on
the same native authority. The focused fixture covers actual publisher board roles and Auth consent, strict sale
restoration, ordinary grant/revoke, Realm membership join/leave, current Realm bans, anonymous floor, session
revocation and native membership work receipts. Source coverage alone claims neither an executed pass nor the
complete Commerce receiving journey or controller-owned browser release.

## platform-gates

**User job:** An operator exposes product operations through declared gates, grants and revocations, including public opening, without a separate flag service.

**Personas:** Anonymous; ordinary account; gate holder; delegated gate recipient; caller with `gate:<group>` or `gate:any`; caller before and after revocation; platform operator.

**Released fixture data:** `privacy` (accounts produces personas); exposure declarations are produced by the kernel route catalogue.

**Surface cells:** Gates apply to operation availability, not list membership.

| Cell                       | Acceptance                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue`                | `specs/platform-gates-outcomes.test.ts` (native binding: `services/kernel/test/access/gates/platform-gates-outcome.test.ts`) verifies route exposure and viewer-visible operations.             |
| `curated`                  | `specs/platform-gates-outcomes.test.ts` (native binding: `services/kernel/test/access/gates/platform-gates-outcome.test.ts`) verifies gated operation admission; no separate curated list rule. |
| `Everything without state` | `specs/platform-gates-outcomes.test.ts` (native binding: `services/kernel/test/access/gates/platform-gates-outcome.test.ts`) verifies shared gate admission; no separate Everything list rule.  |
| `own state`                | `specs/platform-gates-outcomes.test.ts` (native binding: `services/kernel/test/access/gates/platform-gates-outcome.test.ts`) verifies shared gate admission; no separate own-state list rule.   |
| `mounted Zone`             | `specs/platform-gates-outcomes.test.ts` (native binding: `services/kernel/test/access/gates/platform-gates-outcome.test.ts`) verifies shared gate admission; no separate Zone list rule.        |
| `TypeList`                 | `specs/platform-gates-outcomes.test.ts` (native binding: `services/kernel/test/access/gates/platform-gates-outcome.test.ts`) verifies shared gate admission; no separate TypeList list rule.    |

**Frozen scenarios:** Existing: “a route without a valid x-exposure is refused when the kernel is built”, “a closed operation answers the same 403 platform_closed to anonymous callers and ordinary accounts”, “a gated tester with the group's gate on the Global Context succeeds and loses it at revocation”, “platform staff holding gate any use every closed group and grant one gate to another account”, “opening a group in the exposure catalogue makes it public with no code change and closing it restores the denial” (`specs/platform-gates-outcomes.test.ts`; native binding: `services/kernel/test/access/gates/platform-gates-outcome.test.ts`).

**Native acceptance:** `bun run --cwd services/kernel check test/access/gates/platform-gates-outcome.test.ts`.

**Native evidence:** Installed declaration, gate/admission, ordinary grant/revoke and generated discovery suites
retain their original assertions. Global grant review additionally receives the native prepared Context owner,
its authoritative T and mounted gate delegation advice. The native composition regression in
`services/kernel/test/access/realm-claim.test.ts` covers fixed Global approval metadata, source denial mapping,
opaque source custody, atomic rollback, HTTP replay and ordinary Global gate grant/revoke readback.
A later Realm on an already-committed Space copies discovery-reference tuples into remove-work without binding
`producer_epoch` to the INSERT target. Architecture repair of Access/application boundaries keeps these tests
and adds no stories. Live grant authorization uses Community's public eligibility entry; no extra grant-read stories.

**Mounted evidence:** The session-bound operator page retains immutable open/close review and retry and links to
the existing ordinary Global grant screen. `apps/web/tests/platform-exposure.test.ts` covers that navigation and
withheld mutation advice with authored transport fixtures. These are not recorded native API/browser evidence.

**Promoted evidence:** Seeded persona exposure cycling, original native acceptance, recorded responses and mounted
desktop/phone review remain integration verification; no promoted execution is established by source presence.

## agent-identity

**User job:** A reader resolves one public page for a human, organization or software agent and follows a verified subject address to the active account handle.

**Personas:** Anonymous reader; human, organization and software agents; verified subject-address visitor; operator; outsider; active and hidden/private agent.

**Released fixture data:** `privacy` (accounts and semantic producer); account-agent identities and verified subjects are produced by accounts fixtures.

**Surface cells:**

| Cell                       | Acceptance                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue`                | `specs/agent-profile-outcomes.test.ts` (native binding: `services/kernel/test/access/agent-profile-outcomes.test.ts`) resolves public identities for people, organizations and software agents, including verified-subject canonical resolution and operator attribution. |
| `curated`                  | Not applicable: identity resolution does not enumerate curated Collection membership.                                                                                                                                                                                     |
| `Everything without state` | Not applicable: identity resolution does not enumerate Everything membership.                                                                                                                                                                                             |
| `own state`                | Not applicable: identity resolution is public identity, not personal state.                                                                                                                                                                                               |
| `mounted Zone`             | The same native suite exercises Kernel page-address responses for verified subject addresses; it does not establish public website publication or browser qualification.                                                                                                  |
| `TypeList`                 | Not applicable: identity resolution does not enumerate a TypeList.                                                                                                                                                                                                        |

**Frozen scenarios:** Existing: “automated profile and attribution disclose operator while private data stays absent” (`specs/account-lifecycle-outcomes.test.ts`; native binding: `services/kernel/test/access/account-lifecycle-outcome.test.ts`) and the complete `specs/agent-profile-outcomes.test.ts` suite installed by `services/kernel/test/access/agent-profile-outcomes.test.ts`. Named assertions cover correctly typed public identities for person, organization and software agent (no Person fallback), software operator attribution, verified-person subject redirect while active and subject page while suspended, operator-only account:manage editing, outsider/private-field concealment, and public collections/posts visibility controls. This is source coverage, not website publication or browser qualification.

**Native acceptance:** `bun run --cwd services/kernel check test/access/account-lifecycle-outcome.test.ts test/access/account-agent-effect.test.ts test/presentation/agent-page-address.test.ts test/access/agent-profile-outcomes.test.ts`.

**Fixture composition:** the canonical-target and agent-page-address fixtures register human actors through the
lifecycle registration commands and run the work executor in a child process with its own executor identity. The
parent registers Work queues on a dedicated WorkClient and never calls `composeWork` or `setConfig`, so it cannot
hold the system-database lease or share the command pool with DBOS. Publication-waiting cases in those suites run
serially. Organization and operated-actor page
fixtures retain explicit starting rows. Direct publication fixtures join the live identity executor's original SDK
workflow after approval (enqueue only when that effect has not admitted it) and do not duplicate record-pending,
associate, merge or page write beside it. Each success stage of that workflow publishes the original job, then the
fixture reads independently; a pending original is not success. Bootstrap-governance tests that share one Global
installation run serially. The delivered producer
supplies account-source mapping, eight-axis original-source receiving and same-pool Search receiving.
Native execution, mounted HTTP, browser and promoted evidence remain separate; source composition alone establishes none of them.
Fewest tests: the named native publication, recovery, follow, shared-history and bootstrap suites, plus
`test/access/account-identity-source-work.test.ts` for composed original-home/reversal costs; pins distinct work modules and Source path.
Decision: Client root exports `identityOperationLocation`/`identityOperationId` and additive `operationAt` HTTP 202 Location admission; Web/Semantic own reviewed-Person polling. Accounts adds no extra fixture, writer or credential rule. Source getter names `ACCOUNT_IDENTITY_ORIGINAL_SOURCE_DECLARATION` and `ACCOUNT_IDENTITY_REVERSAL_SETTLEMENT_DECLARATION` alias the same reader and settlementFor bodies.

**Native acceptance retained:** `bun run --cwd services/kernel check test/access/account-canonical-targets.test.ts
test/presentation/agent-page-address.test.ts test/access/account-agent-effect.test.ts
test/access/agent-profile-outcomes.test.ts test/access/agent-identity-recovery-retention.test.ts
test/access/account-profile-http.test.ts test/library/follow-counts-outcomes.test.ts
test/access/shared-history-context.test.ts test/access/shared-history-context-prepaid.test.ts
test/access/shared-history-context-prepaid-foreign.test.ts test/access/shared-history-context-prepaid-command.test.ts
test/access/shared-history-context-delivery.test.ts
test/access/bootstrap-governance.test.ts test/access/bootstrap-governance-contract.test.ts
test/access/bootstrap-governance-diagnostics.test.ts`.

## self-profile

**User job:** An account updates its public profile fields and public views over HTTP while other readers see only the fields allowed by those views.

**Personas:** Alice (owner), Bob (reader), anonymous reader, unscoped caller, revoked caller, delegated editor; verification and preferences use their separate authority.

**Released fixture data:** `privacy` (accounts produces personas and privacy controls); no catalogue release is needed.

**Surface cells:**

| Cell                       | Acceptance                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue`                | `services/kernel/test/access/account-profile-http.test.ts` covers a native PATCH and public handle read, including public-view changes. |
| `curated`                  | Not applicable: profile mutation and disclosure are account operations, not curated membership.                                         |
| `Everything without state` | Not applicable: profile fields do not change Everything membership.                                                                     |
| `own state`                | `services/kernel/test/access/account-profile-http.test.ts` covers native profile update and owner-visible resulting state.              |
| `mounted Zone`             | Not applicable: profile edits are not Zone mounted-list operations.                                                                     |
| `TypeList`                 | Not applicable: profile edits do not affect TypeList membership.                                                                        |

**Frozen scenarios:** Existing: “actors and organizations default to all public views and can independently turn each off and on” and “invalid view patches and other accounts cannot change presentation fields” (`services/kernel/test/access/account-public-views.test.ts`); “profile patch sets and clears links, refuses invalid links and preserves the previous value on refusal” (`services/kernel/test/access/account-profile-read.test.ts`). Native `services/kernel/test/access/account-profile-http.test.ts` scenarios cover one PATCH and public handle read; omitted fields and null clearing; automated operator authority and consent; organization-only `speakersListed`; completed avatar ownership; boundary/invalid input without partial change; idempotent replay; display-name events; served OpenAPI/generated-client operation; and bounded growth. The complete agent-profile wrapper imports its frozen suite covering all agent kinds, verified-subject resolution, operator attribution, private-field concealment and public-view control. Profile update remains per-field merge-patch with stable replay; verification and preferences retain their own commands. Source presence establishes implemented coverage, not execution or promotion.

**Native acceptance:** `bun run --cwd services/kernel check test/access/account-public-views.test.ts test/access/account-profile-read.test.ts test/access/account-profile-http.test.ts test/access/agent-profile-outcomes.test.ts`.

**Executed Web consumer check:** `bun apps/web/scripts/focused.ts --private-network -- bun test tests/accounts-profile-editor.test.ts tests/managed-profile-confirmation-presentation.test.tsx tests/upload-stream-lifetime.test.ts tests/editable-profile-source.test.ts tests/upload-memory.test.ts` — 23 passed.
These regressions cover delegated viewer/target binding, exact retry-key encoding, visible acknowledgement after
failed readback, retained bytes after unknown avatar completion, input-error provenance, rejected-storage cleanup
and bounded streaming. A matching GET does not acknowledge an unknown command. Seeded native and mounted browser
acceptance remain deferred to integration; this consumer check does not establish their acceptance.

## follow-owner-counts

**User job:** A person follows an eligible subject, agent, Space or Collection and sees only their own outgoing count or the incoming count they own.

**Personas:** Follower; target owner; stranger; anonymous; suspended; delegated Space manager; revoked Collection manager.

**Released fixture data:** `privacy` (accounts and each target producer); explicit follow edges and target ownership are produced by native accounts/commerce/content fixtures.

**Surface cells:**

| Cell                       | Acceptance                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue`                | `specs/follow-counts-outcomes.test.ts` (native binding: `services/kernel/test/library/follow-counts-outcomes.test.ts`) covers subject counts.                   |
| `curated`                  | `specs/follow-counts-outcomes.test.ts` (native binding: `services/kernel/test/library/follow-counts-outcomes.test.ts`) covers Collection counts and management. |
| `Everything without state` | Not applicable: counts are never listed, sorted or filtered on.                                                                                                 |
| `own state`                | Not applicable: counts are never listed, sorted or filtered on.                                                                                                 |
| `mounted Zone`             | Not applicable: counts are never listed, sorted or filtered on.                                                                                                 |
| `TypeList`                 | Not applicable: counts are never listed, sorted or filtered on.                                                                                                 |

**Frozen scenarios:** Existing: “follower counts are visible only through existing target management authority and outgoing follows only to their follower”, “Space management uses its installed role through native Access”, “revoked Collection management and ordinary unowned subjects conceal follower counts”, “anonymous suspended no-scope and closed gate requests fail closed without disclosing counts”, “follow unfollow receipt replay and duplicate projection effects preserve a single source edge” (`specs/follow-counts-outcomes.test.ts`; native binding: `services/kernel/test/library/follow-counts-outcomes.test.ts`).

**Native acceptance:** `bun run --cwd services/kernel check test/library/follow-counts-outcomes.test.ts`.

## advertised-actions

**User job:** A client discovers exactly the operations the current Access grants permit and executes them only while those grants remain valid.

**Personas:** Curator; delegated editor who is not curator; anonymous reader; suspended account; caller with independently revoked actor grant, principal grant or client consent.

**Released fixture data:** `privacy` (accounts and participating resource producers); Collection, Realm, Space and subject resources are produced by their owning fixtures.

**Surface cells:**

| Cell                       | Acceptance                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue`                | `specs/viewer-actions-surfaces-outcomes.test.ts` with binding `services/kernel/test/access/viewer-actions-surfaces-outcomes.test.ts`, for catalogue subject actions. |
| `curated`                  | `specs/viewer-actions-outcomes.test.ts` (native binding: `services/kernel/test/access/viewer-actions-outcomes.test.ts`) covers Collection detail and list rows.      |
| `Everything without state` | Not applicable: Everything discovery does not advertise per-resource mutations.                                                                                      |
| `own state`                | Not applicable: own-state list rows are not viewer-action discovery resources.                                                                                       |
| `mounted Zone`             | Not applicable: Zone membership is not an advertised-action resource cell.                                                                                           |
| `TypeList`                 | `specs/viewer-actions-surfaces-outcomes.test.ts` with binding `services/kernel/test/access/viewer-actions-surfaces-outcomes.test.ts`, for TypeList rows.             |

**Frozen scenarios:** Existing: “a delegated editor who is not the curator is offered the same operations”, “the same editor after the grant is revoked is offered nothing on the next read with the same bearer and the edit is refused”, “an assigned actor whose principal lacks the action or is suspended or whose assignment was revoked is offered nothing for it”, “a visible resource with no allowed action answers an empty list while a failing dependency answers 503 with no partial positives” (`specs/viewer-actions-outcomes.test.ts`; native binding: `services/kernel/test/access/viewer-actions-outcomes.test.ts`). The catalogue subject and TypeList row cases are bound natively by `services/kernel/test/access/viewer-actions-surfaces-outcomes.test.ts` to the complete `specs/viewer-actions-surfaces-outcomes.test.ts`. Their independent subject, grant and history growth axes are covered by `services/kernel/test/access/growth-viewer-actions-surfaces.test.ts`. Realm and Space evidence remains outside this consumer slice.

**Native acceptance:** `bun run --cwd services/kernel check test/access/viewer-actions-outcomes.test.ts test/access/viewer-actions-surfaces-outcomes.test.ts test/access/growth-viewer-actions-surfaces.test.ts`.

## membership-and-ban-protection

**User job:** A member or banned person loses access to every protected read immediately when membership or ban authority changes, while bounded cleanup finishes.

**Personas:** Protected Realm member; banned member; manager attempting readmission; unrelated public reader; suspended or revoked caller.

**Released fixture data:** `privacy` (accounts and content producers); protected venue, membership and ban are produced by native content/Access fixtures.

**Surface cells:**

| Cell                       | Acceptance                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `catalogue`                | Not applicable: venue membership does not alter public catalogue reads.               |
| `curated`                  | Not applicable: venue membership does not alter curated Collection membership.        |
| `Everything without state` | Not applicable: protected venue reads are not Everything membership.                  |
| `own state`                | Not applicable: this capability protects venue reads, not personal-state enumeration. |
| `mounted Zone`             | Not applicable: venue membership does not create a Zone list rule.                    |
| `TypeList`                 | Not applicable: venue membership does not alter TypeList membership.                  |

**Frozen scenarios:** Existing: “a banned Realm member loses join and participate while unrelated reads keep their own answers” (`specs/viewer-actions-outcomes.test.ts`; native binding: `services/kernel/test/access/viewer-actions-outcomes.test.ts`). `specs/ban-precedence-outcomes.test.ts` (native binding: `services/kernel/test/access/ban-precedence-outcomes.test.ts`) covers direct, organization and delegated independent read grants, public-read comparison, unban restoration, concealed ban state and ordinary not_found/forbidden refusals. Integrated community coverage in `services/kernel/test/community/ban-protected-http.test.ts` includes “a protected ban hides ordinary member reads and denies both admissions before native removal settles”. With no independent read grant, it pauses the real worker after settled membership, commits the ban, proves membership remains present, checks concealed Realm/Board/thread/post/publication/list reads and Space discovery, and denies both self-join and manager-add without writes before cleanup. It resumes bounded durable cleanup and verifies persisted membership and membership-follow removal. Unban alone restores neither state nor protected reads; explicit readmission restores membership, follow and reads. Independent-grant and public-read controls remain separate scenarios. Source coverage does not establish acceptance of the seeded native and mounted-page journey; that acceptance remains assigned to the verifier.

**Native acceptance:** `bun run --cwd services/kernel check test/access/ban-precedence-outcomes.test.ts test/access/viewer-actions-outcomes.test.ts test/community/ban-protected-http.test.ts`.

**Native evidence:** The existing ban-precedence, viewer-actions and held-cleanup HTTP scenarios remain the native
acceptance boundary. Protected-ban fences, membership/follow cleanup and explicit readmission use their installed
writers. The owner-defined Realm model has member/self-leave, direct manager-add and separate ordinary resource
roles; unsupported roster removal or membership-role revision remains unavailable. Space follow is not membership.

**Mounted evidence:** Existing membership and ban controls consume their own native advice and retain immutable
uncertain intent. Operator tester grants reuse ordinary Global resource access. Consumer fixtures do not establish
held native cleanup, persisted-row readback or recorded desktop/phone execution.

**Promoted evidence:** Native deployment/readback and mounted persona journeys remain integration verification.
No new promotion claim follows from the receiving repairs or authored regressions.

## notification-preferences

**User job:** A person chooses per-kind notification preferences and receives content notices only when current send-time access permits delivery.

**Personas:** Recipient with enabled or disabled kind; sender; unrelated account; revoked or suspended participant.

**Released fixture data:** `privacy` (accounts and content producers); notification kinds and source content are produced by accounts/content fixtures.

**Surface cells:**

| Cell                       | Acceptance                                                                    |
| -------------------------- | ----------------------------------------------------------------------------- |
| `catalogue`                | Not applicable: preferences govern notice delivery, not catalogue membership. |
| `curated`                  | Not applicable: preferences govern notice delivery, not curated membership.   |
| `Everything without state` | Not applicable: notices are not an Everything list.                           |
| `own state`                | Not applicable: notice preference state is not a library own-state list.      |
| `mounted Zone`             | Not applicable: notices are not mounted Zone resources.                       |
| `TypeList`                 | Not applicable: notices are not TypeList resources.                           |

**Frozen scenarios:** Existing: “preferences return every optional notification kind as enabled until the account turns one off and no default is stored”, “notificationAllowed follows the recipient's setting for an optional kind”, and “another account cannot read or set notification preferences” (`services/kernel/test/access/notification-preferences.test.ts`). Existing: “a recipient who cannot read the post at send time, who turned the kind off, or who is deleted receives nothing” and “replayed events add no second notice” (`specs/content-notification-outcomes.test.ts`; native binding: `services/kernel/test/content/notification-outcomes.test.ts`, which sets `CONTENT_NOTIFICATION_DRIVER` and imports the unchanged complete suite). The driver makes Kernel HTTP requests; optional preferences use native GET/PATCH, while committed source events run through production content relays, Access and DBOS effects in the native effect host. Fixture helpers establish Realm membership and account state with database writes, including restored active state; this proves effect decisions against those established states, not native membership transitions, reversible deletion or terminal-erasure lifecycle completion. It does not supersede the terminal-erasure graph.

**Native acceptance:** `bun run --cwd services/kernel check test/access/notification-preferences.test.ts test/content/notification-outcomes.test.ts`.

**Implementation choice:** Governance provisions the Spaces, Realms, schemes, concepts and boards through native routes, so Content delivery does not wait on Access admitting Space creation for ordinary accounts. Native-system setup, the notification/reply-notice fixtures and account-erasure staff each receive `space:create`, `realm:create` and `subject:create` on the Global Context as ordinary `POST /v1/grants` receipts from the grantor client (`grantNativeCreationAuthority`), as the Realm and media fixtures do; the fixture does not rely on the platform role to derive them. Governance bootstrap installs that role and `organization:create` only. Whether ordinary accounts may create Spaces is an Access122 decision and is not a dependency of this fixture. `space_discovery_tuple_reference` has no `producer_epoch` column; Community's landed `20261106082422_space_witness_reference_epoch.sql` copies identity-only reference removals with epoch 0 and pending work with its stored epoch, so Space-then-Realm creation no longer selects that column. Community producer 989baccc1a (locked-old-witness provenance) is not on any ref and is not consumed; Community660535a9 owns landing it. Kernel typecheck keeps one `deadlineLive` operand column and the consumed `live` column in `permission-check.sql`; the trailing duplicate alias is dropped so SQL analysis can name the row. Native reply-notice consumers keep `accounts.grant` and `GrowthDatabase` (`url`, instrumented `pool`, unexplained `admin`); grant writes ordinary receipts. Library `collection-source.ts` re-exports the work-dimension types its public facade already named.

**Decision:** Notification, reply-notice and account-erasure fixtures provision sources as the governance operator or staff with ordinary Global creation receipts; ordinary-account Space creation stays an Access122 decision. Identical `POST /v1/grants` intents reuse one receipt key (`accounts.grant:<route>:<resource>:<account>:<action>`), because Access maps a second insert of the same Global creation row to 403, not 409. Native-system already issues the operator's receipts; notification fixtures only add RealmOwner's, before the fixture clock moves, and Space creators receive an ordinary `space:manage` receipt on that Space. Community `createRealm` extras wrap Access `preparePage` as well as `prepare`, because the Global parent is authorized as `semantic.context` through the page path; wrapping only `prepare` denied every authorize. Existing native notification assertions remain the pin; no extra stories.

**Decision:** Settings verification keeps original-command retry only while the command is uncertain without a matching receipt; a receipt never offers original retry, and matching payload alone does not prove success.

**Decision:** Existing Access preference, Content notification-outcome, notice-finalization, publication-driver, account-erasure-notices and Settings focused suites pin the installed lifecycle; no extra stories. Leftover History consumers after the composition split import `history/contract` and `history/application` public entries; Zone commands already bind History evidence, so kernel-zones depends on those modules. History's lazy Semantic source-set producer resolves `../../semantic/record-source-set.ts` from `history/adapters`; the stale `../semantic/` path treated the landed owner as absent and failed native scheme creation. One operator provisions public and protected boards in order so subject writes do not exhaust the partition fence. `thread:read` and `post:read` are not Global-reach and Content owner roles omit `access:grant`, so those fixture rows use `seedGovernanceAuthority`; Global creation stays ordinary `POST /v1/grants`. Semantic `beginSemanticRecordSourceSet` already declares the History set; consumers must not declare again. Begin registers the seal-guard callback, so those commands emit an outbox event rather than `noEffect`. The isolated notification effect host calls `installNativeHistory` and binds `KERNEL_RECEIPT_KEYS` onto its pool from `workerTestEnv` before enqueue, matching `startWorker`, because bun test History preloads and parent-pool WeakMap bindings do not apply to that child. Account-erasure notice work binds the same test receipt ring onto its work pool. Account-erasure fixtures run notice effects on `post.published`. The frozen outcomes suite default timeout is 180 seconds so native provision can finish.

**Native evidence:** landing-command files on `eddee3c801` (check `9ac9f3f3`): `test/access/preferences-erasure.test.ts` 4 pass; `test/access/preferences.test.ts` 12 pass; `test/access/notification-preference-page.test.ts` 3 pass; `test/access/notification-preferences.test.ts` 10 pass and 1 fail (the client-declaration test, blocked by Library type errors on base). Acceptance `test/content/notification-outcomes.test.ts` 0 of 10 pass: every scenario stops at `POST /v1/spaces`, denied by Access on base. `test/content/notice-finalization.test.ts` 0 of 2 and `test/content/publication-driver.test.ts` fail for the same two reasons; `test/content/account-erasure-notices.test.ts` 1 of 3 passes. Kernel workspace typecheck (check `ed955086`) exits 2 with 11 errors in nine files, none in changed files; the list is in the continuation. Failures are named in the continuation. On the fixture revision (`33163d25a4`, rebased as `d1e939d9a4`), four worker checks ended with infrastructure failures before any test result (exit 75): SSH transport drops on hosts `a` and `b`, and a Docker run timeout on `b` that failed the typecheck step with no TypeScript diagnostic. No native result is recorded for this revision.

**Mounted evidence:** local `bun test` over nine preference and Settings web files (`settings-notification-native-form`, `notification-preference-state`, `settings-notification-form-recovery`, `notice-preference-recovery`, `reading-preferences-journey`, `reading-preferences`, `shelf-preferences-advice`, `settings-reading-navigation`, `notifications-inbox`): 83 pass, 3 fail on base, none caused by this branch. Desktop and phone Settings browser journeys (`tests/settings-notifications.test.ts`, Playwright) were not run here.

**Promotion evidence:** none recorded; controller-owned after integration.

## terminal-erasure

**User job:** An account confirms deletion with fresh authentication and a typed confirmation, immediately loses credential authority, and has its private graph erased by each owner while eligible public contributions survive de-identified.

**Attribution choice:** Retained surfaces consume nullable Access attribution: live identity keeps its kind;
only an authoritative deleted identity emits a label without an account link. Pending, missing and unavailable
identity never implies deletion. Deletion detection requires the explicit id-free deletion-label variant,
including during partial enrichment. Focused producer tests cover person/organization and exact native agent relations;
Content's authored-erasure test checks live-to-deleted HTTP presentation and Bob's retained reply with unchanged
revision/SHA/licence/references/body. The eight graph scenarios remain the native acceptance contract; source-backed
producer fixtures do not establish whole-graph execution, mounted surfaces or promotion.

**Implementation choice:** Keep the eight outcome scenarios and their assertions intact; use deterministic fixture-only retention inputs and native `source.kind` Collection rules without selecting a production legal schedule. Native execute confirmation is the current handle after NFC and case-folding; Auth-page localized phrases stay a client-only gate; the closed deletion-page review carries the handle so execute can send it, and handleless accounts skip that field. Pending-registration `startAccountErasure` proceeds from an incomplete registration stage on a deleted fenced account and does not wait for Auth expiry markers the native consumer never writes. Native consumers schedule from the `NATIVE_ERASURE_GROUPS()` list value, never from the producer function. Native Auth fixtures copy the once-migrated `rezics_kernel_test` template; a failed host start releases that generation's DBOS owner after launch settles and keeps the first error; close is idempotent, waits for that generation's launch, then releases; a later host starts only after explicit close or failed-start release and never shuts down a healthy owner; late cleanup cannot clear or shut down a successor. Fewest host-lifecycle tests: failed launch then recovery, close during launch, sequential startup, cleanup failure, and late completion. A lost deletion execute retries once when the first attempt is 503 unavailable; malformed output, timeout and proven refusal (including 403 platform_closed not_applied) never retry. History loads Semantic's original record-source-set module from the adapters directory. Commerce physical expiry purge of the restricted order subset stays the Commerce continuation. Fewest tests: the frozen eight scenarios plus handle-confirmation NFC/case-folding, the pending-registration producer regression, and two Zone grant-drain cases (empty resource grants plus owner role; interrupted pages with a non-1 barrier and independent persisted readback); no extra stories.

**Personas:** Deleting owner; old-token owner; anonymous reader; Bob or other affected user; owner-specific data producers; ordinary restore attempt.

**Released fixture data:** `privacy` and `lifecycle/commerce` (accounts plus each owner); private and public data graph and terminal account records are produced by their owning stores.

**Surface cells:** Owner-store erasure evidence is defined by [deletion policy](../deletion.md); HTTP outcomes and payload removal are required.

| Cell                       | Acceptance                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue`                | `docs/deletion.md` owner-store policy; `specs/terminal-erasure-outcomes.test.ts` with binding `services/kernel/test/access/terminal-erasure-outcomes.test.ts`.                                            |
| `curated`                  | `docs/deletion.md` owner-store policy; `specs/terminal-erasure-outcomes.test.ts` with binding `services/kernel/test/access/terminal-erasure-outcomes.test.ts` for private/unlisted Collections.           |
| `Everything without state` | `docs/deletion.md` owner-store policy; `specs/terminal-erasure-outcomes.test.ts` with binding `services/kernel/test/access/terminal-erasure-outcomes.test.ts` for personal sources.                       |
| `own state`                | `docs/deletion.md` owner-store policy; `specs/terminal-erasure-outcomes.test.ts` with binding `services/kernel/test/access/terminal-erasure-outcomes.test.ts` for entries, labels and sessions.           |
| `mounted Zone`             | `docs/deletion.md` owner-store policy; `specs/terminal-erasure-outcomes.test.ts` with binding `services/kernel/test/access/terminal-erasure-outcomes.test.ts` for prepared exports and Zone sources.      |
| `TypeList`                 | `docs/deletion.md` owner-store policy; `specs/terminal-erasure-outcomes.test.ts` with binding `services/kernel/test/access/terminal-erasure-outcomes.test.ts` for owner stores represented by a TypeList. |

**Frozen scenarios:** Existing: “native completion purges every targeted history and copies while retaining unrelated authors” and “a suspension ends an erasure started before it, and reinstatement does not resume it” (`specs/erasure-operation-outcomes.test.ts`; native binding: `services/kernel/test/content/erasure-operation-outcomes.test.ts`). Existing: `terminal-erasure-graph` — `specs/terminal-erasure-outcomes.test.ts` with binding `services/kernel/test/access/terminal-erasure-outcomes.test.ts`, per accounts scenario A5 in `docs/research/api-acceptance-gaps.md`. No ordinary restore can resurrect the account.

**Native acceptance:** `bun run --cwd services/kernel check test/content/erasure-operation-outcomes.test.ts test/access/account-lifecycle-outcome.test.ts test/access/terminal-erasure-outcomes.test.ts`.

**Evidence limits:** This landing receives the public-identity producer through Content posts and Library collection attribution, binds live-copy seal/minimize to Work and History on the actual Pool, and refuses live-copy activation without native lineage reconciliation. Agent-verification reversal composes default Work modules on the test Pool and launches the identity executor in a child process; author-erasure HTTP kernels use the 30s test request deadline so History-backed realm create is not refused at the 2s default. The terminal fixture inspects native restricted order rows; Commerce physical expiry purge remains `.temp/continuation/commerce-financial-expiry-purge.md`. Producer attribution suites, authored-field receipt-key composition, erasure-native receipt keys, growth Auth isolation, and agent-verification-reversal template clone are the focused checks. They do not establish the eight-scenario graph, mounted surfaces or promotion. Native graph and mounted acceptance remain deferred until the controller releases native execution.

**Checked revision:** recorded at landing commit; promotion none.
