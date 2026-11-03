---
goal: commerce
manager: commerce
kind: implementation
paths:
  - packages/client/src/kernel/library*
  - packages/client/tests/client.test.ts
  - services/kernel/scripts/typecheck.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
estimate:
  lines: 158
  files: 5
after:
  - 8375cd2f-0d50-41d6-8e32-f92f5720c012
  - 96f6fc6e-3867-4bd6-be67-b582d327c51a
  - 54afb2ac-fc24-4862-b9c5-383ff5bbc267
  - 23846690-2d6e-40e4-b713-12d54fbb9b25
---

# Generate the selected label consolidation client

The retained client still needs declarations for the six installed Label consolidation routes:
review, confirmation, apply, retry, cancel and result. Generate from native routes and Reylo SQL
types; never hand-edit generated declarations or frozen tests. The retained compiler inputs
are now included by `outputTreeInputExclusions`; transport and restoration staging remain
excluded, and output authentication and generation replacement checks remain intact.

Repair existing compiler diagnostics minimally: explicit undefined optional fields in AniList
import storage, nullable rating licence, Search discovery filter unions, importer observation
type, duplicate first bindings, Bangumi claim narrowing, optional qualifier values and relation
filter narrowing. The duplicate clock import is already absent. Add one compact typed call-site
assertion in packages/client/tests/client.test.ts for all six routes, including required
idempotency headers on confirmation, apply, retry and cancel. Preserve all unchanged assertions.

Generate and commit declarations with `bun run --cwd services/kernel typecheck --emit-client`
on the managed compiler host, then run `bun run --cwd packages/client typecheck` and
`bun test packages/client/tests/client.test.ts`. Broader acceptance remains deferred to integration.

The managed emitter could not reach compilation on three attempts:
`OSError: [Errno 28] No space left on device` during check-host preparation. Do not force local
placement or alter shared services. Client typechecking also identifies pre-existing stale
consolidation declarations and post-publication declaration mismatches; regenerate before
assessing remaining diagnostics. The new call-site assertion was deferred to avoid introducing
additional errors while declarations cannot be generated.
