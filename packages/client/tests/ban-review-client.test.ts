import { expect, expectTypeOf, test } from 'bun:test';
import {
  createKernelClient,
  type BanReviewIdentity,
  type BanReviewPage,
  type BanReviewPageItem,
  type BanReviewPageQuery,
  type KernelClient,
} from '../src/index.ts';

const realmId = '019a1b2c-3d4e-7f00-8a00-000000000001';
const accountId = '019a1b2c-3d4e-7f00-8a00-000000000002';
const query = { limit: 20, cursor: 'opaque-cursor', selectedAccountId: accountId } satisfies BanReviewPageQuery;
const identity: BanReviewIdentity = { state: 'concealed', accountId, label: 'Account', destination: null };
const item: BanReviewPageItem = {
  accountId,
  reason: 'spam',
  actor: null,
  at: '2026-11-04T00:00:00.000Z',
  account: identity,
  moderator: null,
  unban: {
    state: 'permitted',
    realmId,
    accountId,
    observedAt: '2026-11-04T00:00:00.000Z',
    membershipRestored: false,
  },
  removal: { state: 'unavailable' },
};
const page: BanReviewPage = {
  items: [item],
  next: 'next-cursor',
  context: { state: 'concealed' },
  viewer: {
    accountId,
    clientId: 'review-client',
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
  selected: { state: 'absent', accountId, account: identity },
};

type BanRead = Awaited<ReturnType<ReturnType<KernelClient['realms']>['bans']['get']>>;

test('the installed ban review client sends its query and returns exported page types', async () => {
  expectTypeOf<BanReviewPageQuery>().toEqualTypeOf<{
    limit?: number;
    cursor?: string;
    selectedAccountId?: string;
  }>();
  expectTypeOf<BanReviewPageItem['account']>().toEqualTypeOf<BanReviewIdentity>();
  expectTypeOf<BanRead['data']>().toEqualTypeOf<BanReviewPage | null>();

  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(page);
    },
  });
  const response = await client.realms({ realmId }).bans.get({ query });

  expect(response.error).toBeNull();
  expect(response.data).toEqual(page);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe('GET');
  const url = new URL(requests[0]!.url);
  expect(url.pathname).toBe(`/v1/realms/${realmId}/bans`);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    limit: '20',
    cursor: 'opaque-cursor',
    selectedAccountId: accountId,
  });
});
