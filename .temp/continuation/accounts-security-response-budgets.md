Goal: accounts  
Manager: accounts

## Outcome

Finish the Auth receiver for native Security fixed-shape response budgets after the native owner exposes a
scope-independent public accessor for `securityPage`, `passkeys` and `registrationPage`. The integrated
`securityResponseByteBudgets(scopeLimit, selectedLimit=20)` currently requires a scope operand; do not pass guessed
C or duplicate its formulas. The request for the missing export was sent to the accounts owner.

## Remaining work

- Use the exact admitted fixed budgets with `readJsonBounded` for `/security-page`, `/passkeys`, `/registration-page`
  and the duplicate `/registration-page` password-limits read. Validate a finite safe byte allowance before reading.
- Carry the effective BFF request signal and five-second native deadline through body consumption. Preserve the
  browser `privateAuthRead` race, cancellation, mappings, independent Security sections and operation custody.
- Add focused production-source stream cases in the existing endpoint tests for native legal maxima, split UTF-8,
  absent/dishonest Content-Length, single/chunked overflow, malformed JSON, body stall/caller retirement and unchanged
  native call count. Reuse existing transport fixtures; no new journeys.
- Update `apps/auth/README.md` with the exact accessor, covered fixed endpoints and remaining trusted-C requirement
  for `/session`, `/clients` and `/consents`. Do not claim those readers or the public consent approval page are covered.
- Commit before checks; run the changed focused test files with `bun test <files>` and `bun run --cwd apps/auth typecheck`.

## Preserved behavior

Keep signed-out/denied/unavailable distinctions, current-session membership, exact IDs and duplicate checks,
truncation/completeness, WebAuthn support separation, registration dependency/verification/already-signed-in states,
password-advice unavailability, exact-origin and no-store handling, and existing native call counts.
