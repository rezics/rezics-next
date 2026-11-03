import { expect, test } from 'bun:test';
import { RealmMembersVisit } from '../src/community/members/visit';
import type { MemberPage, MemberSelectionRead, RealmMembersSource } from '../src/community/members/source';

function page(ids = ['a', 'b']): MemberPage {
  return {
    realm: { id: 'realm', label: 'Realm' },
    authority: 'grant',
    next: null,
    rows: ids.map((accountId) => ({
      kind: 'disclosed',
      identity: { accountId, label: 'Same name', reference: accountId },
      episode: `episode-${accountId}`,
      membership: 'current',
    })),
  };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('selection uses exact account and episode, and a replacement page requires a fresh selection', async () => {
  let current = page();
  const addresses: unknown[] = [];
  const source: RealmMembersSource = {
    pageBound: 20,
    readPage: async () => ({ kind: 'ready', page: current }),
    readSelected: async (address) => {
      addresses.push(address);
      return {
        kind: 'ready',
        ...address,
        identity: { accountId: address.accountId, label: 'Same name', reference: address.accountId },
        membership: 'current',
      };
    },
  };
  const visit = new RealmMembersVisit('realm', source);
  const stop = visit.connect();
  await settle();
  await visit.select('b');
  expect(addresses).toEqual([{ realmId: 'realm', accountId: 'b', episode: 'episode-b', authority: 'grant' }]);
  current = page(['b', 'a']);
  await visit.refresh();
  expect(visit.snapshot().selection).toBeNull();
  await visit.select('a');
  expect(visit.snapshot().selection?.address.accountId).toBe('a');
  stop();
});

test('selected retry keeps the original account without moving the cursor; concealment retires disclosed labels', async () => {
  const selected: unknown[] = [];
  let reads = 0;
  let result: MemberSelectionRead = { kind: 'failed' };
  const visit = new RealmMembersVisit('realm', {
    pageBound: 20,
    readPage: async () => {
      reads++;
      return { kind: 'ready', page: page() };
    },
    readSelected: async (address) => {
      selected.push(address);
      return result;
    },
  });
  const stop = visit.connect();
  await settle();
  await visit.select('a');
  result = { kind: 'concealed' };
  await visit.retrySelected();
  expect(selected[0]).toEqual(selected[1]);
  expect(reads).toBe(1);
  expect(visit.snapshot().address.cursor).toBeNull();
  expect(visit.snapshot().selection?.read.kind).toBe('concealed');
  expect(JSON.stringify(visit.snapshot())).not.toContain('Same name');
  stop();
});

test('a newer selected account and a retired caller ignore delayed identity completion', async () => {
  const pending = Promise.withResolvers<MemberSelectionRead>();
  let active = true;
  let changed = () => {};
  const visit = new RealmMembersVisit(
    'realm',
    {
      pageBound: 20,
      readPage: async () => ({ kind: 'ready', page: page() }),
      readSelected: async (address) => (address.accountId === 'a' ? pending.promise : { kind: 'unavailable' }),
    },
    () => active,
    (listener) => {
      changed = listener;
      return () => {};
    },
  );
  const stop = visit.connect();
  await settle();
  const selecting = visit.select('a');
  await visit.select('b');
  active = false;
  changed();
  expect(visit.snapshot()).toMatchObject({ read: { kind: 'retired' }, selection: null });
  pending.resolve({
    kind: 'ready',
    realmId: 'realm',
    authority: 'grant',
    episode: 'episode-a',
    identity: { accountId: 'a', reference: 'a', label: 'Retired person' },
    membership: 'current',
  });
  await selecting;
  expect(JSON.stringify(visit.snapshot())).not.toContain('Retired person');
  stop();
});

test('an episode or authority replacement cannot reuse selected advice', async () => {
  for (const replacement of [
    { episode: 'new-episode', authority: 'grant' },
    { episode: 'episode-a', authority: 'new-grant' },
  ]) {
    const visit = new RealmMembersVisit('realm', {
      pageBound: 20,
      readPage: async () => ({ kind: 'ready', page: page() }),
      readSelected: async () => ({
        kind: 'ready',
        realmId: 'realm',
        ...replacement,
        identity: { accountId: 'a', reference: 'a', label: 'Must retire' },
        membership: 'current',
      }),
    });
    const stop = visit.connect();
    await settle();
    await visit.select('a');
    expect(visit.snapshot()).toMatchObject({ read: { kind: 'unavailable' }, selection: null });
    expect(visit.hasRow('a')).toBe(false);
    stop();
  }
});
