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
| IAM23 | Realm administrator moderates an organization's local publication or suspends participation | Affect only admitted Realm scopes; no global organization control, source ownership or other-Realm erasure. |
| IAM24 | Independent organization joins/moves between Realms, or changes to explicitly managed mode | Structural changes confer no control; managed mode requires the organization's admitted grant and ceilings. |
| IAM25 | P is only A's member/profile editor/administrator while A may manage B | No represented access to B without a representation mandate; an explicit eligible-set grant is evaluated under its own selector. |
| IAM26 | P represents A for B's granted member-administration operation | Allow as A with P recorded privately; a publishing-only mandate does not qualify. |
| IAM27 | A manages B and B holds rights on C | No use of B's rights until an admitted bounded representation path to B exists. |
| IAM28 | Compound command uses several complete proofs, or tries to assemble one obligation from incompatible partial paths | Complete proofs in the admitted acting context can satisfy distinct obligations; incompatible pooling cannot satisfy one obligation. |
| IAM29 | Two independent complete grants allow an operation; revoke one | Preserve the other source and its provenance, subject to mandatory guards. |
| IAM30 | Administrator adds themselves to a protected set, rewrites its role, reparents a group or installs privileged automation | Reject without the resulting authority ceiling and required approvals. |
| IAM31 | Concurrent representation/topology changes each appear acyclic in isolation | No cycle/unapproved expansion becomes active; ordinary mutual management and descriptive links do not imply representation. |
| IAM32 | Institutional representative roster changes within its approved policy, or the policy ceiling widens | Qualified roster replacement retains the institutional grant; widening requires its declared grantor/approval authority. |
| IAM33 | Reuse a proof handle after revoke, expiry, leave/rejoin, role revision or actor switch | Revalidate bound context and dependency generations; no stale allowance. |
| IAM34 | Diamond paths have different limits, or one supporting edge is removed | Memoization preserves distinct bounded states and independent valid support; no duplicate authority or accidental revocation. |
| IAM35 | High branching, negative check, bulk work or an operational-limit reduction exceeds the supported profile | Bounded work and typed unavailable outcomes; profile activation/migration prevents silent reinterpretation of saved grants. |
| IAM36 | Parent/child groups have different grants | Child membership receives the admitted parent grant; parent membership does not receive the child's extra grant. |
| IAM37 | A Realm editor may edit an organization's catalog description | Apply the content owner's editing policy; the edit permission does not establish organizational control. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.

The first `work.create` acting-context API fixture exercises real Account OAuth,
Access PostgreSQL representation/grant rows and Main HTTP reads. Its two concurrent
checks model independent tab selections and its negative cases reject partial
paths and a stale scope epoch. It does not qualify browser tab storage, general
task discovery, grant mutation or multi-hop representation. The current Access
schema has no direct-principal grant path, so IAM04's direct-account plus
represented-Agent case remains pending; this fixture only rejects pooling
incomplete paths from different Agents. The QA integration tier runs this fixture
against Account and Access databases cloned from its migrated templates, so its
scope closure cannot change another file's authority state.
The same fixture saves and clears a private task preference, proves exact replay
and stale/concurrent CAS, keeps another principal's choice separate, and checks
that a revoked preferred Agent disappears from the eligible default without
changing an already explicit tab selection. It checks that the Access recovery
digest changes with the private preference row and its receipt. Browser tab
behavior remains for W1.
