# Finish the ALL-Library identity bodies before the single composed landing check

Goal: commerce
Manager: commerce

This is the same complete outcome (decision commerce:complete-outcome-single-check-43898), not a separate Goal. It
records the bodies still missing and the failure classes still open, so the next attempt can finish them and then
submit ONE composed landing check.

## Delivered on this branch

- Frame-driven step order inside `stepLibraryIdentityEpochWithSource`: native receiving effects, source scopes, one
  follow page, one canonical store call per collection, then handoff and closure reporting. States: `progress`,
  `source-scopes`, `follow-progress`, `canonical-progress`, `canonical-blocked`, `owner-handoff`, `closed`.
- Follow obligations on the first native OLD, NEW or first-apply row per (job, original, disposition); cursor in
  `follow_partition`/`follow_after`; terminals from `identity_scope_effect.operation.change`; foreign followers as
  `foreign-owner` handoffs with the target in the locator.
- Canonical stage: observe, head, begin, one step, publish per collection; each store call composed under the frame
  at its declared per-call ceiling and settled from the store's usage.
- Optional Library command runner (received from the Content change, 31d33a6ece) threaded through the binding
  (ef69ebc5a9); default `runCommand`.
- Library producer seams from the owner amendment: preparation bases carry `source`; the saved collection list returns
  mutable member arrays; search, access and HTTP mocks implement `savedCatalogueMembers`; receipt keys are provided
  to the command-kernel suites (336aa73dbd).

## Missing bodies

1. Owner closure proof per (owner, canonical): page `readLibraryIdentityCandidatePage` (no caller yet), fold the
   highest live `owner_write_seq` winner, reject unready originals (null sequence or pin, unready presence), and
   verify live-parent labels from `readOwnerOriginalTruth`. The stage needs a durable page cursor. No cursor storage
   exists for it; a per-(job, owner, canonical) cursor needs a migration and schema change, or a re-verified bounded
   read that cannot resume. Choose one and keep the schema dump in step with the migration.
2. Cost declarations for Semantic: an exported operation list with the inclusive `WorkDimensions` each stage reserves.
   The follow page as written reads up to 100 followers and can exceed the installed Library statement ceiling
   (`LIBRARY_STATEMENTS` default 128). Lower the page size to a value whose statement bound fits the ceiling
   (about 16 statements per follower), and derive the declared bound from that count. Record it as a bound until a
   growth check measures it.
3. Late births and first apply before original commit: first-apply rows are planned, but no birth enrollment exists.
   Writer-side enrollment in the entry writers is outside this outcome's paths; name it as a producer dependency if it
   stays there, or implement the enrollment guard in the owner module.
4. Named native acceptance tests: merge, repoint and supported published undo; partial failure and rollback; lost
   result; exact replay; behind-frontier first apply. They need the native fixture. The profile-entry fixture is
   blocked by the shared grant administration fixture (Provider and Accounts repair it).
5. Fixed participant receipt: reconcile only after the complete current role, owner and follow proof exists (item 1).
   Semantic composes the three native receipts inside its Source maintenance custody.

## Open failure classes from check 28b460a3 (fix before the composed submission)

- A. Receipt-key environment for the command-kernel suites: repaired in 336aa73dbd; not yet re-verified.
- B. `test/library/command-support.test.ts` "trusted workflow steps ... keep account attribution": the
  `core.receipt` row for the trusted account is not written. `trustedAccount` calls the executor with a legacy receipt
  (`actorAccountId`) and no `...identity`; receipt keys bind only with options.principal (command.ts ~615); the
  receipt row is written only when `input.receipt` exists (fence.sql). Establish the actual receipt path from a trace
  of this test, then repair the trusted path so the attribution and the write basis both hold.
- C. `test/search/members-native-scope.test.ts` "genuine Members native scopes ...": `GET /v1/collections/:id/members`
  returns 404 after the preparation source fixture fix. Trace the 404 through the collection members route and the
  preparation lookup before the fixture is considered correct.
- D. Base, not this outcome: `test/search/service-scope.test.ts` (grant administration 403) and
  `test/search/members-native-scope.test.ts` ("Operator governance bootstrap is unavailable"). Provider and Accounts own
  the grant repairs. Name them in the composed submission.
- E. Base, not this outcome: `test/library/identity-scope-effects.test.ts` GrantDeniedError from the shared profile
  fixture (base commit 8b7e725c38).

## Verification notes

- Architecture check passes against the base for every commit on this branch.
- The last composed check was not resubmitted: the owner decision withholds submissions until the outcome is
  complete.
