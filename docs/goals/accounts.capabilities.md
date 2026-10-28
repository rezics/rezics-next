# Accounts capability acceptance

This manifest maps the accounts capabilities to native acceptance; product documents own behaviour. It covers [Agents and public profiles](../scope.md), [Follows](../scope.md), [Accounts, authentication, preferences and deletion](../scope.md), [Realms and Spaces (membership and Access)](../scope.md), [Notifications (preferences)](../scope.md), and [platform gates](../scope.md).

Every capability uses the `privacy` fixture contract from `docs/research/api-acceptance-gaps.md`, produced by accounts and each participating producer. It includes a suspended valid bearer, revoked token, unscoped actor and delegated agent. Fixture identities are created by native test support in `services/kernel/test/support/personas.ts`.

## authentication

**User job:** A person or API consumer registers, signs in, maintains a session, recovers access, completes step-up and signs out through real Auth and kernel bearer checks.

**Personas:** Anonymous visitor; active human; automated actor; organization; expired token; revoked token; fenced account (401); suspended account with a valid bearer (403 `account_suspended` on every route). Cases expecting 401 for a suspended valid bearer belong to the task that changes those cases.

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

**Frozen scenarios:** Existing: “person registration claims pending handle and authenticates the same immutable account through Better Auth” and “Access commits epoch fence and durable receipt before Auth revokes sessions and stale recovery cannot undo it” (`specs/account-lifecycle-outcomes.test.ts`). Existing: “a person opens a session only with its own credential” (`specs/account-lifecycle-outcomes.test.ts`). Missing: `authentication-bearer-personas` — `services/kernel/test/access/authentication-user-cases.test.ts` (to freeze).

**Native acceptance:** `bun test specs/account-lifecycle-outcomes.test.ts services/auth/test/workflows.test.ts services/kernel/test/access/session-revocation.test.ts services/kernel/test/access/suspension.test.ts services/kernel/test/access/authentication-user-cases.test.ts`.

## permission-formula

**User job:** An actor performs an operation only when actor grants, consented client scopes and principal grants all permit it, subject to the anonymous floor and explicit denials.

**Personas:** Anonymous; ordinary human; automated actor; organization; delegated actor and principal; suspended; revoked; callers independently missing each operand. A ban defeats any independent read grant.

**Released fixture data:** `privacy` (accounts and each producer); grant, consent, principal and ban fixtures are produced by native Auth/Access test support.

**Surface cells:**

| Cell                       | Acceptance                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue`                | `services/kernel/test/access/permission-outcome.test.ts` exercises the consumer formula.                                                        |
| `curated`                  | `specs/viewer-actions-outcomes.test.ts` exercises Collection consumers; `services/kernel/test/access/permission-outcome.test.ts` covers Access. |
| `Everything without state` | `services/kernel/test/access/permission-outcome.test.ts` for consumer formula; no distinct Everything-specific formula.                         |
| `own state`                | `services/kernel/test/access/permission-outcome.test.ts` for consumer formula; own state uses the same Access formula.                          |
| `mounted Zone`             | `services/kernel/test/access/permission-outcome.test.ts` for consumer formula; Zone uses the same Access formula.                               |
| `TypeList`                 | `services/kernel/test/access/permission-outcome.test.ts` for consumer formula; no TypeList-specific formula.                                    |

**Frozen scenarios:** Existing: “actor grant AND consented scope AND principal grant permit the same action and resource”, “revoking only the actor grant denies”, “revoking only client consent denies an already authenticated request”, “revoking only the principal grant denies”, “active explicit denies override each account grant”, “without a principal actor grants and consent suffice”, “suspended and deleted actors fail closed” (`specs/permission-outcomes.test.ts`). Missing: `ban-beats-independent-read-grant` — `services/kernel/test/access/permission-user-cases.test.ts` (to freeze). Existing suspended expectations that return 401 require owner reconciliation; valid suspended bearers on every route must return 403 `account_suspended`.

**Native acceptance:** `bun test specs/permission-outcomes.test.ts services/kernel/test/access/permission-outcome.test.ts services/kernel/test/access/permission-user-cases.test.ts`.

## platform-gates

**User job:** An operator exposes product operations through declared gates, grants and revocations, including public opening, without a separate flag service.

**Personas:** Anonymous; ordinary account; gate holder; delegated gate recipient; caller with `gate:<group>` or `gate:any`; caller before and after revocation; platform operator.

**Released fixture data:** `privacy` (accounts produces personas); exposure declarations are produced by the kernel route catalogue.

**Surface cells:** Gates apply to operation availability, not list membership.

| Cell                       | Acceptance                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `catalogue`                | `specs/platform-gates-outcomes.test.ts` verifies route exposure and viewer-visible operations.             |
| `curated`                  | `specs/platform-gates-outcomes.test.ts` verifies gated operation admission; no separate curated list rule. |
| `Everything without state` | `specs/platform-gates-outcomes.test.ts` verifies shared gate admission; no separate Everything list rule.  |
| `own state`                | `specs/platform-gates-outcomes.test.ts` verifies shared gate admission; no separate own-state list rule.   |
| `mounted Zone`             | `specs/platform-gates-outcomes.test.ts` verifies shared gate admission; no separate Zone list rule.        |
| `TypeList`                 | `specs/platform-gates-outcomes.test.ts` verifies shared gate admission; no separate TypeList list rule.    |

**Frozen scenarios:** Existing: “a route without a valid x-exposure is refused when the kernel is built”, “a closed operation answers the same 403 platform_closed to anonymous callers and ordinary accounts”, “a gated tester with the group's gate on the Global Context succeeds and loses it at revocation”, “platform staff holding gate any use every closed group and grant one gate to another account”, “opening a group in the exposure catalogue makes it public with no code change and closing it restores the denial” (`specs/platform-gates-outcomes.test.ts`).

**Native acceptance:** `bun test specs/platform-gates-outcomes.test.ts`.

## agent-identity

**User job:** A reader resolves one public page for a human, organization or software agent and follows a verified subject address to the active account handle.

**Personas:** Anonymous reader; human, organization and software agents; verified subject-address visitor; operator; outsider; active and hidden/private agent.

**Released fixture data:** `privacy` (accounts and semantic producer); account-agent identities and verified subjects are produced by accounts fixtures.

**Surface cells:**

| Cell                       | Acceptance                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue`                | Missing `agent-identity` in `services/kernel/test/access/profile-user-cases.test.ts` (to freeze), covering subject and agent resolution. |
| `curated`                  | Not applicable: identity resolution does not enumerate curated Collection membership.                                                    |
| `Everything without state` | Not applicable: identity resolution does not enumerate Everything membership.                                                            |
| `own state`                | Not applicable: identity resolution is public identity, not personal state.                                                              |
| `mounted Zone`             | Missing `agent-identity` in `services/kernel/test/access/profile-user-cases.test.ts` (to freeze), including page-read resolution.        |
| `TypeList`                 | Not applicable: identity resolution does not enumerate a TypeList.                                                                       |

**Frozen scenarios:** Existing: “automated profile and attribution disclose operator while private data stays absent” (`specs/account-lifecycle-outcomes.test.ts`). Missing: `agent-identity` — `services/kernel/test/access/profile-user-cases.test.ts` (to freeze); exact behavior is specified in `docs/research/api-acceptance-gaps.md`, accounts scenario A1. An operator relationship gives no agent authority or private profile disclosure.

**Native acceptance:** `bun test specs/account-lifecycle-outcomes.test.ts services/kernel/test/access/account-agent-effect.test.ts services/kernel/test/access/profile-user-cases.test.ts`.

## self-profile

**User job:** An account updates its public profile fields and public views over HTTP while other readers see only the fields allowed by those views.

**Personas:** Alice (owner), Bob (reader), anonymous reader, unscoped caller, revoked caller, delegated editor; verification and preferences use their separate authority.

**Released fixture data:** `privacy` (accounts produces personas and privacy controls); no catalogue release is needed.

**Surface cells:**

| Cell                       | Acceptance                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `catalogue`                | Missing `self-profile-http` in `services/kernel/test/access/profile-user-cases.test.ts` (to freeze), including public subject reads. |
| `curated`                  | Not applicable: profile mutation and disclosure are account operations, not curated membership.                                      |
| `Everything without state` | Not applicable: profile fields do not change Everything membership.                                                                  |
| `own state`                | Missing `self-profile-http` in `services/kernel/test/access/profile-user-cases.test.ts` (to freeze), including owner profile read.   |
| `mounted Zone`             | Not applicable: profile edits are not Zone mounted-list operations.                                                                  |
| `TypeList`                 | Not applicable: profile edits do not affect TypeList membership.                                                                     |

**Frozen scenarios:** Existing: “actors and organizations default to all public views and can independently turn each off and on” and “invalid view patches and other accounts cannot change presentation fields” (`services/kernel/test/access/account-public-views.test.ts`); “profile patch sets and clears links, refuses invalid links and preserves the previous value on refusal” (`services/kernel/test/access/account-profile-read.test.ts`). Missing: `self-profile-http` — `services/kernel/test/access/profile-user-cases.test.ts` (to freeze). Profile update is a per-field merge-patch with no revision precondition; last write wins per field, and replay with the same idempotency key is stable. Verification and preferences retain their own commands and authority.

**Native acceptance:** `bun test services/kernel/test/access/account-public-views.test.ts services/kernel/test/access/account-profile-read.test.ts services/kernel/test/access/profile-user-cases.test.ts`.

## follow-owner-counts

**User job:** A person follows an eligible subject, agent, Space or Collection and sees only their own outgoing count or the incoming count they own.

**Personas:** Follower; target owner; stranger; anonymous; suspended; delegated Space manager; revoked Collection manager.

**Released fixture data:** `privacy` (accounts and each target producer); explicit follow edges and target ownership are produced by native accounts/commerce/content fixtures.

**Surface cells:**

| Cell                       | Acceptance                                                                      |
| -------------------------- | ------------------------------------------------------------------------------- |
| `catalogue`                | `specs/follow-counts-outcomes.test.ts` covers subject counts.                   |
| `curated`                  | `specs/follow-counts-outcomes.test.ts` covers Collection counts and management. |
| `Everything without state` | Not applicable: counts are never listed, sorted or filtered on.                 |
| `own state`                | Not applicable: counts are never listed, sorted or filtered on.                 |
| `mounted Zone`             | Not applicable: counts are never listed, sorted or filtered on.                 |
| `TypeList`                 | Not applicable: counts are never listed, sorted or filtered on.                 |

**Frozen scenarios:** Existing: “follower counts are visible only through existing target management authority and outgoing follows only to their follower”, “Space management uses its installed role through native Access”, “revoked Collection management and ordinary unowned subjects conceal follower counts”, “anonymous suspended no-scope and closed gate requests fail closed without disclosing counts”, “follow unfollow receipt replay and duplicate projection effects preserve a single source edge” (`specs/follow-counts-outcomes.test.ts`). The complete frozen suite is to be bound natively as specified by accounts scenario A3 in `docs/research/api-acceptance-gaps.md`.

**Native acceptance:** `bun test specs/follow-counts-outcomes.test.ts`.

## advertised-actions

**User job:** A client discovers exactly the operations the current Access grants permit and executes them only while those grants remain valid.

**Personas:** Curator; delegated editor who is not curator; anonymous reader; suspended account; caller with independently revoked actor grant, principal grant or client consent.

**Released fixture data:** `privacy` (accounts and participating resource producers); Collection, Realm, Space and subject resources are produced by their owning fixtures.

**Surface cells:**

| Cell                       | Acceptance                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue`                | Missing `advertised-actions` in `services/kernel/test/access/viewer-actions-user-cases.test.ts` (to freeze), for catalogue subject actions. |
| `curated`                  | `specs/viewer-actions-outcomes.test.ts` covers Collection detail and list rows.                                                             |
| `Everything without state` | Not applicable: Everything discovery does not advertise per-resource mutations.                                                             |
| `own state`                | Not applicable: own-state list rows are not viewer-action discovery resources.                                                              |
| `mounted Zone`             | Not applicable: Zone membership is not an advertised-action resource cell.                                                                  |
| `TypeList`                 | Missing `advertised-actions` in `services/kernel/test/access/viewer-actions-user-cases.test.ts` (to freeze), for TypeList rows.             |

**Frozen scenarios:** Existing: “a delegated editor who is not the curator is offered the same operations”, “the same editor after the grant is revoked is offered nothing on the next read with the same bearer and the edit is refused”, “an assigned actor whose principal lacks the action or is suspended or whose assignment was revoked is offered nothing for it”, “a visible resource with no allowed action answers an empty list while a failing dependency answers 503 with no partial positives” (`specs/viewer-actions-outcomes.test.ts`). Missing: `advertised-actions` — `services/kernel/test/access/viewer-actions-user-cases.test.ts` (to freeze), covering catalogue subjects, Realm, Space and TypeList resource rows in addition to the existing Collection cases.

**Native acceptance:** `bun test specs/viewer-actions-outcomes.test.ts`.

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

**Frozen scenarios:** Existing: “a banned Realm member loses join and participate while unrelated reads keep their own answers” (`specs/viewer-actions-outcomes.test.ts`). Missing: `protected-ban-barrier` — `services/kernel/test/content/protected-ban-user-cases.test.ts` (to freeze), per accounts research scenario R2. The decisive fixture has no independent read grant; ban precedence over an independent grant is specified separately by `permission-formula`.

**Native acceptance:** `bun test specs/viewer-actions-outcomes.test.ts services/kernel/test/content/protected-ban-user-cases.test.ts`.

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

**Frozen scenarios:** Existing: “preferences return every optional notification kind as enabled until the account turns one off and no default is stored”, “notificationAllowed follows the recipient's setting for an optional kind”, and “another account cannot read or set notification preferences” (`services/kernel/test/access/notification-preferences.test.ts`). Missing: `notification-send-time-access` — `services/kernel/test/access/notification-preferences.test.ts` (to freeze), covering access recheck at content send time.

**Native acceptance:** `bun test services/kernel/test/access/notification-preferences.test.ts`.

## terminal-erasure

**User job:** An account confirms deletion with fresh authentication and a typed confirmation, immediately loses credential authority, and has its private graph erased by each owner while eligible public contributions survive de-identified.

**Personas:** Deleting owner; old-token owner; anonymous reader; Bob or other affected user; owner-specific data producers; ordinary restore attempt.

**Released fixture data:** `privacy` and `lifecycle/commerce` (accounts plus each owner); private and public data graph and terminal account records are produced by their owning stores.

**Surface cells:** Owner-store erasure evidence is defined by [deletion policy](../deletion.md); HTTP outcomes and payload removal are required.

| Cell                       | Acceptance                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue`                | `docs/deletion.md` owner-store policy; missing `terminal-erasure-graph` in `services/kernel/test/access/terminal-erasure-user-cases.test.ts` (to freeze).                                            |
| `curated`                  | `docs/deletion.md` owner-store policy; missing `terminal-erasure-graph` in `services/kernel/test/access/terminal-erasure-user-cases.test.ts` (to freeze) for private/unlisted Collections.           |
| `Everything without state` | `docs/deletion.md` owner-store policy; missing `terminal-erasure-graph` in `services/kernel/test/access/terminal-erasure-user-cases.test.ts` (to freeze) for personal sources.                       |
| `own state`                | `docs/deletion.md` owner-store policy; missing `terminal-erasure-graph` in `services/kernel/test/access/terminal-erasure-user-cases.test.ts` (to freeze) for entries, labels and sessions.           |
| `mounted Zone`             | `docs/deletion.md` owner-store policy; missing `terminal-erasure-graph` in `services/kernel/test/access/terminal-erasure-user-cases.test.ts` (to freeze) for prepared exports and Zone sources.      |
| `TypeList`                 | `docs/deletion.md` owner-store policy; missing `terminal-erasure-graph` in `services/kernel/test/access/terminal-erasure-user-cases.test.ts` (to freeze) for owner stores represented by a TypeList. |

**Frozen scenarios:** Existing: “native completion purges every targeted history and copies while retaining unrelated authors” and “a suspension ends an erasure started before it, and reinstatement does not resume it” (`specs/erasure-operation-outcomes.test.ts`). Missing: `terminal-erasure-graph` — `services/kernel/test/access/terminal-erasure-user-cases.test.ts` (to freeze), per accounts scenario A5 in `docs/research/api-acceptance-gaps.md`. No ordinary restore can resurrect the account.

**Native acceptance:** `bun test specs/erasure-operation-outcomes.test.ts services/kernel/test/access/account-lifecycle-outcome.test.ts services/kernel/test/access/terminal-erasure-user-cases.test.ts`.
