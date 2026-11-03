---
goal: content
manager: content
kind: claim
paths:
  - packages/client/tests/*ban-review*.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
after:
  - 70cd2a89-afd1-437c-ba19-d9ebe380cc19
  - f7ab95fe-f9aa-469b-ad53-b928d4765eff
  - 4eb719ca-83ba-40ce-9172-5d91df345bbf
  - 689c5e1b-8a7f-4dd6-9623-0a3fc311e3be
estimate:
  lines: 90
  files: 1
inseparable: true
---

# Finish the installed ban review client

Acceptance:

- Consume the shared complete-input Kernel publication once its client declaration, OpenAPI, and package root exports include the mounted bans GET and current query/response. Do not start another generator or edit generated files.
- Add the focused client test for `client.realms({ realmId }).bans.get({ query: { limit, cursor, selectedAccountId } })`, its response type, and root type exports. Run the focused test and `bun run --cwd packages/client typecheck` after publication.
- Keep the Web caller acceptance at `bun apps/web/scripts/focused.ts --private-network -- bun test tests/realm-ban-lifetime.test.tsx` from `apps/web`; its states do not establish a mounted native pass.

The bound base has the producer source but the installed query declaration still exposes only `limit` and `cursor`, and its response type is the old page shape. Resume after the shared declaration publication is available. Do not filter compiler inputs, suppress diagnostics, or edit schema snapshots.
