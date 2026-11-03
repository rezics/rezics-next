---
{
  "goal": "commerce",
  "manager": "commerce",
  "kind": "implementation",
  "paths": [
    "services/kernel/src/library/library-archive-merge-routes.ts",
    "packages/client/src/kernel/**",
    "packages/client/tests/library-archive-merge.test.ts",
    "docs/library-archive-merge.md",
    "docs/library-archive-personal-fact-recovery.md",
    "docs/goals/library.capabilities.md"
  ],
  "riskAreas": ["authorization", "disclosure", "rights", "deletion", "account"],
  "criticalPath": false,
  "after": [],
  "waiting": [],
  "estimate": { "lines": 150, "files": 6 }
}
---

# Install the generated archive confirmation journey

An owner must upload an archive, preview it, review selected changes and apply the exact returned review through
the installed generated client without casts or alternate endpoints. The native owner now exposes and checks
`reviewRevision`; apply accepts `{items:[{ordinal,reviewRevision}]}`. Its upload producer declares original JSON
text or `{manifest,records}`, with bounded raw decoding after owner admission. The retained client still exposes
ordinal-only apply. Web's canonical archive consumer8bb remains unavailable for file admission until delivery;
it retains sole upload and recovery interface ownership.

Run the repository's actual generator, coordinating with generated-label consolidation and retaining unrelated
output. `bun run --cwd services/kernel typecheck --emit-client` could not reach client generation: compiler
errors outside this journey begin at `src/community/member-page.ts(127,32): error TS2740: Type 'AccessClient' is
missing the following properties from type 'PoolClient': release, addListener, emit, eventNames, and 28 more.`
Do not suppress those checks or hand-maintain declarations. Fixes in other owners are not a dependency chain
to merge without authorization; use an installed supported producer when available.

Restore `packages/client/tests/library-archive-merge.test.ts` from commit `fddda48bc9`, which exercises generated
upload, preview, review and apply with both original JSON text and an envelope, then typechecks the exact
revision handoff. Its two runtime cases passed, but its three type errors correctly exposed the missing
generated revision/apply declarations, so it is not retained as a failing workspace test. Install the producer,
run `bun run --cwd packages/client typecheck` and `bun test packages/client/tests/library-archive-merge.test.ts`,
and update the recovery reference and capability inventory with the exact installed types. Send the installed
methods and raw upload operands to the canonical Web owner.

The retained native tests cover refreshed reviews, stale mixed selection before effects, changed label mappings,
foreign owners, cancellation and original binding/receipt replay. Run the landing's focused command when shared
schema preparation works: `bun run --cwd services/kernel check test/library/library-archive-merge.test.ts
test/http/bounded-openapi-compatibility.test.ts`. The worker retry stopped before tests with
`error: Schema dump differs from db/library/schema.sql.` An earlier preparation attempt returned
`OSError: [Errno 28] No space left on device`. Never weaken schema consistency or alter shared infrastructure.

Retain the merge owner's complete-caller derivation, existing payer allowances and finite archive caps. Frozen
acceptance, the full shared Kernel suite and native64/512/4096 cost measurements remain controller-owned.
