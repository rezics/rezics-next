import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { randomUUID } from 'node:crypto';
import {
  realmPermission,
  realmPermissions,
  roleCommand,
  REALM_ADMIN_COST,
} from '../src/modules/realm-admin/contract.ts';

test('G-987: Realm role contracts accept rating configuration alongside every existing permission', () => {
  expect(Value.Check(realmPermission, 'rating.configure')).toBe(true);
  expect(
    Value.Check(roleCommand, {
      actingSubject: `https://rezics.com/id/${randomUUID()}`,
      expectedGeneration: '0',
      reason: 'Manage a Realm',
      change: {
        kind: 'role',
        roleId: randomUUID(),
        name: 'Manager',
        permissions: [...realmPermissions],
      },
    }),
  ).toBe(true);
  expect(realmPermissions).toHaveLength(REALM_ADMIN_COST.permissions);
  expect(Value.Check(realmPermission, 'rating.observation.set')).toBe(false);
});
