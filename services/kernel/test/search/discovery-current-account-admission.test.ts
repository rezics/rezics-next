import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { FilterRelease } from '@rezics/filter';
import { derivedId } from '../../src/route/route.ts';
import { validateAccountSnapshot } from '../../src/search/account-discovery.ts';
import { currentDiscoveryCandidates } from '../../src/search/discovery-current.ts';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import {
  MAX_ACCOUNT_DISCOVERY_BATCH,
  type AccountDiscoverySummary,
  type AccountSnapshot,
  type DiscoveryEngineHit,
  type DiscoveryReadContext,
  type IndexedAccount,
} from '../../src/search/discovery.ts';
import { SearchUnavailableError } from '../../src/search/opensearch.ts';

const route = 160;
const partition = 10;
const nativeId = '018f0000-0000-7000-8000-00a000000001';
const over = 9_223_372_036_854_775_808n;
const release: FilterRelease = { types: {}, properties: {}, filters: {} };
const context = { actor: { kind: 'anonymous' }, deadline: 1, access: {} } as DiscoveryReadContext;
const noRead = async (): Promise<never> => {
  throw new Error('Account current disclosure must not read a foreign producer');
};
const noHydrate = async (): Promise<never> => {
  throw new Error('Account hydration must not run');
};
const row = (id: string, extras: Partial<IndexedAccount> = {}): IndexedAccount => ({
  id,
  accountKind: 'actor',
  handle: 'mira',
  displayName: 'Mira',
  revision: 7n,
  ...extras,
});
const hit = (id: string, revision = '7', sourcePosition = '12'): DiscoveryEngineHit => ({
  key: { owner: 'accounts', kind: 'account', route, id },
  index: 'test-discovery-g1',
  sourcePosition,
  revision,
  matched: [],
  sort: [id, 'account', `account:${id}`],
});

function disclose(
  candidates: readonly DiscoveryEngineHit[],
  read: (ids: readonly string[]) => AccountSnapshot | Promise<AccountSnapshot>,
  hydrate: (
    ids: readonly string[],
  ) => Promise<ReadonlyMap<string, AccountDiscoverySummary>> = noHydrate,
) {
  return currentDiscoveryCandidates(
    createDiscoveryRegistry({
      release: bundledRelease,
      semantic: {
        source: { read: noRead, count: noRead },
        hydrate: noRead,
        icons: Object.fromEntries(Object.keys(bundledRelease.types).map((kind) => [kind, 'catalogue'])),
      },
      accounts: {
        source: {
          read: async (home, ids) => {
            expect(home).toBe(partition);
            return read(ids);
          },
          count: noRead,
          page: noRead,
        },
        hydrate,
        labels: { en: 'Accounts' },
        icon: 'account',
      },
    }),
    candidates,
    undefined,
    release,
    context,
  );
}

test('Current Account disclosure rejects invalid native revisions, positions and handles through the existing whole-chunk validator before Account hydration', async () => {
  const snapshot = (accounts: IndexedAccount[], position = 12n): AccountSnapshot => ({
    partition,
    position,
    accounts,
  });
  for (const observed of [
    snapshot([row(nativeId, { revision: 0n })]),
    snapshot([row(nativeId, { revision: over })]),
    snapshot([row(nativeId)], over),
    snapshot([row(nativeId)], 0n),
    snapshot([row(nativeId, { handle: 'Reader' })]),
  ]) {
    expect(() => validateAccountSnapshot(observed, partition, [nativeId], 0n)).toThrow();
    await expect(disclose([hit(nativeId)], () => observed)).rejects.toBeInstanceOf(SearchUnavailableError);
  }
});

test('a malformed later Account chunk fails the whole current disclosure before hydration', async () => {
  const ids = Array.from({ length: MAX_ACCOUNT_DISCOVERY_BATCH + 1 }, (_, index) =>
    derivedId('00000000-0000-8000-8000-000000000001', `current-account-${index}`, route),
  );
  await expect(
    disclose(
      ids.map((id) => hit(id)),
      (requested) => ({
        partition,
        position: 12n,
        accounts: requested.map((id) => row(id, requested.length === 1 ? { revision: 0n } : {})),
      }),
    ),
  ).rejects.toBeInstanceOf(SearchUnavailableError);
});

test('valid current Account rows hydrate and omitted keys stay not-current while source-position coverage remains', async () => {
  const omitted = derivedId('00000000-0000-8000-8000-000000000001', 'omitted-current-account', route);
  const observed: AccountSnapshot = { partition, position: 12n, accounts: [row(nativeId)] };
  const live = hit(nativeId);
  const missing = hit(omitted);
  expect(validateAccountSnapshot(observed, partition, [nativeId, omitted], 0n).accounts.map(({ id }) => id)).toEqual([
    nativeId,
  ]);
  const summary: AccountDiscoverySummary = {
    id: nativeId,
    accountKind: 'actor',
    handle: 'mira',
    displayName: 'Mira',
    automated: false,
    operatorId: null,
    avatar: null,
    verifiedAgent: null,
  };
  const passed = await disclose([live, missing], () => observed, async (ids) => {
    expect(ids).toEqual([nativeId]);
    return new Map([[nativeId, summary]]);
  });
  expect([...passed.keys()]).toEqual([live]);
  expect(passed.get(live)).toEqual({ key: live.key, summary: { kind: 'account', value: summary } });
  await expect(disclose([hit(nativeId, '7', '13')], () => observed)).rejects.toBeInstanceOf(SearchUnavailableError);
});
