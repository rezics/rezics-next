---
goal: commerce
manager: commerce
kind: implementation
paths:
  - packages/client/src/kernel/library*
  - packages/client/tests/client.test.ts
  - services/kernel/scripts/typecheck.ts
  - scripts/check-output-tree.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
estimate:
  lines: 160
  files: 6
after:
  - 8375cd2f-0d50-41d6-8e32-f92f5720c012
  - 96f6fc6e-3867-4bd6-be67-b582d327c51a
  - 54afb2ac-fc24-4862-b9c5-383ff5bbc267
---

# Regenerate the selected label consolidation client

The installed native Label routes expose review, confirmation, apply, retry, cancel and result, but the
retained client declarations omit all six. Generate the declarations from native routes and Reylo SQL types;
do not hand-edit generated files or widen the API beyond the installed endpoints.

The duplicate clock import in `services/kernel/src/library/label-consolidation.ts` has been removed.
The remaining outcome is to generate the six declarations and add one compact typed call-site assertion in
`packages/client/tests/client.test.ts`, including the required idempotency header on mutations.

The managed emitter typecheck fails before declaration generation on existing source and test diagnostics.
Its compiler cannot resolve retained client declarations: `outputTreeInputExclusions` excludes the generated
client tree from managed inputs, although `withKernelClientOutput` expects the retained declarations as compiler
inputs. Resolve this without weakening output authentication or checks. Source diagnostics also include
explicit undefined optional fields in AniList import storage, nullable rating licence, Search discovery filter
unions, and the importer observation type. Existing kernel test diagnostics include duplicate `first` bindings,
unnarrowed Bangumi claims, optional qualifier values and relation filter narrowing. Keep repairs minimal.

Acceptance:

- Run `bun run --cwd services/kernel typecheck --emit-client` successfully on the managed compiler host and
  commit generated declarations for all six installed routes.
- Add the compact typed assertion in `packages/client/tests/client.test.ts` and run
  `bun run --cwd packages/client typecheck` and `bun test packages/client/tests/client.test.ts` from the root.
- Preserve unchanged assertions and frozen files. Broader acceptance remains deferred to integration under
  the controller's validation policy.
