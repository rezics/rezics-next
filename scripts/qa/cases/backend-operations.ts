import type { Case } from './types.ts';

export interface OperationTarget {
  // Planned behavior may share a URL with an installed, narrower operation.
  status: 'existing' | 'planned';
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  path: string;
}
export interface OperationMapping {
  ids: readonly string[];
  targets: readonly OperationTarget[];
  /** Context and unimplemented qualifiers from the original operation map. */
  context: string;
}

export const backendOperationMappings: readonly OperationMapping[] = [
  {
    ids: ['IAM01', 'IAM02'],
    targets: [
      { status: 'existing', path: '/api/auth/*' },
      { status: 'existing', method: 'GET', path: '/v1/me/acting-contexts' },
    ],
    context:
      'E `/api/auth/*` authorization, token and session operations; E `GET /v1/me/acting-contexts`.',
  },
  {
    ids: ['IAM03', 'IAM04'],
    targets: [
      { status: 'existing', method: 'GET', path: '/v1/me/acting-contexts' },
      { status: 'existing', method: 'POST', path: '/v1/me/acting-context-checks' },
    ],
    context: 'E `GET /v1/me/acting-contexts`; E `POST /v1/me/acting-context-checks`.',
  },
  {
    ids: ['IAM05'],
    targets: [
      { status: 'existing', method: 'GET', path: '/v1/access/group-scope' },
      { status: 'existing', method: 'POST', path: '/v1/access/group-changes' },
      { status: 'existing', method: 'POST', path: '/v1/access/group-impact-proposals' },
      { status: 'existing', method: 'GET', path: '/v1/access/group-impact-proposals/{proposalId}' },
      { status: 'existing', method: 'POST', path: '/v1/access/group-impact-approvals' },
      { status: 'existing', method: 'POST', path: '/v1/access/roles' },
      { status: 'existing', method: 'POST', path: '/v1/access/role-revisions' },
      { status: 'existing', method: 'GET', path: '/v1/access/roles/{familyId}' },
      { status: 'existing', method: 'POST', path: '/v1/access/protected-sets' },
      { status: 'existing', method: 'POST', path: '/v1/access/protected-change-proposals' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/access/protected-change-proposals/{proposalId}',
      },
      { status: 'existing', method: 'POST', path: '/v1/access/protected-change-approvals' },
      { status: 'existing', method: 'POST', path: '/v1/access/protected-change-activations' },
    ],
    context:
      'E `GET /v1/access/group-scope`; E `POST /v1/access/group-changes`; E `POST /v1/access/group-impact-proposals`; E `GET /v1/access/group-impact-proposals/{proposalId}`; E `POST /v1/access/group-impact-approvals`; E `POST /v1/access/roles`; E `POST /v1/access/role-revisions`; E `GET /v1/access/roles/{familyId}`; E `POST /v1/access/protected-sets`; E `POST /v1/access/protected-change-proposals`; E `GET /v1/access/protected-change-proposals/{proposalId}`; E `POST /v1/access/protected-change-approvals`; E `POST /v1/access/protected-change-activations`.',
  },
  {
    ids: ['IAM06'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/me/membership-consents' },
      { status: 'existing', method: 'POST', path: '/v1/me/membership-consent-revocations' },
      { status: 'existing', method: 'POST', path: '/v1/access/membership-changes' },
      { status: 'existing', method: 'POST', path: '/v1/access/grant-changes' },
      { status: 'existing', method: 'POST', path: '/v1/me/private-membership-consents' },
      { status: 'existing', method: 'POST', path: '/v1/me/private-membership-consent-revocations' },
      { status: 'existing', method: 'POST', path: '/v1/access/private-membership-changes' },
      { status: 'existing', method: 'POST', path: '/v1/access/private-group-member-changes' },
      { status: 'existing', method: 'POST', path: '/v1/access/private-role-binding-changes' },
      { status: 'existing', method: 'GET', path: '/v1/me/private-memberships' },
      { status: 'existing', method: 'POST', path: '/v1/access/org-realm-changes' },
    ],
    context:
      'E `POST /v1/me/membership-consents`, E `POST /v1/me/membership-consent-revocations` and E `POST /v1/access/membership-changes` for Agent episodes; E `POST /v1/access/grant-changes` for episode-dependent grants; E `POST /v1/me/private-membership-consents`, E `POST /v1/me/private-membership-consent-revocations`, E `POST /v1/access/private-membership-changes`, E `POST /v1/access/private-group-member-changes`, E `POST /v1/access/private-role-binding-changes` and E `GET /v1/me/private-memberships` for private-principal episodes; E `POST /v1/access/org-realm-changes` for independent Org participation. General group/role/Realm semantics remain planned.',
  },
  {
    ids: ['IAM07'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/access/revocations' },
      { status: 'existing', method: 'GET', path: '/v1/access/revocations/{revocationId}' },
      { status: 'existing', method: 'POST', path: '/v1/me/acting-context-checks' },
    ],
    context:
      'E `POST /v1/access/revocations`; E `GET /v1/access/revocations/{revocationId}`; E `POST /v1/me/acting-context-checks`; protected command replay.',
  },
  {
    ids: ['IAM08'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/agents/control' },
      { status: 'existing', method: 'GET', path: '/v1/agents/control' },
      { status: 'existing', method: 'POST', path: '/v1/agents/controller-changes' },
      { status: 'existing', method: 'POST', path: '/v1/agents/recoveries' },
      { status: 'existing', method: 'POST', path: '/v1/access/protected-change-approvals' },
      { status: 'existing', method: 'POST', path: '/v1/access/protected-change-activations' },
      { status: 'planned', method: 'POST', path: '/v1/accounts/recoveries' },
    ],
    context:
      'E `POST /v1/agents/control`; E `GET /v1/agents/control`; E `POST /v1/agents/controller-changes`; E `POST /v1/agents/recoveries`; E `POST /v1/access/protected-change-approvals` and E `POST /v1/access/protected-change-activations` for independent recovery approval; P `POST /v1/accounts/recoveries`.',
  },
  {
    ids: ['IAM09'],
    targets: [{ status: 'existing', path: '/api/auth/*' }],
    context: 'E `/api/auth/*` consent, refresh and token introspection operations.',
  },
  {
    ids: ['IAM10'],
    targets: [{ status: 'existing', method: 'POST', path: '/v1/me/acting-context-checks' }],
    context: 'E `POST /v1/me/acting-context-checks`; protected command admission.',
  },
  {
    ids: ['IAM11'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/accounts/erasures' },
      { status: 'existing', method: 'GET', path: '/v1/content-revisions/{revision}' },
    ],
    context: 'P `POST /v1/accounts/erasures`; E `GET /v1/content-revisions/{revision}`.',
  },
  {
    ids: ['IAM12'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/agents/invitations' },
      { status: 'existing', method: 'GET', path: '/v1/agents/invitations/{invitationId}' },
      { status: 'existing', method: 'POST', path: '/v1/agents/invitation-acceptances' },
      { status: 'existing', method: 'POST', path: '/v1/agents/invitation-revocations' },
    ],
    context:
      'E `POST /v1/agents/invitations`; E `GET /v1/agents/invitations/{invitationId}`; E `POST /v1/agents/invitation-acceptances`; E `POST /v1/agents/invitation-revocations`.',
  },
  {
    ids: ['IAM13', 'IAM14'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/access/grant-changes' },
      { status: 'existing', method: 'POST', path: '/v1/access/delegated-grant-changes' },
      { status: 'existing', method: 'GET', path: '/v1/access/grants/{grantId}' },
      { status: 'existing', method: 'GET', path: '/v1/access/grants/{grantId}/lineage' },
      { status: 'existing', method: 'GET', path: '/v1/access/grants' },
    ],
    context:
      'E `POST /v1/access/grant-changes`; E `POST /v1/access/delegated-grant-changes`; E `GET /v1/access/grants/{grantId}`; E `GET /v1/access/grants/{grantId}/lineage`; E `GET /v1/access/grants`.',
  },
  {
    ids: ['IAM15', 'IAM16', 'IAM17'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/access/policy-decisions' },
      { status: 'existing', method: 'POST', path: '/v1/access/policy-changes' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/access/policies/{policyId}/revisions/{revision}',
      },
    ],
    context:
      'E `POST /v1/access/policy-decisions`; E `POST /v1/access/policy-changes`; E `GET /v1/access/policies/{policyId}/revisions/{revision}`.',
  },
  {
    ids: ['IAM18', 'IAM19', 'IAM20'],
    targets: [
      { status: 'existing', method: 'PUT', path: '/v1/me/interaction-mutes' },
      { status: 'existing', method: 'GET', path: '/v1/me/interaction-mutes' },
      { status: 'existing', method: 'POST', path: '/v1/access/interaction-blocks' },
      { status: 'existing', method: 'POST', path: '/v1/access/interaction-decisions' },
      { status: 'existing', method: 'POST', path: '/v1/access/policy-decisions' },
    ],
    context:
      'E `PUT /v1/me/interaction-mutes`; E `GET /v1/me/interaction-mutes`; E `POST /v1/access/interaction-blocks`; E `POST /v1/access/interaction-decisions`; E `POST /v1/access/policy-decisions`.',
  },
  {
    ids: ['IAM21', 'IAM22'],
    targets: [
      { status: 'existing', method: 'GET', path: '/v1/content-revisions/{revision}' },
      { status: 'existing', method: 'POST', path: '/v1/access/policy-decisions' },
    ],
    context: 'E `GET /v1/content-revisions/{revision}`; E `POST /v1/access/policy-decisions`.',
  },
  {
    ids: ['IAM23', 'IAM24'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/access/org-realm-proposals' },
      { status: 'existing', method: 'POST', path: '/v1/access/org-realm-changes' },
      { status: 'existing', method: 'GET', path: '/v1/access/org-realm-participation' },
      { status: 'existing', method: 'POST', path: '/v1/access/org-realm-moves' },
      { status: 'existing', method: 'POST', path: '/v1/organization-publication-rejections' },
      { status: 'existing', method: 'POST', path: '/v1/publication-rejections' },
      { status: 'existing', method: 'POST', path: '/v1/access/managed-organization-grants' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/access/managed-organization-grants/{grantId}',
      },
      { status: 'existing', method: 'GET', path: '/v1/access/organization-management' },
      { status: 'existing', method: 'POST', path: '/v1/access/organization-roster-policy' },
    ],
    context:
      'E `POST /v1/access/org-realm-proposals`, E `POST /v1/access/org-realm-changes` and E `GET /v1/access/org-realm-participation` for independent Org/Realm participation; E `POST /v1/access/org-realm-moves` for an atomic independent-organization transfer; E `POST /v1/organization-publication-rejections` and E `POST /v1/publication-rejections` for exact Realm-local moderation; E `POST /v1/access/managed-organization-grants`, E `GET /v1/access/managed-organization-grants/{grantId}`, E `GET /v1/access/organization-management` and E `POST /v1/access/organization-roster-policy` for one explicit managed authority and protected roster operation. P broader quota/review and paid benefits.',
  },
  {
    ids: ['IAM25', 'IAM26', 'IAM27'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/me/acting-context-checks' },
      { status: 'existing', method: 'POST', path: '/v1/me/representation-requests' },
      { status: 'existing', method: 'GET', path: '/v1/access/representation-requests/{requestId}' },
      { status: 'existing', method: 'POST', path: '/v1/access/representation-changes' },
      { status: 'existing', method: 'GET', path: '/v1/access/representations/{representationId}' },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/access/eligible-org-member-set-grant-changes',
      },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/access/eligible-org-member-set-grants/{grantId}',
      },
      { status: 'existing', method: 'POST', path: '/v1/access/selected-org-membership-changes' },
      { status: 'existing', method: 'GET', path: '/v1/me/selected-org-membership-changes' },
      { status: 'existing', method: 'POST', path: '/v1/me/represented-org-membership-requests' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/access/represented-org-membership-requests/{requestId}',
      },
      { status: 'existing', method: 'POST', path: '/v1/access/represented-org-mandate-changes' },
      { status: 'existing', method: 'POST', path: '/v1/access/represented-org-grant-changes' },
      { status: 'existing', method: 'POST', path: '/v1/access/represented-org-membership-changes' },
      { status: 'existing', method: 'POST', path: '/v1/access/representation-edge-changes' },
      { status: 'existing', method: 'GET', path: '/v1/access/representation-edges/{edgeId}' },
      { status: 'existing', method: 'POST', path: '/v1/me/authority-admissions' },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/me/authority-admissions/{admissionId}/checks',
      },
    ],
    context:
      "E `POST /v1/me/acting-context-checks`; E `POST /v1/me/representation-requests`; E `GET /v1/access/representation-requests/{requestId}`; E `POST /v1/access/representation-changes`; E `GET /v1/access/representations/{representationId}`; E `POST /v1/access/eligible-org-member-set-grant-changes`, E `GET /v1/access/eligible-org-member-set-grants/{grantId}`, E `POST /v1/access/selected-org-membership-changes` and E `GET /v1/me/selected-org-membership-changes` for IAM25's exact selected set; E `POST /v1/me/represented-org-membership-requests`, E `GET /v1/access/represented-org-membership-requests/{requestId}`, E `POST /v1/access/represented-org-mandate-changes`, E `POST /v1/access/represented-org-grant-changes` and E `POST /v1/access/represented-org-membership-changes` for IAM26; E `POST /v1/access/representation-edge-changes`, E `GET /v1/access/representation-edges/{edgeId}`, E `POST /v1/me/authority-admissions` and E `POST /v1/me/authority-admissions/{admissionId}/checks` for an admitted representation path. P wider selectors.",
  },
  {
    ids: ['IAM28', 'IAM29'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/me/acting-context-checks' },
      { status: 'existing', method: 'POST', path: '/v1/access/representation-edge-changes' },
      { status: 'existing', method: 'GET', path: '/v1/access/representation-edges/{edgeId}' },
      { status: 'existing', method: 'POST', path: '/v1/me/authority-admissions' },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/me/authority-admissions/{admissionId}/checks',
      },
      { status: 'existing', method: 'POST', path: '/v1/access/revocations' },
    ],
    context:
      'E `POST /v1/me/acting-context-checks`; E `POST /v1/access/representation-edge-changes`; E `GET /v1/access/representation-edges/{edgeId}`; E `POST /v1/me/authority-admissions`; E `POST /v1/me/authority-admissions/{admissionId}/checks`; E `POST /v1/access/revocations` for one of two independent grants. P incompatible partial-path pooling.',
  },
  {
    ids: ['IAM30', 'IAM31', 'IAM32'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/access/group-changes' },
      { status: 'existing', method: 'POST', path: '/v1/access/group-impact-approvals' },
      { status: 'existing', method: 'POST', path: '/v1/access/roles' },
      { status: 'existing', method: 'POST', path: '/v1/access/role-bindings' },
      { status: 'existing', method: 'POST', path: '/v1/access/protected-sets' },
      { status: 'existing', method: 'POST', path: '/v1/access/protected-change-proposals' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/access/protected-change-proposals/{proposalId}',
      },
      { status: 'existing', method: 'POST', path: '/v1/access/protected-change-approvals' },
      { status: 'existing', method: 'POST', path: '/v1/access/protected-change-activations' },
      { status: 'existing', method: 'POST', path: '/v1/me/automation-enrollments' },
      { status: 'existing', method: 'POST', path: '/v1/access/automation-installations' },
      { status: 'existing', method: 'POST', path: '/v1/access/representative-policy-changes' },
      { status: 'existing', method: 'GET', path: '/v1/access/representative-policies/{policyId}' },
      { status: 'existing', method: 'POST', path: '/v1/access/representative-roster-changes' },
      { status: 'existing', method: 'POST', path: '/v1/access/delegated-grant-changes' },
    ],
    context:
      'E `POST /v1/access/group-changes`; E `POST /v1/access/group-impact-approvals`; E `POST /v1/access/roles`; E `POST /v1/access/role-bindings`; E `POST /v1/access/protected-sets`; E `POST /v1/access/protected-change-proposals`; E `GET /v1/access/protected-change-proposals/{proposalId}`; E `POST /v1/access/protected-change-approvals`; E `POST /v1/access/protected-change-activations`; E `POST /v1/me/automation-enrollments`; E `POST /v1/access/automation-installations`; E `POST /v1/access/representative-policy-changes`; E `GET /v1/access/representative-policies/{policyId}`; E `POST /v1/access/representative-roster-changes`; E `POST /v1/access/delegated-grant-changes`.',
  },
  {
    ids: ['IAM33', 'IAM34', 'IAM35', 'IAM36'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/me/acting-context-checks' },
      { status: 'existing', method: 'PUT', path: '/v1/me/acting-context-preferences/work.create' },
      { status: 'existing', method: 'GET', path: '/v1/access/group-scope' },
      { status: 'existing', method: 'POST', path: '/v1/access/grant-changes' },
      { status: 'existing', method: 'POST', path: '/v1/access/representation-changes' },
      { status: 'existing', method: 'POST', path: '/v1/access/roles' },
      { status: 'existing', method: 'GET', path: '/v1/access/role-bindings' },
      { status: 'existing', method: 'GET', path: '/v1/access/role-bindings/{bindingId}' },
      { status: 'existing', method: 'POST', path: '/v1/access/policy-decision-revalidations' },
    ],
    context:
      'E `POST /v1/me/acting-context-checks`; E `PUT /v1/me/acting-context-preferences/work.create`; E `GET /v1/access/group-scope`; E `POST /v1/access/grant-changes`; E `POST /v1/access/representation-changes`; E `POST /v1/access/roles`; E `GET /v1/access/role-bindings`; E `GET /v1/access/role-bindings/{bindingId}`; E `POST /v1/access/policy-decision-revalidations`. P broader proof operations.',
  },
  {
    ids: ['IAM37'],
    targets: [
      { status: 'planned', method: 'PATCH', path: '/v1/catalog/resources/{resource}/descriptions' },
      { status: 'existing', method: 'POST', path: '/v1/me/acting-context-checks' },
    ],
    context:
      'P `PATCH /v1/catalog/resources/{resource}/descriptions`; E `POST /v1/me/acting-context-checks`.',
  },
  {
    ids: ['MODEL01', 'MODEL02', 'MODEL03', 'MODEL04'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/works' },
      { status: 'existing', method: 'GET', path: '/v1/revisions/{revision}' },
      { status: 'existing', method: 'POST', path: '/v1/works/{id}/scalar-value' },
      { status: 'existing', method: 'GET', path: '/v1/works/{id}/scalar-value' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/works/{id}/scalar-value/revisions/{revision}',
      },
    ],
    context:
      "E `POST /v1/works` with bounded `semanticTypes`; E `GET /v1/revisions/{revision}`; E `POST /v1/works/{id}/scalar-value`, E `GET /v1/works/{id}/scalar-value` and E `GET /v1/works/{id}/scalar-value/revisions/{revision}` for MODEL02's six-state Work profile; P general `POST /v1/semantic/changes` and `GET /v1/semantic/resources/{resource}/revisions/{revision}`. Huge/exact quantity and temporal/language profiles remain planned for MODEL03/04.",
  },
  {
    ids: ['MODEL05', 'MODEL06'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/works/{id}/source-author-credits' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/works/{id}/author-credits/{credit}/revisions/{revision}',
      },
      { status: 'existing', method: 'GET', path: '/v1/sources/author-credit-supports/{support}' },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/sources/author-credit-supports/{support}/withdrawals',
      },
    ],
    context:
      'E `POST /v1/works/{id}/source-author-credits`; E `GET /v1/works/{id}/author-credits/{credit}/revisions/{revision}`; E `GET /v1/sources/author-credit-supports/{support}` and E `POST /v1/sources/author-credit-supports/{support}/withdrawals` for one immutable external-reference credit profile. P general `POST /v1/relations/changes` and `GET /v1/relations/{occurrence}/revisions/{revision}`.',
  },
  {
    ids: ['MODEL07'],
    targets: [
      { status: 'existing', method: 'GET', path: '/v1/revisions/{revision}' },
      { status: 'planned', method: 'POST', path: '/v1/owners/relocations' },
    ],
    context: 'E `GET /v1/revisions/{revision}`; P `POST /v1/owners/relocations`.',
  },
  {
    ids: ['MODEL08', 'MODEL09', 'MODEL10'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/works' },
      { status: 'planned', method: 'POST', path: '/v1/semantic/changes' },
      { status: 'existing', method: 'POST', path: '/v1/me/acting-context-checks' },
      { status: 'planned', method: 'POST', path: '/v1/sources/observations' },
    ],
    context:
      'E `POST /v1/works` with bounded `semanticTypes`; P `POST /v1/semantic/changes`; E `POST /v1/me/acting-context-checks`; P `POST /v1/sources/observations`.',
  },
  {
    ids: ['MODEL11', 'MODEL12'],
    targets: [
      { status: 'existing', method: 'GET', path: '/v1/revisions/{revision}' },
      { status: 'planned', method: 'POST', path: '/v1/owners/reconciliations' },
    ],
    context: 'E `GET /v1/revisions/{revision}`; P `POST /v1/owners/reconciliations`.',
  },
  {
    ids: ['MODEL13', 'MODEL14'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/semantic/changes' },
      { status: 'planned', method: 'GET', path: '/v1/semantic/resources/{resource}' },
    ],
    context: 'P `POST /v1/semantic/changes`; P `GET /v1/semantic/resources/{resource}`.',
  },
  {
    ids: ['MODEL15', 'MODEL16', 'MODEL17', 'MODEL18'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/works' },
      { status: 'existing', method: 'POST', path: '/v1/classification-propositions' },
      { status: 'existing', method: 'GET', path: '/v1/classification-propositions/{sense}' },
      { status: 'existing', method: 'GET', path: '/v1/works/{id}/title-control' },
      { status: 'existing', method: 'POST', path: '/v1/works/{id}/title-control/source-return' },
      { status: 'planned', method: 'POST', path: '/v1/semantic/changes' },
    ],
    context:
      "E `POST /v1/works`; E `POST /v1/classification-propositions`; E `GET /v1/classification-propositions/{sense}`; E `GET /v1/works/{id}/title-control` and E `POST /v1/works/{id}/title-control/source-return` for MODEL17's editorial-control epoch; P `POST /v1/semantic/changes`.",
  },
  {
    ids: ['MODEL19', 'MODEL20', 'MODEL21'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/semantic/changes' },
      { status: 'planned', method: 'POST', path: '/v1/semantic/resolutions' },
    ],
    context: 'P `POST /v1/semantic/changes`; P `POST /v1/semantic/resolutions`.',
  },
  {
    ids: ['MODEL22', 'MODEL23', 'MODEL24'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/works' },
      { status: 'planned', method: 'POST', path: '/v1/semantic/changes' },
      { status: 'planned', method: 'GET', path: '/v1/model/generations/current' },
    ],
    context:
      'E `POST /v1/works`; P `POST /v1/semantic/changes`; P `GET /v1/model/generations/current`.',
  },
  {
    ids: ['MODEL25', 'MODEL26', 'MODEL27'],
    targets: [
      { status: 'existing', method: 'GET', path: '/v1/revisions/{revision}' },
      { status: 'existing', method: 'POST', path: '/v1/works' },
      { status: 'planned', method: 'POST', path: '/v1/owners/reconciliations' },
    ],
    context:
      'E `GET /v1/revisions/{revision}`; E `POST /v1/works`; P `POST /v1/owners/reconciliations`.',
  },
  {
    ids: ['CTX01', 'CTX02', 'CTX03'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/spaces' },
      { status: 'existing', method: 'GET', path: '/v1/spaces/{space}' },
      { status: 'existing', method: 'POST', path: '/v1/contexts' },
      { status: 'existing', method: 'POST', path: '/v1/contexts/{id}/semantic-revisions' },
      { status: 'existing', method: 'GET', path: '/v1/contexts/{id}' },
      { status: 'existing', method: 'POST', path: '/v1/realms/{realm}/context-selections' },
      { status: 'existing', method: 'PUT', path: '/v1/me/context-selections' },
      { status: 'existing', method: 'GET', path: '/v1/me/context-selections' },
      { status: 'existing', method: 'POST', path: '/v1/context-interpretations' },
      { status: 'existing', method: 'POST', path: '/v1/statements' },
      { status: 'existing', method: 'GET', path: '/v1/statements/{id}' },
      { status: 'existing', method: 'POST', path: '/v1/statement-decisions' },
      { status: 'existing', method: 'POST', path: '/v1/statement-resolutions' },
      { status: 'planned', method: 'POST', path: '/v1/contexts/changes' },
    ],
    context:
      'E `POST /v1/spaces`; E `GET /v1/spaces/{space}`; E earlier `POST /v1/classification-decisions`, `POST /v1/classification-resolutions`, `POST /v1/classification-contexts` and `GET /v1/realms/{realm}/classification-context`; E `POST /v1/contexts`, E `POST /v1/contexts/{id}/semantic-revisions` and E `GET /v1/contexts/{id}` for shared Context create and revision; E `POST /v1/realms/{realm}/context-selections`, E `PUT /v1/me/context-selections` and E `GET /v1/me/context-selections` for Realm and personal selection; E `POST /v1/context-interpretations`; E `POST /v1/statements`; E `GET /v1/statements/{id}`; E `POST /v1/statement-decisions` and E `POST /v1/statement-resolutions` for separate acceptance. P `POST /v1/contexts/changes` for publish, derive and retire.',
  },
  {
    ids: ['CTX04', 'CTX05'],
    targets: [
      { status: 'existing', method: 'GET', path: '/v1/classification-propositions/{sense}' },
      { status: 'existing', method: 'POST', path: '/v1/classification-resolutions' },
      { status: 'existing', method: 'POST', path: '/v1/contexts' },
      { status: 'existing', method: 'POST', path: '/v1/contexts/{id}/semantic-revisions' },
      { status: 'existing', method: 'GET', path: '/v1/contexts/{id}' },
      { status: 'existing', method: 'POST', path: '/v1/context-interpretations' },
      { status: 'existing', method: 'POST', path: '/v1/statements' },
      { status: 'existing', method: 'GET', path: '/v1/statements/{id}' },
      { status: 'existing', method: 'POST', path: '/v1/statement-resolutions' },
      { status: 'planned', method: 'POST', path: '/v1/semantic/changes' },
      { status: 'planned', method: 'POST', path: '/v1/contexts/changes' },
    ],
    context:
      'E earlier `POST /v1/classification-propositions`, E `GET /v1/classification-propositions/{sense}` and E `POST /v1/classification-resolutions`; E `POST /v1/contexts`, E `POST /v1/contexts/{id}/semantic-revisions` and E `GET /v1/contexts/{id}`; E `POST /v1/context-interpretations`; E `POST /v1/statements` and E `GET /v1/statements/{id}` for authored meaning; E `POST /v1/statement-resolutions`. P `POST /v1/semantic/changes` for exact resources and scoped definitions; P `POST /v1/contexts/changes` for publish, derive and retire.',
  },
  {
    ids: ['CTX06', 'CTX07'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/semantic/changes' },
      { status: 'existing', method: 'POST', path: '/v1/context-interpretations' },
      { status: 'existing', method: 'POST', path: '/v1/statement-resolutions' },
    ],
    context:
      'P `POST /v1/semantic/changes` for admitted definition/rule/name profiles; E `POST /v1/context-interpretations` for bounded unambiguous interpretation; E `POST /v1/statement-resolutions`; E earlier `POST /v1/classification-resolutions`.',
  },
  {
    ids: ['CTX08', 'CTX09', 'CTX10'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/semantic/changes' },
      { status: 'existing', method: 'POST', path: '/v1/contexts/{id}/semantic-revisions' },
      { status: 'existing', method: 'POST', path: '/v1/realms/{realm}/context-selections' },
      { status: 'planned', method: 'POST', path: '/v1/contexts/changes' },
      { status: 'existing', method: 'POST', path: '/v1/statement-resolutions' },
    ],
    context:
      'P `POST /v1/semantic/changes` for vocabulary/definition lifecycle; E `POST /v1/contexts/{id}/semantic-revisions` and E `POST /v1/realms/{realm}/context-selections` for pinned bases; P `POST /v1/contexts/changes` for retirement and successor adoption; P grouped-statement profiles at `POST /v1/queries`; E `POST /v1/statement-resolutions`.',
  },
  {
    ids: ['WORK01', 'WORK02'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/works' },
      { status: 'existing', method: 'POST', path: '/v1/contributions' },
      { status: 'existing', method: 'POST', path: '/v1/contribution-publications' },
      { status: 'existing', method: 'POST', path: '/v1/contribution-edits' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/contributions/{contribution}/drafts/{revision}',
      },
      { status: 'existing', method: 'POST', path: '/v1/translation-links' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/main-versions/{mainVersion}/revisions/{revision}/translation-links',
      },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/main-versions/{mainVersion}/native-variants',
      },
      {
        status: 'existing',
        method: 'PUT',
        path: '/v1/me/main-versions/{mainVersion}/variant-preference',
      },
      {
        status: 'existing',
        method: 'PUT',
        path: '/v1/realms/{realm}/main-versions/{mainVersion}/variant-recommendation',
      },
    ],
    context:
      'E `POST /v1/works`; E `POST /v1/contributions`; E `POST /v1/contribution-publications`; E `POST /v1/contribution-edits`; E `GET /v1/contributions/{contribution}/drafts/{revision}`; E `POST /v1/translation-links`; E `GET /v1/main-versions/{mainVersion}/revisions/{revision}/translation-links`; E `GET /v1/main-versions/{mainVersion}/native-variants`; E `PUT /v1/me/main-versions/{mainVersion}/variant-preference`; E `PUT /v1/realms/{realm}/main-versions/{mainVersion}/variant-recommendation`.',
  },
  {
    ids: ['WORK03', 'WORK04'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/publication-selections' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/realms/{realm}/main-versions/{mainVersion}/selection',
      },
      { status: 'existing', method: 'GET', path: '/v1/main-versions/{mainVersion}/selection' },
      { status: 'existing', method: 'POST', path: '/v1/work-derivations' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/main-versions/{mainVersion}/revisions/{revision}/work-derivations',
      },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/main-versions/{mainVersion}/revisions/{revision}',
      },
    ],
    context:
      'E `POST /v1/publication-selections`; E `GET /v1/realms/{realm}/main-versions/{mainVersion}/selection`; E `GET /v1/main-versions/{mainVersion}/selection`; E `POST /v1/work-derivations`; E `GET /v1/main-versions/{mainVersion}/revisions/{revision}/work-derivations`; E `GET /v1/main-versions/{mainVersion}/revisions/{revision}`.',
  },
  {
    ids: ['WORK05'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/fixed-releases' },
      { status: 'existing', method: 'GET', path: '/v1/fixed-releases/{release}' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/main-versions/{mainVersion}/revisions/{revision}',
      },
    ],
    context:
      'E `POST /v1/fixed-releases`; E `GET /v1/fixed-releases/{release}`; E `GET /v1/main-versions/{mainVersion}/revisions/{revision}`.',
  },
  {
    ids: ['WORK06'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/rating-observations' },
      { status: 'existing', method: 'POST', path: '/v1/rating-aggregates' },
    ],
    context: 'E `POST /v1/rating-observations`; E `POST /v1/rating-aggregates`.',
  },
  {
    ids: ['WORK07'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/package-resolutions' },
      { status: 'existing', method: 'POST', path: '/v1/package-locks' },
    ],
    context: 'E `POST /v1/package-resolutions`; E `POST /v1/package-locks`.',
  },
  {
    ids: ['WORK08'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/sources/observations' },
      { status: 'existing', method: 'POST', path: '/v1/sources/correspondences' },
      { status: 'existing', method: 'GET', path: '/v1/sources/correspondences/{correspondence}' },
    ],
    context:
      'P `POST /v1/sources/observations`; E `POST /v1/sources/correspondences`; E `GET /v1/sources/correspondences/{correspondence}`.',
  },
  {
    ids: ['WORK09', 'WORK10'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/content-drafts' },
      { status: 'existing', method: 'POST', path: '/v1/content-publications' },
      { status: 'existing', method: 'POST', path: '/v1/contribution-publications' },
      { status: 'existing', method: 'GET', path: '/v1/content-revisions/{revision}' },
    ],
    context:
      'E `POST /v1/content-drafts`; E `POST /v1/content-publications`; E `POST /v1/contribution-publications`; E `GET /v1/content-revisions/{revision}`.',
  },
  {
    ids: ['RATE01', 'RATE02'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/rating-observations' },
      { status: 'existing', method: 'POST', path: '/v1/rating-aggregates' },
    ],
    context: 'E `POST /v1/rating-observations`; E `POST /v1/rating-aggregates`.',
  },
  {
    ids: ['RATE03', 'RATE04'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/rating-contexts' },
      { status: 'existing', method: 'POST', path: '/v1/rating-observations' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/rating-observations/{observation}/revisions/{revision}',
      },
    ],
    context:
      'E `POST /v1/rating-contexts` for the daily timezone profile, E `POST /v1/rating-observations` for server-calendar daily slots and exact-head standing/daily `value: null` withdrawal, E `GET /v1/rating-observations/{observation}/revisions/{revision}` for private exact history. Daily aggregation and broader cadence policies remain planned.',
  },
  {
    ids: ['RATE05', 'RATE06'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/rating-contexts' },
      { status: 'existing', method: 'GET', path: '/v1/rating-contexts/{id}' },
      { status: 'existing', method: 'POST', path: '/v1/rating-contexts/{id}/policy-revisions' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/rating-contexts/{id}/policy-revisions/{revision}',
      },
      { status: 'existing', method: 'POST', path: '/v1/rating-aggregates' },
      { status: 'existing', method: 'POST', path: '/v1/global-rating-contexts' },
      { status: 'existing', method: 'GET', path: '/v1/global-rating-contexts/{id}' },
      { status: 'existing', method: 'POST', path: '/v1/global-rating-observations' },
      { status: 'existing', method: 'POST', path: '/v1/global-rating-aggregates' },
      { status: 'existing', method: 'POST', path: '/v1/rating-syntheses' },
    ],
    context:
      'E `POST /v1/rating-contexts`; E `GET /v1/rating-contexts/{id}`; E `POST /v1/rating-contexts/{id}/policy-revisions`; E `GET /v1/rating-contexts/{id}/policy-revisions/{revision}`; E `POST /v1/rating-aggregates`; E `POST /v1/global-rating-contexts`; E `GET /v1/global-rating-contexts/{id}`; E `POST /v1/global-rating-observations`; E `POST /v1/global-rating-aggregates`; E `POST /v1/rating-syntheses`.',
  },
  {
    ids: ['RATE07', 'RATE08', 'RATE09'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/events/observations' },
      { status: 'planned', method: 'POST', path: '/v1/events/queries' },
    ],
    context: 'P `POST /v1/events/observations`; P `POST /v1/events/queries`.',
  },
  {
    ids: ['GRAPH01', 'GRAPH02'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/queries' },
      { status: 'planned', method: 'POST', path: '/v1/relations/changes' },
    ],
    context: 'E `POST /v1/queries`; P `POST /v1/relations/changes`.',
  },
  {
    ids: ['GRAPH03', 'GRAPH04', 'GRAPH05'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/queries' },
      { status: 'existing', method: 'POST', path: '/v1/queries/page' },
    ],
    context: 'E `POST /v1/queries`; E `POST /v1/queries/page`.',
  },
  {
    ids: ['GRAPH06'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/graph-layouts' },
      { status: 'existing', method: 'GET', path: '/v1/graph-layouts/{layoutId}' },
    ],
    context: 'E `POST /v1/graph-layouts`; E `GET /v1/graph-layouts/{layoutId}`.',
  },
  {
    ids: ['OPS01', 'OPS02'],
    targets: [
      { status: 'existing', method: 'GET', path: '/health/live' },
      { status: 'existing', method: 'GET', path: '/health/ready' },
    ],
    context:
      'E `GET /health/live`; E `GET /health/ready`; owner `task toolchain:install`, `task stack:up`.',
  },
  {
    ids: ['OPS03', 'OPS04'],
    targets: [
      { status: 'existing', method: 'GET', path: '/v1/revisions/{revision}' },
      { status: 'planned', method: 'POST', path: '/v1/owners/reconciliations' },
    ],
    context:
      'E `GET /v1/revisions/{revision}`; P `POST /v1/owners/reconciliations`; owner `task stack:backup`.',
  },
  {
    ids: ['OPS05', 'OPS06'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/queries' },
      { status: 'existing', method: 'POST', path: '/v1/works' },
      { status: 'existing', method: 'GET', path: '/v1/operations/backpressure' },
    ],
    context:
      'E `POST /v1/queries`; E `POST /v1/works`; E `GET /v1/operations/backpressure`; owner `task load`, `task fixture:restore`.',
  },
  {
    ids: ['OPS07', 'OPS08'],
    targets: [
      { status: 'existing', path: '/api/auth/*' },
      { status: 'existing', method: 'POST', path: '/v1/me/acting-context-checks' },
    ],
    context: 'E `/api/auth/*` token/session operations; E `POST /v1/me/acting-context-checks`.',
  },
  {
    ids: ['OPS09'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/queries' },
      { status: 'existing', method: 'GET', path: '/health/search-ready' },
    ],
    context: 'E `POST /v1/queries`; E `GET /health/search-ready`; owner `task search:rebuild`.',
  },
  {
    ids: ['OPS10', 'OPS11', 'OPS12'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/erasures' },
      { status: 'existing', method: 'GET', path: '/v1/erasures/{erasureId}' },
      { status: 'existing', method: 'GET', path: '/v1/revisions/{revision}' },
    ],
    context:
      'E `POST /v1/erasures`; E `GET /v1/erasures/{erasureId}`; E `GET /v1/revisions/{revision}`.',
  },
  {
    ids: ['OPS13', 'OPS14'],
    targets: [
      { status: 'existing', method: 'GET', path: '/health/live' },
      { status: 'existing', method: 'GET', path: '/health/ready' },
      { status: 'existing', method: 'GET', path: '/health/search-ready' },
      { status: 'existing', method: 'POST', path: '/v1/works' },
      { status: 'existing', method: 'POST', path: '/v1/queries' },
    ],
    context:
      'E `GET /health/live`; E `GET /health/ready`; E `GET /health/search-ready`; E `POST /v1/works`; E `POST /v1/queries`; owner `task stack:up`.',
  },
  {
    ids: ['OPS15', 'OPS16'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/queries' },
      { status: 'existing', method: 'GET', path: '/v1/search/generations/current' },
      { status: 'existing', method: 'GET', path: '/health/search-ready' },
    ],
    context:
      'E `POST /v1/queries`; E `GET /v1/search/generations/current`; E `GET /health/search-ready`; owner `task search:rebuild`.',
  },
  {
    ids: ['SEARCH01', 'SEARCH02'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/queries' },
      { status: 'existing', method: 'POST', path: '/v1/queries/page' },
    ],
    context: 'E `POST /v1/queries`; E `POST /v1/queries/page`.',
  },
  {
    ids: ['SEARCH03', 'SEARCH04'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/queries' },
      { status: 'existing', method: 'POST', path: '/v1/private-queries' },
    ],
    context: 'E `POST /v1/queries`; E `POST /v1/private-queries`.',
  },
  {
    ids: ['SEARCH05', 'SEARCH06'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/queries' },
      { status: 'existing', method: 'POST', path: '/v1/queries/page' },
    ],
    context: 'E `POST /v1/queries`; E `POST /v1/queries/page`.',
  },
  {
    ids: ['SEARCH07', 'SEARCH08'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/works' },
      { status: 'existing', method: 'POST', path: '/v1/queries' },
      { status: 'existing', method: 'POST', path: '/v1/queries/page' },
    ],
    context: 'E `POST /v1/works`; E `POST /v1/queries`; E `POST /v1/queries/page`.',
  },
  {
    ids: ['SEARCH09', 'SEARCH10'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/queries' },
      { status: 'existing', method: 'POST', path: '/v1/queries/page' },
    ],
    context: 'E `POST /v1/queries`; E `POST /v1/queries/page`.',
  },
  {
    ids: ['SEARCH11', 'SEARCH12'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/private-queries' },
      { status: 'existing', method: 'POST', path: '/v1/me/acting-context-checks' },
    ],
    context: 'E `POST /v1/private-queries`; E `POST /v1/me/acting-context-checks`.',
  },
  {
    ids: ['SEARCH13', 'SEARCH14'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/queries' },
      { status: 'planned', method: 'POST', path: '/v1/semantic/changes' },
    ],
    context: 'E `POST /v1/queries`; P `POST /v1/semantic/changes`.',
  },
  {
    ids: ['SEARCH15', 'SEARCH16', 'SEARCH17'],
    targets: [{ status: 'existing', method: 'POST', path: '/v1/queries' }],
    context: 'E `POST /v1/queries`; owner `task search:rebuild`.',
  },
  {
    ids: ['SEARCH18', 'SEARCH19', 'SEARCH20'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/queries' },
      { status: 'existing', method: 'POST', path: '/v1/content-search-eligibility' },
    ],
    context:
      'E `POST /v1/queries`; E `POST /v1/content-search-eligibility`; owner `task search:rebuild`, `task load`.',
  },
  {
    ids: ['SUB01', 'SUB02', 'SUB03'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/subscriptions/quotes' },
      { status: 'existing', method: 'POST', path: '/v1/subscriptions/changes' },
      { status: 'existing', method: 'POST', path: '/v1/subscriptions/gifts' },
      { status: 'existing', method: 'POST', path: '/v1/subscriptions/settlements' },
      { status: 'existing', method: 'GET', path: '/v1/subscriptions/{subscriptionId}' },
      { status: 'existing', method: 'GET', path: '/v1/subscriptions/benefits' },
    ],
    context:
      'E `POST /v1/subscriptions/quotes`; E `POST /v1/subscriptions/changes`; E `POST /v1/subscriptions/gifts`; E `POST /v1/subscriptions/settlements`; E `GET /v1/subscriptions/{subscriptionId}`; E `GET /v1/subscriptions/benefits`.',
  },
  {
    ids: ['SUB04', 'SUB05', 'SUB06'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/realms/{realm}/quota-reservations' },
      { status: 'existing', method: 'GET', path: '/v1/realms/{realm}/quota-reservations' },
      { status: 'planned', method: 'POST', path: '/v1/realms/{realm}/review-decisions' },
      { status: 'planned', method: 'POST', path: '/v1/realms/{realm}/replies' },
    ],
    context:
      'E `POST /v1/realms/{realm}/quota-reservations`; E `GET /v1/realms/{realm}/quota-reservations`; P `POST /v1/realms/{realm}/review-decisions`; P `POST /v1/realms/{realm}/replies`.',
  },
  {
    ids: ['SUB07', 'SUB08'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/pro-sites/queries' },
      { status: 'existing', method: 'POST', path: '/v1/subscriptions/reconciliations' },
    ],
    context: 'E `POST /v1/pro-sites/queries`; E `POST /v1/subscriptions/reconciliations`.',
  },
  {
    ids: ['HUB01', 'HUB02'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/hub/imports' },
      { status: 'planned', method: 'POST', path: '/v1/prompts/revisions' },
    ],
    context: 'P `POST /v1/hub/imports`; P `POST /v1/prompts/revisions`.',
  },
  {
    ids: ['HUB03', 'HUB04'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/package-resolutions' },
      { status: 'planned', method: 'GET', path: '/v1/hub/artifacts/{artifact}' },
    ],
    context: 'E `POST /v1/package-resolutions`; P `GET /v1/hub/artifacts/{artifact}`.',
  },
  {
    ids: ['HUB05', 'HUB06'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/connected-apps/consents' },
      { status: 'planned', method: 'POST', path: '/v1/connected-apps/invocations' },
    ],
    context: 'P `POST /v1/connected-apps/consents`; P `POST /v1/connected-apps/invocations`.',
  },
  {
    ids: ['LIVE01', 'LIVE02', 'LIVE03'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/sources/intakes' },
      { status: 'existing', method: 'POST', path: '/v1/sources/acquisitions/open-library/works' },
      { status: 'existing', method: 'POST', path: '/v1/sources/acquisitions' },
      { status: 'existing', method: 'GET', path: '/v1/sources/runs/{run}' },
      { status: 'existing', method: 'GET', path: '/v1/sources/runs/{base}/drift/{candidate}' },
      { status: 'existing', method: 'GET', path: '/v1/sources/observations/{observation}' },
      { status: 'existing', method: 'GET', path: '/v1/sources/conversions/{conversion}' },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/sources/conversions/{conversion}/source-graph',
      },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/sources/conversions/{conversion}/source-graph',
      },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/sources/proposals/{proposal}/adoption/native-work',
      },
      { status: 'existing', method: 'GET', path: '/v1/sources/proposals/{proposal}' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/sources/proposals/{proposal}/adoption/native-work',
      },
      { status: 'existing', method: 'GET', path: '/v1/works/{id}/source-support' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/works/{id}/source-refresh-assessments/{candidateProposal}',
      },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/works/{id}/source-title-applications/{candidateProposal}',
      },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/works/{id}/source-title-applications/{candidateProposal}',
      },
      { status: 'existing', method: 'GET', path: '/v1/works/{id}/title-control' },
      { status: 'existing', method: 'POST', path: '/v1/works/{id}/title-control/source-return' },
      { status: 'existing', method: 'POST', path: '/v2/works/{id}/source-supports' },
      { status: 'existing', method: 'GET', path: '/v2/works/{id}/source-supports' },
      { status: 'existing', method: 'GET', path: '/v2/works/{id}/source-supports/{binding}' },
      { status: 'existing', method: 'POST', path: '/v1/works/{id}/source-support/withdrawal' },
      {
        status: 'existing',
        method: 'POST',
        path: '/v2/works/{id}/source-supports/{binding}/withdrawal',
      },
    ],
    context:
      'E `POST /v1/sources/intakes` for private manual staging; E `POST /v1/sources/acquisitions/open-library/works` for bounded single-Work capture; E `POST /v1/sources/acquisitions`, E `GET /v1/sources/runs/{run}` and E `GET /v1/sources/runs/{base}/drift/{candidate}` for a frozen run and its field drift; E `GET /v1/sources/observations/{observation}`; E `GET /v1/sources/conversions/{conversion}`; E `POST /v1/sources/conversions/{conversion}/source-graph` and E `GET /v1/sources/conversions/{conversion}/source-graph`; E `POST /v1/sources/proposals/{proposal}/adoption/native-work`, E `GET /v1/sources/proposals/{proposal}` and E `GET /v1/sources/proposals/{proposal}/adoption/native-work` for title-only new-Work adoption; E `GET /v1/works/{id}/source-support` for exact private historical support and current disposition; E `GET /v1/works/{id}/source-refresh-assessments/{candidateProposal}` for a read-only later source assessment; E `POST /v1/works/{id}/source-title-applications/{candidateProposal}` and E `GET /v1/works/{id}/source-title-applications/{candidateProposal}` for guarded same-epoch title refresh; E `GET /v1/works/{id}/title-control` and E `POST /v1/works/{id}/title-control/source-return`; E `POST /v2/works/{id}/source-supports`, E `GET /v2/works/{id}/source-supports` and E `GET /v2/works/{id}/source-supports/{binding}`; E `POST /v1/works/{id}/source-support/withdrawal` and E `POST /v2/works/{id}/source-supports/{binding}/withdrawal` for one exact title-binding disposition. P complete field-control and cross-epoch resolution operations.',
  },
  {
    ids: ['LIVE04', 'LIVE05', 'LIVE06'],
    targets: [
      { status: 'existing', method: 'GET', path: '/v1/sources/conversions/{conversion}' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/sources/conversions/{base}/drift/{candidate}',
      },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/sources/conversions/{base}/child-correspondences/{candidate}',
      },
      { status: 'existing', method: 'POST', path: '/v1/sources/correspondences' },
      { status: 'existing', method: 'GET', path: '/v1/sources/correspondences/{correspondence}' },
      { status: 'existing', method: 'POST', path: '/v1/works/{id}/source-author-credits' },
      { status: 'existing', method: 'GET', path: '/v1/sources/author-credit-supports/{support}' },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/sources/author-credit-supports/{support}/withdrawals',
      },
      { status: 'existing', method: 'POST', path: '/v1/works/{id}/source-support/withdrawal' },
      { status: 'existing', method: 'POST', path: '/v2/works/{id}/source-supports' },
      { status: 'existing', method: 'GET', path: '/v2/works/{id}/source-supports' },
      { status: 'existing', method: 'GET', path: '/v2/works/{id}/source-supports/{binding}' },
      {
        status: 'existing',
        method: 'POST',
        path: '/v2/works/{id}/source-supports/{binding}/withdrawal',
      },
    ],
    context:
      'E `GET /v1/sources/conversions/{conversion}`; E `GET /v1/sources/conversions/{base}/drift/{candidate}`; E `GET /v1/sources/conversions/{base}/child-correspondences/{candidate}` for a read-only occurrence assessment; E `POST /v1/sources/correspondences` and E `GET /v1/sources/correspondences/{correspondence}` for an explicit ambiguous source-only child match; E `POST /v1/works/{id}/source-author-credits`, E `GET /v1/sources/author-credit-supports/{support}` and E `POST /v1/sources/author-credit-supports/{support}/withdrawals` for bounded native author credit and independent support; E `POST /v1/works/{id}/source-support/withdrawal`, E `POST /v2/works/{id}/source-supports`, E `GET /v2/works/{id}/source-supports`, E `GET /v2/works/{id}/source-supports/{binding}` and E `POST /v2/works/{id}/source-supports/{binding}/withdrawal` for a recorded title binding. P general `POST /v1/sources/withdrawals`, child retirement and provider identity reconciliation.',
  },
  {
    ids: ['LIVE07', 'LIVE08', 'LIVE09'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/sources/acquisitions/open-library/works' },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/sources/observations/{observation}/conversions/open-library-work',
      },
      { status: 'existing', method: 'POST', path: '/v1/sources/acquisitions' },
      { status: 'existing', method: 'GET', path: '/v1/sources/runs/{run}' },
      { status: 'existing', method: 'GET', path: '/v1/sources/runs/{base}/drift/{candidate}' },
      { status: 'existing', method: 'GET', path: '/v1/sources/observations/{observation}' },
      { status: 'existing', method: 'GET', path: '/v1/sources/conversions/{conversion}' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/sources/conversions/{base}/drift/{candidate}',
      },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/sources/conversions/{conversion}/source-graph',
      },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/sources/conversions/{conversion}/source-graph',
      },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/sources/conversions/{conversion}/proposals/native-work',
      },
    ],
    context:
      'E `POST /v1/sources/acquisitions/open-library/works` for bounded Work capture; E `POST /v1/sources/observations/{observation}/conversions/open-library-work` for source-qualified staging; E `POST /v1/sources/acquisitions`; E `GET /v1/sources/runs/{run}`; E `GET /v1/sources/runs/{base}/drift/{candidate}`; E `GET /v1/sources/observations/{observation}`; E `GET /v1/sources/conversions/{conversion}`; E `GET /v1/sources/conversions/{base}/drift/{candidate}`; E `POST /v1/sources/conversions/{conversion}/source-graph`; E `GET /v1/sources/conversions/{conversion}/source-graph`; E `POST /v1/sources/conversions/{conversion}/proposals/native-work`.',
  },
  {
    ids: ['LIVE10', 'LIVE11', 'LIVE12'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/sources/acquisitions/open-library/works' },
      { status: 'existing', method: 'POST', path: '/v1/sources/acquisitions' },
      { status: 'existing', method: 'GET', path: '/v1/sources/runs/{run}' },
      { status: 'existing', method: 'POST', path: '/v1/sources/feeds' },
      { status: 'existing', method: 'GET', path: '/v1/sources/feeds/{feed}' },
      { status: 'existing', method: 'POST', path: '/v1/sources/feeds/{feed}/baselines' },
      { status: 'existing', method: 'POST', path: '/v1/sources/feeds/{feed}/windows' },
      { status: 'planned', method: 'POST', path: '/v1/exports' },
    ],
    context:
      'E `POST /v1/sources/acquisitions/open-library/works` for a bounded available surface; E `POST /v1/sources/acquisitions`; E `GET /v1/sources/runs/{run}`; E `POST /v1/sources/feeds`; E `GET /v1/sources/feeds/{feed}`; E `POST /v1/sources/feeds/{feed}/baselines` and E `POST /v1/sources/feeds/{feed}/windows` for dump then change intake. P `POST /v1/exports`.',
  },
  {
    ids: ['LIVE13', 'LIVE14', 'LIVE15'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/sources/intakes' },
      { status: 'existing', method: 'POST', path: '/v1/rights/use-assessments' },
      { status: 'existing', method: 'POST', path: '/v1/rights/use-evaluations' },
      { status: 'planned', method: 'POST', path: '/v1/exports' },
    ],
    context:
      'E `POST /v1/sources/intakes` for private manual staging; E `POST /v1/rights/use-assessments`; E `POST /v1/rights/use-evaluations`. P `POST /v1/exports`.',
  },
  {
    ids: ['LIVE16', 'LIVE17', 'LIVE18'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/sources/intakes' },
      { status: 'existing', method: 'POST', path: '/v1/sources/acquisitions' },
      { status: 'existing', method: 'POST', path: '/v1/rights/use-assessments' },
      { status: 'existing', method: 'POST', path: '/v1/rights/use-evaluations' },
      { status: 'existing', method: 'POST', path: '/v1/rights/restrictions' },
      { status: 'planned', method: 'POST', path: '/v1/exports' },
    ],
    context:
      'E `POST /v1/sources/intakes` for a non-retained record; E `POST /v1/sources/acquisitions`; E `POST /v1/rights/use-assessments`; E `POST /v1/rights/use-evaluations`; E `POST /v1/rights/restrictions`. P `POST /v1/exports`.',
  },
  {
    ids: ['PKG01', 'PKG02', 'PKG03', 'PKG04', 'PKG05', 'PKG06'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/package-resolutions' },
      { status: 'existing', method: 'GET', path: '/v1/package-resolutions/{resolution}' },
      { status: 'existing', method: 'POST', path: '/v1/package-resolutions/cargo' },
      { status: 'existing', method: 'GET', path: '/v1/package-resolutions/cargo/{resolution}' },
      { status: 'existing', method: 'POST', path: '/v1/package-resolutions/npm' },
      { status: 'existing', method: 'GET', path: '/v1/package-resolutions/npm/{resolution}' },
      { status: 'existing', method: 'POST', path: '/v1/package-sources/go' },
      { status: 'existing', method: 'GET', path: '/v1/package-sources/go/{capture}' },
      { status: 'existing', method: 'POST', path: '/v1/package-sources/go/{capture}/verify' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/package-sources/go-verifications/{verification}',
      },
      { status: 'existing', method: 'POST', path: '/v1/package-resolutions/from-captures' },
      { status: 'existing', method: 'POST', path: '/v1/package-resolutions/nix' },
      { status: 'existing', method: 'GET', path: '/v1/package-resolutions/nix/{resolution}' },
    ],
    context:
      'E `POST /v1/package-resolutions` and E `GET /v1/package-resolutions/{resolution}` for bounded Go snapshots; E `POST /v1/package-resolutions/cargo` and E `GET /v1/package-resolutions/cargo/{resolution}` for bounded exact Cargo resolver 2 v1/v2/v3 snapshots, including `links` conflict and admitted-lock yanked eligibility; E `POST /v1/package-resolutions/npm` and E `GET /v1/package-resolutions/npm/{resolution}` for caller-supplied npm lockfile-v3 nested and peer-host topology; E `POST /v1/package-sources/go`, E `GET /v1/package-sources/go/{capture}`, E `POST /v1/package-sources/go/{capture}/verify`, E `GET /v1/package-sources/go-verifications/{verification}` and E `POST /v1/package-resolutions/from-captures` for the bounded captured Go path; E `POST /v1/package-resolutions/nix` and E `GET /v1/package-resolutions/nix/{resolution}` for bounded Nix snapshots. P other ecosystem profiles, full resolver/provider/installation behavior.',
  },
  {
    ids: ['PKG07', 'PKG08', 'PKG09', 'PKG10', 'PKG11', 'PKG12', 'PKG13'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/package-resolutions' },
      { status: 'existing', method: 'GET', path: '/v1/package-resolutions/{resolution}' },
      { status: 'existing', method: 'POST', path: '/v1/package-resolutions/cargo' },
      { status: 'existing', method: 'GET', path: '/v1/package-resolutions/cargo/{resolution}' },
      { status: 'existing', method: 'POST', path: '/v1/package-resolutions/npm' },
      { status: 'existing', method: 'GET', path: '/v1/package-resolutions/npm/{resolution}' },
      { status: 'existing', method: 'POST', path: '/v1/package-resolutions/mods' },
      { status: 'existing', method: 'GET', path: '/v1/package-resolutions/mods/{resolution}' },
    ],
    context:
      'E `POST /v1/package-resolutions`, E `GET /v1/package-resolutions/{resolution}`, E `POST /v1/package-resolutions/cargo`, E `GET /v1/package-resolutions/cargo/{resolution}`, E `POST /v1/package-resolutions/npm` and E `GET /v1/package-resolutions/npm/{resolution}` for bounded incomplete/unsupported/budget outcomes; E `POST /v1/package-resolutions/mods` and E `GET /v1/package-resolutions/mods/{resolution}` for bounded mod capture. Cargo v2/v3 has selected native `links` unsatisfiability and v3 lock/index checksum inconsistency; npm v1 retains peer-host topology without fresh range solving. P other ecosystem profiles and general unsatisfiable/timeout outcomes.',
  },
  {
    ids: ['PKG14'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/package-sources/go/{capture}/verify' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/package-sources/go-verifications/{verification}',
      },
      { status: 'existing', method: 'POST', path: '/v1/package-locks' },
      { status: 'existing', method: 'GET', path: '/v1/package-locks/{lock}' },
      { status: 'existing', method: 'POST', path: '/v1/package-locks/{lock}/replays' },
      { status: 'existing', method: 'GET', path: '/v1/package-lock-replays/{replay}' },
    ],
    context:
      'E `POST /v1/package-sources/go/{capture}/verify`; E `GET /v1/package-sources/go-verifications/{verification}` for exact `go.mod` provenance only; E `POST /v1/package-locks`; E `GET /v1/package-locks/{lock}`; E `POST /v1/package-locks/{lock}/replays`; E `GET /v1/package-lock-replays/{replay}`.',
  },
  {
    ids: ['PKG15', 'PKG16', 'PKG17'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/package-installations' },
      { status: 'existing', method: 'GET', path: '/v1/package-installations/{installation}' },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/package-installations/{installation}/generations',
      },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/package-installations/{installation}/generations/{generation}',
      },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/package-installations/{installation}/generations/{generation}/apply',
      },
      { status: 'existing', method: 'POST', path: '/v1/package-artifacts/revocations' },
      {
        status: 'planned',
        method: 'POST',
        path: '/v1/package-installations/{installation}/recoveries',
      },
    ],
    context:
      'E `POST /v1/package-installations`; E `GET /v1/package-installations/{installation}`; E `POST /v1/package-installations/{installation}/generations`; E `GET /v1/package-installations/{installation}/generations/{generation}`; E `POST /v1/package-installations/{installation}/generations/{generation}/apply`; E `POST /v1/package-artifacts/revocations`. P `POST /v1/package-installations/{installation}/recoveries`.',
  },
  {
    ids: ['PKG18', 'PKG19'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/package-resolutions' },
      { status: 'existing', method: 'GET', path: '/v1/package-resolutions/{resolution}' },
    ],
    context: 'E `POST /v1/package-resolutions`; E `GET /v1/package-resolutions/{resolution}`.',
  },
  {
    ids: ['PKG20'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/sources/acquisitions' },
      { status: 'existing', method: 'POST', path: '/v1/package-resolutions' },
    ],
    context: 'E `POST /v1/sources/acquisitions`; E `POST /v1/package-resolutions`.',
  },
  {
    ids: ['VIEW01'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/addresses/claims' },
      { status: 'existing', method: 'GET', path: '/v1/addresses/work/{slug}' },
    ],
    context: 'E `POST /v1/addresses/claims`; E `GET /v1/addresses/work/{slug}`.',
  },
  {
    ids: ['VIEW02'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/addresses/renames' },
      { status: 'existing', method: 'POST', path: '/v1/addresses/dispositions' },
      { status: 'existing', method: 'GET', path: '/v1/addresses/work/{slug}' },
      { status: 'existing', method: 'GET', path: '/v1/works/{id}/addresses' },
      { status: 'existing', method: 'GET', path: '/v1/addresses/work/{slug}/revisions/{revision}' },
    ],
    context:
      'E `POST /v1/addresses/renames`; E `POST /v1/addresses/dispositions`; E `GET /v1/addresses/work/{slug}`; E `GET /v1/works/{id}/addresses`; E `GET /v1/addresses/work/{slug}/revisions/{revision}`. Transitive merge-chain reads traverse at most 32 Work hops; a longer, broken or cyclic route is unavailable (503).',
  },
  {
    ids: ['VIEW03'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/zones/{zone}/mounts' },
      { status: 'planned', method: 'GET', path: '/v1/zones/{zone}/resources/{resource}' },
    ],
    context: 'P `POST /v1/zones/{zone}/mounts`; P `GET /v1/zones/{zone}/resources/{resource}`.',
  },
  {
    ids: ['VIEW05'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/zones/{zone}/queries' },
      { status: 'existing', method: 'POST', path: '/v1/queries' },
    ],
    context: 'P `POST /v1/zones/{zone}/queries`; E `POST /v1/queries`.',
  },
  {
    ids: ['VIEW06'],
    targets: [
      { status: 'planned', method: 'PATCH', path: '/v1/zones/{zone}/configurations' },
      { status: 'planned', method: 'GET', path: '/v1/zones/{zone}' },
    ],
    context: 'P `PATCH /v1/zones/{zone}/configurations`; P `GET /v1/zones/{zone}`.',
  },
  {
    ids: ['VIEW07'],
    targets: [
      { status: 'existing', method: 'GET', path: '/v1/public-previews/{resource}' },
      { status: 'existing', method: 'GET', path: '/v1/sitemap' },
      { status: 'existing', method: 'GET', path: '/v1/resources/{resource}' },
      { status: 'existing', method: 'GET', path: '/v1/media/avatars/{selection}' },
      { status: 'existing', method: 'POST', path: '/v1/media/assets/{asset}/state' },
    ],
    context:
      'E `GET /v1/public-previews/{resource}`; E `GET /v1/sitemap`; E `GET /v1/resources/{resource}` summary with current-disclosure-qualified avatar; E `GET /v1/media/avatars/{selection}`; E `POST /v1/media/assets/{asset}/state`.',
  },
  {
    ids: ['VIEW08'],
    targets: [
      { status: 'existing', method: 'GET', path: '/v1/me/main-versions/{mainVersion}/selection' },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/me/realms/{realm}/main-versions/{mainVersion}/selection',
      },
      {
        status: 'existing',
        method: 'GET',
        path: '/v1/main-versions/{mainVersion}/native-variants',
      },
      { status: 'existing', method: 'GET', path: '/v1/resources/{resource}' },
      { status: 'existing', method: 'POST', path: '/v1/resources/summaries' },
      { status: 'existing', method: 'PUT', path: '/v1/resources/{resource}/avatar' },
      { status: 'existing', method: 'POST', path: '/v1/media/uploads' },
      { status: 'existing', method: 'PUT', path: '/v1/media/uploads/{upload}/bytes' },
      { status: 'existing', method: 'POST', path: '/v1/media/assets/{asset}/state' },
      { status: 'existing', method: 'GET', path: '/v1/media/avatars/{selection}' },
    ],
    context:
      'E `GET /v1/me/main-versions/{mainVersion}/selection`; E `GET /v1/me/realms/{realm}/main-versions/{mainVersion}/selection`; E `GET /v1/main-versions/{mainVersion}/native-variants`; E `GET /v1/resources/{resource}`; E `POST /v1/resources/summaries`; E `PUT /v1/resources/{resource}/avatar`; E `POST /v1/media/uploads`; E `PUT /v1/media/uploads/{upload}/bytes`; E `POST /v1/media/assets/{asset}/state`; E `GET /v1/media/avatars/{selection}`.',
  },
  {
    ids: ['VIEW09'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/themes/{theme}/activations' },
      { status: 'planned', method: 'GET', path: '/v1/themes/{theme}' },
    ],
    context: 'P `POST /v1/themes/{theme}/activations`; P `GET /v1/themes/{theme}`.',
  },
  {
    ids: ['COMP01', 'COMP02'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/compositions' },
      { status: 'existing', method: 'POST', path: '/v1/compositions/{id}/changes' },
      { status: 'existing', method: 'POST', path: '/v1/compositions/{id}/seals' },
      { status: 'existing', method: 'GET', path: '/v1/compositions/{id}' },
      { status: 'existing', method: 'GET', path: '/v1/compositions/{id}/occurrences/{occurrence}' },
    ],
    context:
      'E `POST /v1/compositions`; E `POST /v1/compositions/{id}/changes`; E `POST /v1/compositions/{id}/seals`; E `GET /v1/compositions/{id}`; E `GET /v1/compositions/{id}/occurrences/{occurrence}`.',
  },
  {
    ids: ['COMP03', 'COMP04'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/compositions/{composition}/stages' },
      { status: 'planned', method: 'POST', path: '/v1/compositions/{composition}/activations' },
    ],
    context:
      'P `POST /v1/compositions/{composition}/stages`; P `POST /v1/compositions/{composition}/activations`.',
  },
  {
    ids: ['COMP05', 'COMP06'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/compositions/{id}/changes' },
      { status: 'existing', method: 'GET', path: '/v1/compositions/{id}/revisions/{revision}' },
      { status: 'existing', method: 'GET', path: '/v1/compositions/{id}/occurrences/{occurrence}' },
      { status: 'existing', method: 'POST', path: '/v1/compositions/{id}/seals' },
    ],
    context:
      'E `POST /v1/compositions/{id}/changes`; E `GET /v1/compositions/{id}/revisions/{revision}`; E `GET /v1/compositions/{id}/occurrences/{occurrence}`; E `POST /v1/compositions/{id}/seals`.',
  },
  {
    ids: ['COMP07', 'COMP08'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/owners/relocations' },
      { status: 'planned', method: 'POST', path: '/v1/exports' },
      { status: 'existing', method: 'GET', path: '/v1/revisions/{revision}' },
    ],
    context:
      'P `POST /v1/owners/relocations`; P `POST /v1/exports`; E `GET /v1/revisions/{revision}`.',
  },
  {
    ids: ['WIKI01', 'WIKI02'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/zones/{zone}/mounts' },
      { status: 'planned', method: 'POST', path: '/v1/collections/{collection}/changes' },
    ],
    context: 'P `POST /v1/zones/{zone}/mounts`; P `POST /v1/collections/{collection}/changes`.',
  },
  {
    ids: ['WIKI03', 'WIKI04'],
    targets: [
      { status: 'planned', method: 'GET', path: '/v1/collections/{collection}/members' },
      { status: 'planned', method: 'POST', path: '/v1/collections/{collection}/captures' },
    ],
    context:
      'P `GET /v1/collections/{collection}/members`; P `POST /v1/collections/{collection}/captures`.',
  },
  {
    ids: ['WIKI05', 'WIKI06'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/publication-selections' },
      { status: 'planned', method: 'POST', path: '/v1/collections/{collection}/changes' },
    ],
    context: 'E `POST /v1/publication-selections`; P `POST /v1/collections/{collection}/changes`.',
  },
  {
    ids: ['BOOK01'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/works' },
      { status: 'existing', method: 'POST', path: '/v1/content-drafts' },
      { status: 'existing', method: 'POST', path: '/v1/content-publications' },
      { status: 'existing', method: 'POST', path: '/v1/compositions' },
      { status: 'existing', method: 'POST', path: '/v1/compositions/{id}/changes' },
      { status: 'existing', method: 'GET', path: '/v1/compositions/{id}' },
    ],
    context:
      'E `POST /v1/works`; E `POST /v1/content-drafts`; E `POST /v1/content-publications`; E `POST /v1/compositions`; E `POST /v1/compositions/{id}/changes`; E `GET /v1/compositions/{id}`.',
  },
  {
    ids: ['BOOK02', 'BOOK03'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/compositions/{id}/changes' },
      { status: 'existing', method: 'GET', path: '/v1/compositions/{id}/occurrences/{occurrence}' },
      { status: 'existing', method: 'POST', path: '/v1/fixed-releases' },
    ],
    context:
      'E `POST /v1/compositions/{id}/changes`; E `GET /v1/compositions/{id}/occurrences/{occurrence}`; E `POST /v1/fixed-releases`.',
  },
  {
    ids: ['BOOK04', 'BOOK05'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/content-comments' },
      { status: 'existing', method: 'GET', path: '/v1/content-comments/{comment}' },
      { status: 'existing', method: 'GET', path: '/v1/content-revisions/{revision}/comments' },
      { status: 'existing', method: 'POST', path: '/v1/content-edits' },
      { status: 'existing', method: 'POST', path: '/v1/contribution-edits' },
      { status: 'existing', method: 'GET', path: '/v1/content-revisions/{revision}' },
    ],
    context:
      'E `POST /v1/content-comments`; E `GET /v1/content-comments/{comment}`; E `GET /v1/content-revisions/{revision}/comments`; E `POST /v1/content-edits`; E `POST /v1/contribution-edits`; E `GET /v1/content-revisions/{revision}`.',
  },
  {
    ids: ['BOOK06', 'BOOK07', 'BOOK08'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/compositions/{composition}/activations' },
      { status: 'planned', method: 'POST', path: '/v1/sources/adoptions' },
      { status: 'planned', method: 'POST', path: '/v1/compositions/{composition}/restorations' },
    ],
    context:
      'P `POST /v1/compositions/{composition}/activations`; P `POST /v1/sources/adoptions`; P `POST /v1/compositions/{composition}/restorations`.',
  },
  {
    ids: ['BOOK09', 'BOOK10'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/media/publications' },
      { status: 'existing', method: 'GET', path: '/v1/media/uses/{use}' },
      { status: 'existing', method: 'POST', path: '/v1/content-edits' },
      { status: 'existing', method: 'POST', path: '/v1/me/acting-context-checks' },
    ],
    context:
      'E `POST /v1/media/publications`; E `GET /v1/media/uses/{use}`; E `POST /v1/content-edits`; E `POST /v1/me/acting-context-checks`.',
  },
  {
    ids: ['RECIPE01', 'RECIPE02'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/recipes/{recipe}/revisions' },
      { status: 'planned', method: 'POST', path: '/v1/recipes/{recipe}/scalings' },
    ],
    context: 'P `POST /v1/recipes/{recipe}/revisions`; P `POST /v1/recipes/{recipe}/scalings`.',
  },
  {
    ids: ['RECIPE03', 'RECIPE04'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/sources/intakes' },
      { status: 'existing', method: 'POST', path: '/v1/publication-selections' },
    ],
    context: 'E `POST /v1/sources/intakes`; E `POST /v1/publication-selections`.',
  },
  {
    ids: ['RECIPE05', 'RECIPE06'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/recipes/{recipe}/nutrition-calculations' },
      { status: 'planned', method: 'POST', path: '/v1/sources/withdrawals' },
    ],
    context:
      'P `POST /v1/recipes/{recipe}/nutrition-calculations`; P `POST /v1/sources/withdrawals`.',
  },
  {
    ids: ['FACT01', 'FACT02'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/claims' },
      { status: 'existing', method: 'GET', path: '/v1/claims/{claim}' },
      { status: 'existing', method: 'POST', path: '/v1/claims/{claim}/evidence' },
      { status: 'existing', method: 'GET', path: '/v1/claims/{claim}/evidence/{revision}' },
      { status: 'existing', method: 'POST', path: '/v1/claims/{claim}/assessments' },
      { status: 'existing', method: 'POST', path: '/v1/source-reliability-assessments' },
      { status: 'existing', method: 'POST', path: '/v1/verification/origins' },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/sources/observations/{observation}/lineage',
      },
      { status: 'existing', method: 'POST', path: '/v1/verification/lineage/{edge}/retraction' },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/sources/observations/{observation}/derivation',
      },
      { status: 'planned', method: 'POST', path: '/v1/sources/observations' },
    ],
    context:
      'E `POST /v1/claims`; E `GET /v1/claims/{claim}`; E `POST /v1/claims/{claim}/evidence`; E `GET /v1/claims/{claim}/evidence/{revision}`; E `POST /v1/claims/{claim}/assessments`; E `POST /v1/source-reliability-assessments`; E `POST /v1/verification/origins`; E `POST /v1/sources/observations/{observation}/lineage`; E `POST /v1/verification/lineage/{edge}/retraction`; E `POST /v1/sources/observations/{observation}/derivation`. P `POST /v1/sources/observations`.',
  },
  {
    ids: ['FACT03', 'FACT04'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/claims/{claim}/assessments' },
      { status: 'existing', method: 'GET', path: '/v1/claims/{claim}/assessments/{assessment}' },
      { status: 'existing', method: 'GET', path: '/v1/claims/{claim}/corrections' },
      { status: 'existing', method: 'POST', path: '/v1/source-reliability-assessments' },
    ],
    context:
      'E `POST /v1/claims/{claim}/assessments`; E `GET /v1/claims/{claim}/assessments/{assessment}`; E `GET /v1/claims/{claim}/corrections`; E `POST /v1/source-reliability-assessments`.',
  },
  {
    ids: ['FACT05', 'FACT06'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/exports' },
      { status: 'existing', method: 'POST', path: '/v1/claims/{claim}/challenges' },
      { status: 'existing', method: 'GET', path: '/v1/claims/{claim}/challenges' },
      {
        status: 'existing',
        method: 'POST',
        path: '/v1/claims/{claim}/challenges/{challenge}/withdrawal',
      },
    ],
    context:
      'P `POST /v1/exports`; E `POST /v1/claims/{claim}/challenges`; E `GET /v1/claims/{claim}/challenges`; E `POST /v1/claims/{claim}/challenges/{challenge}/withdrawal`.',
  },
  {
    ids: ['GOV01', 'GOV02', 'GOV03'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/reports' },
      { status: 'existing', method: 'GET', path: '/v1/reports/{report}' },
      { status: 'existing', method: 'POST', path: '/v1/moderation/decisions' },
      { status: 'existing', method: 'POST', path: '/v1/governance/process-steps' },
    ],
    context:
      'E `POST /v1/reports`; E `GET /v1/reports/{report}`; E `POST /v1/moderation/decisions`; E `POST /v1/governance/process-steps`.',
  },
  {
    ids: ['GOV04'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/rights/offerings/{offering}/changes' },
      { status: 'planned', method: 'GET', path: '/v1/rights/offerings/{offering}' },
    ],
    context:
      'P `POST /v1/rights/offerings/{offering}/changes`; P `GET /v1/rights/offerings/{offering}`.',
  },
  {
    ids: ['GOV05', 'GOV06'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/deliveries' },
      { status: 'existing', method: 'GET', path: '/v1/deliveries/{delivery}' },
      { status: 'existing', method: 'GET', path: '/v1/me/notifications' },
      { status: 'existing', method: 'GET', path: '/v1/me/notifications/hint' },
      { status: 'existing', method: 'PUT', path: '/v1/me/notification-preferences' },
      { status: 'existing', method: 'PUT', path: '/v1/me/notification-endpoints/push' },
      { status: 'existing', method: 'POST', path: '/v1/notification-providers/{provider}/events' },
    ],
    context:
      'P `POST /v1/deliveries`; E `GET /v1/deliveries/{delivery}`; E `GET /v1/me/notifications`; E `GET /v1/me/notifications/hint`; E `PUT /v1/me/notification-preferences`; E `PUT /v1/me/notification-endpoints/push`; E `POST /v1/notification-providers/{provider}/events`.',
  },
  {
    ids: ['GOV07', 'GOV08'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/erasures' },
      { status: 'existing', method: 'GET', path: '/v1/deliveries/{delivery}' },
      { status: 'existing', method: 'GET', path: '/v1/me/notifications' },
      { status: 'existing', method: 'GET', path: '/v1/me/notifications/hint' },
      { status: 'existing', method: 'PUT', path: '/v1/me/notification-read-watermarks/inbox' },
      { status: 'existing', method: 'POST', path: '/v1/me/notification-streams/inbox/resets' },
    ],
    context:
      'E `POST /v1/erasures`; E `GET /v1/deliveries/{delivery}`; E `GET /v1/me/notifications`; E `GET /v1/me/notifications/hint`; E `PUT /v1/me/notification-read-watermarks/inbox`; E `POST /v1/me/notification-streams/inbox/resets`.',
  },
  {
    ids: ['GOV09', 'GOV10'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/ratings/fit-observations' },
      { status: 'planned', method: 'POST', path: '/v1/ratings/spoiler-observations' },
    ],
    context: 'P `POST /v1/ratings/fit-observations`; P `POST /v1/ratings/spoiler-observations`.',
  },
  {
    ids: ['GOV11', 'GOV12'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/polls/{poll}/ballots' },
      { status: 'planned', method: 'GET', path: '/v1/polls/{poll}/tallies' },
    ],
    context: 'P `POST /v1/polls/{poll}/ballots`; P `GET /v1/polls/{poll}/tallies`.',
  },
  {
    ids: ['GOV13', 'GOV14'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/polls/{poll}/allocations' },
      { status: 'planned', method: 'POST', path: '/v1/polls/{poll}/openings' },
    ],
    context: 'P `POST /v1/polls/{poll}/allocations`; P `POST /v1/polls/{poll}/openings`.',
  },
  {
    ids: ['GOV15', 'GOV16'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/polls/{poll}/ballots' },
      { status: 'planned', method: 'POST', path: '/v1/polls/{poll}/mandate-approvals' },
    ],
    context: 'P `POST /v1/polls/{poll}/ballots`; P `POST /v1/polls/{poll}/mandate-approvals`.',
  },
  {
    ids: ['GOV17', 'GOV18'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/polls/{poll}/ballots' },
      { status: 'planned', method: 'GET', path: '/v1/polls/{poll}/charter' },
    ],
    context: 'P `POST /v1/polls/{poll}/ballots`; P `GET /v1/polls/{poll}/charter`.',
  },
  {
    ids: ['GOV19', 'GOV20'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/polls/{poll}/proxies' },
      { status: 'planned', method: 'POST', path: '/v1/polls/{poll}/ballots' },
    ],
    context: 'P `POST /v1/polls/{poll}/proxies`; P `POST /v1/polls/{poll}/ballots`.',
  },
  {
    ids: ['GOV21', 'GOV22'],
    targets: [
      { status: 'planned', method: 'GET', path: '/v1/polls/{poll}/tallies' },
      { status: 'planned', method: 'POST', path: '/v1/polls/{poll}/reconciliations' },
    ],
    context: 'P `GET /v1/polls/{poll}/tallies`; P `POST /v1/polls/{poll}/reconciliations`.',
  },
  {
    ids: ['GOV23'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/proposals/{proposal}/executions' },
      { status: 'planned', method: 'GET', path: '/v1/proposals/{proposal}' },
    ],
    context: 'P `POST /v1/proposals/{proposal}/executions`; P `GET /v1/proposals/{proposal}`.',
  },
  {
    ids: ['GOV24', 'GOV25'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/rights/complaints' },
      { status: 'existing', method: 'POST', path: '/v1/rights/restrictions' },
      { status: 'existing', method: 'POST', path: '/v1/governance/process-steps' },
    ],
    context:
      'E `POST /v1/rights/complaints`; E `POST /v1/rights/restrictions`; E `POST /v1/governance/process-steps`.',
  },
  {
    ids: ['SYS01', 'SYS02', 'SYS03'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/agents' },
      { status: 'existing', method: 'POST', path: '/v1/works' },
      { status: 'existing', method: 'GET', path: '/v1/revisions/{revision}' },
      { status: 'existing', method: 'POST', path: '/v1/editorial-protections' },
      { status: 'existing', method: 'POST', path: '/v1/corrections' },
      { status: 'existing', method: 'POST', path: '/v1/corrections/{proposalRevision}/decisions' },
      { status: 'existing', method: 'GET', path: '/v1/corrections/{proposalRevision}' },
      { status: 'existing', method: 'GET', path: '/v1/corrections' },
      { status: 'existing', method: 'POST', path: '/v1/editorial-state-queries' },
    ],
    context:
      'P `POST /v1/agents`; E `POST /v1/works`; E `GET /v1/revisions/{revision}`; E `POST /v1/editorial-protections`; E `POST /v1/corrections`; E `POST /v1/corrections/{proposalRevision}/decisions`; E `GET /v1/corrections/{proposalRevision}`; E `GET /v1/corrections`; E `POST /v1/editorial-state-queries`.',
  },
  {
    ids: ['SYS04', 'SYS05'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/owners/reconciliations' },
      { status: 'existing', method: 'POST', path: '/v1/content-publications' },
    ],
    context: 'P `POST /v1/owners/reconciliations`; E `POST /v1/content-publications`.',
  },
  {
    ids: ['SYS06', 'SYS07', 'SYS08'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/sources/acquisitions' },
      { status: 'existing', method: 'POST', path: '/v1/package-installations' },
      { status: 'existing', method: 'POST', path: '/v1/erasures' },
    ],
    context:
      'E `POST /v1/sources/acquisitions`; E `POST /v1/package-installations`; E `POST /v1/erasures`.',
  },
  {
    ids: ['SYS09', 'SYS10', 'SYS11'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/works' },
      { status: 'existing', method: 'POST', path: '/v1/content-publications' },
      { status: 'existing', method: 'GET', path: '/v1/revisions/{revision}' },
      { status: 'existing', method: 'POST', path: '/v1/editorial-protections' },
      { status: 'existing', method: 'POST', path: '/v1/corrections' },
      { status: 'existing', method: 'POST', path: '/v1/corrections/{proposalRevision}/decisions' },
      { status: 'existing', method: 'GET', path: '/v1/corrections' },
      { status: 'existing', method: 'POST', path: '/v1/editorial-state-queries' },
    ],
    context:
      'E `POST /v1/works`; E `POST /v1/content-publications`; E `GET /v1/revisions/{revision}`; E `POST /v1/editorial-protections`; E `POST /v1/corrections`; E `POST /v1/corrections/{proposalRevision}/decisions`; E `GET /v1/corrections`; E `POST /v1/editorial-state-queries`.',
  },
  {
    ids: ['SYS12', 'SYS13', 'SYS14'],
    targets: [
      { status: 'planned', method: 'POST', path: '/v1/owners/reconciliations' },
      { status: 'existing', method: 'POST', path: '/v1/works' },
      { status: 'existing', method: 'GET', path: '/v1/revisions/{revision}' },
      { status: 'existing', method: 'POST', path: '/v1/editorial-protections' },
      { status: 'existing', method: 'POST', path: '/v1/corrections' },
      { status: 'existing', method: 'POST', path: '/v1/corrections/{proposalRevision}/decisions' },
      { status: 'existing', method: 'GET', path: '/v1/corrections' },
      { status: 'existing', method: 'POST', path: '/v1/editorial-state-queries' },
    ],
    context:
      'P `POST /v1/owners/reconciliations`; E `POST /v1/works`; E `GET /v1/revisions/{revision}`; E `POST /v1/editorial-protections`; E `POST /v1/corrections`; E `POST /v1/corrections/{proposalRevision}/decisions`; E `GET /v1/corrections`; E `POST /v1/editorial-state-queries`.',
  },
  {
    ids: ['REC01', 'REC02'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/recommendations/queries' },
      { status: 'existing', method: 'POST', path: '/v1/recommendations/generation-builds' },
      { status: 'existing', method: 'GET', path: '/v1/recommendations/generations/{generation}' },
    ],
    context:
      'E `POST /v1/recommendations/queries`; E `POST /v1/recommendations/generation-builds`; E `GET /v1/recommendations/generations/{generation}`.',
  },
  {
    ids: ['REC03', 'REC04'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/recommendations/generation-builds' },
      { status: 'existing', method: 'GET', path: '/v1/recommendations/generations/{generation}' },
      { status: 'existing', method: 'POST', path: '/v1/recommendations/generation-activations' },
    ],
    context:
      'E `POST /v1/recommendations/generation-builds`; E `GET /v1/recommendations/generations/{generation}`; E `POST /v1/recommendations/generation-activations`.',
  },
  {
    ids: ['REC05', 'REC06'],
    targets: [
      { status: 'existing', method: 'POST', path: '/v1/recommendations/queries' },
      { status: 'existing', method: 'POST', path: '/v1/recommendations/pages' },
      { status: 'existing', method: 'GET', path: '/v1/recommendations/generations/{generation}' },
    ],
    context:
      'E `POST /v1/recommendations/queries`; E `POST /v1/recommendations/pages`; E `GET /v1/recommendations/generations/{generation}`.',
  },
];

export function operationMap(cases: readonly Case[]): ReadonlyMap<string, OperationMapping> {
  const map = new Map<string, OperationMapping>();
  for (const group of backendOperationMappings) {
    for (const id of group.ids) {
      if (map.has(id)) throw new Error(`Duplicate operation mapping for ${id}`);
      map.set(id, group);
    }
  }
  const expected = new Set(cases.map((item) => item.id));
  const missing = [...expected].filter((id) => !map.has(id));
  const unexpected = [...map.keys()].filter((id) => !expected.has(id));
  if (missing.length || unexpected.length) {
    throw new Error(
      `Backend operation mapping changed: missing ${missing.join(', ')}; unexpected ${unexpected.join(', ')}`,
    );
  }
  return map;
}
