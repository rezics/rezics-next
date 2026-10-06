import { expect, test } from 'bun:test';
import { readRealmThread, readRealmThreads } from '../src/modules/realm-reply/thread-read.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { realm, reply, world } from './realm-reply-threads.test.ts';

// The declaration is a field of the exact revision the thread read already loads.
// Absence is a revision that never set one (an edit that omitted `spoiler` keeps
// whatever was stored, including this). `false` is a cleared declaration.

const japanese = '最終章の手紙\nエリザベスは手紙を読み返す。';
const unmarked = 'Spoilers: a review of spoiler culture\nThe title names the subject.';

test('a marked discussion warns from the revision, in Japanese or as a reply, without another content read', async () => {
  const placed = [
    { id: 1, author: 1, body: japanese, spoiler: true as const },
    { id: 2, author: 2, body: unmarked },
    { id: 3, author: 1, body: 'Cleared\nNothing to hide.', spoiler: false as const },
    { id: 4, parent: 1, author: 2, body: 'A reply that keeps the ending.', spoiler: true as const },
    { id: 5, author: 3, body: 'Unset\nStill visible.', spoiler: null },
  ];
  const thread = world(placed);
  const read = await readRealmThread(thread.session, realm, reply(1));
  expect(thread.calls.bodies).toBe(1);
  expect(read.items[0]).toMatchObject({
    title: '最終章の手紙', body: 'エリザベスは手紙を読み返す。', spoiler: true,
  });
  expect(read.items.find((item) => item.reply === reply(4))).toMatchObject({
    title: null, body: 'A reply that keeps the ending.', spoiler: true,
  });
  const listed = world(placed);
  const page = await readRealmThreads(listed.session, realm, { sort: 'new' });
  expect(listed.calls.bodies).toBe(1);
  const byReply = new Map(page.items.map((item) => [item.reply, item]));
  expect(byReply.get(reply(1))).toMatchObject({
    title: '最終章の手紙', excerpt: 'エリザベスは手紙を読み返す。', spoiler: true,
  });
  expect(byReply.get(reply(2))).toMatchObject({ title: 'Spoilers: a review of spoiler culture',
    excerpt: 'The title names the subject.' });
  expect(Object.hasOwn(byReply.get(reply(2))!, 'spoiler')).toBe(false);
  expect(byReply.get(reply(3))).toMatchObject({ spoiler: false });
  expect(Object.hasOwn(byReply.get(reply(5))!, 'spoiler')).toBe(false);
});

test('a blocked reply withholds the declaration along with the words', async () => {
  const read = await readRealmThread(world([
    { id: 1, author: 1, body: 'Open\nVisible.', spoiler: true },
    { id: 2, parent: 1, author: 2, body: 'Secret ending.', spoiler: true },
  ], { blocked: [2] }).session, realm, reply(1));
  const hidden = read.items.find((item) => item.reply === reply(2))!;
  expect(hidden).toMatchObject({ blocked: true, body: '', title: null });
  expect(Object.hasOwn(hidden, 'spoiler')).toBe(false);
  expect(read.items[0]!.spoiler).toBe(true);
});

test('a corrupt spoiler declaration fails the read instead of looking safe', async () => {
  const { session } = world([{ id: 1, author: 1, body: 'Title\nBody', spoiler: 'bad' }]);
  await expect(readRealmThread(session, realm, reply(1))).rejects.toBeInstanceOf(WorkReadUnavailable);
});
