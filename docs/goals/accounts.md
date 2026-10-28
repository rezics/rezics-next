# Accounts and platform gates

## Outcome

People and automated actors can authenticate, manage their public identity and preferences, delegate authority and
exercise only the permissions they hold. Operators can open product capabilities through ordinary grants.

## Done when

- Registration, sign-in, sessions, recovery, step-up and account lifecycle work through real Auth and kernel Access.
- The shared permission formula is exercised with each operand independently denying; anonymous, ordinary,
  automated, organization, suspended and revoked callers have the outcomes specified by the owner contracts.
- Public profiles and agent identity are available without exposing private account data.
- Platform exposure declarations, grant/revoke and public opening work without a parallel flag service. Generated
  operation discovery matches the viewer's available operations.
- Membership and ban changes protect every affected read immediately while bounded cleanup proceeds.
- Preferences and account deletion satisfy their lifecycle contracts across consumers, including erasure handoff.

Completion requires the scoped outcomes on main with recorded checks covering the promoted commit. Specified,
implemented, exposed, tested and promoted are separate states; a passing local check alone does not complete a Goal.

## Scope

Includes Auth, Access, operators, grants, memberships, platform gates, public profiles and account preferences.
Consumer-specific content, library and interface implementation stays with its owner. Follow [public scope](../scope.md);
a future adapter is not required merely because operation discovery supports it.

## Ownership

Owns `services/auth/**`, `services/kernel/{src,db,test}/access/**`, and `packages/auth-contract/**`.
[Auth](../../services/auth/README.md), [Access](../../services/kernel/src/access/README.md) and
[platform gates](../../services/kernel/src/access/gates/README.md) own the contracts;
[deletion](../deletion.md) owns lifecycle policy. Kernel owns partition and request machinery. Web owns Auth pages;
content owns community resources; commerce owns library follow storage.

## Dependencies

Requires kernel commands, routed storage, ordinary grant routes and resource declarations. Supplies authentication,
authorization, creation grants, membership and lifecycle ports to all product modules. Agree shared runtime changes
before consumers adopt them; use the shared production-default test factories.

## Acceptance

Use the [accounts capability acceptance manifest](accounts.capabilities.md) to map every scoped capability to its
personas, released fixtures, surface evidence, frozen scenarios and native acceptance command.

Use the [permission outcomes](../../specs/permission-outcomes.test.ts),
[account workflow outcomes](../../specs/native-account-workflow-outcomes.test.ts),
[platform gate outcomes](../../specs/platform-gates-outcomes.test.ts), and native tests under
`services/kernel/test/access/` and `services/auth/`. Include denial, replay, revocation, lifecycle and unavailable
dependencies through real boundaries. Carry adopted suspended-credential expectations into Auth/Access and frozen acceptance before dependent briefs;
the exact response mapping belongs to those contracts. Run the applicable workspace commands from their manifests;
a shared kernel runtime contract change requires `bun run --cwd services/kernel check`.
Use [verification](../development/verification.md) for root typecheck, growth and promotion evidence.

## External conditions

Production identity, mail and abuse-prevention integrations must be configured through supported interfaces.
Provisioning and private deployment values are external; deterministic functional acceptance must not wait for them.
