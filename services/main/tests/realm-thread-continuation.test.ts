import { expect, test } from 'bun:test';
import { readRealmThread } from '../src/modules/realm-reply/thread-read.ts';
import { REALM_THREAD_COST } from '../src/modules/realm-reply/thread-contract.ts';
import { WorkReadExpired, WorkReadInvalid, WorkReadMissing, WorkReadUnavailable }
  from '../src/modules/work/read-session.ts';
import { realm, reply, world } from './realm-reply-threads.test.ts';

const siblings = (count: number) => [{ id: 1, author: 1 },
  ...Array.from({ length: count }, (_, index) => ({ id: index + 2, parent: 1, author: 1 }))];
const branch = (depth: number) => Array.from({ length: depth + 1 }, (_, index) =>
  ({ id: index + 1, author: 1, ...(index ? { parent: index } : {}) }));
const siblingCursor = (read: Awaited<ReturnType<typeof readRealmThread>>) => {
  const continuation = read.continuations.find(item => item.kind === 'siblings');
  if (!continuation || continuation.kind !== 'siblings') throw new Error('Missing sibling continuation');
  return continuation;
};

test('sibling 192 is reachable in the existing reply order, with the focus repeated only as context', async () => {
  for (const sort of ['best', 'top', 'new'] as const) {
    const placed = siblings(192);
    const { session } = world(placed, { votes: { 2: { score: 100 }, 193: { score: -100 } } });
    const first = await readRealmThread(session, realm, reply(1), sort);
    expect(first.items).toHaveLength(REALM_THREAD_COST.replies + 1);
    expect(first.complete).toBe(false);
    const next = siblingCursor(first);
    expect(next.reply).toBe(reply(1));
    const second = await readRealmThread(session, realm, next.reply, sort, next.cursor);
    expect(second.items).toHaveLength(2);
    expect(second.continuations).toEqual([]);
    expect(second.complete).toBe(true);
    const combined = [...first.items.slice(1), ...second.items.slice(1)].map(item => item.reply);
    expect(new Set(combined).size).toBe(192);
    expect(combined).toContain(reply(2));
    expect(combined).toContain(reply(193));
  }
});

test('depth 33 and ancestors above the 32-parent window have bounded refocus reads', async () => {
  const { session } = world(branch(80));
  const first = await readRealmThread(session, realm, reply(1), 'new');
  expect(first.items).toHaveLength(33);
  expect(first.continuations).toEqual([{ kind: 'depth', reply: reply(33) }]);
  const next = await readRealmThread(session, realm, reply(33), 'new');
  expect(next.items[1]!.reply).toBe(reply(34));
  expect(next.items).toHaveLength(33);
  expect(next.ancestors).toHaveLength(32);
  expect(next.continuations).toContainEqual({ kind: 'depth', reply: reply(65) });

  const bottom = await readRealmThread(session, realm, reply(81), 'new');
  expect(bottom.thread).toBe(reply(1));
  expect(bottom.ancestors).toHaveLength(32);
  expect(bottom.continuations).toEqual([{ kind: 'ancestors', reply: reply(49) }]);
  const above = await readRealmThread(session, realm, reply(49), 'new');
  expect(above.continuations).toContainEqual({ kind: 'ancestors', reply: reply(17) });
  const root = await readRealmThread(session, realm, reply(17), 'new');
  expect(root.ancestors[0]!.reply).toBe(reply(1));
  expect(root.continuations.some(item => item.kind === 'ancestors')).toBe(false);
});

test('the reply budget preserves an entry point for every deferred branch', async () => {
  const placed = siblings(191);
  placed.push(...Array.from({ length: 191 }, (_, index) =>
    ({ id: index + 1000, parent: index + 2, author: 1 })));
  const { session } = world(placed);
  const first = await readRealmThread(session, realm, reply(1), 'new');
  expect(first.items).toHaveLength(192);
  expect(first.continuations).toHaveLength(191);
  expect(first.continuations.every(item => item.kind === 'depth')).toBe(true);
  const continued = await readRealmThread(session, realm, reply(2), 'new');
  expect(continued.items.map(item => item.reply)).toEqual([reply(2), reply(1000)]);
});

test('a new reply invalidates the old walk explicitly and is reachable after restart without silent skips', async () => {
  const placed = siblings(192), { session } = world(placed);
  const first = await readRealmThread(session, realm, reply(1), 'new');
  const next = siblingCursor(first);
  placed.push({ id: 194, parent: 1, author: 1 });
  session.position.sequence = '10';
  await expect(readRealmThread(session, realm, reply(1), 'new', next.cursor))
    .rejects.toBeInstanceOf(WorkReadExpired);
  const restarted = await readRealmThread(session, realm, reply(1), 'new');
  expect(restarted.items[1]!.reply).toBe(reply(194));
  const rest = siblingCursor(restarted);
  const second = await readRealmThread(session, realm, rest.reply, 'new', rest.cursor);
  const reached = [...restarted.items.slice(1), ...second.items.slice(1)].map(item => item.reply);
  expect(new Set(reached).size).toBe(193);
});

test('a removed cursor anchor leaves no gap in a keyset seek', async () => {
  const placed = siblings(192), { session } = world(placed);
  const first = await readRealmThread(session, realm, reply(1), 'new');
  const next = siblingCursor(first), anchor = first.items.at(-1)!.reply;
  placed.splice(placed.findIndex(item => reply(item.id) === anchor), 1);
  // The owner key survives removal before the graph position catches up; once
  // that position moves, the same cursor gets the explicit restart above.
  const second = await readRealmThread(session, realm, reply(1), 'new', next.cursor);
  expect(second.items.map(item => item.reply)).toEqual([reply(1), reply(2)]);
});

test('continuations bind the parent, Realm, sort, language and reader; recovery epochs cannot reuse them', async () => {
  const { session } = world(siblings(192));
  const next = siblingCursor(await readRealmThread(session, realm, reply(1), 'new'));
  for (const [focus, sort, selectedRealm] of [
    [reply(2), 'new', realm], [reply(1), 'top', realm], [reply(1), 'new', reply(999)],
  ] as const) {
    await expect(readRealmThread(session, selectedRealm, focus, sort, next.cursor))
      .rejects.toBeInstanceOf(WorkReadInvalid);
  }
  Object.assign(session, { displayLanguages: ['ja'] });
  await expect(readRealmThread(session, realm, reply(1), 'new', next.cursor))
    .rejects.toBeInstanceOf(WorkReadInvalid);
  Object.assign(session, { displayLanguages: ['en'] });
  session.position.dataEpoch = 'restored';
  await expect(readRealmThread(session, realm, reply(1), 'new', next.cursor))
    .rejects.toBeInstanceOf(WorkReadExpired);
});

test('continuations never admit a withdrawn focus, an inaccessible Realm or an incomplete projection', async () => {
  const placed = siblings(192), { session } = world(placed);
  const next = siblingCursor(await readRealmThread(session, realm, reply(1), 'new'));
  Object.assign(placed[0]!, { approved: false });
  await expect(readRealmThread(session, realm, reply(1), 'new', next.cursor))
    .rejects.toBeInstanceOf(WorkReadMissing);
  const denied = world(siblings(192), { privateRealm: true });
  await expect(readRealmThread(denied.session, realm, reply(1), 'new', next.cursor))
    .rejects.toBeInstanceOf(WorkReadMissing);
  expect(denied.calls.store).toBe(0);
  Object.assign(session.deps.realmReplyThreads!, { assertThreadProjection: async () => {
    throw new WorkReadUnavailable('Realm replies are projecting');
  } });
  await expect(readRealmThread(session, realm, reply(1), 'new', next.cursor))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
});
