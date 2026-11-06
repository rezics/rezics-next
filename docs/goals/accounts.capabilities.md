# Accounts capability acceptance

This manifest maps the accounts capabilities to native acceptance; product documents own behaviour.

Decision: capability rows record source-backed native coverage and its evidence limits; source presence alone does not claim execution, release, promotion or browser qualification. It covers [Agents and public profiles](../scope.md), [Follows](../scope.md), [Accounts, authentication, preferences and deletion](../scope.md), [Realms and Spaces (membership and Access)](../scope.md), [Notifications (preferences)](../scope.md), and [platform gates](../scope.md).

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
A prior supported run passed native same-database concurrent registrations across three close/relaunch
cycles. The latest combined run passed installed login receiving, startup client locking, persisted deployment
bindings, website consent renewal and the mounted website-scope/media configuration cases. Auth Pages, Auth
service and Kernel workspace typechecks passed. The fresh-stack browser case could not launch because neither
supported task executable was installed. Native erasure setup timed out, and subsequent workflow setup found
an existing process-wide DBOS owner, so that run did not repeat the registration lifecycle coverage.
Historical separate-system-store registration failures remain unqualified; these results do not establish
an integrated registration-to-Home completion.
The subsequent internal service-factory move passed the architecture check against its landing base. Two
supported remote submissions lost their connection during Auth service typing. Only Auth Pages typing
completed on that revision; service typing and focused native tests have no completed result after the move.

**Lifecycle journey acceptance:** Not accepted. This landing typechecks the written managed-account lifecycle, including OAuth website composition `cdae0566525fbbd87398c5f23dcfc5f2e54bed05`. Check `fe93067b-b74a-41fb-8f73-88d70dd89801` passed native-ready and developer-token, then organization creation returned HTTP503 `account_operation_denied`/`effect_status:not_applied` at `managed-accounts-seeded-walk.ts:556`. Native lifecycle, focused Auth creation/opening/membership/rename/transfer, and Web management fixtures remain as previously executed. The seeded multi-persona walk uses the stack host persona and public signup, talks to native Auth for HTTP, defers Vite until after native work, serves Kernel HTTP from that host, skips OpenSearch and the Kernel worker, and keeps one Chromium process; it does not run catalogue import or a second persona assemble. Checks 372c5fd6-82e7-4339-b7d8-b86a199f08b1, 9d3d14ee-1fc4-4a6b-b868-b73746a017ec, 40d48ab8-5c90-4290-9925-2e3287750d21 and ec795905-e787-417b-87fe-07d13e8e21b0 exceeded the 6 GiB run memory cap (import, duplicate assemble, Vite plus Chromium beside a second Kernel and OpenSearch).

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
consent renewal cases. Session and credential capability fixtures stopped at `KERNEL_RECEIPT_KEYS is required`;
they do not establish Security
review/readback or credential effects. Seeded browser and promoted desktop/phone evidence remain open.

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

**Native acceptance:** `bun run --cwd services/kernel check test/access/permission-outcome.test.ts`.

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

**Worker fixture evidence:** the canonical-target and agent-page-address fixtures register named actors through the
lifecycle registration commands and run the work executor in a child process. Their publication step needs Semantic52's
verify and unverify mapping, so these suites are not accepted until that delivery lands.

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

**Implementation choice:** Native fixtures issue parent-creation grants on the Global Context through ordinary `POST /v1/grants` receipts, using the grantor client's `access:grant` token, the same train Space HTTP and board-create fixtures use. Source boards are created through native Space, Realm, scheme, concept and board routes by the governance operator so Content delivery does not wait on Access admitting Space creation for ordinary accounts. Whether Access admits those ordinary-account rows remains an Access producer decision; it is carried by `.temp/continuation/access-parent-creation.md`. Community's current `refresh_space_discovery_tuple_witness` (`20261106043000_space_discovery_witness_locals.sql`) copies reference removals from the Space witness producer epoch; this consumer does not add a second Community migration. `space_discovery_tuple_reference` has no `producer_epoch` column, and selecting it failed `POST /v1/spaces` then `POST /v1/realms`. Kernel typecheck keeps one `deadlineLive` operand column and the consumed `live` column in `permission-check.sql`; the trailing duplicate alias is dropped so SQL analysis can name the row. Native reply-notice consumers keep `accounts.grant` and `GrowthDatabase` (`url`, instrumented `pool`, unexplained `admin`); grant writes ordinary receipts. Library `collection-source.ts` re-exports the work-dimension types its public facade already named.

**Decision:** Settings verification keeps original-command retry only while the command is uncertain without a matching receipt; a receipt never offers original retry, and matching payload alone does not prove success.

**Decision:** Existing Access preference, Content notification-outcome, notice-finalization, publication-driver, account-erasure-notices and Settings focused suites pin the installed lifecycle; no extra stories.

**Native evidence:** landing-command files on `eddee3c801` (check `9ac9f3f3`): `test/access/preferences-erasure.test.ts` 4 pass; `test/access/preferences.test.ts` 12 pass; `test/access/notification-preference-page.test.ts` 3 pass; `test/access/notification-preferences.test.ts` 10 pass and 1 fail (the client-declaration test, blocked by Library type errors on base). Acceptance `test/content/notification-outcomes.test.ts` 0 of 10 pass: every scenario stops at `POST /v1/spaces`, denied by Access on base. `test/content/notice-finalization.test.ts` 0 of 2 and `test/content/publication-driver.test.ts` fail for the same two reasons; `test/content/account-erasure-notices.test.ts` 1 of 3 passes. Kernel workspace typecheck (check `ed955086`) exits 2 with 11 errors in nine files, none in changed files; the list is in the continuation. Failures are named in the continuation.

**Mounted evidence:** local `bun test` over nine preference and Settings web files (`settings-notification-native-form`, `notification-preference-state`, `settings-notification-form-recovery`, `notice-preference-recovery`, `reading-preferences-journey`, `reading-preferences`, `shelf-preferences-advice`, `settings-reading-navigation`, `notifications-inbox`): 83 pass, 3 fail on base, none caused by this branch. Desktop and phone Settings browser journeys (`tests/settings-notifications.test.ts`, Playwright) were not run here.

**Promotion evidence:** none recorded; controller-owned after integration.

## terminal-erasure

**User job:** An account confirms deletion with fresh authentication and a typed confirmation, immediately loses credential authority, and has its private graph erased by each owner while eligible public contributions survive de-identified.

**Implementation choice:** Keep the eight outcome scenarios and their assertions intact; use deterministic fixture-only retention inputs and native `source.kind` Collection rules without selecting a production legal schedule.

**Personas:** Deleting owner; old-token owner; anonymous reader; Bob or other affected user; owner-specific data producers; ordinary restore attempt.

**Released fixture data:** `privacy` and `lifecycle/commerce` (accounts plus each owner); private and public data graph and terminal account records are produced by their owning stores.

**Surface cells:** Owner-store erasure evidence is defined by [deletion policy](../deletion.md); HTTP outcomes and payload removal are required.

| Cell                       | Acceptance                                                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue`                | `docs/deletion.md` owner-store policy; `specs/terminal-erasure-outcomes.test.ts` with binding `services/kernel/test/access/terminal-erasure-outcomes.test.ts` (binding missing).                                            |
| `curated`                  | `docs/deletion.md` owner-store policy; `specs/terminal-erasure-outcomes.test.ts` with binding `services/kernel/test/access/terminal-erasure-outcomes.test.ts` (binding missing) for private/unlisted Collections.           |
| `Everything without state` | `docs/deletion.md` owner-store policy; `specs/terminal-erasure-outcomes.test.ts` with binding `services/kernel/test/access/terminal-erasure-outcomes.test.ts` (binding missing) for personal sources.                       |
| `own state`                | `docs/deletion.md` owner-store policy; `specs/terminal-erasure-outcomes.test.ts` with binding `services/kernel/test/access/terminal-erasure-outcomes.test.ts` (binding missing) for entries, labels and sessions.           |
| `mounted Zone`             | `docs/deletion.md` owner-store policy; `specs/terminal-erasure-outcomes.test.ts` with binding `services/kernel/test/access/terminal-erasure-outcomes.test.ts` (binding missing) for prepared exports and Zone sources.      |
| `TypeList`                 | `docs/deletion.md` owner-store policy; `specs/terminal-erasure-outcomes.test.ts` with binding `services/kernel/test/access/terminal-erasure-outcomes.test.ts` (binding missing) for owner stores represented by a TypeList. |

**Frozen scenarios:** Existing: “native completion purges every targeted history and copies while retaining unrelated authors” and “a suspension ends an erasure started before it, and reinstatement does not resume it” (`specs/erasure-operation-outcomes.test.ts`; native binding: `services/kernel/test/content/erasure-operation-outcomes.test.ts`). Missing: `terminal-erasure-graph` — `specs/terminal-erasure-outcomes.test.ts` with binding `services/kernel/test/access/terminal-erasure-outcomes.test.ts` (binding missing), per accounts scenario A5 in `docs/research/api-acceptance-gaps.md`. No ordinary restore can resurrect the account.

**Native acceptance:** `bun run --cwd services/kernel check test/content/erasure-operation-outcomes.test.ts test/access/account-lifecycle-outcome.test.ts test/access/terminal-erasure-outcomes.test.ts`.
