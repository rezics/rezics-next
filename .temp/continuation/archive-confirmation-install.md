---
goal: commerce
manager: commerce
kind: implementation
paths:
  - packages/client/src/kernel/**
  - packages/client/tests/library-archive-merge.test.ts
  - docs/library-archive-merge.md
  - docs/library-archive-personal-fact-recovery.md
  - docs/goals/library.capabilities.md
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
after:
  - 8bd324c6-d8c5-4527-b119-3d03fed963a2
waiting: []
estimate:
  lines: 80
  files: 5
---

# Install the generated archive confirmation journey

An owner must upload an archive, preview it, review selected changes and apply the exact returned review through the
installed generated client without casts or alternate endpoints. The native owner already declares raw JSON text or
`{manifest, records}` upload, exposes `reviewRevision`, and applies `{items:[{ordinal,reviewRevision}]}`. The client
still needs those generated declarations, the restored generated journey test, updated owner references, and a
handoff of the installed methods and upload operands to the canonical Web owner.

## Acceptance

Run the repository generator with `bun run --cwd services/kernel typecheck --emit-client`, preserving unrelated
generated output such as label consolidation. Do not suppress compiler checks or hand-maintain declarations. The
installed upload body must be `string | {manifest: Record<string, unknown>; records: Record<string, unknown>[]}`;
preview and review must expose `reviewRevision`; apply must accept `{items: {ordinal: number; reviewRevision: number}[]}`.
Restore the test from `fddda48bc9`, run `bun run --cwd packages/client typecheck` and
`bun test packages/client/tests/library-archive-merge.test.ts`, update the two library owner references and
capability inventory, and send the exact installed client methods and raw upload operands to the canonical Web owner.

The generator command on the current base stopped before emission on existing compiler errors outside this journey,
including `../../packages/client/src/index.ts(113,8): error TS2307: Cannot find module './kernel/rating/own-votes-counted' or its corresponding type declarations.` The standalone script also requires the compiler database environment and returned `No database URL`; use the repository's supported generator path when the compiler errors are resolved.
