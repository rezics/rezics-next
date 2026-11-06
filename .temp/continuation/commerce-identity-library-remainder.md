# Complete the Library side of the fixed ALL-Library identity participant

Goal: commerce
Manager: commerce

## Delivered on this branch

- Source-basis invalidation for each sealed Library receiving effect, with the immutable receiving frontier,
  release of the home, independent reconciliation and control custody (`applySourceInvalidation`).
- One sealed native plan effect per call (`applyLibraryPlanEffect`): the operation is reread from the sealed
  manifest, the owner candidate is applied through `applyLibraryIdentityCandidate`, the frontier is recorded, and
  the effect is reconciled and custodied. Foreign-home, frozen-output and public-output authority gaps retain an
  exact owner handoff (`retainOwnerHandoff`).
- Bounded scope advancement over one sealed manifest page (`advanceLibraryIdentityNativeScope`).
- Default Library binding `createLibraryIdentityEpochReceiver({ pool, frame })` and
  `createLibraryIdentityNativePlanner({ pool, frame })` in `services/kernel/src/library/module.ts`. Library receives
  Semantic's live Source frame as the injected `LibrarySourceFrame` accessor; it does not import the frame module.
- The fixed `stepLibraryIdentityEpoch` applies source invalidation for the first effect and then reports the
  remaining work as unavailable. It never mints the fixed receipt from an empty queue, and it refuses native
  six-driver effects unless Semantic's frame drives them.

## Remaining Library work

1. OLD withdrawal and NEW addition. Owner candidate rows are written, but no canonical generation is repaired or
   published for the member, entry, label, session, copy and output roles. The identity path does not call
   `beginCanonicalSourceRepair`, `repairCanonicalSourceStep` or `publishCanonicalSourceRepair`
   (`canonical-source-store.ts`). Bind them per affected collection under the retained source generation and
   frontier, then read back the current members, winners and labels.
2. Owner candidates, support and winners. `readLibraryIdentityCandidatePage` in `owner-identity.ts` has no caller.
   Select the highest live `owner_write_seq` winner per structural owner candidate and recompute current live-parent
   labels from those winners.
3. Follow obligations. `applyFollowIdentityPage` in `follow-identity.ts` has no caller. Drive it over each saved
   admitted change, record source, pair, support, total, outgoing, negative and fence receipts, resolve target and
   account owner handoffs, and apply the terminal follower fence under the actual follow owner.
4. Late births and first apply. Enroll late births and first applications before their original commit, and
   persist each source plan cursor with its exhaustive seal.
5. Declarations and costs. Publish the exact callable and default binding, the native operation declarations and
   the inclusive cost terms that Semantic's Source maintenance schedule needs. Refuse before I/O when the complete
   original partition does not fit.
6. Acceptance tests. None of the named merge, repoint and published-undo tests, partial failure, lost result, exact
   replay or behind-frontier first-apply tests exist yet. Write them on the native fixture once item 7 is fixed.

## Blocked by another Goal

- `services/kernel/test/library/support/profile-entry-fixture.ts` fails on base with
  `GrantDeniedError: Access grant administration denied`, thrown from `authorize` in
  `services/kernel/src/access/grant-command.ts` while the steward's Global grants are created. Base commit
  `8b7e725c38` removed the direct grant seeds and records that the denial is unchanged. Until the access grant
  contract gives the first Global holder authority, `test/library/identity-scope-effects.test.ts` fails on base and
  the native acceptance scenario cannot be built on that fixture. Owner: the access grant-contract track.

## Semantic composition (another Goal)

The prepaid schedule, Source maintenance composition and fixed receipt reconciliation are described in
`commerce-identity-source-composition.md`.

## Verification on this branch

- `test/library/identity-epoch-participant.test.ts`: passes on a managed check host (2 tests).
- `test/library/identity-scope-effects.test.ts`: fails on base at the fixture described above.
- Architecture check against the base passes for the participant, module and adapter index changes.
