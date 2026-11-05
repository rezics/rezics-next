# Accounts design status across five In systems

31 October 2026. This synthesis consumes the five delivered reports below and [public scope](../scope.md);
it adds no comparative research or implementation. **Selected** means the owner contract requires the behavior;
**delivered source** means the reports trace a concrete development assembly; **outcome proof** belongs to the
owning delivery and covers only its stated journey. Existing owner deliveries are trusted. Neither source nor
test existence establishes a complete native, served or main outcome. No new outcome verification was performed;
the declared local formatting acceptance remains post-integration proof.

Tables use localized Web page paths, issuer-host Auth paths and literal kernel HTTP paths. Web server functions
have generated transport URLs, not additional public APIs. The BFF resolves an opaque session through `SESSIONS`,
keeps tokens server-side and checks Origin/CSRF for unsafe cookie requests; Auth issues/refreshes credentials.
Kernel uses current actor grants ∩ consented client scopes ∩ delegated principal grants at trusted T, authorizing
before receipt replay. Commands couple one partition's effects with `core.receipt`/`core.outbox`; DBOS sequences
cross-owner work. Tables name additional authoritative stores. Research is informational; adopted Accounts rules
live in [Accounts](../accounts.md), with mechanisms in [Access](../../services/kernel/src/access/README.md).
The sources share a useful separation: stable identity, current permission, relationship intent and asynchronous
cleanup have distinct authorities. Finish the existing native TypeScript/PostgreSQL/DBOS journeys with truthful
pending/refusal states; do not import another product's policy, code or parallel service.

## Realms and Spaces

**Responsibility and design.** Content owns this In system's resources, boards and publications; Accounts owns
membership, inverse admission, grants and Access. Web owns controls; Semantic retains Context/definition authority.
Normative design is [Accounts §5](../accounts.md#5-organizations-and-memberships),
[Community](../../services/kernel/src/community/README.md), Content and Access, with lifecycle in
[deletion](../deletion.md). Space address, carried Realm, participation, membership and resource role are distinct.

**Research.** [Delivered report](accounts-design-realms-spaces.md) supplies primary documentation and source;
membership/state comparison exists, while succession and container deletion remain product decisions. Matrix's
[membership transitions](https://spec.matrix.org/v1.19/client-server-api/#room-membership) separate join, leave,
ban and unban: this supports retaining explicit transitions, without importing invitation or creator supremacy.
The report pins Synapse `synapse/handlers/{room_member,room_summary}.py`, with URLs and
AGPL-3.0-or-later/commercial licensing. Reuse that evidence; no source port is recommended.

| Page / journey                     | Method / endpoint → actual service path                                                                                                          | Authority / durable state → result or missing step                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/spaces/$address`, `/realms/$id`  | BFF → kernel `GET /v1/spaceAddresses/{address}`, `/v1/spaces/{id}`, `/v1/realms/{id}`                                                            | `space_address_claim`, Space/Realm heads plus current Access; hidden carried ID is null/404; addressed Realm redirects 307.                                                          |
| Realm home content                 | BFF → `GET /v1/realms/{id}/boards`, `/publications`; owned Subject/Content reads                                                                 | `content.board`, threads/posts, `publication_head_adopted_page`; current parent Access; bounded first pages lack continuation controls.                                              |
| Create/edit/address; no controls   | Kernel `POST /v1/spaces`, `/v1/realms`; `PATCH /v1/spaces/{id}`, `/v1/realms/{id}`; `PUT /v1/spaces/{id}/address`, `/v1/realms/{id}/boardScheme` | Global creation/host or current manage authority; Space/Realm revisions, address claims, creator roles/receipt. Native initialization exists; explicit manifest integration remains. |
| Membership/participation state     | Private BFF → `GET /v1/realms/{id}/members/me`, `/v1/realms/{id}/participation`                                                                  | Current Realm read plus exact `realm_member` interval/current participate check; member/none, allowed/denied/hidden. Denied does not establish banned.                               |
| Join/leave buttons                 | BFF → `POST`/`DELETE /v1/realms/{id}/membership` → Community → Auth membership workflow → Access                                                 | Realm `realm_member`, actor `membership_inverse`/reservation; DBOS `workflows`; 202 is pending. Leave revokes membership first; later Space follow is separate.                      |
| Manager add; no controls           | Kernel `POST /v1/realms/{id}/members` → same membership work                                                                                     | Current `realm:manage`, target ban/cap checks; direct add, not invitation/approval.                                                                                                  |
| Ban/unban/history; no controls     | `PUT`/`DELETE /v1/realms/{id}/bans/{accountId}`; `GET .../bans`                                                                                  | Community/Access ban intervals and `realm_ban_current`; protected-read veto precedes cleanup; unban restores no membership.                                                          |
| Roles / succession                 | `POST /v1/roleGrants`, `:change`, `:revoke` → Access                                                                                             | `resource_role_grant`; grantor must hold delegated actions. Generic commands supply no atomic succession or last-holder policy.                                                      |
| Private/public own lists; deletion | `/realms/` → BFF → `GET /v1/me/realms`; `GET /v1/accounts/{id}/realms`; Auth deletion workflow                                                   | Inverse candidates require native membership/current Realm proof; public view defaults off. Account barrier starts owner cleanup; no callable Realm delete/restore journey.          |

**Next whole slices.** Existing Accounts membership-transition delivery must retire the exact settled hold and
allow deletion entry; inverse cleanup or a leave bypass cannot substitute. Continue Content/Accounts ban,
own-list disclosure and member-history erasure through actual shared-copy acknowledgement. Web can now reconcile
join/leave with existing participation/member reads, preserve sign-in and stop labelling arbitrary denial “banned.”
Content/Web can compose existing creation/metadata/address commands. Root/Content/Accounts still own succession,
orphan and Realm/Space delete/restore decisions, including direct-owner discovery; no extra `globalReach` follows.
Those pending decisions do not block the existing slices or authorize new permissions.

## Agents and public profiles

**Responsibility and design.** Accounts owns one Account identity/page, profile authority, operator relationship,
handles and verification. [Accounts §§1–3, 7](../accounts.md), [Access](../../services/kernel/src/access/README.md)
and [Auth](../../services/auth/README.md) are normative. Semantic owns catalogue identity and publication;
Content owns media/activity, Library its Collections, Search discovery and Web presentation/SEO. An operated actor
is not a third account kind; an organization has no login. Representation grants no catalogue editing rights.

**Research.** [Delivered report](accounts-design-agents-profiles.md) provides primary-backed identity/operator,
profile and OAuth comparisons; broad interface coverage and complete publication outcomes remain partial.
[GitHub App authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app)
distinguishes acting identities; [Mastodon profiles](https://docs.joinmastodon.org/user/profile/) separate automation
marking, discovery and link control. These support explicit attribution, not imported federation or bot policy.
Pinned Mastodon `app/models/account.rb`, serializer and credentials-controller paths, URLs and AGPL-3.0 licence
are recorded in the report. GitHub Docs uses CC BY 4.0; documentation is evidence, not code to copy.

| Page / journey                            | Method / endpoint → actual service path                                                                                | Authority / durable state → result or missing step                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/signup`; `/organizations/new`           | Auth `POST /signup`; `POST /account-operations/approve`, `/execute` → native Access workflows                          | Pending account/handle, encrypted registration stage, provisioning receipts, `organization_member`/inverse; activation or first owner, never organization login.                   |
| Automated creation/opening                | Trusted Auth `createAutomated`, `authorizeOperatorOpening`, `openOperatorSession` → Access                             | `operator_relation_slot`/version, one-use opening receipt, Auth session; no public descriptor/page. Operator grants are not copied.                                                |
| `/@handle`, named views, Subject redirect | Anonymous BFF → `POST /v1/pages:read` → Presentation/Access `GET /v1/accounts`                                         | `account`, exact `handle_claim`, `agent_page`, domain activity stores; public allowlist, canonical/forward redirects; ID attribution differs from discovery.                       |
| `/settings` profile/avatar                | BFF → `PATCH /v1/accounts/{id}`; media BFF → kernel media reserve/complete/read                                        | `account`, `content.media`/object bytes, account-agent effect; authorized patch exists. Handleless/managed-target loading and avatar `{media}` adapter remain gaps.                |
| Activity / speakers                       | BFF composition → account `/posts`, `/threads`, `/collections`; API `/realms`, `/speakers`                             | Domain Access and public-view flags; native assignments/membership. Flags do not widen access; Web projection omits Realms.                                                        |
| Rename; no form                           | Auth approval/execution with rename descriptor → native handle workflow                                                | `lifecycle_handle_operation`/effect, claim authority; 30-day same-account forwarding, then permanent nonassignment.                                                                |
| Verification application/review           | Settings → account `:requestVerification`, `/verification`, `:withdrawVerification`; reviewer API `:approve`/`:reject` | `agent_verification_request`, private evidence; outbox → DBOS verification → Semantic → `agent_page`. Review UI/final identity-coordinator publication remain gaps.                |
| Release/revoke; transfer                  | Account `:releaseVerification`/`:revokeVerification`; Auth transfer-acceptance then transfer                           | Exact link/relation receipts prevent stale reversal; Semantic reversal/workflow state. No full controls; generic descriptors exceed the fixed page client's profiles.              |
| Discovery / lifecycle                     | No Account search journey established here; existing sitemap `GET /v1/agent-pages`; suspend/delete native workflows    | `account_agent_pages` is enumeration, not search. Current account/claim guards plus Search generations/count custody are required; tombstone/reversal cleanup remains cross-owner. |

**Adoption and slices.** Search has adopted the shared mixed-kind boundary; the sole Accounts source producer
supplies its selected population/text/current-claim contract, and existing Search integration continues. The older
report's request for another adoption/research round is superseded; no `SubjectSource` change belongs here.
Continue the existing account-agent/Semantic verification publisher and Auth managed-actor assembly. Web/Accounts
can immediately finish truthful bot/operator display, avatar reload, form limits, public views and minimal deleted
actor attribution. Complete publication and all-copy erasure retain their existing owners; delivered primitives
and scoped owner evidence do not prove the entire page lifecycle.

## Notifications

**Responsibility and design.** Content retains existing notification delivery/storage; Accounts owns private
preferences and lifecycle, Web settings/inbox, Auth credentials and security delivery. The notification report's
alternative delivery allocation is superseded. Normative design is [Accounts §6](../accounts.md#6-auth-ownership-and-registration),
[Access preferences](../../services/kernel/src/access/README.md#viewer-preferences),
[Content notifications](../../services/kernel/src/content/README.md#notifications) and deletion. Scope is in-app
replies, mentions and required moderation/report/appeal outcomes; no email/channel/conversation expansion.

**Research.** [Delivered report](accounts-design-notification-preferences.md) supplies primary preference, timing,
subscription and inbox evidence; broad interface surveying and runtime race proof remain partial.
[RFC 7396 §2](https://www.rfc-editor.org/rfc/rfc7396#section-2) explains null removal, not application defaults.
Pinned Discourse [`app/controllers/notifications_controller.rb`](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/controllers/notifications_controller.rb)
filters inaccessible topics separately from subscription state (GPL-2.0-or-later; retained source path/licence in
the report). The shared pattern is separate preference, delivery and current disclosure authority.

| Page / journey                          | Method / endpoint → actual service path                                                                          | Authority / durable state → result or missing step                                                                                                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/settings#notifications` load/readback | Session BFF → kernel `GET /v1/accounts/{a}/preferences` → Access                                                 | Self plus `account:read`; `account_preferences` PK. Absent row gives reply/mention true, version 0; private/no-store. Unreadable map means unavailable controls.                                                              |
| Toggle / reset / no-JS form             | BFF or `POST /{locale}/settings` → `PATCH .../preferences`                                                       | Self plus `account:update`; expectedVersion CAS, same command receipt/outbox. Null removes override; unchanged result preserves version; unknown/mandatory key 400.                                                           |
| Conflict / response loss                | Same PATCH/key replay and fresh GET                                                                              | Shared preference version; 409 conflict, changed-key input 422; current authorization precedes replay. UI currently loses ambiguous-attempt key; historical response is not current readback.                                 |
| Optional reply/mention send             | Post event → outbox/effects → DBOS `effects` → Content → `notificationAllowed` + resource Access → notice writer | Current recipient account/preferences and current content authority; `content.notice` unique recipient/kind/source. Helper exists; final recipient-commit cut and durable suppression/replay still need delivery integration. |
| Required outcome                        | Moderation/report/appeal decision → Content notice effect                                                        | Mandatory catalogue kind, decision/report authority; optional settings cannot suppress it. Suspended recipient handling differs from deleted/pending absence.                                                                 |
| `/inbox`, then target                   | BFF → `GET /v1/accounts/{a}/notifications`; later post/decision/report reads                                     | Own inbox; `notice_recipient_created_idx`, bounded current Access filtering and cursor; IDs carry no copied body. Revoked content has no historical fallback.                                                                 |
| Badge / mark seen                       | `GET .../notifications/count`; `POST .../notifications:markSeen`                                                 | `notice_seen` forward marker; count caps stored unread candidates, not visible-list count. BFF currently turns unavailable into zero; mark-seen lacks ordinary preference receipt semantics.                                  |
| Delete / retention / late writer        | Auth deletion → Access barrier → Content erasure/retention work                                                  | Barrier removes preference row; recipient notices/seen marker and 180-day retention are separate. Shared private receipt/workflow copies still require actual custody.                                                        |

**Selected and next slices.** Optional-send becomes final at actual recipient notice commit, using current native
preference/account cut and existing current resource Access; suppression and replay must be durable. Opt-out
affects future optional sends, not old inbox, content permissions or follows. Web/Accounts can finish ambiguous
save recovery and required-outcome copy using existing defaults/CAS/session/CSRF. Web must represent unavailable
unread data distinctly from zero. Continue the existing Content send and Accounts preference-receipt/shared-history
producers; do not create another sender. This adopts the Accounts side; the manager coordinates Content/Web
contract alignment. Current helper/deduplication alone is not proof of the selected commit race outcome.

## Follows

**Responsibility and design.** Accounts owns current actor/client/principal, Access and membership/lifecycle
boundaries; Commerce owns Library edges, replacement/count maintenance and erasure; Web owns controls.
Normative authorities are [Accounts §5](../accounts.md#5-organizations-and-memberships),
[Library Follow](../../services/kernel/src/library/README.md#follow), [private counts](../private-follow-counts.md)
and [viewer actions](../viewer-actions.md). Content supplies Space/Realm visibility, Semantic canonical identity.
An Account is followed through its agent Subject. No follow grants membership or access, and no count grants
follower identities. Counts are private manager aggregates, never a public zero fallback.

**Research.** [Delivered report](accounts-design-follows.md) reuses the adopted twenty-product count survey and
adds primary journey/replay evidence; count runtime and receiving closure remain incomplete.
[ActivityPub §6.10](https://www.w3.org/TR/activitypub/#undo-activity-outbox) requires the original actor for Undo;
Mastodon [`app/services/unfollow_service.rb`](https://github.com/mastodon/mastodon/blob/f943e0583be804bb062e5c9a4f8e65e2a05e5346/app/services/unfollow_service.rb)
separates relationship removal from queued cleanup. These support authenticated reversal without adopting
federation or approval. W3C uses its permissive document licence, Mastodon AGPL-3.0; retained paths/versions
are in the report. Recommend current-state replacements in the existing TypeScript/PostgreSQL/DBOS stack.

| Page / journey                         | Method / endpoint → actual service path                                           | Authority / durable state → result or missing step                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection button                      | Session/CSRF BFF → `PUT`/`DELETE /v1/follows/{targetId}` → Library command/Access | Own active unfenced account, independent create/delete actions; `library.follow`, source trigger, receipt/outbox. Both UI branches currently advertise put.                                                    |
| State / Subject, agent, Space          | `GET /v1/follows/{id}`; existing PUT supports Subject/Collection/Space            | Own keyed edge, including explicit negative intent; absent 404. Subject/account/Space explicit controls absent; no Account edge type.                                                                          |
| `/library/following` continuation      | BFF → `GET /v1/follows?view=FULL&cursor=…` → current domain hydration             | `follow_account_page`, signed actor/epoch keyset; unavailable target retained as `target:null`, no total/list of followers; Space link absent.                                                                 |
| Remove unavailable / refollow / replay | Following DELETE → stored original edge → command                                 | Selected own-edge removal needs current scope/grant/principal, no target disclosure. Source currently rechecks target preflight and refuses hidden/deleted targets; create/refollow needs target at command T. |
| Entry implies follow                   | Subject Library slot → `PUT /v1/libraryEntries/{subjectId}` → Library             | Entry and `followFromLibrary` share account transaction; existing explicit negative intent wins. Clearing/restoring Entry is not unfollow/refollow.                                                            |
| Join/add/leave Realm                   | Membership BFF → Community/Auth workflow → separate Library `followForMembership` | Realm membership authority first, member-home follow later. 202 is pending; leave retains follow; delayed work cannot defeat explicit unfollow.                                                                |
| Manager/outgoing counts                | No UI/BFF/runtime route; required `/v1/followCounts/...` reads are contracts only | `follow_count_source`/owner metadata exist; bootstrap, target contribution/support/total, readiness and complete receiving delivery absent. Represented-row counter is not ready zero.                         |
| Canonical change / deletion            | Semantic identity participant; Auth barrier → existing Library erasure            | Canonical replacement and terminal receiving fence must precede source removal; local purge exists, complete count withdrawal/shared-copy acknowledgement does not.                                            |

**Next whole slices.** Accounts adopts unavailable-target own-edge removal now; manager coordinates Library/Web
contract adoption before their existing removal/control producer consumes it. Bind create/refollow target evidence
to command T and expose delete independently. Continue the sole full private-count and ALL-Library identity/erasure
producers, then Web management counts after real runtime reads and placement adoption. Existing metadata is a
delivered slice, not count readiness/outcome proof. Global admission order and `403 platform_closed` remain;
Root's exact count-only concealment adoption is pending and cannot silently change global behavior.

## Accounts, authentication, preferences and deletion

**Responsibility and design.** Accounts owns the five concepts and one permission formula, Auth authentication
and Access authority. Web owns BFF/Auth pages; Kernel command machinery and each data owner retain their stores.
Normative design is [Accounts](../accounts.md), [Auth](../../services/auth/README.md), Access and
[deletion](../deletion.md). Immediate refusal, Auth native local proof, shared-copy minimization, eleven-owner
closure and external/backup restore disposition are distinct obligations.

**Research.** [Delivered report](accounts-design-accounts-auth-deletion.md) supplies primary OAuth, WebAuthn,
credential, workflow and restore evidence; external receiver inventory and complete user controls remain partial.
[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) supports redirect/PKCE and refresh-replay defenses;
[PostgreSQL 18 recovery](https://www.postgresql.org/docs/18/continuous-archiving.html) explains why restored data
needs deletion replay. Comparative password/controller/notification recommendations do not adopt new policy.
The report records Better Auth `packages/oauth-provider/src/token.ts` (MIT), Discourse anonymization
(GPL-2.0-or-later) and DBOS `src/dbos.ts` (MIT), with retained paths, revisions and URLs; RFCs use IETF Trust terms.

| Page / journey                         | Method / endpoint → actual service path                                                                                                                                               | Authority / durable state → result or missing step                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Signup/login/key                       | Auth `/signup`, `/login` → `POST /signup`, `/signin`, `/signin/key` → native Access                                                                                                   | Registration stage/provisioning, `user`/credential/session, account/claim/floor; signup 201 creates no session; suspended password gives bounded refusal.                                        |
| Passkeys / security                    | Auth `POST /signin/passkey/options`, `/signin/passkey`, `/passkeys/register/options`, `/passkeys/register`, `/passkeys/remove`; `GET /passkeys`, `/sessions`; `POST /sessions/revoke` | Native challenges/passkeys/session keys, current credential proofs; last interactive credential protected. TOTP/backup controls, actor-wide passkey contract and `amr` alignment remain gaps.    |
| Website login/refresh/logout           | `/auth/sign-in` → Auth `/authorize`; callback → `/token`; `POST /auth/sign-out` → `/revoke`, `/logout`                                                                                | One-use DO login state, server-held tokens, refresh-family/consent authority; local logout is not proof of remote revocation.                                                                    |
| Recovery / consent                     | Auth `/recovery` → `POST /recovery/start`, `/recovery/complete`; `/consent` → `GET /consent/{client_id}`, `POST /consent`                                                             | Hashed recovery proof, Access-first floor, credential CAS; `auth_consent`/client reduction. Generic start response; delivery callback has no durable receiving result.                           |
| Profile/preferences                    | Web settings BFF → account PATCH; preference GET/PATCH                                                                                                                                | `account`, `account_preferences`, receipt/outbox; self-only settings/CAS; handleless/managed loading gaps and private historical copies remain.                                                  |
| Approved organization/delete           | Auth pages → same-origin `/account-operations/approve`, `/execute` → started `createAuthHost.handler` → native Access/DBOS                                                            | Exact operation/key, fresh proof, fixed organization/delete client; missing ports 503. Page server recognizes both pages; production page triggers omit them in this source.                     |
| Organization/operator/grants           | Existing approved membership/rename/transfer descriptors; native grant and suspend/reinstate APIs                                                                                     | Organization membership/owner checks, responsibility holds, resource grants/fences; general management pages/scoped client absent; automation creation/opening remain trusted methods.           |
| `/account/delete` then durable cleanup | Fresh confirmation → Access terminal barrier → Auth native pages → owner erasure                                                                                                      | `access.erasure`, `auth_erasure`, progress/locators and owner queues; immediate admission loss, exact minimal public tombstone. Enqueue/local absence is not eleven-owner closure.               |
| External copies / restore              | Adopted custody contract; no callable restore-source feed                                                                                                                             | Original obligation/version/source T, epoch, applicability and original 310-second consent due time survive retry/restore. Actual sinks, backup disposition and source admission remain missing. |

**Next whole slices.** Continue actual Auth/Web host lifetime/approval and production page routing using the fixed
two-profile client; never union website/login scopes. Existing Auth native proof/local-copy producers feed Access
residue and historical coverage, then receipt-key → preference custody → universal shared-history, without waiting
on global acknowledgement to retire native consumers. Eleven actual owners still owe closure; no replacement
harness is needed. Owned-client inventory, additional credential-control transport and restore-source APIs remain
explicit product gaps/proposals, unavailable to page callers until adopted/delivered. External receivers and
database/deployment owners must supply real copy/restore disposition; no new provider, retention schedule,
confirmation rule or deleted-account recovery is selected by this audit.
