Goal: imports
Manager: imports

# Selected Release native acceptance

The selected Release context fix is implemented and committed. The importer regression now proves that a later selected-family reseed carries the current platform binding, replaces a changed current Concept ID, and does not revive a retracted platform group. The kernel test authors the full CLI run, independent current Release/Work reads, exact reopen, and one source platform refresh while preserving native identities and independent release facts.

The local importer proof passed:

```text
bun test services/importer/tests/showcase-vndb-releases.test.ts
3 pass, 0 fail
```

The importer typecheck passed:

```text
bun run --cwd services/importer typecheck
No type errors in 408 files
```

`bun run --cwd services/kernel typecheck` remains red on untouched kernel files, including `services/kernel/src/content/appeal-routes.ts(317,5)` (`TS2345`) and `services/kernel/test/semantic/identity-core.test.ts` (`TS2769`). The importer-specific type errors seen on its first run were fixed; importer typecheck now passes.

Pending native acceptance: run `bun run --cwd services/kernel check test/imports/showcase-vndb-releases.test.ts` after the controller resolves the schema preflight. This attempt stopped before the target test ran with:

```text
error: Schema dump differs from db/semantic/schema.sql.
Checked source commit/tree: UNKNOWN (no retained source provenance at this boundary).
remote-check: returned empty directory differs from its manifest: services/kernel/.temp/schema-diagnostics/schema-3aQitT
```

The independent current read must confirm the actual Release/Work identities, example-of-work relation, language, cited date, platform and medium after later vocabulary reseeds. The same CLI journey must confirm exact reopen and a refreshed platform source while preserving those identities. No native acceptance result or check ID is claimed.
