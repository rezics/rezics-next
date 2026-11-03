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
installed generated client without casts or alternate endpoints. The native owner declares raw JSON text or
`{manifest, records}` upload, exposes and checks `reviewRevision`, and accepts
`{items:[{ordinal,reviewRevision}]}`. The retained generated client remains ordinal-only, and the base client test
covers upload and preview without the revision-bound apply journey.

## Acceptance

Run `bun run --cwd services/kernel typecheck --emit-client` through the repository's supported compiler placement,
preserving unrelated generated output such as label consolidation. Do not suppress compiler checks or hand-maintain
declarations. The installed upload body must be `string | {manifest: Record<string, unknown>; records: Record<string, unknown>[]}`;
preview and review must expose `reviewRevision`; apply must accept
`{items: {ordinal: number; reviewRevision: number}[]}`. Restore the generated journey test from `fddda48bc9`, run
`bun run --cwd packages/client typecheck` and `bun test packages/client/tests/library-archive-merge.test.ts`, update
the recovery reference and capability inventory, then send the installed client methods and raw upload operands to
the canonical Web owner.

On the current base, generation stops before emission with existing errors outside this journey, beginning
`../../packages/client/src/index.ts(117,8): error TS2307: Cannot find module './kernel/rating/own-votes-counted' or its corresponding type declarations.` and `src/community/member-page.ts(127,32): error TS2740: Type 'AccessClient' is missing the following properties from type 'PoolClient': release, addListener, emit, eventNames, and 28 more.` Continue through the supported generator without suppressing these checks or hand-maintaining declarations.
