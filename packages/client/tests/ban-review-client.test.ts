import { expect, expectTypeOf, test } from 'bun:test';
import {
  createKernelClient,
  type BanReviewIdentity,
  type BanReviewPage,
  type BanReviewPageItem,
  type BanReviewPageQuery,
  type KernelClient,
} from '../src/index.ts';

const REALM_ID = '019a1b2c-3d4e-7f00-8a00-000000000001';
const ACCOUNT_ID = '019a1b2c-3d4e-7f00-8a00-000000000002';

const page = {
  items: [],
  next: null,
  context: { state: 'concealed' },
  viewer: {
    accountId: ACCOUNT_ID,
    clientId: 'web',
    requestedBy: null,
    authnEpoch: 1,
    unban: {
      state: 'permitted',
      operationId: 'realm.unban',
      action: 'realm:ban',
      resource: { route: 1, id: REALM_ID },
      reauthorizes: true,
    },
  },
  selected: {
    state: 'absent',
    accountId: ACCOUNT_ID,
    account: { state: 'concealed', accountId: ACCOUNT_ID, label: 'Account', destination: null },
  },
} satisfies BanReviewPage;

expectTypeOf<BanReviewIdentity>().toEqualTypeOf<BanReviewPageItem['account']>();
expectTypeOf<BanReviewPageQuery>().toEqualTypeOf<{
  limit?: number;
  cursor?: string;
  selectedAccountId?: string;
}>();

test('generated ban review call sends exact selection and exports the mounted response', async () => {
  const query: BanReviewPageQuery = { limit: 20, selectedAccountId: ACCOUNT_ID };
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe(`/v1/realms/${REALM_ID}/bans`);
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('selectedAccountId')).toBe(ACCOUNT_ID);
    expect(url.searchParams.has('cursor')).toBe(false);
    return Response.json(page);
  }) as typeof globalThis.fetch;
  const client: KernelClient = createKernelClient('https://kernel.test', { fetch });
  const result = await client.realms({ realmId: REALM_ID }).bans.get({ query });
  expectTypeOf(result.data).toEqualTypeOf<BanReviewPage | null>();
  expect(result.error).toBeNull();
  expect(result.data).toEqual(page);
  // @ts-expect-error exact selection accepts an account ID string
  await client.realms({ realmId: REALM_ID }).bans.get({ query: { selectedAccountId: 42 } });
});
