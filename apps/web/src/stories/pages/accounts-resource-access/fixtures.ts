import type { AccessSnapshot } from '../../../accounts/resource-access/data';

/** HTTP-shaped presentation examples, not native recordings or authorization evidence. */
export const resourceId = '0192f3a0-6c1e-7b2a-a001-000100000001';
export const managerId = '0192f3a0-6c1e-7b2a-a001-000200000001';
export const readerId = '0192f3a0-6c1e-7b2a-a001-000200000002';
export const snapshot: AccessSnapshot = {
  resource: { id: resourceId, route: 1, type: 'library.collection' },
  authority: { accountId: managerId, clientId: 'rezics-website', principalId: null },
  roles: [
    {
      id: 'library.collection.owner',
      actions: ['collection:read', 'collection:update', 'collection:delete'],
      delegable: true,
    },
  ],
  actions: ['collection:read', 'collection:update', 'collection:delete'],
  identities: [
    {
      id: managerId,
      kind: 'actor',
      handle: 'mira',
      displayName: 'Mira',
      state: 'active',
      automated: false,
      operatorId: null,
    },
    {
      id: readerId,
      kind: 'actor',
      handle: 'aki',
      displayName: 'Aki',
      state: 'active',
      automated: false,
      operatorId: null,
    },
  ],
  grants: [
    {
      kind: 'direct',
      state: 'active',
      subject: { kind: 'account', id: readerId },
      actions: ['collection:read'],
      role: null,
      valid: '["2026-10-01 00:00:00+00",)',
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: null,
      manageable: true,
    },
  ],
  next: null,
  mutationState: 'ready',
};

export const permissionSnapshot: AccessSnapshot = {
  ...snapshot,
  resource: { ...snapshot.resource, type: 'semantic.context' },
  roles: [
    {
      id: 'semantic.context.owner',
      actions: ['context:accept', 'context:adopt', 'access:grant', 'context:delete', 'context:restore'],
      delegable: true,
    },
  ],
  actions: ['context:accept', 'context:adopt', 'access:grant', 'context:delete', 'context:restore'],
  grants: [
    {
      ...snapshot.grants[0]!,
      kind: 'direct',
      actions: ['context:accept'],
      role: null,
    },
  ],
};
