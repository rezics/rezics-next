Goal: accounts. Manager: accounts.

Delivered: producer-derived shared sign-in DTO/error/proof bounds, native discoverable options byte receiving and projection, and a reusable five-second browser sign-in receiver. Browser receiver is deliberately not yet wired into installed callers: this is a coherent first part, not complete acceptance.

Continue from the current commit; do not rebase. Read the original contract and sign-in/passkey/account-operation/management sections of services/auth/README.md and apps/auth/README.md.

Wire apps/auth/src/sign-in-transport.ts into sign-in.ts, passkeys.ts and the existing password reauthentication adapters in step-up.ts, automated-account-create.ts, operator-transfer.ts and organization-membership.ts. Preserve their state machines, original return custody and existing independent native reads. Update signInResult to recognize native 429 authentication_denied and 403 ACCOUNT_SUSPENDED as admitted refusal; malformed acknowledgements must remain unknown. Preserve the four-minute shared options cache and eviction, current guards and clear-before-assertion semantics.

Existing browser fixtures in login.test.ts and step-up.test.ts return empty/success JSON; replace only sign-in acknowledgements with complete native proofs bound to submitted fixed profiles. Passkeys tests/cost fixtures return localhost RP options: reconcile browser test hosting with actual pinned rezics.com RP output rather than broadening the production parser. Installed consumer tests must show malformed 200 cannot navigate/complete step-up, retired replies retain original unresolved history, no automatic resend/readback and failed options cannot start a prompt. Native authenticator/password proof tests remain to be expanded and run; source projection fixtures do not qualify native/browser acceptance.

Finish owner paragraphs with installed browser receiving, fixed-profile formula, unknown custody and cache behavior after wiring. Run changed tests once with bun test <files>, commit before checks/after fixes, and typecheck all changed workspaces. Full native/browser/root acceptance stays with integration.
