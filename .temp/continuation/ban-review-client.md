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
  - 7f224ec2-2da8-4912-80e9-d68e7a570ba2
estimate:
  lines: 35
  files: 1
inseparable: true
---

# Finish the installed ban review client

Acceptance:

- Resume only after the shared complete-input Kernel publication includes the mounted bans GET, current query and response in its client declaration, OpenAPI, and package root exports. Do not start a generator or edit generated files.
- Update the focused client test for `client.realms({ realmId }).bans.get({ query: { limit, cursor, selectedAccountId } })`, verify its response type and root type exports, then run the focused test and `bun run --cwd packages/client typecheck`.
- Keep Web caller acceptance at `bun apps/web/scripts/focused.ts --private-network -- bun test tests/realm-ban-lifetime.test.tsx` from `apps/web`; Web states do not establish mounted native pass.

Remaining outcome in user terms: make the installed client type the mounted ban review request and complete response, and prove consumers can import those types from the package root. The current base still lacks the shared declaration publication; the existing client test only covers runtime query serialization and uses an intersection to cover the missing selection member.
