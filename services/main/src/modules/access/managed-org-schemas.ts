import { t } from 'elysia';

const id = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const instant = t.String({ format: 'date-time', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });
export const managedOrgUuid = t.String({ format: 'uuid' });
const generation = t.String({ pattern: '^(0|[1-9][0-9]{0,18})$', maxLength: 19 });
const recipient = t.Object({ kind: t.Union([t.Literal('realm'), t.Literal('parent')]), id }, { additionalProperties: false });
const action = t.Literal('access.org.roster.policy');
const grantFields = { organizationSubject: id, recipient, actions: t.Array(action, { minItems: 1, maxItems: 1 }),
  delegationCeiling: t.Literal(0), validFrom: instant, validUntil: instant };
const stateFields = { organizationSubject: id, authorityEpoch: generation, policyRevision: generation, admissionsOpen: t.Boolean() };
const grantResultFields = { ...grantFields, grantId: managedOrgUuid, recipientSubject: id,
  resource: t.Object({ kind: t.Literal('org-roster'), organizationSubject: id }),
  generation, active: t.Boolean() };
export const managedOrgQuery = t.Object({ organizationSubject: id }, { additionalProperties: false });
export const managedOrgStateResult = t.Object({ profile: t.Literal('access-organization-management-v1'), ...stateFields });
export const managedOrgChangeBody = t.Union([
  t.Object({ profile: t.Literal('access-managed-organization-grant-v1'), operation: t.Literal('issue'),
    ...grantFields, expectedAuthorityEpoch: generation }, { additionalProperties: false }),
  t.Object({ profile: t.Literal('access-managed-organization-grant-v1'), operation: t.Literal('revoke'),
    organizationSubject: id, grantId: managedOrgUuid, expectedAuthorityEpoch: generation,
    expectedGeneration: generation }, { additionalProperties: false }),
]);
export const managedOrgChangeResult = t.Object({ profile: t.Literal('access-managed-organization-grant-v1'),
  ...grantResultFields, operation: t.Union([t.Literal('issue'), t.Literal('revoke')]),
  authorityEpoch: generation, replayed: t.Boolean() });
export const managedOrgReadQuery = t.Object({ side: t.Union([t.Literal('organization'), t.Literal('recipient')]) },
  { additionalProperties: false });
export const managedOrgReadResult = t.Object({ profile: t.Literal('access-managed-organization-grant-v1'),
  ...grantResultFields, ...stateFields,
  representation: t.Nullable(t.Object({ id: managedOrgUuid, generation })) });
export const orgRosterPolicyBody = t.Object({ profile: t.Literal('access-organization-roster-policy-v1'),
  organizationSubject: id, recipient, grantId: managedOrgUuid, expectedGrantGeneration: generation,
  representationId: managedOrgUuid, expectedRepresentationGeneration: generation,
  expectedPolicyRevision: generation, admissionsOpen: t.Boolean() }, { additionalProperties: false });
export const orgRosterPolicyResult = t.Object({ profile: t.Literal('access-organization-roster-policy-v1'),
  ...stateFields, grantId: managedOrgUuid, grantGeneration: generation, replayed: t.Boolean() });
