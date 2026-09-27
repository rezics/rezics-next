import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/identity-and-access.md', [
  {
    id: 'IAM01',
    scenario: 'Log in across two products and select different Agents per tab',
    requiredResult: 'OIDC/session boundaries and tab contexts remain independent.',
  },
  {
    id: 'IAM02',
    scenario: 'Replay invalid issuer/audience/redirect/CSRF state',
    requiredResult: 'Reject without changing account state.',
  },
  {
    id: 'IAM03',
    scenario: 'One principal represents several Agents; several control one Agent',
    requiredResult: 'No public account mapping and no one-to-one assumption.',
  },
  {
    id: 'IAM04',
    scenario: 'Combine direct account and represented Agent rights',
    requiredResult: 'Reject unauthorized pooling.',
  },
  {
    id: 'IAM05',
    scenario: 'Edit populated role/group while impact approval is pending',
    requiredResult: 'Stale generation/ceiling blocks activation.',
  },
  {
    id: 'IAM06',
    scenario: 'Leave/rejoin Org or Realm',
    requiredResult: 'New admission generation; no revived dependent grant or erased ban.',
  },
  {
    id: 'IAM07',
    scenario: 'Revoke while command/search/download is admitted',
    requiredResult: 'Declared fence and in-flight semantics hold at completion.',
  },
  {
    id: 'IAM08',
    scenario: 'Lose last controller or recover compromised account',
    requiredResult: 'Continuity proof and independent recovery enforced.',
  },
  {
    id: 'IAM09',
    scenario: 'Refresh revoked consent/installation',
    requiredResult: 'Cannot regain access or widen ceilings.',
  },
  {
    id: 'IAM10',
    scenario: 'Account or Access becomes unavailable',
    requiredResult: 'Protected admission fails closed; no unknown-to-allow conversion.',
  },
  {
    id: 'IAM11',
    scenario: 'Erase account then restore/replay',
    requiredResult: 'Private credentials stay erased without deleting unrelated public content.',
  },
  {
    id: 'IAM12',
    scenario: 'Invite a cataloged author with no admitted representative',
    requiredResult:
      'Invitation remains pending; profile editing or a matching name cannot activate it.',
  },
  {
    id: 'IAM13',
    scenario:
      'Grant to an author, change its admitted representative, then issue a grant as that author',
    requiredResult:
      'Recipient/issuer object identity persists; actual principals and complete grantable ceilings remain explicit.',
  },
  {
    id: 'IAM14',
    scenario: 'Issuing employee departs, or a dependent upstream grant is revoked',
    requiredResult:
      'Institutional assignments and dependent delegation follow their distinct lifetime contracts.',
  },
  {
    id: 'IAM15',
    scenario: 'A wiki excludes a Realm, evaluated under principal and acting-subject modes',
    requiredResult:
      'Switching Agent cannot bypass principal-mode exclusion; actor mode does not infer membership through every controlled object.',
  },
  {
    id: 'IAM16',
    scenario: 'Reorder a scoped exception and a Realm exclusion',
    requiredResult:
      'Results follow the declared combining algorithm and policy revision; mandatory guards remain effective.',
  },
  {
    id: 'IAM17',
    scenario: 'Earlier exclusion evidence is unavailable or its work budget is exhausted',
    requiredResult:
      'Do not fall through to a later allow or treat unknown membership as non-membership.',
  },
  {
    id: 'IAM18',
    scenario: 'Mute a Realm, block its interactions, and inspect direct resource access',
    requiredResult:
      'Presentation, interaction admission and resource-access effects follow separate declared contracts.',
  },
  {
    id: 'IAM19',
    scenario: "A private membership set is referenced by another wiki's policy",
    requiredResult:
      'Reference is admitted for that purpose; errors/diagnostics do not expose a private roster or create an unrestricted membership oracle.',
  },
  {
    id: 'IAM20',
    scenario:
      'Atomically switch grant and exclusion facts between two always-denied states while reading decision inputs',
    requiredResult:
      'A decision cannot combine facts from different authority snapshots into an allow. Batch transport or cache bypass alone does not establish this boundary.',
  },
  {
    id: 'IAM21',
    scenario: "Read old content after its reader's authority is revoked",
    requiredResult:
      'Historical data uses current qualified authority; an old content snapshot cannot revive old grants.',
  },
  {
    id: 'IAM22',
    scenario:
      'A lower-priority condition is unavailable after an earlier rule already decided, or a higher-priority condition is unavailable before a later allow',
    requiredResult:
      'Preserve first-applicable/error semantics without weakening mandatory guards; unresolved earlier evidence cannot become non-membership.',
  },
  {
    id: 'IAM23',
    scenario:
      "Realm administrator moderates an organization's local publication or suspends participation",
    requiredResult:
      'Affect only admitted Realm scopes; no global organization control, source ownership or other-Realm erasure.',
  },
  {
    id: 'IAM24',
    scenario:
      'Independent organization joins/moves between Realms, or changes to explicitly managed mode',
    requiredResult:
      "Structural changes confer no control; managed mode requires the organization's admitted grant and ceilings.",
  },
  {
    id: 'IAM25',
    scenario: "P is only A's member/profile editor/administrator while A may manage B",
    requiredResult:
      'No represented access to B without a representation mandate; an explicit eligible-set grant is evaluated under its own selector.',
  },
  {
    id: 'IAM26',
    scenario: "P represents A for B's granted member-administration operation",
    requiredResult:
      'Allow as A with P recorded privately; a publishing-only mandate does not qualify.',
  },
  {
    id: 'IAM27',
    scenario: 'A manages B and B holds rights on C',
    requiredResult:
      "No use of B's rights until an admitted bounded representation path to B exists.",
  },
  {
    id: 'IAM28',
    scenario:
      'Compound command uses several complete proofs, or tries to assemble one obligation from incompatible partial paths',
    requiredResult:
      'Complete proofs in the admitted acting context can satisfy distinct obligations; incompatible pooling cannot satisfy one obligation.',
  },
  {
    id: 'IAM29',
    scenario: 'Two independent complete grants allow an operation; revoke one',
    requiredResult: 'Preserve the other source and its provenance, subject to mandatory guards.',
  },
  {
    id: 'IAM30',
    scenario:
      'Administrator adds themselves to a protected set, rewrites its role, reparents a group or installs privileged automation',
    requiredResult: 'Reject without the resulting authority ceiling and required approvals.',
  },
  {
    id: 'IAM31',
    scenario: 'Concurrent representation/topology changes each appear acyclic in isolation',
    requiredResult:
      'No cycle/unapproved expansion becomes active; ordinary mutual management and descriptive links do not imply representation.',
  },
  {
    id: 'IAM32',
    scenario:
      'Institutional representative roster changes within its approved policy, or the policy ceiling widens',
    requiredResult:
      'Qualified roster replacement retains the institutional grant; widening requires its declared grantor/approval authority.',
  },
  {
    id: 'IAM33',
    scenario:
      'Reuse a proof handle after revoke, expiry, leave/rejoin, role revision or actor switch',
    requiredResult: 'Revalidate bound context and dependency generations; no stale allowance.',
  },
  {
    id: 'IAM34',
    scenario: 'Diamond paths have different limits, or one supporting edge is removed',
    requiredResult:
      'Memoization preserves distinct bounded states and independent valid support; no duplicate authority or accidental revocation.',
  },
  {
    id: 'IAM35',
    scenario:
      'High branching, negative check, bulk work or an operational-limit reduction exceeds the supported profile',
    requiredResult:
      'Bounded work and typed unavailable outcomes; profile activation/migration prevents silent reinterpretation of saved grants.',
  },
  {
    id: 'IAM36',
    scenario: 'Parent/child groups have different grants',
    requiredResult:
      "Child membership receives the admitted parent grant; parent membership does not receive the child's extra grant.",
  },
  {
    id: 'IAM37',
    scenario: "A Realm editor may edit an organization's catalog description",
    requiredResult:
      "Apply the content owner's editing policy; the edit permission does not establish organizational control.",
  },
]);
