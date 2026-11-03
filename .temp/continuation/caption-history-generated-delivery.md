---
{
  "goal": "content",
  "manager": "content",
  "kind": "claim",
  "paths": [
    "services/kernel/src/library/personal-routes.ts",
    "services/kernel/src/rating/routes.ts",
    "packages/client/src/kernel/**",
    "packages/client/src/index.ts",
    "contracts/openapi.json"
  ],
  "riskAreas": [
    "authorization",
    "disclosure",
    "rights",
    "deletion",
    "account"
  ],
  "criticalPath": false,
  "waiting": [],
  "after": [
    "94d8bd6a-0882-43d2-8207-302ca0797fb9"
  ],
  "estimate": {
    "lines": 180,
    "files": 4
  },
  "inseparable": true
}
---

# Complete generated caption history delivery

The native caption history implementation and focused race coverage are committed. Finish the generated delivery by correcting the existing mounted library route metadata that prevents the supported full-input generator from starting, then run `bun run --cwd services/kernel derived` and retain the normal generated OpenAPI and KernelClient outputs. Export the generated caption history DTOs from `packages/client/src/index.ts`.

The current producer error is `POST /v1/libraryShelfScorePreparation: routes declare operationId as <resource>.<verb>` for `operationId: library_shelf.score.prepare` in `services/kernel/src/library/personal-routes.ts`. That route is unchanged from the source base. Keep the schema SQL inputs and generated schema snapshots owned by the SQL/schema repair; do not bypass the complete-input generator.

Acceptance: supported full-input generation succeeds; the generated OpenAPI includes the closed caption history schemas and `stale_cursor` response; KernelClient types and the required public client exports are generated; the changed workspaces type-check; controller-run integration acceptance covers the complete history journey and connected growth evidence.
