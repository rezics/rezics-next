---
goal: imports
manager: imports
---

# VNDB credit publication follow-up

The candidate-signature manifest repair and production vocabulary phase test are committed. Focused importer tests pass, and `bun run --cwd services/importer typecheck` passes.

Pending native verification: rerun `bun run --cwd services/kernel check test/imports/showcase-vndb-credits.test.ts test/imports/vndb-staff-credits.test.ts` when the check host can complete schema preflight. This attempt stopped before test execution with `error: Schema dump differs from db/semantic/schema.sql.` The host reported `Checked source commit/tree: UNKNOWN (no retained source provenance at this boundary).` Its diff showed expected `identity_receiving_capture_pending` but actual `identity_rating_repair_journal`; do not weaken the schema check.

Pending kernel typecheck: `bun run --cwd services/kernel typecheck` completed with workspace diagnostics after the compiler phase. The report includes errors in untouched files such as `src/content/appeal-routes.ts`, `src/content/media.ts`, `src/content/routes.ts`, and `test/semantic/bulk.test.ts`. Re-establish the current base result and resolve any diagnostics in the changed native test before promotion.
