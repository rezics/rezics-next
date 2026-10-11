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
  expect(visibleCalls).toBe(9); // Eight children and one distinct immediate parent.
  expect(result.items).toHaveLength(7);
  expect(result.items[0]).toMatchObject({ reply: nodes[0]!.reply, title: 'A title' });
  expect(result.nextCursor).toBeString();
});

test('profile privacy changing during a contribution read fails closed', async () => {
  const author = id(1), realm = id(2), reply = id(10);
  let visible = true, hydration = 0;
  const session = { position: { datasetId: 'product', dataEpoch: 'epoch', sequence: '10' },
    principal: null, options: {}, deps: { content: {}, realmReplyThreads: { authorPage: async () => [{
      reply, parent: null, author, origin: realm, rootTarget: id(3), rootRevision: id(4),
      createdAt: new Date('2026-10-10'),
    }] },
      realmReplies: { readPublic: async () => {
        hydration++;
        visible = false;
        return { reply, author, originRealm: realm, body: 'Previously public contribution' };
      } },
      personPreferences: { profileVisible: async () => visible } },
  } as unknown as WorkReadSession;
  await expect(readProfileContributions(session, author, 'posts', undefined,
    async () => { expect(visible).toBe(true); return {} as never; })).rejects.toBeInstanceOf(WorkReadMissing);
  expect(hydration).toBe(1);
});

function parentWorld(parent: 'visible' | 'hidden' | 'absent', options: {
  revokeDuringProfileFence?: boolean; unavailable?: boolean; count?: number; distinct?: boolean;
  privateDuringParentRead?: boolean; individualReads?: boolean;
} = {}) {
  const author = id(1), realm = id(2), actor = id(5), principal = { issuer: 'issuer', subject: 'reader' };
  const nodes = Array.from({ length: options.count ?? 1 }, (_, index) => ({ reply: id(10 + index),
    parent: id(options.distinct ? 50 + index : 50), author, origin: realm,
    rootTarget: id(3), rootRevision: id(4), createdAt: new Date('2026-10-10') }));
  const requests: string[][] = [];
  let revoked = false, privateProfile = false;
  const parentIds = new Set(nodes.map(node => node.parent));
  const readPublicBatch = async (replies: string[], viewer: unknown, actingSubject: string) => {
    requests.push(replies);
    expect(viewer).toBe(principal);
    expect(actingSubject).toBe(actor);
    return replies.map(reply => {
      if (parentIds.has(reply)) {
        if (options.unavailable) throw new Error('Parent disclosure owner unavailable');
        if (options.privateDuringParentRead) privateProfile = true;
        // The hidden record exists, while the absent record never did. Both
        // are suppressed by the existing owner, not a profile policy branch.
        return parent === 'visible' && !revoked ? { reply, parentReply: id(99) } : null;
      }
      return { reply, author, originRealm: realm, body: 'Child heading\nUnchanged child text', spoiler: false };
    });
  };
  const session = { position: { datasetId: 'product', dataEpoch: 'epoch', sequence: '10' },
    principal, options: { actingSubject: actor }, deps: { content: {}, realmReplyThreads: {
      authorPage: async () => nodes,
    }, realmReplies: options.individualReads ? {
      readPublic: async (reply: string, viewer: unknown, actingSubject: string) =>
        (await readPublicBatch([reply], viewer, actingSubject))[0],
    } : { readPublicBatch }, personPreferences: { profileVisible: async () => {
      revoked = options.revokeDuringProfileFence === true;
      return !privateProfile;
    } } },
  } as unknown as WorkReadSession;
  const read = () => readProfileContributions(session, author, 'comments', undefined, async () => ({} as never));
  return { read, nodes, requests };
}

test('Person contribution parent output is identical for a hidden parent and a parent that never existed', async () => {
  const hidden = parentWorld('hidden'), absent = parentWorld('absent');
  const result = await hidden.read();
  expect(result).toEqual(await absent.read());
  expect(result.items[0]).toMatchObject({ parent: null, title: null,
    excerpt: 'Child heading\nUnchanged child text', spoiler: false });
  expect(JSON.stringify(result)).not.toContain(id(50));
  expect(hidden.requests).toEqual([[id(10)], [id(50)]]);
  expect(hidden.requests).toEqual(absent.requests);
});

test('Person contributions retain visible parent ids without walking their ancestors', async () => {
  const h = parentWorld('visible', { count: 8 });
  const result = await h.read();
  expect(result.items.every(item => item.parent === id(50))).toBe(true);
  expect(h.requests).toHaveLength(2);
  expect(h.requests.map(ids => ids.length)).toEqual([8, 1]);
  expect(h.requests.flat()).not.toContain(id(99));
});

test('Person contributions authorize at most eight distinct immediate parents', async () => {
  const h = parentWorld('visible', { count: 8, distinct: true });
  const result = await h.read();
  expect(result.items.map(item => item.parent)).toEqual(h.nodes.map(node => node.parent));
  expect(h.requests.map(ids => ids.length)).toEqual([8, 8]);
});

test('a parent revoked during the profile fence has no coordinates in Person contributions', async () => {
  const revoked = await parentWorld('visible', { revokeDuringProfileFence: true }).read();
  expect(revoked).toEqual(await parentWorld('absent').read());
});

for (const individualReads of [false, true]) {
  test(`profile privacy changing during ${individualReads ? 'individual' : 'batched'} parent hydration fails closed`, async () => {
    const changed = parentWorld('visible', { privateDuringParentRead: true, individualReads });
    await expect(changed.read()).rejects.toBeInstanceOf(WorkReadMissing);
    // The parent owner returned a visible record after the profile changed;
    // only the closing preferences-owner check can suppress the contribution.
    expect(changed.requests).toEqual([[id(10)], [id(50)]]);
  });
}

test('a parent disclosure outage fails the Person contribution read instead of pretending no parent', async () => {
  await expect(parentWorld('hidden', { unavailable: true }).read()).rejects.toThrow('Parent disclosure owner unavailable');
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
