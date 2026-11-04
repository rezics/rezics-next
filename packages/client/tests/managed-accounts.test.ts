import { expect, expectTypeOf, test } from 'bun:test';
import {
  createKernelClient,
  type KernelClient,
  type ManagedAccountsPage,
  type ManagedDirectoryNavigation,
} from '../src/index.ts';

type Inventory = KernelClient['me']['managedAccounts'];
expectTypeOf<Awaited<ReturnType<Inventory['get']>>['data']>().toEqualTypeOf<ManagedAccountsPage | null>();
expectTypeOf<ManagedAccountsPage['viewer']['state']>().toEqualTypeOf<'current'>();
expectTypeOf<ManagedAccountsPage['organizations']['items'][number]['navigation']>().toEqualTypeOf<ManagedDirectoryNavigation>();
expectTypeOf<ManagedDirectoryNavigation['state']>().toEqualTypeOf<'admitted' | 'unavailable' | 'concealed'>();

test('typed managed-account directory keeps closed viewer and navigation without a synthetic endpoint', async () => {
  const viewer = '019a0000-0000-7000-8000-000000000001';
  const page: ManagedAccountsPage = {
    account: { id: viewer, kind: 'actor', handle: 'avery', displayName: 'Avery' },
    viewer: {
      state: 'current',
      account: { id: viewer, kind: 'actor', handle: 'avery', displayName: 'Avery' },
    },
    organizations: {
      state: 'ready',
      items: [
        {
          account: { id: '019a0000-0000-7000-8000-000000000002', kind: 'organization', handle: null, displayName: 'Group' },
          role: 'owner',
          navigation: { state: 'admitted' },
        },
      ],
      next: null,
    },
    responsibilities: {
      items: [
        {
          reservationId: '019a0000-0000-7000-8000-000000000003',
          accountId: '019a0000-0000-7000-8000-000000000004',
          account: null,
          state: 'reconciling',
          navigation: { state: 'concealed' },
        },
      ],
      next: null,
    },
  };
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(page);
    }) as typeof fetch,
  });
  const result = await client.me.managedAccounts.get({
    headers: { authorization: 'Bearer viewer', 'cache-control': 'no-store' },
    fetch: { cache: 'no-store' },
    query: { organizationsCursor: 'org', operatorsCursor: 'op' },
  });
  expect(result.status).toBe(200);
  expect(result.data).toEqual(page);
  expect(new URL(requests[0]!.url).pathname).toBe('/v1/me/managedAccounts');
  expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toEqual({
    organizationsCursor: 'org',
    operatorsCursor: 'op',
  });
});
