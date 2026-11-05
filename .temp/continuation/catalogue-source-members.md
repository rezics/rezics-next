# Search continuation: native catalogue Source and Members

Goal: search
Manager: search

## Completed slice

Search property predicates now produce a catalogue-sourced save selection without injecting `owner.presence`. The
one-use same-tab handoff carries that source through the existing editor and create/update HTTP DTOs. Commerce stores
the source kind separately from the filter, keeps it in rule reads and CAS/replay, and the Search decision is recorded
in `docs/dynamic-collections.md`. Existing owner rules default to the owner source. Owner-only execution refuses a
catalogue rule so it cannot silently narrow to the curator's private Library facts.

## Remaining work

Commerce's native Source/Members contract is needed to execute a saved catalogue rule. On this base, `readDynamicMembers`
delegates to `admitSavedCollectionMemberQuery`, whose owner adapter accepts only the private OWNER population; retained
members preparation also restores that owner binding. Search's `scope-source.ts` `members-preparation` branch explicitly
refuses catalogue leaves because it has no public capture or index proof. Coordinate with Commerce's existing native
owner to receive the typed source binding, currentness, callable, retained definition and refresh operands. Replace the
fail-closed owner adapter seam with that returned contract; do not add a second evaluator or a frozen member snapshot.

Carry the source and immutable accepted release through direct reads, retained basis, preparation, replay, cursor
freshness and final currentness. Add bounded catalogue prefix work using existing Source allowances, and connect the
result to common Members so pages include catalogue Subjects without curator Library facts while excluding
nonmatching Library-only Subjects. Keep explicit public Publication output separate and complete. Verify property
changes that add and remove members, empty and paged results, edit/reopen, and the no-curator positive receiving case
on the seeded running stack; inspect browser create/view/edit at 390/1440 in light and dark after integration.

The contract-named Search acceptance, native and browser checks remain deferred to the controller's integration
verifier. The one-use handoff is not the missing native execution contract, and the current member endpoint still
reports Commerce's unavailable dependency for catalogue rules; this remains unfinished work, not an accepted result.

## Verification in this attempt

- `bun apps/web/scripts/focused.ts --private-network -- bun test tests/library-save-query.test.tsx tests/saved-query-editor.test.ts tests/search-saved-query-selection.test.ts` passed: 9 tests.
- `bun run --cwd services/kernel check test/library/collection-rules.test.ts test/library/collection-rule-read-http.test.ts test/library/collection-rules-growth.test.ts test/library/released-library-population.test.ts test/library/saved-query-lifecycle.test.ts` stopped at the schema check. The Library snapshot now matches; the unchanged `services/kernel/db/semantic/schema.sql` differs from the database built from migrations, so kernel tests did not run.
- `bun run --cwd services/kernel typecheck` failed on pre-existing repository diagnostics in producer/check-host files; the new rule-source and retained-preparation literals had no remaining diagnostics. The `collections.ts` time diagnostic is on an unchanged call site.
- `bun run --cwd apps/web typecheck` failed on unchanged diagnostics in `search-regions/results.tsx`, verified against base. No diagnostics were reported in the new Search selection, handoff, rule DTO, or focused test files.
- Seeded-stack, native, browser, refresh, empty/page, and catalogue entry/leave acceptance remain for the integration verifier after Commerce supplies the native Source/Members binding.
