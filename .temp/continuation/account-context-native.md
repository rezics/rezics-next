goal: semantic
manager: semantic

# Native account context continuation

The existing binding boundary is committed at `1aebf89d01`; native account-context coverage is committed at
`8e6d26542c`. The Semantic README records the exact existing binding entry, its static and deferred edges, the
unchanged read/store loading roles, and retirement of the four replaced Access rule 2 exceptions. Rule 3 cycle
records remain unchanged.

The focused Search case uses a real Account verification request and publication, checks the reciprocal persisted
link and both current native mappings, then calls the installed account discovery reader around anonymous Subject
hydration. It also exercises actual native unavailable and pending reads. The test was not reached by its check
command, so none of those observations are an executed pass.

## Remaining acceptance

The requested actual-native differing-epoch refusal case is not represented yet. For an accepted verified link,
the reader requests the Account's original and current candidate, and requires both mappings to terminate at that
candidate. `identity-core/mapping.ts` selects each returned epoch from the current basis row. The basis query
`identity-terminal-closure-current.sql` reads both from the same `(control_partition, terminal)` group and returns
that group's one `published_epoch`. A genuine exact mapped pair therefore cannot produce unequal returned epochs.
Do not make a fake Pool adapter, fabricate a mapped DTO, or alter the native classifier to force the case. Reconcile
the acceptance wording with the owner docs and current data contract, or identify a valid native state that can
produce this input before changing the reader.

## Receiving evidence to preserve

- `bun run --cwd services/kernel check test/search/account-population-native.test.ts` stopped in the schema guard
  before running tests. It reported `Schema dump differs from db/semantic/schema.sql`; the expected dump began at
  `identity_receiving_capture_pending`, while the actual dump began at `identity_rating_repair_journal`. The host
  reported source provenance `UNKNOWN`; the remote run was `mw325m89-d122179a`. No schema change is in scope.
- `bun run --cwd services/kernel typecheck` exited 2 at source commit
  `8e6d26542c0eef8a021776f443a6064ca76c44be` on remote host `b`, concurrency 1. The compiler phase took
  `283.982136669s`; the run reported `353.294` CPU seconds over `333.535s` and peak memory `8576 MiB`.
  The output included `src/content/appeal-routes.ts(317,5)` TS2345, `src/content/media.ts(513,5)` TS2322,
  `src/content/routes.ts(1249,7)` and `(1367,7)` TS2345, plus diagnostics in Semantic tests including
  `test/semantic/identity-core.test.ts` and `test/support/growth-aggregate-captures.test.ts`. The returned compiler
  output was truncated by the tool. No base compiler run was made, so do not attribute these to base or call them
  collateral.
- The native test and remaining acceptance were not executed successfully. The controller still owns the full
  acceptance, architecture audit, and post-integration receiving.
