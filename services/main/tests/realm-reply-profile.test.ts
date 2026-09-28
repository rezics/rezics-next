import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { readProfileContributions } from '../src/modules/realm-reply/thread-read.ts';
import { RealmReplyThreadStore } from '../src/modules/realm-reply/thread-store.ts';
import { WorkReadMissing, type WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (suffix: number) => `https://rezics.com/id/00000000-0000-4000-8000-${suffix.toString(16).padStart(12, '0')}`;

test('profile contributions seek one bounded author page and disclose only current public placements', async () => {
  const author = id(1), realm = id(2);
  const nodes = Array.from({ length: 9 }, (_, index) => ({ reply: id(index + 10), parent: index % 2 ? id(50) : null,
    author, origin: realm, rootTarget: id(3), rootRevision: id(4),
    createdAt: new Date(Date.UTC(2026, 8, 28, 0, 9 - index)) }));
  let gate = 0, pageCalls = 0, visibleCalls = 0;
  const session = { position: { datasetId: 'product', dataEpoch: 'epoch', sequence: '10' },
    principal: null, options: {}, deps: { content: {}, realmReplyThreads: {
      authorPage: async (_author: string, kind: string, limit: number) => {
        pageCalls++;
        expect([kind, limit]).toEqual(['posts', 9]);
        return nodes;
      },
    }, realmReplies: { readPublic: async (reply: string) => {
      visibleCalls++;
      return reply === nodes[1]!.reply ? null : { reply, author, originRealm: realm,
        body: `A title\nBody for ${reply}` };
    } }, personPreferences: { profileVisible: async () => true } },
  } as unknown as WorkReadSession;
  const result = await readProfileContributions(session, author, 'posts', undefined,
    async () => { gate++; return {} as never; });
  expect(gate).toBe(1);
  expect(pageCalls).toBe(1);
  expect(visibleCalls).toBe(8);
  expect(result.items).toHaveLength(7);
  expect(result.items[0]).toMatchObject({ reply: nodes[0]!.reply, title: 'A title' });
  expect(result.nextCursor).toBeString();
});

test('profile privacy changing during a contribution read fails closed', async () => {
  const session = { position: { datasetId: 'product', dataEpoch: 'epoch', sequence: '10' },
    principal: null, options: {}, deps: { content: {}, realmReplyThreads: { authorPage: async () => [] },
      realmReplies: { readPublic: async () => null },
      personPreferences: { profileVisible: async () => false } },
  } as unknown as WorkReadSession;
  await expect(readProfileContributions(session, id(1), 'comments', undefined,
    async () => ({} as never))).rejects.toBeInstanceOf(WorkReadMissing);
});

test('author paging uses a fixed index seek and separates posts from comments', async () => {
  const queries: string[] = [];
  const content = { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } } as unknown as Pool;
  const store = new RealmReplyThreadStore(content, {} as Pool);
  await store.authorPage(id(1), 'posts', 9);
  await store.authorPage(id(1), 'comments', 9);
  expect(queries[0]).toContain('parent_reply IS NULL');
  expect(queries[1]).toContain('parent_reply IS NOT NULL');
  expect(queries[0]).toContain('ORDER BY created_at DESC, id DESC LIMIT $4');
});
