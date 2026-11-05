# VNDB optional Latin-cell verification

This verifies the adopted [optional Latin-cell contract](../../../packages/conversion/README.md#vndb-optional-latin-cell-source-contract)
against the evidence in [the pinned-dump audit](vndb-empty-latin.md). The audit found no exact-empty or
whitespace-only Latin cells in the 2026-10-25 pinned dump. This implementation therefore handles a schema edge;
it does not repair an observed pinned row or claim VNDB treats empty text as SQL NULL.

## Decision and implementation

The prior admitted converter revision was `vndb@6`. Revision `vndb@7` accepts only exact `''` for optional
`vn_titles.latin`, preserves it in the sanitized projection and digest, and omits its Romanized semantic name.
`null` remains distinct. Whitespace-only, missing and wrong-type Latin values, and invalid primary titles remain
strict errors at their existing paths. Nonempty Romanization and canonical BCP 47 language behavior are
unchanged. Source entry revision is not synthesized; native `entry_meta.revision` and optional `lastmod` remain
the source for revision and date citations.

The independent pure regression covers null, exact-empty and nonempty values; exact normalized values; no
invented labels, aliases or names; digest distinction and stability across bootstrap, resolution, target
rebinding and converter registration; portable bulk-command validation; and strict invalid controls. Existing
language, bootstrap, outcome and citation tests remain unchanged. The native COPY test and fixture are frozen
and unchanged. Native acceptance supplies the real staging, replay, public bulk-effect and strict-error
composition evidence.

## Verification record

The retry's first acceptance attempt reported `stalled: no output for 40 minutes`, so it yielded no assertion
result. The serialized pre-change source at the assigned base commit `6cd096da5d36e67ee7f4efdb583f2e8fc7b81503`
used `titleText(latin, ...)` for every non-null Latin value; because `titleText` rejects zero-length strings,
that source path rejects the synthetic exact-empty cell at `/vn_titles/0/latin`. This is the baseline red path;
no output from the stalled attempt is represented as an assertion failure.

The frozen native acceptance file hash before and after implementation is
`c96e29014e1d1a3fb92c9f15b2ecff1c9637048c41cb5ed3c6b6f8f91b21e7d5`.
It contains six native scenarios. Its bytes were not changed.

| Check                                                            | Command                                                                                                                                                                                                                                                                                                          | Result                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native optional-Latin acceptance                                 | `bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/vndb-optional-latin.test.ts`                                                                                                                                                                                                    | Exit 0; 6 passed, 0 failed, 484 assertions. The frozen COPY scenario passed.                                                                                                                                                                                                                                    |
| Pure optional-Latin, language, outcomes, bootstrap and citations | `bun scripts/worker-check.ts -- --local bun test packages/conversion/tests/vndb-optional-latin.test.ts packages/conversion/tests/vndb-language.test.ts packages/conversion/tests/vndb-outcomes.test.ts packages/conversion/tests/vndb-bootstrap.test.ts packages/conversion/tests/vndb-native-citations.test.ts` | 9 passed, 1 failed. Both optional-Latin regressions, 3 language, bootstrap, and 3 citation tests passed. The unchanged outcomes wrapper's nested source suite failed before conversion: `IMPORT_VNDB_DRIVER is required` at `specs/imports-vndb-driver.ts:66`; the nested child observed no driver environment. |
| Root typecheck                                                   | `bun scripts/worker-check.ts -- bun scripts/typecheck.ts`                                                                                                                                                                                                                                                        | Exit 0 on the first run. A post-regression-edit rerun hit `Lix open did not settle within 30000ms` while generating; it was not a compiler diagnostic.                                                                                                                                                          |

The pure converter processes only the supplied bounded projection (up to the existing 64 KiB record cap), with
linear work in its supplied record bytes. No database, network, or retained state was added. Existing command,
title, and link caps are unchanged. The outcomes harness failure occurs in unchanged harness files before
converter execution; its broader source outcome scenarios remain unverified by that focused check. This
source-edge pass does not establish every VNDB discovery, statistics, or publication capability.
