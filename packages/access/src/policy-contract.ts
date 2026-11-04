export type PolicyFact = boolean | null;
export type PolicyMode = 'ordinary' | 'explicit';

export type PolicyActionDeclaration = Readonly<{
  action: string;
  anonymous: boolean;
  authority: 'resource' | 'own-account';
  resourceTypes: readonly string[];
  globalReach: boolean;
}>;

export type PolicyRoleDeclaration = Readonly<{
  role: string;
  actions: readonly string[];
}>;

export type PolicyResourceTypeDeclaration = Readonly<{
  type: string;
  ownerRole?: string;
  standingRoles: readonly string[];
}>;

export type PolicyCatalogueInput = Readonly<{
  actions: readonly PolicyActionDeclaration[];
  roles: readonly PolicyRoleDeclaration[];
  resourceTypes: readonly PolicyResourceTypeDeclaration[];
}>;

export type PolicyCatalogueError = Readonly<{
  code:
    | 'invalid-input'
    | 'catalogue-too-large'
    | 'too-many-actions'
    | 'too-many-resource-types'
    | 'too-many-role-references'
    | 'invalid-action'
    | 'duplicate-action'
    | 'invalid-role'
    | 'duplicate-role'
    | 'unknown-role-action'
    | 'invalid-resource-type'
    | 'duplicate-resource-type'
    | 'unknown-resource-action'
    | 'unknown-owner-role'
    | 'unknown-standing-role'
    | 'invalid-profile';
  index: number;
}>;

export type PolicyAction = PolicyActionDeclaration;
export type PolicyRole = PolicyRoleDeclaration;
export type PolicyResourceType = PolicyResourceTypeDeclaration;

/** The compiled representation owns copies of every mutable input array. */
export type PolicyCatalogue = Readonly<{
  actions: readonly PolicyAction[];
  roles: readonly PolicyRole[];
  resourceTypes: readonly PolicyResourceType[];
  actionByName: Readonly<Record<string, PolicyAction>>;
  roleByName: Readonly<Record<string, PolicyRole>>;
  resourceTypeByName: Readonly<Record<string, PolicyResourceType>>;
}>;

export type PolicyCatalogueResult =
  | Readonly<{ ok: true; catalogue: PolicyCatalogue }>
  | Readonly<{ ok: false; errors: readonly PolicyCatalogueError[] }>;

export type PolicyRequest = Readonly<{
  action: string;
  resourceType: string;
  mode: PolicyMode;
  anonymous: boolean;
  hasPrincipal: boolean;
  /** True only when the native resource profile declares this qualified relation operand. */
  authenticatedBenefit?: boolean;
}>;

export type PolicySubjectFacts = Readonly<{
  actionGrant: PolicyFact;
  resourceRoleGrant: PolicyFact;
  ownAccount: PolicyFact;
  authenticatedBenefit: PolicyFact;
}>;

export type PolicyGlobalFacts = Readonly<{
  denial: PolicyFact;
  actor: PolicySubjectFacts;
  principal?: PolicySubjectFacts;
}>;

/**
 * These values are qualified primitive evidence. `null` means a required
 * source was missing or unavailable; it never means a complete negative.
 */
export type PolicyFacts = Readonly<{
  standing: PolicyFact;
  assignment: PolicyFact;
  deadlineLive: PolicyFact;
  scope: PolicyFact;
  localDenial: PolicyFact;
  publicFloor: PolicyFact;
  actor: PolicySubjectFacts;
  principal?: PolicySubjectFacts;
  global?: PolicyGlobalFacts;
}>;

export type PolicyOperandName =
  | 'standing'
  | 'assignment'
  | 'deadline'
  | 'scope'
  | 'actor.action-grant'
  | 'actor.resource-role-grant'
  | 'actor.own-account'
  | 'actor.authenticated-benefit'
  | 'principal.action-grant'
  | 'principal.resource-role-grant'
  | 'principal.own-account'
  | 'principal.authenticated-benefit'
  | 'local.denial'
  | 'public.floor'
  | 'global.denial'
  | 'global.actor-action-grant'
  | 'global.actor-resource-role-grant'
  | 'global.actor.own-account'
  | 'global.actor.authenticated-benefit'
  | 'global.principal-action-grant'
  | 'global.principal-resource-role-grant'
  | 'global.principal.own-account'
  | 'global.principal.authenticated-benefit';

export type PolicyOperand = Readonly<{
  name: PolicyOperandName;
  value: 'true' | 'false' | 'unknown' | 'not-required';
  decisive: boolean;
}>;

export type PolicyDecision = Readonly<{
  decision: 'allow' | 'deny' | 'unavailable' | 'invalid';
  reason:
    | 'local-floor'
    | 'local-grant'
    | 'global-reach'
    | 'standing'
    | 'assignment'
    | 'deadline'
    | 'denial'
    | 'scope'
    | 'grant'
    | 'evidence'
    | 'invalid-request';
  explanation: readonly PolicyOperand[];
}>;

export type RequiredPolicyOperand = Readonly<{
  name: PolicyOperandName;
  required: boolean;
  independentOfScope?: boolean;
}>;

export type TemporalInterval = Readonly<{
  fromMicros: string | null;
  untilMicros: string | null;
}>;

export type TemporalEvidence = Readonly<{
  complete: boolean;
  intervals: readonly TemporalInterval[];
}>;

export const MAX_POLICY_ACTIONS = 100 * 64;
export const MAX_POLICY_RESOURCE_TYPES = 100;
export const MAX_POLICY_ACTIONS_PER_RESOURCE_TYPE = 64;
export const MAX_POLICY_ROLE_REFERENCES_PER_ACTION = 4;
export const MAX_POLICY_TYPE_ROLE_REFERENCES = MAX_POLICY_ACTIONS_PER_RESOURCE_TYPE * MAX_POLICY_RESOURCE_TYPES;
export const MAX_POLICY_ACTION_TYPE_REFERENCES = MAX_POLICY_ACTIONS_PER_RESOURCE_TYPE * MAX_POLICY_RESOURCE_TYPES;
export const MAX_POLICY_CATALOGUE_BYTES = 1_048_576;
export const MAX_POLICY_TEMPORAL_INTERVALS = 2_000;
export const MAX_POLICY_TEMPORAL_INTEGER_CHARS = 32;
export const MAX_POLICY_EXPLANATION_NODES = 32;
export const MAX_POLICY_EXPLANATION_BYTES = 4_096;
