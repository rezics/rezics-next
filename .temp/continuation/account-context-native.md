goal: semantic
manager: semantic

# Native account context continuation

The control-plane rebase onto main completed. The conflict resolution used the current main version of
`docs/architecture/boundary-baseline.json` and removed only the four replaced Access rule 2 exceptions. The Semantic
README records the exact existing binding entry, its static and deferred edges, the unchanged read/store loading
roles, and retained rule 3 cycle records.

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

- After the rebase, `bun run --cwd services/kernel check test/search/account-population-native.test.ts` again stopped
  in the schema guard before running tests. It reported `Schema dump differs from db/semantic/schema.sql`; the
  expected dump began at `identity_receiving_capture_pending`, while the actual dump began at
  `identity_rating_repair_journal`. The host reported source provenance `UNKNOWN`; the remote run was
  `mw32z46g-181921ba`. GitHub check-ref publication failed twice with TLS EOF, then snapshot upload succeeded; the
  schema guard remained the command failure. No schema change is in scope.
- After the rebase, `bun run --cwd services/kernel typecheck` exited 2 at source commit
  `3e59d599f5cf65ebfaa24ad004e74c2d75686f4e` on remote host `a`, concurrency 1. The compiler phase took
  `296.178913105s`; the run reported `362.083` CPU seconds over `351.491s` and peak memory `8823 MiB`.
  Its observation was `anon=26300416`, `file=3309838336`, `inactive_file=3309838336`, `io.some.avg10=13.67`,
  `io.full.avg10=13.67`.
  The output included `src/content/appeal-routes.ts(317,5)` TS2345, `src/content/media.ts(513,5)` TS2322,
  `src/content/routes.ts(1249,7)` and `(1367,7)` TS2345, plus diagnostics in Semantic tests including
  `test/semantic/identity-core.test.ts` and `test/support/growth-aggregate-captures.test.ts`. The returned compiler
  output was truncated by the tool. No base compiler run was made, so do not attribute these to base or call them
  collateral.
- The native test and remaining acceptance were not executed successfully. The controller still owns the full
  acceptance, architecture audit, and post-integration receiving.
