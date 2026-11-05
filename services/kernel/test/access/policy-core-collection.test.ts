import { expect, test } from 'bun:test';
import {
  compileNativePolicyCatalogue,
  decideNativePermission,
  uniqueNativePolicyResourceType,
  type NativePermissionProjection,
} from '../../src/access/policy-core.ts';
import type { ActionCatalogue } from '../../src/request/access.ts';
import type { ResolvedResourceRoles } from '../../src/access/resource-roles.ts';

const actions: ActionCatalogue = new Map([
  ['collection:read', { anonymous: true }],
  ['moderation:takedown', { anonymous: false }],
  ['post:read', { anonymous: true }],
]);
const roles: ResolvedResourceRoles = {
  roles: new Map([
    ['library.collection.owner', ['collection:read']],
    ['platform.governance', ['moderation:takedown']],
  ]),
  types: new Map([
    ['library.collection', { owner: 'library.collection.owner', standing: [] }],
    ['platform.report', { standing: ['platform.governance'] }],
    ['community.post', { standing: [] }],
  ]),
};
const catalogue = compileNativePolicyCatalogue(actions, roles);

function projection(overrides: Partial<NativePermissionProjection> = {}): NativePermissionProjection {
  return {
    assignmentValid: true,
    deadlineLive: true,
    localDenied: false,
    actorActionGrant: false,
    actorResourceRoleGrant: false,
    actorOwnAccountGrant: false,
    actorAuthenticatedBenefitGrant: false,
    principalActionGrant: false,
    principalResourceRoleGrant: false,
    principalOwnAccountGrant: false,
    principalAuthenticatedBenefitGrant: false,
    globalDenied: false,
    globalActorActionGrant: false,
    globalActorResourceRoleGrant: false,
    globalActorOwnAccountGrant: false,
    globalActorAuthenticatedBenefitGrant: false,
    globalPrincipalActionGrant: false,
    globalPrincipalResourceRoleGrant: false,
    globalPrincipalOwnAccountGrant: false,
    globalPrincipalAuthenticatedBenefitGrant: false,
    explicitLocalDenied: false,
    explicitActorActionGrant: false,
    explicitActorResourceRoleGrant: false,
    explicitActorOwnAccountGrant: false,
    explicitActorAuthenticatedBenefitGrant: false,
    explicitPrincipalActionGrant: false,
    explicitPrincipalResourceRoleGrant: false,
    explicitPrincipalOwnAccountGrant: false,
    explicitPrincipalAuthenticatedBenefitGrant: false,
    explicitGlobalDenied: false,
    explicitGlobalActorActionGrant: false,
    explicitGlobalActorResourceRoleGrant: false,
    explicitGlobalActorOwnAccountGrant: false,
    explicitGlobalActorAuthenticatedBenefitGrant: false,
    explicitGlobalPrincipalActionGrant: false,
    explicitGlobalPrincipalResourceRoleGrant: false,
    explicitGlobalPrincipalOwnAccountGrant: false,
    explicitGlobalPrincipalAuthenticatedBenefitGrant: false,
    ...overrides,
  };
}

const collection = {
  action: 'collection:read',
  resourceType: 'library.collection',
  anonymous: false,
  hasPrincipal: true,
  authenticatedBenefit: false,
  scope: true,
  floor: false,
  mode: 'ordinary' as const,
};

test('Collection policy consumes separate actor and principal facts, never the legacy allow bit', () => {
  const input = projection({ actorActionGrant: true, principalActionGrant: false });
  expect(
    decideNativePermission(catalogue, collection, { ...input, allowed: true } as NativePermissionProjection),
  ).toMatchObject({
    decision: 'deny',
    reason: 'grant',
  });
});

test('Collection floor remains public and scopeless while explicit advice drops floor and resource roles', () => {
  const publicInput = projection();
  expect(
    decideNativePermission(
      catalogue,
      { ...collection, anonymous: true, hasPrincipal: false, scope: false, floor: true },
      publicInput,
    ).decision,
  ).toBe('allow');

  const explicit = projection({ explicitActorResourceRoleGrant: true });
  expect(
    decideNativePermission(catalogue, { ...collection, hasPrincipal: false, floor: true, mode: 'explicit' }, explicit)
      .decision,
  ).toBe('deny');
});

test('exact registered Global reach is the only alternate path, and unavailable facts stay unavailable', () => {
  const reach = decideNativePermission(
    catalogue,
    {
      ...collection,
      action: 'moderation:takedown',
      resourceType: 'platform.report',
      hasPrincipal: false,
    },
    projection({
      localDenied: true,
      globalActorActionGrant: true,
      globalDenied: false,
    }),
  );
  expect(reach).toMatchObject({ decision: 'allow', reason: 'global-reach' });

  const unknown = decideNativePermission(catalogue, collection, projection({ actorActionGrant: null }));
  expect(unknown.decision).toBe('unavailable');
});

test('own-account Library writes keep the SQL live clock as deadline evidence', () => {
  const ownAccountCatalogue = compileNativePolicyCatalogue(
    new Map([['library_entry:update', { anonymous: false, authority: 'own-account' }]]),
    { roles: new Map(), types: new Map() },
  );
  const ownAccount = {
    action: 'library_entry:update',
    resourceType: 'access.account',
    anonymous: false,
    hasPrincipal: false,
    authenticatedBenefit: false,
    scope: true,
    floor: false,
    mode: 'ordinary' as const,
  };
  const missingDeadline = projection({ actorOwnAccountGrant: true, deadlineLive: null });
  expect(decideNativePermission(ownAccountCatalogue, ownAccount, missingDeadline).decision).toBe('unavailable');
  expect(
    decideNativePermission(ownAccountCatalogue, ownAccount, {
      ...missingDeadline,
      live: true,
    }).decision,
  ).toBe('allow');
  const mixed = compileNativePolicyCatalogue(
    new Map([
      ['rating:vote', { anonymous: false, authority: 'own-account', 'x-resource-types': ['semantic.work'] }],
    ]),
    { roles: new Map(), types: new Map([['semantic.work', { standing: [] }]]) },
  );
  expect(uniqueNativePolicyResourceType(mixed, 'rating:vote')).toBe('access.account');
});
