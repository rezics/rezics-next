---
goal: content
manager: content
kind: claim
paths:
  - packages/client/src/kernel/rating/own-votes-page.d.ts
  - packages/client/src/index.ts
  - contracts/openapi.json
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
after:
  - fde5a113-246b-4aff-a56c-f209ac6c5a5e
  - 4eb719ca-83ba-40ce-9172-5d91df345bbf
  - 680f2440-cd92-4bf9-adac-9c1f1e0cd04a
estimate:
  lines: 40
  files: 3
---

# Publish My ratings client transport

Expose the installed `GET /v1/me/rating-votes` query, page, row, and closed action types through `@rezics/client`. The Kernel route, response schema, and OpenAPI operation already exist. Keep ordinary vote commands as the only writer; Web owns request lifetime and presentation.

Acceptance:

- After Kernel typecheck inputs compile, run the complete-input client declaration and OpenAPI generators. Never hand-edit generated declarations.
- Export the exact mounted page query, page, row, and action variants. Add a focused client test for a typed request and the three closed action states.
- Keep the generated OpenAPI response aligned with the mounted route.

The standard Kernel check-host command reached declaration generation but failed on existing type errors in unchanged community, search, and semantic sources. The direct client generator also requires the Kernel compiler database; use the standard check-host placement. No client exports or focused test remain in the source tree.
