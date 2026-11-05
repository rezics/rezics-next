import { expect, expectTypeOf, test } from 'bun:test';
import {
  createKernelClient,
  type BanReviewIdentity,
  type BanReviewPage,
  type BanReviewPageItem,
  type BanReviewPageQuery,
  type KernelClient,
} from '../src/index.ts';

type BanGet = ReturnType<KernelClient['realms']>['bans']['get'];
expectTypeOf<Awaited<ReturnType<BanGet>>['data']>().toEqualTypeOf<BanReviewPage | null>();
expectTypeOf<BanReviewPageItem>().toEqualTypeOf<BanReviewPage['items'][number]>();

test('ban review GET carries pagination and exact selection and preserves the complete response', async () => {
  const realmId = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const accountId = '019a1b2c-3d4e-7f00-8a00-000000000002';
  const viewerId = '019a1b2c-3d4e-7f00-8a00-000000000003';
  const at = '2026-11-04T00:00:00.000Z';
  const account: BanReviewIdentity = { state: 'concealed', accountId, label: 'Account', destination: null };
  const item: BanReviewPageItem = {
    accountId,
    reason: 'Current reason',
    actor: null,
    at,
    account,
    moderator: null,
    unban: { state: 'permitted', realmId, accountId, observedAt: at, membershipRestored: false },
    removal: { state: 'unavailable' },
  };
  const page: BanReviewPage = {
    items: [item],
    next: 'next/page+token',
    context: { state: 'concealed' },
    viewer: {
      accountId: viewerId,
      clientId: 'web',
      requestedBy: null,
      authnEpoch: 1,
      unban: {
        state: 'permitted',
        operationId: 'realm.unban',
        action: 'realm:ban',
        resource: { route: 1, id: realmId },
        reauthorizes: true,
      },
    },
    selected: { state: 'current', ban: item },
  };
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.method).toBe('GET');
      expect(url.pathname).toBe(`/v1/realms/${realmId}/bans`);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        limit: '20',
        cursor: 'page/token+with spaces',
        selectedAccountId: accountId,
      });
      return Response.json(page);
    }) as typeof fetch,
  });
  const query = {
    limit: 20,
    cursor: 'page/token+with spaces',
    selectedAccountId: accountId,
  } satisfies BanReviewPageQuery;
  const result = await client.realms({ realmId }).bans.get({ query });
  expect(result.error).toBeNull();
  expect(result.data).toEqual(page);
});
