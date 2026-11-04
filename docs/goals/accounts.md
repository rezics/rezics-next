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

## Scope and ownership

Accounts owns native Auth and Access, `apps/auth/**`, `packages/auth-contract/**` and pure `packages/access/**`,
including native profile, verification, preferences and identity-publication semantics. Native Access lives under
`services/kernel/{src,db,test}/access/**`; that placement does not transfer Kernel's command, storage, request or
execution machinery to Accounts. Web and Performance own their Settings and account-page consumers. Content,
Commerce, Semantic, Search and generated publication retain their module ownership.

[Accounts](../accounts.md) owns identity, delegation, consent and preference policy;
[deletion](../deletion.md) owns erasure and restore policy;
[native Auth](../../services/auth/README.md) owns protocol and trusted composition;
[Auth pages](../../apps/auth/README.md) owns browser behavior;
[native Access](../../services/kernel/src/access/README.md) owns preparations, disclosure and bounded native work.
The [adopted Access architecture](../architecture.md) places pure policy behind the public
`packages/access/src/index.ts` entry. [Platform gates](../../services/kernel/src/access/gates/README.md) retain their
native exposure contract. Follow [public scope](../scope.md); future adapters are not required merely because
operation discovery supports them.

## Dependencies

Requires kernel commands, routed storage, ordinary grant routes and resource declarations. Supplies authentication,
authorization, creation grants, membership and lifecycle ports to all product modules. Kernel owns shared runtime
contracts and production-default test composition.

## Acceptance

Use the [accounts capability acceptance manifest](accounts.capabilities.md) to map every scoped capability to its
personas, released fixtures, surface evidence, frozen scenarios and native acceptance command.

Use the [permission outcomes](../../specs/permission-outcomes.test.ts),
[account workflow outcomes](../../specs/native-account-workflow-outcomes.test.ts),
[platform gate outcomes](../../specs/platform-gates-outcomes.test.ts), and native tests under
`services/kernel/test/access/` and `services/auth/`. Include denial, replay, revocation, lifecycle and unavailable
dependencies through real boundaries, including the adopted suspended-credential response mapping in Auth/Access.
Acceptance evidence follows [verification](../development/verification.md), with scoped workspace, growth and
promotion evidence bound to the promoted revision.

## External conditions

Production identity, mail and abuse-prevention integrations must be configured through supported interfaces.
Provisioning and private deployment values are external; deterministic functional acceptance must not wait for them.
