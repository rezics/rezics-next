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
| IAM12 | Invite a cataloged author with no admitted representative | Invitation remains pending; profile editing or a matching name cannot activate it. |
| IAM13 | Grant to an author, change its admitted representative, then issue a grant as that author | Recipient/issuer object identity persists; actual principals and complete grantable ceilings remain explicit. |
| IAM14 | Issuing employee departs, or a dependent upstream grant is revoked | Institutional assignments and dependent delegation follow their distinct lifetime contracts. |
| IAM15 | A wiki excludes a Realm, evaluated under principal and acting-subject modes | Switching Agent cannot bypass principal-mode exclusion; actor mode does not infer membership through every controlled object. |
| IAM16 | Reorder a scoped exception and a Realm exclusion | Results follow the declared combining algorithm and policy revision; mandatory guards remain effective. |
| IAM17 | Earlier exclusion evidence is unavailable or its work budget is exhausted | Do not fall through to a later allow or treat unknown membership as non-membership. |
| IAM18 | Mute a Realm, block its interactions, and inspect direct resource access | Presentation, interaction admission and resource-access effects follow separate declared contracts. |
| IAM19 | A private membership set is referenced by another wiki's policy | Reference is admitted for that purpose; errors/diagnostics do not expose a private roster or create an unrestricted membership oracle. |
| IAM20 | Atomically switch grant and exclusion facts between two always-denied states while reading decision inputs | A decision cannot combine facts from different authority snapshots into an allow. Batch transport or cache bypass alone does not establish this boundary. |
| IAM21 | Read old content after its reader's authority is revoked | Historical data uses current qualified authority; an old content snapshot cannot revive old grants. |
| IAM22 | A lower-priority condition is unavailable after an earlier rule already decided, or a higher-priority condition is unavailable before a later allow | Preserve first-applicable/error semantics without weakening mandatory guards; unresolved earlier evidence cannot become non-membership. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.
