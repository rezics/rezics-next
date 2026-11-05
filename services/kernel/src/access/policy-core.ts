import {
  compilePolicyCatalogue,
  decidePolicy,
  type PolicyCatalogue,
  type PolicyDecision,
  type PolicyFacts,
  type PolicyMode,
  type PolicySubjectFacts,
} from '@rezics/access';
import type { Access, ActionCatalogue } from '../request/access.ts';
import { isGlobalReachAction } from './governance-reach.ts';
import { resourceRoleCatalogue, type ResolvedResourceRoles } from './resource-roles.ts';

const nativePolicyCatalogues = new WeakMap<ResolvedResourceRoles, PolicyCatalogue>();

/** Primitive projection returned by the existing bounded permission statement. */
export type NativePermissionProjection = Readonly<{
  assignmentValid: boolean | null;
  deadlineLive: boolean | null;
  localDenied: boolean | null;
  actorActionGrant: boolean | null;
  actorResourceRoleGrant: boolean | null;
  actorOwnAccountGrant: boolean | null;
  actorAuthenticatedBenefitGrant: boolean | null;
  principalActionGrant: boolean | null;
  principalResourceRoleGrant: boolean | null;
  principalOwnAccountGrant: boolean | null;
  principalAuthenticatedBenefitGrant: boolean | null;
  globalDenied: boolean | null;
  globalActorActionGrant: boolean | null;
  globalActorResourceRoleGrant: boolean | null;
  globalActorOwnAccountGrant: boolean | null;
  globalActorAuthenticatedBenefitGrant: boolean | null;
  globalPrincipalActionGrant: boolean | null;
  globalPrincipalResourceRoleGrant: boolean | null;
  globalPrincipalOwnAccountGrant: boolean | null;
  globalPrincipalAuthenticatedBenefitGrant: boolean | null;
  explicitLocalDenied: boolean | null;
  explicitActorActionGrant: boolean | null;
  explicitActorResourceRoleGrant: boolean | null;
  explicitActorOwnAccountGrant: boolean | null;
  explicitActorAuthenticatedBenefitGrant: boolean | null;
  explicitPrincipalActionGrant: boolean | null;
  explicitPrincipalResourceRoleGrant: boolean | null;
  explicitPrincipalOwnAccountGrant: boolean | null;
  explicitPrincipalAuthenticatedBenefitGrant: boolean | null;
  explicitGlobalDenied: boolean | null;
  explicitGlobalActorActionGrant: boolean | null;
  explicitGlobalActorResourceRoleGrant: boolean | null;
  explicitGlobalActorOwnAccountGrant: boolean | null;
  explicitGlobalActorAuthenticatedBenefitGrant: boolean | null;
  explicitGlobalPrincipalActionGrant: boolean | null;
  explicitGlobalPrincipalResourceRoleGrant: boolean | null;
  explicitGlobalPrincipalOwnAccountGrant: boolean | null;
  explicitGlobalPrincipalAuthenticatedBenefitGrant: boolean | null;
}>;

function subject(
  row: NativePermissionProjection,
  prefix:
    | 'actor'
    | 'principal'
    | 'explicitActor'
    | 'explicitPrincipal'
    | 'globalActor'
    | 'globalPrincipal'
    | 'explicitGlobalActor'
    | 'explicitGlobalPrincipal',
): PolicySubjectFacts {
  const key = (name: string) => `${prefix}${name}` as keyof NativePermissionProjection;
  return {
    actionGrant: row[key('ActionGrant')] ?? null,
    resourceRoleGrant: row[key('ResourceRoleGrant')] ?? null,
    ownAccount: row[key('OwnAccountGrant')] ?? null,
    authenticatedBenefit: row[key('AuthenticatedBenefitGrant')] ?? null,
  };
}

/** Project the one native Access registration into the standalone data catalogue. */
export function compileNativePolicyCatalogue(actions: ActionCatalogue, roles: ResolvedResourceRoles): PolicyCatalogue {
  const typesByAction = new Map<string, Set<string>>();
  for (const [type, template] of roles.types) {
    const registeredRoles = [template.owner, ...template.standing].filter((role): role is string => role !== undefined);
    for (const role of registeredRoles) {
      for (const action of roles.roles.get(role) ?? []) {
        const types = typesByAction.get(action) ?? new Set<string>();
        types.add(type);
        typesByAction.set(action, types);
      }
    }
  }
  const result = compilePolicyCatalogue({
    actions: [...actions].map(([action, metadata]) => ({
      action,
      anonymous: metadata.anonymous,
      authority: metadata.authority === 'own-account' ? 'own-account' : 'resource',
      resourceTypes: [...new Set([...(metadata['x-resource-types'] ?? []), ...(typesByAction.get(action) ?? [])])],
      globalReach: isGlobalReachAction(action),
    })),
    roles: [...roles.roles].map(([role, values]) => ({ role, actions: [...values] })),
    resourceTypes: [...roles.types].map(([type, template]) => ({
      type,
      ...(template.owner ? { ownerRole: template.owner } : {}),
      standingRoles: [...template.standing],
    })),
  });
  if (!result.ok)
    throw new TypeError(
      `Invalid native Access policy catalogue: ${result.errors.map((error) => error.code).join(',')}`,
    );
  nativePolicyCatalogues.set(roles, result.catalogue);
  return result.catalogue;
}

/** Return the already compiled native catalogue without rebuilding or copying its registrations. */
export function nativePolicyCatalogueForAccess(access: Access): PolicyCatalogue | undefined {
  const roles = resourceRoleCatalogue(access);
  return roles ? nativePolicyCatalogues.get(roles) : undefined;
}

/** Evaluate ordinary and explicit forms from distinct SQL branches. `allowed` is intentionally absent. */
export function decideNativePermission(
  catalogue: PolicyCatalogue,
  input: Readonly<{
    action: string;
    resourceType: string;
    anonymous: boolean;
    hasPrincipal: boolean;
    authenticatedBenefit: boolean;
    scope: boolean;
    floor: boolean;
    mode: PolicyMode;
  }>,
  row: NativePermissionProjection,
): PolicyDecision {
  const explicit = input.mode === 'explicit';
  const actor = subject(row, explicit ? 'explicitActor' : 'actor');
  const principal = subject(row, explicit ? 'explicitPrincipal' : 'principal');
  const globalActor = subject(row, explicit ? 'explicitGlobalActor' : 'globalActor');
  const globalPrincipal = subject(row, explicit ? 'explicitGlobalPrincipal' : 'globalPrincipal');
  const facts: PolicyFacts = {
    standing: true,
    assignment: row.assignmentValid,
    deadlineLive: row.deadlineLive,
    scope: input.scope,
    localDenial: explicit ? row.explicitLocalDenied : row.localDenied,
    publicFloor: explicit ? false : input.floor,
    actor,
    ...(input.hasPrincipal ? { principal } : {}),
    global: {
      denial: explicit ? row.explicitGlobalDenied : row.globalDenied,
      actor: globalActor,
      ...(input.hasPrincipal ? { principal: globalPrincipal } : {}),
    },
  };
  return decidePolicy(
    catalogue,
    {
      action: input.action,
      resourceType: input.resourceType,
      mode: input.mode,
      anonymous: input.anonymous,
      hasPrincipal: input.hasPrincipal,
      authenticatedBenefit: input.authenticatedBenefit,
    },
    facts,
  );
}
