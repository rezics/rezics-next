import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { directoryNavigation, managedAccountsSchema } from '../../src/access/account-management.ts';

const account = {
  id: '019a0000-0000-7000-8000-000000000001',
  kind: 'actor' as const,
  handle: 'avery',
  displayName: 'Avery',
};
const organization = {
  id: '019a0000-0000-7000-8000-000000000002',
  kind: 'organization' as const,
  handle: null,
  displayName: 'Group',
};

test('managed-account inventory schema is closed, page-bounded and distinguishes admission from a concealed target', () => {
  expect(directoryNavigation(false, true)).toEqual({ state: 'concealed' });
  expect(directoryNavigation(true, false)).toEqual({ state: 'unavailable' });
  expect(directoryNavigation(true, true)).toEqual({ state: 'admitted' });
  const page = {
    account,
    viewer: { state: 'current' as const, account },
    organizations: {
      state: 'ready' as const,
      items: [{ account: organization, role: 'owner' as const, navigation: { state: 'admitted' as const } }],
      next: null,
    },
    responsibilities: {
      items: [
        {
          reservationId: '019a0000-0000-7000-8000-000000000003',
          accountId: '019a0000-0000-7000-8000-000000000004',
          account: null,
          state: 'reconciling' as const,
          navigation: { state: 'concealed' as const },
        },
      ],
      next: null,
    },
  };
  expect(Value.Check(managedAccountsSchema, page)).toBe(true);
  expect(
    Value.Check(managedAccountsSchema, {
      ...page,
      organizations: { state: 'preparing', items: [], next: null },
    }),
  ).toBe(true);
  expect(Value.Check(managedAccountsSchema, { ...page, extra: true })).toBe(false);
  expect(
    Value.Check(managedAccountsSchema, {
      ...page,
      organizations: { ...page.organizations, items: Array.from({ length: 21 }, () => page.organizations.items[0]!) },
    }),
  ).toBe(false);
  expect(
    Value.Check(managedAccountsSchema, {
      ...page,
      viewer: { state: 'former', account },
    }),
  ).toBe(false);
  expect(
    Value.Check(managedAccountsSchema, {
      ...page,
      organizations: {
        ...page.organizations,
        items: [{ account: organization, role: 'owner', navigation: { state: 'admitted', href: '/x' } }],
      },
    }),
  ).toBe(false);
});
