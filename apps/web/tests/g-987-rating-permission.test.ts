import { expect, test } from 'bun:test';
import { realmPermissions } from '../../../services/main/src/modules/realm-admin/contract.ts';
import {
  impactLines,
  permissionOrder,
  permissionText,
  sortPermissions,
} from '../features/manage/permissions.ts';

test('G-987: the role editor and impact preview retain every public Realm permission', () => {
  expect(new Set(permissionOrder)).toEqual(new Set(realmPermissions));
  expect(new Set(Object.keys(permissionText))).toEqual(new Set(realmPermissions));
  expect(sortPermissions(['rating.configure'])).toEqual(['rating.configure']);
  expect(
    impactLines({
      changes: [{ member: 'rating-manager', gained: ['rating.configure'], lost: [] }],
    }),
  ).toEqual([{ permission: 'rating.configure', direction: 'gain', members: ['rating-manager'] }]);
});
