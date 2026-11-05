# Agents and public profiles: design status

Desk snapshot: 2026-10-31 Asia/Shanghai (2026-10-30 UTC), using this worker's integrated development checkout.
This report is evidence for the Accounts manager, not a second contract. **Proposed** means specified without a
callable production assembly; **implemented** means present in the source traced below; **outcome-proven** means
owning delivery established the stated outcome, not merely that a test or adapter exists. No acceptance, native,
browser, database or formatting check was run for this research. Landed owning delivery is trusted; this source
read does not certify the complete native journey or completion on main.

## Boundary and authorities

[Scope](../scope.md) assigns Accounts **“Agents and public profiles — In (one agent, one page)”**. The separate
Accounts/authentication/preferences/deletion row supplies its identity and lifecycle dependencies. The normative
owners are [accounts.md](../accounts.md), the [Access mechanisms](../../services/kernel/src/access/README.md),
[Auth](../../services/auth/README.md), [Semantic account agents](../../services/kernel/src/semantic/README.md),
[deletion](../deletion.md), and Search's [conditions](../search-conditions.md) and [facets](../search-facets.md).
Web owns the page/settings experience and [SEO](../seo.md); Content owns media and activity, Commerce/Library owns
Collection reads, and Semantic owns catalogue identity and its publication coordinator. These shared owners
remain dependencies, not authority transferred to Accounts.

An Account has an immutable ID and exactly one immutable kind, `actor` or `organization`. A human is an
unoperated actor; automation is an actor's operator relation, not a third kind. Its single operator is an
unoperated human or an organization. Automated actors cannot operate actors or join organizations. Organizations
cannot authenticate or become token subjects. An assistant using a person's session is a client; an agent with
its own identity is an operated actor. Operator management never copies the operator's resource grants.

The public address is `/@handle`, rendered as `/<locale>/@<handle>` and optional view paths, outside Realms and
Zones. A catalogue Person/Organization is a Subject, not a login account. Derived person/organization/software
agent nodes support attribution; reviewed representation can link the account to a catalogue agent, without
granting catalogue editing rights. No Account Semantic type, second Search engine, GitHub-App installation
product or Mastodon-style discovery opt-in is implied by this research.

## Existing research and primary-source additions

| Evidence                                                                                   | Status and finding                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Agent verification](agent-verification.md)                                                | **Primary-backed.** Existing official author/artist/channel, Bluesky and Mastodon research separates control of a channel/domain from reviewed representation and endorsement. Retain private evidence, reversible governance and no universal fixed expiry. It does not establish the current implementation's publication outcome. |
| [Account handles](account-handles.md)                                                      | **Primary-backed.** Stable identity must survive rename; forwarding and reuse are distinct policies. Its proposed 3–32 limit was not adopted: current claims use 3–64, lookup accepts historical 1–64. Thirty-day forwarding and permanent nonassignment are already owner policy.                                                   |
| [Account deletion](account-deletion.md)                                                    | **Primary-backed.** Existing product and identity-provider sources distinguish immediate loss of authority, eventual erasure, preserved contributions and operational copies. Reuse it and the adopted deletion contract; do not reopen a cooling-off decision here.                                                                 |
| [Earlier Accounts audit](accounts-done-when-audit-current.md)                              | **Partial for this question.** Useful historical scoped evidence, explicitly tied to an earlier base. Its verdicts cannot establish today's Web/Auth/Semantic assembly, account discovery or complete erasure.                                                                                                                       |
| GitHub bot/App identity, actual Mastodon profile implementation, delegated OAuth semantics | **Partial in the earlier agent survey; filled below** with official documentation, standards and a reused source clone. These explain design patterns, not REZICS runtime availability.                                                                                                                                              |

GitHub distinguishes a password-bearing machine user from a GitHub App's built-in bot, which cannot be signed
into with a password. Apps may act independently or for a user; installation-token activity is attributed to the
app, while user-token activity retains the user. Installation permissions and the user's own permissions bound
user-authorized access. The useful pattern is explicit acting identity and bounded delegation, not sharing a
human's credentials. REZICS already permits independently credentialed automation, so GitHub's passwordless bot
policy is not a replacement contract. See [machine versus bot accounts][github-differences] and
[App authentication][github-auth]. The [user/profile API][github-users] separates public user reads, the
authenticated `/user` response and `PATCH /user`; fine-grained profile updates require Profile write permission.
It also provides public lookup by durable user ID rather than mutable login. Presentation, private fields and
editing authority are therefore separate boundaries; GitHub's exact disclosure settings are not REZICS policy.

Mastodon's [profile documentation][mastodon-profile] describes `bot` as a visual indication, directory discovery
as a separate opt-in, and HTTPS `rel=me` as evidence of reciprocal link control. It does not establish operator
authority or reviewed catalogue representation. In the inspected source, `app/models/account.rb` separates
`searchable`/`discoverable` eligibility from the automation flag; `app/serializers/rest/account_serializer.rb`
exposes `bot`, discovery settings and optional movement separately. The authenticated credentials controller
allows profile/flag edits, validates them, and schedules an ActivityPub update after the account update. See
[model][mastodon-model], [serializer][mastodon-serializer] and [controller][mastodon-controller]. This supports
separating public marking, editing authority, discovery eligibility and asynchronous publication. Its federation,
self-selected bot flag and directory policy should not be imported into REZICS.

[RFC 8693 §§1.1, 2.1, 4.1][oauth-exchange] distinguishes delegation from impersonation: `sub`, current `act`, and
`client_id` have different meanings; nested prior actors are informational, not extra authorization. Exchange
does not inherently revoke its input tokens. REZICS rejects `act` and implements neither token exchange nor an
exchange endpoint; its assignment reference `requested_by` and operator-opening receipts are existing, different
mechanisms. [RFC 7523 §§2–3, 6][oauth-jwt] also distinguishes JWT client authentication from a JWT authorization
grant and makes assertion replay protection optional at the standard level. A signed assertion alone therefore
does not prove current operator authority; REZICS must retain its stricter current checks and replay rules.
[RFC 9700 §§2.2–2.5, 4.14][oauth-security] supports narrow audience/scope, asymmetric client authentication and
refresh replay defenses. It does not make a five-minute bearer sufficient for immediate revocation.

**Recommendation:** retain the adopted Account/operator model and central Access formula; finish visible,
server-derived automation/operator disclosure and the existing lifecycle and verification journeys. Treat
representation, catalogue permissions, authentication and discovery as separate decisions. Their shared pattern
is stable identity plus mutable presentation, explicit delegation, current authority, reversible claims and
asynchronous publication with honest completion status. This is an inference from the sources above, not a new
product policy.

Sources were accessed 2026-10-30 UTC. GitHub documentation is living documentation; the REST reference offers
version selection and is not a REZICS API-version recommendation. GitHub Docs uses [CC BY 4.0][github-license].
Mastodon profile documentation was updated 2026-04-15 and uses CC BY-SA 4.0 (page footer); its
[Account API reference][mastodon-account] records field-specific version changes. Source inspection reused
`.reference/follow-counts/mastodon` at `f943e0583be804bb062e5c9a4f8e65e2a05e5346`, recorded in the reference
index under `accounts-agents-profiles`; its [LICENSE][mastodon-license] is AGPL-3.0. No reference code was run or
copied. RFC 8693 (2020), RFC 7523 (2015), and RFC 9700/BCP 240 (2025) carry the IETF Trust/BCP 78 terms in their
copyright notices. Recommendations are designs for this repository's stack, not source-port proposals.

## Actual UI ↔ API ↔ storage journeys

`T` below is the trusted Access evaluator time for the protected effect, not a browser timestamp. The formula is
actor grant ∩ current consented client scope ∩ optional principal grant; platform admission is an additional
gate, not a permission grant. Account authority lives on the account anchor; handle uniqueness on the normalized
handle anchor; organization membership on the organization. Each kernel command commits one partition's state,
receipt and outbox atomically. Auth has its own database and DBOS `auth_dbos` system schema; cross-owner work is
durable steps, never a distributed SQL transaction. Replaying an operation key is not permission to repeat a
new effect or disclose a private result to a caller whose current authority disappeared.

The table cites production source groups defined immediately below it. Browser server-function calls use the
framework's generated transport, not a separately designed stable HTTP endpoint. Kernel paths are literal.

| Journey and actual entry                                                                                                                                                | Hops, current authority and transaction boundary                                                                                                                                                                                                                                                                                                                                                                                                               | Durable work, response/disclosure and actual gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human registration: Auth `/signup`; `POST /signup`, then UI `POST /signin`                                                                                              | Auth UI → Auth workflow host → Turnstile verification → Access pending-account/handle reservation → Auth encrypted credential staging/provisioning → Access activation. Native registration evidence binds the same Account ID; activation is separate from Auth credential commit. [A]                                                                                                                                                                        | `access.account`, `access.handle_claim` full keys; `auth_registration_stage` with `auth_registration_stage_due`, `auth_provisioning_receipt`, `auth_workflow_request`, DBOS steps. Signup returns 201 account ID, **no session**; invalid proof/input 400, unavailable configuration 503. Same key binds input; expired pending work releases reservations. Pending/orphan credentials cannot sign in.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Organization creation: Auth `/organizations/new`; `POST /account-operations/approve`, then `/execute`                                                                   | Fresh human Auth proof → native Access approval and `organizations` admission → `createOrganization` workflow → organization anchor plus first human owner/membership inverse and management defaults. Each home commits separately. [A, B]                                                                                                                                                                                                                    | `workflow_approval`/expiry index, `lifecycle_coordination`, `organization_member`, membership inverse, Auth workflow journal/DBOS. Reply identifies account, never an organization session. Closed gate 403 `platform_closed`; stale/changed authority 409, step-up 401, missing binding 503. Dedicated operation client has only `organization:create`/`account:delete`; login remains scope-empty. **No organization-target profile settings selector.**                                                                                                                                                                                                                                                                                                                                                                   |
| Automated creation: **no creator page or public creation endpoint**                                                                                                     | Actual trusted `createAutomated({key, authorization, operatorAccountId, handle, credential?})` in Auth → current workflow approval → reserve operator responsibility **before** subject relation → optional password owner or credentialless owner → claim/activate. Human/org operator eligibility is native Access authority, not a caller-supplied flag. [A, B]                                                                                             | Operator `operator_relation_slot`, subject relation/version, optional encrypted registration stage, provisioning receipt and DBOS steps. Resource grants are not inherited. The closed HTTP account-operation descriptor currently excludes automated creation; calling the trusted method is not an exposed product journey. Web's native fixture deliberately lacks the real creation binding.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Authentication, operator opening, credential change and revocation: Auth `/login`, `/security`, `/step-up`, `/recovery`                                                 | Own credential uses `POST /signin`, `/signin/key`, passkey endpoints, then `/token`; Web `GET /auth/sign-in`, `GET /auth/callback` keep tokens in its BFF session store, and `POST /auth/sign-out` ends that session. Trusted `authorizeOperatorOpening`/`openOperatorSession` → Access `authorizeOpening`/`consumeOpening` → Auth session with automated `sub`. Credential effects have actual `POST /credential-effects/stage`, `/approve`, `/apply`. [A, B] | Auth `user`, `account`, `session`, `passkey`, `auth_public_key`, `auth_client`, `auth_consent`, OAuth token/family/assertion tables; Access `operator_opening_receipt`. Opening binds relation version, human/client/scopes/principal/floors, expires within 60 seconds and is one-use; lost issuance acknowledgement fails closed on reuse. `POST /sessions/revoke` and consent reduction fence in Access before Auth mutation; old bearer becomes 401 `invalid_credentials`/`invalid_token`. Web local sign-out can succeed while Auth refresh-token revocation is unavailable. **No operator-opening UI/public descriptor; passkeys are self-human-only and TOTP/backup codes are absent, despite the broader credential contract. Automated recovery uses the operator, not human email recovery.**                      |
| Public account/attribution/profile: Web `/<locale>/@<handle>` and `/<locale>/@<handle>/<view>`                                                                          | Web route → anonymous `readAgentPage` BFF → `POST /v1/pages:read` with account target → Presentation account probe → `GET /v1/accounts?handle=…` and planned Semantic/Content/Library reads. Operator attribution hydrates through ID reads. API also accepts exactly one of `ids` (≤100 deduplicated), `handle`, `agent`; ID reads are attribution, not discovery. [C, D]                                                                                     | Account point read plus handle claim `(route, normalized_handle)`; verified lookup uses `access.agent_page(route, subject_id)` then current account. Returns public identity/profile, omits pending/unknown; ID lookup preserves deleted attribution. Email, controller, credentials, sessions, consent and preferences never belong in this response. Public HTML uses anonymous data; personal preferences load after hydration, `private, no-store`. **Deleted actors still carry extra null/false identity fields; exact three-field tombstone currently holds only for organizations.**                                                                                                                                                                                                                                 |
| Derived identity, verified Subject address and one page                                                                                                                 | Activation/display-name/fence events → `account_agent` effect → anchored current account → Semantic `ensureAccountAgent`; person/organization/software type follows current account/operator. Subject-target `POST /v1/pages:read` probes verified account linkage and supplies a redirect; Web `subject.tsx` returns localized 308 to the account page. [C, E]                                                                                                | `semantic.subject`, `semantic.account_agent`, `semantic.account_agent_subject`, revisions and outbox; deterministic derived ID shares the account route. Missing active definition release defers creation. A retry reads current state rather than reinstating an old label; merged catalogue labels are not overwritten by profile synchronization. This is not an Account Search source. **Same-workflow verify/replay/reversal publication through the final identity coordinator remains an existing producer's gap.**                                                                                                                                                                                                                                                                                                  |
| Self profile, avatar and public-view edit: Web `/<locale>/settings` profile/public-activity sections; BFF `readProfile`/`saveProfile` → `PATCH /v1/accounts/:accountId` | BFF session subject and CSRF headers → authenticated kernel client → account-local `account:update`, or current operator management at T for API callers. Patch merges named fields, with Content avatar validation in the protected command. Settings BFF currently insists target equals session subject. [B, C, F]                                                                                                                                          | `access.account` profile/public-view columns; command receipt/outbox and `account_agent` display-name effect. Atomic invalid-patch rollback; per-field last-writer-wins, no revision precondition, same-key retry stable. Avatar: browser `POST /media`, `PUT /media/:id`, bounded `GET /media/:id` polling → Web media BFF → kernel `POST /v1/media`, `POST /v1/media/:id:complete`, reservation reads; bytes in `MEDIA` object storage, metadata in `content.media`. Only accepted available media is patched as avatar. Errors include 400 validation, 403 authority, 413/415 upload limits, 429/503; UI collapses avatar failures. **Managed organization/automation edits and handleless self-profile reads have no complete settings path. UI link-label max 80 exceeds API 64; biography UI 2000 is below API 4096.** |
| Public activity and organization speakers                                                                                                                               | Same account view composition; continuation uses `GET /v1/accounts/:accountId/posts`, `/threads?kind=…`, `/collections?view=BASIC`. Access also exposes `/realms` and `GET /v1/accounts/:accountId/speakers`. Public-view flags suppress lists, not underlying content grants. Speakers require organization opt-in and currently live assignments/eligible actors at T. [B, C]                                                                                | Content posts/threads, Library collections and domain-owned authorization; `principal_assignment_speakers` index, keyset limit+lookahead, then bounded identity hydration. Encrypted speaker cursor binds viewer/query and expires after 15 minutes; no full materialization/count. Filtering can produce a short/empty page with a valid next cursor. **Account Web `publicViews` projection omits `realms`; there is no generic all-accounts directory behind these lists.**                                                                                                                                                                                                                                                                                                                                               |
| Handle rename and former address                                                                                                                                        | **No rename form.** HTTP account-operation transport accepts `rename`; native `renameHandle` uses approved immutable input, fresh authority and durable handle/account-home steps. New claims use lowercase 3–64 ASCII alphanumeric/underscore/hyphen with alphanumeric ends, no trimming; reserved-name exceptions need their own grant. Former profile lookup can return `movedTo`. [A–D]                                                                    | `handle_claim`, `lifecycle_handle_operation`, `lifecycle_handle_effect`, `lifecycle_coordination`; no cross-anchor SQL transaction. Former spelling forwards to the same active account for 30 days without chains, then stays unavailable to another account. Web implements 308 canonical correction, or 302/max-age 300 fallback forwarding, preserving query/view. Unknown/expired former lookup is missing. **Owner prose still says forwarding is absent, but current routes implement it; retain the code finding, not the obsolete gap claim.**                                                                                                                                                                                                                                                                      |
| Verification application, status, withdrawal: Web settings Verification section                                                                                         | BFF `verification-actions.ts`/`verification-core.ts` → `POST /v1/accounts/:accountId:requestVerification`, `GET /v1/accounts/:accountId/verification`, `POST /v1/accounts/:accountId:withdrawVerification`. `gate:agent_verification` plus current self-human or organization-manager authority; target must match Person/Organization, not software. Existing Search suggestions supply candidate Subjects, not proof of representation. [B, G]               | Route-0 `agent_verification_request`: private statement/≤5 HTTPS links, requested/deciding actors, problem/reason, decision receipt; indexes `agent_verification_active_account_idx`, `agent_verification_account_latest_idx`, `agent_verification_pending_page_idx`. Application returns 201 request; latest returns request/null; withdrawal 200. States include pending/withdrawn; stale decisions 409, denial 403, closed gate 403. Evidence is available to the authorized applicant/reviewer, not public profile readers. **Settings supplies only the signed-in target, not managed-organization selection.**                                                                                                                                                                                                         |
| Governance review, rejection and approval                                                                                                                               | **No reviewer page found.** Actual `GET /v1/verification-requests?state=pending`, `POST /v1/verification-requests/:requestId:approve` or `:reject` require current `account:verify_agent` on Global Context and the verification gate. An approval transaction records `approving` plus receipt/event; it is not completed publication. [B, G]                                                                                                                 | Pending keyset page is bounded; request state/indexes prevent two active decisions. Outbox → `accounts.agent-verification` DBOS workflow on `workflows`: record pending account → Semantic verify → insert `agent_page` → complete account → finish request. Rejection records private reason; typed Semantic failure clears pending markers and records `failed`. Retry uses request+receipt workflow identity and existing command receipts. **Current Semantic verify still calls `mergeSubjectsInCommand`; the new identity-epoch types/admission modules do not by themselves connect this workflow to published identity epochs.**                                                                                                                                                                                     |
| Release, governance revocation, stale replay and deletion reversal                                                                                                      | Actual `POST /v1/accounts/:accountId:releaseVerification` (self/current manager) or `:revokeVerification` (governance), both gated. Account-local reversal commits marker/receipt/event; deletion uses the internal reversal path. **No release/revoke UI or representative-status explanation in the current profile header.** [B, G, E]                                                                                                                      | `accounts.agent-verification-reversal` on `workflows`: Semantic unverify → remove exact `agent_page` pointer → finish clear → synchronize current account. `semantic.account_agent_moved_link` and reversal revisions support undo. Decision receipt binds the original link so delayed reversal cannot undo a newer verification. Response is `{reversal}`, not proof all participants published. Replay must not resurrect the claim or leak private evidence. Current single verified-subject columns do not implement the owner's multiple-pen-name claim contract.                                                                                                                                                                                                                                                      |
| Discovery eligibility, text, kind counts and sitemap                                                                                                                    | **No Account text-result/count API or Web account-discovery journey in this checkout.** Existing `POST /v1/subjects:search`, Search source/index/query/facets and `SubjectSummary` hydration are Subject-only. `GET /v1/agent-pages` is sitemap enumeration, not account search/count. [H, C]                                                                                                                                                                  | `account_agent_pages` partial index enumerates active, unfenced handled accounts using `(route, account_id)`; limit ≤1000+lookahead, viewer/limit-bound 15-minute cursor. `account_active_pages` separately pages deployment accounts, including handleless ones. Proposed discovery requires active AND unfenced at T for text, sort, summary and counts; only exact ACTIVE claim supplies handle text/navigation, displayName is the other text field. **No Account source/document/summary/count union or final whole-query authority join exists here; page length and Subject counts cannot substitute.**                                                                                                                                                                                                               |
| Operator transfer, refusal and replay: **no transfer UI**                                                                                                               | Existing account-operation descriptors `transfer-acceptance` and `transfer` → Access destination approval, then source approval over same account/old relation version/destination → Auth `transferOperator`. Destination responsibility is reserved before subject-local switch; each manager's own actor/client/scope/principal is checked at the protected T. [A, B]                                                                                        | `operator_relation_slot`, `operator_relation_version`, `workflow_approval`, Auth request journal/DBOS. Revoke old sessions, retire/release old responsibility; grants stay with the automated account. Last-owner/operator eligibility, stale version or changed authority deny; same key cannot install a new destination. Old openings/approvals fail after relation change. Profile operator disclosure must then reflect the current relation, not the old workflow input.                                                                                                                                                                                                                                                                                                                                               |
| Suspension, operator fanout and reinstatement                                                                                                                           | Governance `POST /v1/accounts/:accountId:suspend` / `:reinstate`; Auth also has protected `fence-operator` descriptor. Access commits fence/floor first; native responsibility pages drive separate subject fences and Auth revocation. Reinstatement reverses only matching suspension receipts on still-matching relations. [A, B]                                                                                                                           | Account/floor, responsibility reservations, suspension/fanout durable receipts and `account_agent` effects. Old credentials fail; sign-in can return 403 `ACCOUNT_SUSPENDED`. Public ID attribution remains `active`, with no reason; discovery must exclude all authentication fences equally from T. Floors never fall and reinstatement does not restore old tokens. **Attribution/profile SQL and sitemap/speakers have different guards; using one as another's discovery source would disclose forbidden membership/counts.**                                                                                                                                                                                                                                                                                          |
| Deletion and restore: Auth `/account/delete`; approve/execute with `delete`                                                                                             | Fresh human confirmation/approval → authorized Access terminal tombstone/fence → Auth native erasure → responsibility retirement and current-handle permanent retirement, without forwarding. Self-deletion has narrowly defined result-authorization handling; no post-deletion session or restore action. [A, B, I]                                                                                                                                          | `access.erasure`, acknowledgement/progress/late-item/locator-work tables and role-first indexes; Auth `auth_erasure`, native credential-terminal/consumer-proof tables and role indexes; owner queues, receipts/outbox and DBOS copies also need real erasure/minimization. Semantic verification reversal precedes final agent cleanup. Account deletion is irreversible at T; the separate 30-day record-deletion restore rule is not account recovery. Keep only exact public `{id,state,kind}` and permitted minimal internal safety skeleton; retired spelling must lose identity/forwarding provenance. **Enqueue, absent sessions or an empty child page does not prove all copies, historical roles, external sinks or backups are erased; completion stays pending for missing owner evidence.**                    |

Source groups (paths are implementations or owner mechanisms, not substitute APIs):

- **A — Auth:** [host](../../services/auth/src/host.ts), [workflows](../../services/auth/src/workflows.ts),
  [account-operation transport](../../services/auth/src/account-operations-transport.ts),
  [service](../../services/auth/src/service.ts), [credential effects](../../services/auth/src/credential-effects.ts),
  [Auth UI operations](../../apps/auth/src/account-operations.ts), [page mounting](../../apps/auth/src/server.ts),
  [Web session routes](../../apps/web/src/session/routes.ts) and [session store](../../apps/web/src/session/store.ts).
- **B — Access:** [routes](../../services/kernel/src/access/routes.ts),
  [lifecycle](../../services/kernel/src/access/lifecycle.ts), [operator](../../services/kernel/src/access/operator.ts),
  [workflow approvals](../../services/kernel/src/access/workflow-approvals.ts),
  [account workflows](../../services/kernel/src/access/account-workflows.ts),
  [speaker paging](../../services/kernel/src/access/organization-speakers.ts) and [Access migrations](../../services/kernel/db/access/migrations/).
- **C — Public reads:** [account data](../../services/kernel/src/access/account-data.ts),
  [public profile SQL](../../services/kernel/src/access/account-public-read.sql),
  [Presentation routing](../../services/kernel/src/presentation/http/pages.ts),
  [Web agent BFF](../../apps/web/src/features/pages/agent-actions.ts),
  [page loading/continuation](../../apps/web/src/features/pages/agent.tsx),
  [profile projection](../../apps/web/src/features/pages/account-read.ts) and [header](../../apps/web/src/features/pages/account.tsx).
- **D — Addresses:** [handle policy](../../services/kernel/src/access/handle-policy.ts),
  [Web route](../../apps/web/src/routes/@{$handle}.tsx),
  [named-view route](../../apps/web/src/routes/@{$handle}_.$view.tsx) and [Subject redirect](../../apps/web/src/features/pages/subject.tsx).
- **E — Identity:** [account-agent effect](../../services/kernel/src/access/account-agent-effect.ts),
  [Semantic account agents](../../services/kernel/src/semantic/account-agents.ts),
  [identity admission](../../services/kernel/src/semantic/identity-epoch-admission.ts) and
  [epoch contract](../../services/kernel/src/semantic/identity-epoch-contract.ts).
- **F — Editing/media:** [settings BFF](../../apps/web/src/settings/actions.ts),
  [profile data](../../apps/web/src/settings/profile-data.ts), [form](../../apps/web/src/settings/profile.tsx),
  [upload client](../../apps/web/src/threads/upload.ts), [media BFF](../../apps/web/src/media/upload.ts) and
  [Content routes](../../services/kernel/src/content/media-routes.ts) and [avatar wire shape](../../services/kernel/src/content/avatar.ts).
- **G — Verification:** [commands](../../services/kernel/src/access/agent-verification.ts),
  [workflow](../../services/kernel/src/access/agent-verification-work.ts),
  [Web BFF](../../apps/web/src/settings/verification-actions.ts) and [API client](../../apps/web/src/settings/verification-core.ts).
- **H — Discovery:** [Accounts coowner proposal](../../services/kernel/src/access/account-discovery-contract.md),
  [Semantic source](../../services/kernel/src/semantic/search-source.ts), [Search source](../../services/kernel/src/search/source.ts),
  [assembly](../../services/kernel/src/search/work.ts) and [HTTP hydration](../../services/kernel/src/search/http/routes.ts).
- **I — Erasure:** [deletion owner](../deletion.md), [Access erasure](../../services/kernel/src/access/erasure.ts),
  [Auth native erasure](../../services/auth/src/erasure-native.ts) and [Auth migrations](../../services/auth/db/migrations/).

## Remaining gaps and confidence

The ordinary public page, profile patch, anonymous composition, operator fields/marking, typed software identity
and former-handle forwarding are **implemented**. Two owner-prose gap statements are stale: `account-read.ts`
now retains `automated`/`operatorId`, and the header and routes implement marking/forwarding. Marking still
depends on successful operator hydration; a missing operator suppresses it, while a handleless operator can
produce an empty `/@` link. The header reads no representative-status explanation despite the API's verified
field. Another concrete adapter mismatch affects settings reload: Content returns avatar `{media, ...}` while
`settings/profile-data.ts` accepts only `avatar.id`, so the existing avatar becomes null in the form. These are
source-visible usability/disclosure gaps, not reasons to redesign identity or claims of observed browser runs.

Verification commands/workflows and reversible mapping primitives are **implemented**, but the current verify
caller still follows the local merge path. The complete identity-publication path is **not outcome-proven by
this report**. Account discovery's shared source/wire/count integration is **proposed in this checkout**.
The live Accounts continuation reports its producer integrated elsewhere; that status does not install runtime
interfaces in this worker. Trust that delivery when it is integrated, rather than dispatching a duplicate.

Owning delivery records scoped native outcomes for the operation client and exact session revocation; those
are accepted without rerunning them. They do not establish automated creation UI, the entire public-page
workflow, all verification participants, account discovery, or deletion across every holder. Existing
[profile outcomes](../../specs/agent-profile-outcomes.test.ts) and
[Web native identity outcomes](../../apps/web/tests/native/native-agent-identity.host.test.ts) describe later
observable acceptance; their existence is not a passing result. The current
[Web native stack](../../apps/web/tests/native/stack.ts) explicitly refuses missing account-operation/automated
creation bindings. Auth's real `createAuthHost` accepts construction-time `accountOperations` and wraps the
host handler; serving `service.handler` alone or adding scopes cannot repair that seam.

Privacy/authority debt also includes the deleted-actor projection, direct verified-target hydration that uses
labels/types rather than the ordinary visible Subject summary, and the unimplemented alternate-controller /
independent-review registry. Review the target visibility guard with Semantic before exposing a verification
badge; a stored link is not a permission grant. Current columns support one verified target whereas the owning
document allows multiple pen names. These are explicit existing-contract gaps, not authorization here to add
new identity products. Operational completion still needs current publication, bounded redrive and erasure
across owners; no account restore or rollback of a committed fence should be offered to mask unfinished work.

## Adoption boundaries and ordered implementation slices

Root/Search must adopt and consume the shared mixed-kind source/index/query/current-summary/count boundary in
the Accounts discovery proposal; it cannot be implemented as Account-to-Subject coercion. Semantic owns the
released identity coordinator interface used by verification. Auth/Web/Semantic must apply the already accepted
construction/lifetime plumbing in the same existing assembly. The live continuation's latest entries supersede
older proof-only holds: they report discovery and external Auth custody delivered, metadata work continuing,
and cancellation of a new harness-only graph task in favor of product behavior. Keep the original outcome debt;
do not open replacement research, audit or native-harness work. This report consulted the coordinator's exact
`.temp/goal/accounts/CONTINUATION.md` because the worker-local file was absent; operational status is separate
from the runtime source inventory above.

The following are ordered product slices to fold into those existing owners/producers, not new dispatches:

1. **Publish a real verified representative page, including release/revocation.** Continue the existing Accounts
   account-agent producer in `access/agent-verification.ts`, `agent-verification-work.ts`,
   `semantic/account-agents.ts` and Semantic's identity-admission/binding modules. Input is the original immutable
   account-home decision intent and the actual released coordinator/verifier, not a fabricated receipt or the
   legacy merge shortcut. Finish Web verification status/release and governance review controls against the
   existing routes. Later outcome: apply → approve → one public page and truthful representative explanation;
   reject/withdraw disclose no evidence; replay, failure, revoke, release and delete cannot publish a stale claim
   or undo a later link. Use the existing profile/verification outcome suites, without a new large harness.
2. **Make operated and organization accounts manageable through the existing Auth boundary.** Continue the
   current Auth workflow/Web assembly work in `services/auth/src/host.ts`, `workflows.ts`,
   `account-operations-transport.ts`, `apps/auth/src/account-operations.ts` and Web account/settings actions.
   Inputs are real native workflow approvals, creation/opening ports, current responsibility receipts, the
   dedicated operation client and the accepted coowned construction diff. Automated creation/opening have no
   callable public descriptor today; their protected transport must be supplied by Auth, not assumed in Web.
   Deliver creation, credential/opening, target profile editing, rename and destination-accept/source-transfer
   as usable controls. Later outcome: the displayed operator changes only after authorized transfer; old
   credentials/openings/replayed approvals fail, grants do not migrate, and rejection leaves the previous
   accountable identity intact. Do not union website/login scopes or manufacture fixture automation.
3. **Finish reliable public profile presentation and editing.** The existing Web/Accounts profile owner can
   work now in `apps/web/src/features/pages/account.tsx`, `account-read.ts`, `agent-actions.ts`,
   `apps/web/src/settings/{profile.tsx,profile-data.ts,actions.ts}` and
   `services/kernel/src/access/account-data.ts`. Use the current public projection and patch/avatar APIs; a
   handleless or managed-target read needs a real authorized owner implementation, not an invented public
   profile endpoint. Preserve automation marking when operator hydration is unavailable, avoid empty operator
   links, consume the real avatar summary, align form limits, retain all public-view choices, and emit exact
   deleted-actor tombstones. Later outcome: anonymous HTML and hydrated views agree on identity/privacy, edits
   and avatar reload round-trip, failed upload leaves the old avatar, and former addresses preserve view/query
   without disclosing expired forwarding.
4. **Expose Account discovery through the existing Search product.** Reuse the existing discovery producer's
   delivered work when integrated; first resolve the explicit Root/Search ABI adoption above. Owning inputs are
   `access/account-discovery-contract.md`, `account-data.ts`, exact `handle_claim` authority and Search's actual
   source/document/generation/query/summary modules, then the existing Web Search surface. Later outcome:
   handle/displayName search and kind counts keep Account and catalogue Person separate; handleless eligible
   accounts remain representable; rename/fence/transfer/delete at T removes forbidden text, navigation, sort and
   count witnesses together, including stale indexed copies. No new engine, guessed export or attribution-ID
   scan can satisfy this slice.
5. **Complete irreversible lifecycle privacy with truthful user outcomes.** Continue the existing Access role
   erasure, Auth native-consumer/copy minimization, metadata and shared-history producers in
   `access/erasure*.ts`, `services/auth/src/erasure-native.ts`, Auth workflow/credential storage, Semantic agent
   reversal, and each registered owner participant. Incorporate the reported external-custody delivery rather
   than replacing it. Inputs are real holder/role enumeration and committed deletion/fence identities. Later
   outcome: confirm deletion once, immediately lose authentication/discovery/forwarding, preserve permitted
   contribution tombstones, show no restoration promise, and never report physical completion while a known
   database, workflow, index, cache, external or restore copy remains unaccounted for. Use focused existing
   lifecycle outcomes later; a queued job or copied receipt is not the product result.

[github-differences]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
[github-auth]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app
[github-users]: https://docs.github.com/en/rest/users/users
[github-license]: https://github.com/github/docs/blob/main/LICENSE
[mastodon-profile]: https://docs.joinmastodon.org/user/profile/
[mastodon-account]: https://docs.joinmastodon.org/entities/Account/
[mastodon-model]: https://github.com/mastodon/mastodon/blob/f943e0583be804bb062e5c9a4f8e65e2a05e5346/app/models/account.rb
[mastodon-serializer]: https://github.com/mastodon/mastodon/blob/f943e0583be804bb062e5c9a4f8e65e2a05e5346/app/serializers/rest/account_serializer.rb
[mastodon-controller]: https://github.com/mastodon/mastodon/blob/f943e0583be804bb062e5c9a4f8e65e2a05e5346/app/controllers/api/v1/accounts/credentials_controller.rb
[mastodon-license]: https://github.com/mastodon/mastodon/blob/f943e0583be804bb062e5c9a4f8e65e2a05e5346/LICENSE
[oauth-exchange]: https://www.rfc-editor.org/rfc/rfc8693
[oauth-jwt]: https://www.rfc-editor.org/rfc/rfc7523
[oauth-security]: https://www.rfc-editor.org/rfc/rfc9700
