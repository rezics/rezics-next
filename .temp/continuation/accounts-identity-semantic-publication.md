# Accounts identity Semantic publication continuation

Goal: accounts. Manager: accounts.

## Delivered here

- Identity fixtures for the canonical-target, agent-page-address and public-view suites register each named actor
  through the production lifecycle (`registrationTarget` path via `reserveHandle`, `createPending`, `activate`,
  `claimHandle`) in `services/kernel/test/support/identity-registration.ts`. `createRealAccess` takes a `registered`
  option that skips the raw account insert for those personas.
- The production work executor runs in a child process (`services/kernel/test/support/identity-work-child.ts` and
  `identity-work-process.ts`). The test process keeps only its DBOS client for enqueueing.

## Undelivered producer (Semantic)

`services/kernel/src/semantic/identity-epoch-mapping.ts`, `stepIdentityEpochMapping`, currently accepts only
`subject.merge` receipts. Every other receipt, including the Accounts account-agent intents, fails with:

    unavailable('Accounts immutable source-intent custody is required')

The Accounts side is delivered: verification and reversal write `access.agent_identity_intent` in the original native
transactions (`services/kernel/src/access/agent-verification-identity*.ts`). The adopted contract is
`services/kernel/src/semantic/identity-epoch-contract.md`, sections "Accounts source intent and workflow boundary" and
"Bounded native mapping and fixed participants". The coordinator exports `resumeIdentityEpochJob` and
`waitIdentityEpochPublished` already exist (`services/kernel/src/semantic/identity-epoch-coordinator.ts`); the Accounts
adapter in `services/kernel/src/access/agent-verification-identity.ts` resolves them.

Until Semantic accepts `account-agent.verify` and `account-agent.unverify` receipts backed by the intent table, no
verification publishes. The retryable failure keeps the same intent and receipt; nothing is faked.

## Acceptance that receives it

- `bun run --cwd services/kernel check test/access/account-canonical-targets.test.ts`
  (currently 0 of 6 expected to pass on base; see the canonical-target contract).
- `bun run --cwd services/kernel check test/presentation/agent-page-address.test.ts`
  (currently 1 of 8).
- `bun run --cwd services/kernel check test/access/agent-identity-recovery-retention.test.ts`.

## Other dependencies named by the brief (not blockers for this part)

- Access: shared grant and policy fixture receiving. Grant rows in these suites are still raw `access.resource_grant`
  inserts.
- Auth: registration producer. Native personas (`createPersonas`) already register through Auth; the identity
  fixtures above use the Kernel lifecycle path directly.
- Community: witness epoch migration and replay.
