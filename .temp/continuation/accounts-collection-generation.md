# Native collection generation replacement

Goal: accounts
Manager: supermanager

Root coordinates the remaining Library/Semantic producer integration. Keep the
fixture and publication work. Do not rerun unchanged collection cases or an
erasure batch, and do not broaden into Semantic in this handle.

## Delivered

The additional real account registers while the identity fixture owns a live
Auth executor. Actual credentials, distinct account IDs, permanent close and
workflow ownership remain intact. Finite Source preparation uses the existing
native worker step and its real execution contract. Background work starts on
demand before imports or member-page preparation. No production Auth changes,
permissive mocks, readiness seed rows or deadline increases were introduced.

The SQL empty-result and null-provenance slices, plus identity bounds assertions,
are accepted on Dev `7fc31c1f32`; reuse their unchanged proof.

## Retained execution evidence

Check `10427449-aa2d-484f-9e37-29520f4715fd`, source `1eb887af89`:

- Kernel compiler and selected quality checks passed.
- `identity-original-work.test.ts`: 12 pass, 0 fail; unchanged since then.
- `canonical-source-capture.test.ts`: all three product cases passed; teardown
  failed with `TimeoutError: The operation timed out.` This cleanup failure is
  superseded by the passing result below for this suite.
- `collection-publication.test.ts`: 4 pass, 7 fail including teardown. In the
  selected-member case, first POST returned 200, `itemCount` was 1, and persisted
  members equalled exactly `[a]`; all assertions through line 135 passed. Exact
  replay at line 137 returned 503 instead of 200. Later replay authorization and
  no-change assertions were unreached.
- Other independent collection failures: nonmember returned 503 instead of 404
  at line 166; changed-source race returned 503 instead of 409 at line 223;
  second publication returned 503 instead of 200 at line 248; post-activation
  preparation threw `Native scoped Source custody is unavailable` with code
  `identity_epoch_unavailable`; member-page lookup returned 503 instead of 200
  at rules fixture line 92; teardown timed out. These are not passing cases.

Check `721a0913-27fc-4f96-be7c-595dd3d92f2d`, source `308eb5b556`:

- Kernel compiler reached selected quality and test stages without a type error;
  selected lint and formatting passed.
- `canonical-source-capture.test.ts`: 3 pass, 0 fail, 7 assertions; fixture closed,
  database dropped, file explicitly reported PASS, 103.60 seconds.
- The next collection process started but returned no case results. The batch
  ended with exit 120 after `remote-check: reconnected to a in 2.817 s`. No exact
  exit-120 cause or infrastructure-only classification was supplied. Collection
  execution and its cleanup remain unverified at this revision. Identity was
  unreached; retain the unchanged 12-case pass above.
- Final cleanup warning: `check-git: ref cleanup deferred: Error: check-git: check
  ref push deadline exceeded (exit null, SIGTERM; elapsed 2001ms; deadline
  1794263119531):`. It does not prove why the batch ended.

Full logs are `.temp/check-logs/<check UUID>.log` in this worktree. No check is
still running. No browser, growth, ordinary root acceptance or erasure suite ran.

## First distinct native prerequisite

`services/kernel/src/library/collection-source-output.ts:363` increments
`source_generation` when activating the completed output.
`library/native-source-fence.ts` includes that generation in its fence.
`library/collection-source.ts:250` requires canonical readiness for current native
metadata before reauthorization and receipt replay; a non-ready result becomes
`dependency_unavailable`.

`library/canonical-source-store.ts:874` captures the freshly observed working
Source. Its scope key at line 317 remains `collection-source`, and registration
at line 950 reaches the existing Semantic stable scope. The observed exception
at `services/kernel/src/semantic/identity-scoped-observations.ts:1917` rejects
`!same(locked.source, input.key.source)` while that scope has not retired.
Retirement and fresh registration must preserve actual native custody; replacing
the stored identity or inventing a fresh scope key would bypass that contract.

Library's README retains the native producer integration qualification; Semantic's
scoped-observation contract requires retirement before fresh registration and
actual hold release. Root should coordinate this lifecycle and the independent
changed-source race result, preserving all current publication assertions and
existing completed public output. No claim is made that this generation mismatch
caused the separate eight erasure-fixture 503s.

## Changed paths outside the original fixture contract

- `docs/goals/accounts.capabilities.md`
- `services/kernel/src/library/README.md`
- `services/kernel/src/library/canonical-source-store.ts` (accepted SQL slice)
- `services/kernel/src/library/native-source-custody-bounds.ts` (accepted provenance slice)
- `services/kernel/src/library/collection-selected-publication-bounds.ts`
- `services/kernel/test/library/canonical-source-capture.test.ts`
- `services/kernel/test/library/identity-original-work.test.ts`
- `services/kernel/test/library/support/collection-rules-fixture.ts`

After producer repair, the owning runner is `bun run --cwd services/kernel check
test/library/canonical-source-capture.test.ts test/library/collection-publication.test.ts
test/library/identity-original-work.test.ts`, through `scripts/worker-check.ts`.
Reuse passing unchanged slices and rerun only checks affected by that repair.
