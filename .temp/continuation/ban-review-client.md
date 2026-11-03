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
  - 9ebe0b06-df31-4dd1-be0a-4a99e1d4a3b0
estimate:
  lines: 30
  files: 1
inseparable: true
---

# Finish the installed ban review client types

The focused client test now exercises the mounted GET wire address, all three query
values, complete response preservation, and the existing root page/query/item exports.
The installed declaration still accepts only limit/cursor and returns the old page;
OpenAPI already includes selectedAccountId. Do not regenerate or edit generated files.

Acceptance:

- After the shared complete-input Kernel publication lands, use a fresh query literal
  satisfying the root BanReviewPageQuery export, including selectedAccountId.
- Type the complete response fixture as BanReviewPage and its account presentation as
  the root BanReviewIdentity export, including the concealed identity variant. Keep
  the route response equality check so the exported page cannot mask a stale route.
- Run `bun test tests/ban-review-client.test.ts` from packages/client and
  `bun run --cwd packages/client typecheck` from the worktree root.
- Keep Web acceptance at `bun apps/web/scripts/focused.ts --private-network -- bun test tests/realm-ban-lifetime.test.tsx`
  from apps/web; it does not establish a mounted native pass.

The remaining outcome is a directly typed installed client request and complete
review response, including the public identity export, after shared publication.
