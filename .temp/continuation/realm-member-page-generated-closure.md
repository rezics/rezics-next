---
{
  "goal": "content",
  "manager": "content",
  "kind": "claim",
  "paths": [
    "services/kernel/db/community/schema.sql",
    "services/kernel/src/community/member-page*.ts",
    "services/kernel/src/community/routes.ts",
    "services/kernel/test/community/*member-page*.ts",
    "packages/client/src/kernel/**",
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
  "after": [],
  "acceptance": [
    "Publish the community schema snapshot, OpenAPI document, and client declarations through their existing generators; verify the default route, operation and exposure metadata, response examples, and client exports.",
    "Complete connected outcomes for authorized managers, readers, outsiders, suspended callers, concealed Realms, 20/21 paging, selected accounts outside the page, pending and completed membership transitions, replay, ban/unban readback, sparse pages, and safe same-cursor retries.",
    "Exercise final withholding after management revocation, Realm removal, membership close/reopen, and account-session replacement; verify current identity and action advice without leakage.",
    "Run the landing focused tests and changed workspace typecheck, then complete the frozen connected and growth acceptance after integration."
  ],
  "estimate": {
    "lines": 850,
    "files": 8
  },
  "inseparable": true
}
---
# Finish the Realm member page generated closure and connected outcomes

The native bounded reader, current membership checks, action advice, and initial focused tests are committed. The generated community schema snapshot, OpenAPI document, and client declarations remain unpublished. The connected outcome matrix and frozen growth acceptance also remain to be completed.

The shared check host repeatedly failed during dependency preparation with `OSError: [Errno 28] No space left on device`. Standalone OpenAPI/client generation lacked an available database analysis. Resume through the existing generators when those dependencies are available; do not hand-edit consumer DTOs or add new membership or ban writers.
