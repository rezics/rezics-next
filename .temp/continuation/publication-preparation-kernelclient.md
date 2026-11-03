---
goal: content
manager: content
kind: claim
paths:
  - packages/client/src/index.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
after:
  - 0c60ab46-3609-4b9c-b731-3c9848accbfb
  - dcf1002d-1967-4c22-9c89-8d7bd0658924
estimate:
  lines: 15
  files: 1
inseparable: true
---

# Bind publication preparation to the installed route declaration

## Acceptance

- Derive the root publication preparation DTO from the installed `KernelClient` route declaration for `GET /v1/realms/:realmId/publications/:subjectId/preparation`, using the declared 200 response's `preparation` field.
- Keep the Web subject picker caller contract and confirmation availability unchanged. Replace the standalone package substitute only when the installed generated type supplies the route response.
- Do not add transport, enable confirmation, edit generated declarations, start another compiler, or add a publication dependency on this receiver.
- Run `bun run --cwd packages/client typecheck` and `bun test packages/client/tests/publication-preparation-client.test.ts` after the installed route type is present.

## Remaining outcome

The server route exists, but the installed client route declaration still lacks this GET route and its response DTO. Resume this receiver after the owner installs that route in `KernelClient`. Then derive the root DTO from the installed response type and keep the existing Web caller behavior. Native/currentness/physical-growth and Web picker acceptance remain with their established owners; no native or rendered pass is inferred here.
