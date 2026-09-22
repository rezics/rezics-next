# Account and Access acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| IAM01 | Log in across two products and select different Agents per tab | OIDC/session boundaries and tab contexts remain independent. |
| IAM02 | Replay invalid issuer/audience/redirect/CSRF state | Reject without changing account state. |
| IAM03 | One principal represents several Agents; several control one Agent | No public account mapping and no one-to-one assumption. |
| IAM04 | Combine direct account and represented Agent rights | Reject unauthorized pooling. |
| IAM05 | Edit populated role/group while impact approval is pending | Stale generation/ceiling blocks activation. |
| IAM06 | Leave/rejoin Org or Realm | New admission generation; no revived dependent grant or erased ban. |
| IAM07 | Revoke while command/search/download is admitted | Declared fence and in-flight semantics hold at completion. |
| IAM08 | Lose last controller or recover compromised account | Continuity proof and independent recovery enforced. |
| IAM09 | Refresh revoked consent/installation | Cannot regain access or widen ceilings. |
| IAM10 | Account or Access becomes unavailable | Protected admission fails closed; no unknown-to-allow conversion. |
| IAM11 | Erase account then restore/replay | Private credentials stay erased without deleting unrelated public content. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.
