import { expect, test } from 'bun:test';
import { RealmMembersVisit } from '../src/community/members/visit';
import type { MemberPage, MemberSelectionRead, RealmMembersSource } from '../src/community/members/source';

function page(ids = ['a', 'b']): MemberPage {
  const intervals: Record<string, string> = { a: 'producer-interval-a', b: 'producer-interval-b' };
  return {
    realm: { id: 'realm', label: 'Realm' },
    authority: 'grant',
    next: null,
    rows: ids.map((accountId) => ({
      kind: 'disclosed',
      identity: { accountId, label: 'Same name', reference: accountId },
      membershipInterval: intervals[accountId]!,
      membership: 'current',
    })),
  };
}
function windowPage(cursor: string | null, windows = 3): MemberPage {
  const index = cursor === null ? 0 : Number(cursor.slice(1));
  return {
    realm: { id: 'realm', label: 'Realm' },
    authority: 'grant',
    rows: [],
    next: index + 1 < windows ? `w${index + 1}` : null,
  };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('selection uses exact account and interval, and a replacement page requires a fresh selection', async () => {
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
        membershipInterval: address.membershipInterval ?? null,
        membershipEpisode: address.membershipInterval ?? `episode-${address.accountId}`,
        membership: 'current',
        advice: { add: 'unavailable', ban: 'available', unban: 'unavailable' },
      };
    },
  };
  const visit = new RealmMembersVisit('realm', source);
  const stop = visit.connect();
  await settle();
  await visit.select('b');
  expect(addresses).toEqual([
    { realmId: 'realm', accountId: 'b', membershipInterval: 'producer-interval-b', authority: 'grant' },
  ]);
  current = page(['b', 'a']);
  visit.closeSelection();
  await visit.refresh();
  expect(visit.snapshot().selection).toBeNull();
  await visit.select('a');
  expect(visit.snapshot().selection?.address.accountId).toBe('a');
  stop();
});

test('opaque membership intervals are scoped to the selected Account', async () => {
  const sharedIntervalPage = page().rows.map((row) =>
    row.kind === 'disclosed' ? { ...row, membershipInterval: 'producer-interval-token' } : row,
  );
  const addresses: unknown[] = [];
  const visit = new RealmMembersVisit('realm', {
    pageBound: 20,
    readPage: async () => ({ kind: 'ready', page: { ...page(), rows: sharedIntervalPage } }),
    readSelected: async (address) => {
      addresses.push(address);
      return {
        kind: 'ready',
        ...address,
        identity: { accountId: address.accountId, reference: address.accountId, label: 'Exact account' },
        membershipInterval: address.membershipInterval ?? null,
        membershipEpisode: address.membershipInterval ?? `episode-${address.accountId}`,
        membership: 'current',
        advice: { add: 'unavailable', ban: 'available', unban: 'available' },
      };
    },
  });
  const stop = visit.connect();
  await settle();
  await visit.select('a');
  await visit.select('b');
  expect(addresses).toEqual([
    { realmId: 'realm', accountId: 'a', membershipInterval: 'producer-interval-token', authority: 'grant' },
    { realmId: 'realm', accountId: 'b', membershipInterval: 'producer-interval-token', authority: 'grant' },
  ]);
  expect(visit.snapshot().selection?.address.accountId).toBe('b');
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

test('manual Account inspection does not infer an interval or move the roster cursor', async () => {
  const addresses: unknown[] = [];
  let pages = 0;
  const visit = new RealmMembersVisit('realm', {
    pageBound: 20,
    readPage: async () => {
      pages++;
      return { kind: 'ready', page: page() };
    },
    readSelected: async (address) => {
      addresses.push(address);
      return {
        kind: 'ready',
        realmId: address.realmId,
        authority: address.authority,
        identity: { accountId: address.accountId, label: 'Exact entered Account', reference: 'exact-account' },
        membershipInterval: null,
        membershipEpisode: 'absence-entered-account',
        membership: 'none',
        advice: { add: 'available', ban: 'unavailable', unban: 'unavailable' },
      };
    },
  });
  const stop = visit.connect();
  await settle();
  await visit.inspectAccount('entered-account');
  expect(addresses).toEqual([{ realmId: 'realm', accountId: 'entered-account', authority: 'grant' }]);
  expect(visit.snapshot().selection?.read).toMatchObject({
    kind: 'ready',
    identity: { accountId: 'entered-account' },
    membership: 'none',
    membershipInterval: null,
  });
  expect([pages, visit.snapshot().address.cursor]).toEqual([1, null]);
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
    membershipInterval: 'producer-interval-a',
    identity: { accountId: 'a', reference: 'a', label: 'Retired person' },
    advice: { add: 'unavailable', ban: 'available', unban: 'unavailable' },
    membershipEpisode: 'producer-interval-a',
    membership: 'current',
  });
  await selecting;
  expect(JSON.stringify(visit.snapshot())).not.toContain('Retired person');
  stop();
});

test('an interval or authority replacement cannot reuse selected advice', async () => {
  for (const replacement of [
    { membershipInterval: 'replacement-interval', membershipEpisode: 'replacement-interval', authority: 'grant' },
    { membershipInterval: 'producer-interval-a', membershipEpisode: 'producer-interval-a', authority: 'new-grant' },
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
        advice: { add: 'unavailable', ban: 'available', unban: 'unavailable' },
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

test('effect replay retains the original producer lifetime across an unsubscribed interval change', async () => {
  for (const state of ['current', 'changed', 'retired'] as const) {
    let epoch = 0;
    let observations = 0;
    let pages = 0;
    const visit = new RealmMembersVisit('realm', {
      pageBound: 20,
      observe: () => {
        observations++;
        const captured = epoch;
        return { current: () => state !== 'retired' && epoch === captured, subscribe: () => () => {} };
      },
      readPage: async () => {
        pages++;
        return { kind: 'ready', page: page() };
      },
      readSelected: async () => ({ kind: 'unavailable' }),
    });
    const disconnect = visit.connect();
    await settle();
    disconnect();
    if (state === 'changed') epoch++;
    const stop = visit.connect();
    await settle();
    expect(visit.snapshot()).toMatchObject({
      read: { kind: state === 'current' ? 'ready' : 'retired' },
      selection: null,
    });
    expect([observations, pages]).toEqual([1, state === 'current' ? 2 : state === 'changed' ? 1 : 0]);
    stop();
  }
});

test('selected episode changes retire stale inspection while explicit add readback updates the selection', async () => {
  const identity = { accountId: 'entered-account', label: 'Exact account', reference: 'entered-account' };
  const selected = (membership: 'none' | 'current', membershipEpisode: string): MemberSelectionRead => ({
    kind: 'ready',
    realmId: 'realm',
    authority: 'grant',
    identity,
    membership,
    membershipInterval: membership === 'current' ? membershipEpisode : null,
    membershipEpisode,
    advice: {
      add: membership === 'none' ? 'available' : 'unavailable',
      ban: 'unavailable',
      unban: 'unavailable',
    },
  });

  let selectedReads = 0;
  const readback = new RealmMembersVisit('realm', {
    pageBound: 20,
    readPage: async () => ({ kind: 'ready', page: page([]) }),
    readSelected: async () => {
      selectedReads++;
      return selectedReads === 1 ? selected('none', 'absence-episode') : selected('current', 'new-member-episode');
    },
  });
  const stopReadback = readback.connect();
  await settle();
  await readback.inspectAccount('entered-account');
  await readback.refreshSelected();
  expect(readback.snapshot().selection?.read).toMatchObject({
    kind: 'ready',
    membership: 'current',
    membershipInterval: 'new-member-episode',
    membershipEpisode: 'new-member-episode',
  });
  expect(selectedReads).toBe(2);
  stopReadback();

  let attempts = 0;
  const retry = new RealmMembersVisit('realm', {
    pageBound: 20,
    readPage: async () => ({ kind: 'ready', page: page([]) }),
    readSelected: async () => {
      attempts++;
      return attempts === 1
        ? selected('current', 'original-member-episode')
        : attempts === 2
          ? { kind: 'failed' }
          : selected('current', 'rejoined-member-episode');
    },
  });
  const stopRetry = retry.connect();
  await settle();
  await retry.inspectAccount('entered-account');
  await retry.refreshSelected();
  await retry.retrySelected();
  expect(retry.snapshot()).toMatchObject({ read: { kind: 'unavailable' }, selection: null });
  stopRetry();
});

test('a fresh visit has no predecessor and a three-window terminal page returns through exact coordinates', async () => {
  const addresses: { realmId: string; cursor: string | null }[] = [];
  const visit = new RealmMembersVisit('realm', {
    pageBound: 20,
    readPage: async (address) => {
      addresses.push(address);
      return { kind: 'ready', page: windowPage(address.cursor) };
    },
    readSelected: async () => ({ kind: 'unavailable' }),
  });
  const stop = visit.connect();
  await settle();
  expect(visit.canPrevious()).toBe(false);
  expect(await visit.previous()).toBe(false);
  await visit.more();
  await visit.more();
  expect(visit.snapshot().read).toMatchObject({ kind: 'ready', page: { next: null } });
  expect(visit.canPrevious()).toBe(true);
  expect(visit.canFirst()).toBe(true);
  await visit.previous();
  await visit.previous();
  expect(visit.snapshot().address).toEqual({ realmId: 'realm', cursor: null });
  expect(visit.canPrevious()).toBe(false);
  expect(addresses.map(({ cursor }) => cursor)).toEqual([null, 'w1', 'w2', 'w1', null]);
  stop();
});

test('predecessor history is bounded and a forward move branches from the accepted window', async () => {
  const addresses: (string | null)[] = [];
  const visit = new RealmMembersVisit('realm', {
    pageBound: 20,
    readPage: async ({ cursor }) => {
      addresses.push(cursor);
      return { kind: 'ready', page: windowPage(cursor, 12) };
    },
    readSelected: async () => ({ kind: 'unavailable' }),
  });
  const stop = visit.connect();
  await settle();
  for (let index = 0; index < 11; index++) await visit.more();
  for (let index = 10; index >= 3; index--) {
    await visit.previous();
    expect(visit.snapshot().address.cursor).toBe(`w${index}`);
  }
  expect(visit.canPrevious()).toBe(false);
  await visit.more();
  await visit.previous();
  expect(visit.snapshot().address.cursor).toBe('w3');
  await visit.first();
  expect(visit.snapshot().address.cursor).toBe(null);
  expect(visit.canPrevious()).toBe(false);
  expect(addresses.slice(-3)).toEqual(['w4', 'w3', null]);
  stop();
});

test('duplicate More reads once; failed Previous and First retry their staged cursor exactly', async () => {
  const addresses: (string | null)[] = [];
  const delayed = Promise.withResolvers<MemberPageRead>();
  let deferNext = true;
  let failPrevious = true;
  let failFirst = false;
  const visit = new RealmMembersVisit('realm', {
    pageBound: 20,
    readPage: async ({ cursor }) => {
      addresses.push(cursor);
      if (cursor === 'w1' && deferNext) {
        deferNext = false;
        return delayed.promise;
      }
      if (cursor === 'w1' && failPrevious) {
        failPrevious = false;
        return { kind: 'failed' };
      }
      if (cursor === null && failFirst) {
        failFirst = false;
        return { kind: 'unavailable' };
      }
      return { kind: 'ready', page: windowPage(cursor) };
    },
    readSelected: async () => ({ kind: 'unavailable' }),
  });
  const stop = visit.connect();
  await settle();
  expect(visit.snapshot().read.kind).toBe('ready');
  const advancing = visit.more();
  expect(await visit.more()).toBe(false);
  expect(addresses).toEqual([null, 'w1']);
  delayed.resolve({ kind: 'ready', page: windowPage('w1') });
  expect(await advancing).toBe(true);
  await visit.more();
  expect(await visit.previous()).toBe(false);
  expect(visit.snapshot().read.kind).toBe('failed');
  expect(await visit.retryPage()).toBe(true);
  expect(visit.canPrevious()).toBe(true);
  failFirst = true;
  expect(await visit.first()).toBe(false);
  expect(visit.snapshot().read.kind).toBe('unavailable');
  expect(await visit.retryPage()).toBe(true);
  expect(visit.canPrevious()).toBe(false);
  expect(addresses).toEqual([null, 'w1', 'w2', 'w1', 'w1', null, null]);
  stop();
});

test('a staged page read throws without creating an empty page or accepting its coordinate', async () => {
  let reads = 0;
  const visit = new RealmMembersVisit('realm', {
    pageBound: 20,
    readPage: async ({ cursor }) => {
      reads++;
      if (cursor !== null) throw new Error('unexpected source failure');
      return { kind: 'ready', page: { ...windowPage(null), next: 'w1' } };
    },
    readSelected: async () => ({ kind: 'unavailable' }),
  });
  const stop = visit.connect();
  await settle();
  await expect(visit.more()).rejects.toThrow('unexpected source failure');
  expect(visit.snapshot().read.kind).toBe('loading');
  expect(visit.snapshot().address.cursor).toBe('w1');
  expect(visit.canPrevious()).toBe(false);
  expect(reads).toBe(2);
  stop();
});
