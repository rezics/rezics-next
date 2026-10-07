import { expect, test } from 'bun:test';
import { allocateAgentHandle } from '../src/modules/agent/handle.ts';
import { discussionParts } from '../src/modules/realm-reply/discussion-text.ts';
import { readRealmThread, readRealmThreads } from '../src/modules/realm-reply/thread-read.ts';
import { REALM_THREAD_COST } from '../src/modules/realm-reply/thread-contract.ts';
import { bestKey } from '../src/modules/feed/ranking.ts';
import type { RealmRankKey } from '../src/modules/rankings/realm-threads.ts';
import type { PlacedHead, ThreadNode, ThreadVote } from '../src/modules/realm-reply/thread-store.ts';
import { RV } from '../src/modules/work/activate.ts';
import { decodeReadCursor, WorkReadMissing, WorkReadMoved, type WorkReadSession } from '../src/modules/work/read-session.ts';

// Realm threads over an in-memory graph, Content and vote projection: the
// fakes answer the reads' batches, so the tests pin which replies a Realm
// shows, in what order, and that each read stays a fixed number of batches.

export const realm = 'https://rezics.com/id/00000000-0000-4000-8000-00000000000a';
const work = 'https://rezics.com/id/00000000-0000-4000-8000-00000000000b';
const n = (value: number) => value.toString(16).padStart(12, '0');
export const reply = (value: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n(value)}`;
// UUIDv7 placements carry their time: `minutes` after a fixed start.
const start = Date.parse('2026-09-20T00:00:00Z');
const placement = (value: number, minutes = value) => {
  const hex = (start + minutes * 60_000).toString(16).padStart(12, '0');
  return `https://rezics.com/id/${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-${n(value)}`;
};
const revision = (value: number) => `00000000-0000-4000-a000-${n(value)}`;
const review = (value: number) => `00000000-0000-4000-b000-${n(value)}`;
const agent = (value: number) => `https://rezics.com/id/00000000-0000-4000-c000-${n(value)}`;
const bind = (value: string) => ({ value });

interface Placed { id: number; parent?: number; author: number; minutes?: number; body?: string;
  approved?: boolean; graphParent?: number | null; hiddenAuthor?: boolean; rootRevision?: string;
  /** `bad` is a corrupt declaration. Null is an unset JSON value. */
  spoiler?: boolean | null | 'bad';
}

export function world(placed: Placed[], options: { privateRealm?: boolean; votes?: Record<number, Partial<ThreadVote>>;
  truncated?: boolean; countsComplete?: boolean; blocked?: number[];
  } = {}) {
  if (options.truncated) placed = [...placed, ...Array.from({ length: REALM_THREAD_COST.replies + 2 },
    (_, index) => ({ id: 1000 + index, parent: placed[0]!.id, author: 1 }))];
  const calls = { graph: 0, admitted: 0, votes: 0, bodies: 0, counts: 0, store: 0 };
  const byId = new Map(placed.map((item) => [item.id, item]));
  const siblingOrders = new Map<string, { scores: string; revision: number }>();
  const node = (item: Placed): ThreadNode => ({ reply: reply(item.id), parent: item.parent ? reply(item.parent) : null,
    author: agent(item.author), origin: null, rootTarget: work, rootRevision: item.rootRevision ?? reply(900),
    createdAt: new Date(start) });
  const graphRow = (item: Placed) => ({ id: bind(placement(item.id, item.minutes)), reply: bind(reply(item.id)),
    work: bind(work), author: bind(agent(item.author)), revision: bind(`urn:rezics:content:revision:${revision(item.id)}`),
    review: bind(`urn:rezics:realm-review:${review(item.id)}`), preparation: bind(`prep-${item.id}`),
    rootRevision: bind(item.rootRevision ?? reply(900)), sequence: bind(String(1000 + item.id)), epochOrder: bind('0'),
    revisionEpoch: bind('epoch'),
    ...(item.graphParent !== undefined ? item.graphParent === null ? {} : { parent: bind(reply(item.graphParent)) }
      : item.parent ? { parent: bind(reply(item.parent)) } : {}) });
  const descendants = (id: number): Placed[] => {
    const out: Placed[] = [byId.get(id)!];
    for (let index = 0; index < out.length; index++) {
      out.push(...placed.filter((item) => item.parent === out[index]!.id));
    }
    return out;
  };
  const session = {
    checkDeadline: () => {}, displayLanguages: ['en'], request: new Request('http://main.test/v1/resources'),
    options: options.blocked ? { actingSubject: agent(9) } : {},
    position: { dataEpoch: 'epoch', sequence: '9' }, principal: options.blocked ? {} : null,
    realm: async () => {
      if (options.privateRealm) throw new WorkReadMissing('Realm is unavailable');
      return { space: realm, realmRevision: 'r1', visibility: 'public', reviewMode: 'open', revision: null };
    },
    query: async (query: string) => {
      if (query.includes('SELECT ?epoch ?sequence ?r ?revision')) {
        return [{ epoch: bind(session.position.dataEpoch), sequence: bind(session.position.sequence), r: bind(work), revision: bind(reply(900)),
          type: bind('https://schema.org/CreativeWork') }];
      }
      if (query.includes('SELECT ?decision WHERE')) return [];
      if (query.includes('rv:RestoreCutover')) return [];
      if (query.includes('rv:agentKind')) {
        return [...new Set(placed.filter((item) => !item.hiddenAuthor).map((item) => item.author))].map((id) => ({
          agent: bind(agent(id)), displayName: bind(`Reader ${id}`), agentKind: bind(`${RV}PersonAgent`),
          handle: bind(allocateAgentHandle(agent(id))) }));
      }
      calls.graph++;
      if (query.includes('VALUES (?slot ?id)')) {
        return placed
          .filter((item) => query.includes(`<${placement(item.id, item.minutes)}>`))
          .map(graphRow);
      }
      if (query.includes('VALUES (?slot ?reply)')) {
        return placed.filter((item) => query.includes(`<${reply(item.id)}>`)).map(graphRow);
      }
      return placed.filter((item) => !item.parent).sort((a, b) => b.id - a.id).map(graphRow);
    },
    summaries: async (ids: string[]) => ids.map((id) => ({ status: 'available', disclosure: 'public', type: 'work',
      name: { value: 'Rainy Night Bookshop', language: 'en', direction: 'ltr', basis: 'requested' },
      avatar: { kind: 'fallback', policy: 'avatar-fallback-v1', key: id, resourceType: 'work' } })),
    deps: {
      access: {},
      environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
        objectDirectory: '.temp/thread-unit', fuseki: { query: async () => ({ results: { bindings: [{
          epoch: bind(session.position.dataEpoch), sequence: bind(session.position.sequence), r: bind(work), type: bind('work'), work: bind(work),
          head: bind(reply(900)), public: bind('true'), erased: bind('false'),
          label: { value: 'Rainy Night Bookshop', 'xml:lang': 'en' },
        }] } }) } },
      personPreferences: {
        blockedActors: async (_principal: unknown, _agent: string, actors: string[]) =>
          new Set(actors.filter((actor) => options.blocked?.some((id) => actor === agent(id)))),
        visibleNameOwners: async (agents: readonly string[]) => new Set(agents),
      },
      profiles: { agentFences: async (ids: string[]) => new Map(ids.map((id) => [id, 'fence'])) },
      content: { readExactBatch: async (ids: string[]) => {
        calls.bodies++;
        return ids.map((id) => {
          const item = placed.find((candidate) => revision(candidate.id) === id)!;
          const spoiler = item.spoiler === 'bad' ? 'yes' : item.spoiler;
          return { revisionId: id, status: 'available', body: { body: item.body ?? `Title ${item.id}\nBody ${item.id}`,
            ...(spoiler === undefined ? {} : { spoiler }) },
            reference: { resourceId: reply(item.id), language: { kind: 'tag', tag: 'en', originalTag: 'en' } } };
        });
      } },
      realmReplyThreads: {
        assertThreadProjection: async () => {},
        siblingOrderRevisions: async (_epoch: string, _realm: string, parents: readonly string[]) =>
          new Map(parents.map(parent => {
            const scores = JSON.stringify([...byId.values()].filter(item => item.parent && reply(item.parent) === parent)
              .map(item => [item.id, options.votes?.[item.id]?.score ?? 0]));
            const previous = siblingOrders.get(parent);
            const revision = previous ? previous.revision + (previous.scores === scores ? 0 : 1) : 0;
            siblingOrders.set(parent, { scores, revision });
            return [parent, `00000000-0000-4000-8000-${n(revision)}`];
          })),
        identities: async (ids: readonly string[]) => placed.filter(item => ids.includes(reply(item.id))).map(node),
        focusBasis: async (_epoch: string, _realm: string, focus: string) => {
          let current = placed.find(item => reply(item.id) === focus);
          let active = current?.approved !== false;
          while (current?.parent) current = byId.get(current.parent);
          let above = placed.find(item => reply(item.id) === focus);
          while (above?.parent) {
            above = byId.get(above.parent);
            if (above?.approved === false) active = false;
          }
          return current ? { thread: reply(current.id), active } : null;
        },
        siblingPage: async (_epoch: string, _realm: string, parent: string, sort: 'best' | 'new' | 'top',
          limit: number, after?: { rank: number; time: string; placement: string }) => {
          calls.store++;
          const key = (item: Placed) => {
            const time = start + (item.minutes ?? item.id) * 60_000;
            const score = options.votes?.[item.id]?.score ?? 0;
            return { rank: sort === 'new' ? 0 : sort === 'top' ? -score : -bestKey(score, time),
              time: String(-time), placement: placement(item.id, item.minutes) };
          };
          const compare = (a: ReturnType<typeof key>, b: ReturnType<typeof key>) =>
            a.rank - b.rank || Number(a.time) - Number(b.time) || a.placement.localeCompare(b.placement);
          return placed.filter(item => item.parent && reply(item.parent) === parent)
            .map(item => ({ ...key(item), reply: reply(item.id),
              hasChildren: placed.some(child => child.parent === item.id) }))
            .sort(compare).filter(item => !after || compare(item, after) > 0).slice(0, limit + 1);
        },
        rankingRevision: async () =>
          String(
            1 +
              Object.values(options.votes ?? {}).reduce(
                (sum, vote) => sum + Math.abs(vote.score ?? 0),
                0,
              ),
          ),
        rankedPage: async (
          _session: unknown,
          _realm: string,
          sort: 'best' | 'top',
          period: 'week' | 'month' | 'all',
          limit: number,
          after?: RealmRankKey & { revision: string },
        ) => {
          const revision = String(
            1 +
              Object.values(options.votes ?? {}).reduce(
                (sum, vote) => sum + Math.abs(vote.score ?? 0),
                0,
              ),
          );
          if (after && after.revision !== revision)
            throw new WorkReadMoved('Thread ranking changed');
          const ranked = placed
            .filter(
              (item) =>
                !item.parent &&
                item.approved !== false &&
                (sort === 'best' ||
                  period === 'all' ||
                  now - (start + (item.minutes ?? item.id) * 60_000) <=
                    (period === 'week' ? 7 : 30) * 86_400_000),
            )
            .map((item) => {
              const time = start + (item.minutes ?? item.id) * 60_000,
                score = options.votes?.[item.id]?.score ?? 0;
              return {
                reply: reply(item.id),
                placement: placement(item.id, item.minutes),
                rank_key: -(sort === 'best' ? bestKey(score, time) : score),
                time_key: String(-time),
              };
            })
            .sort(
              (a, b) =>
                a.rank_key - b.rank_key ||
                Number(a.time_key) - Number(b.time_key) ||
                a.placement.localeCompare(b.placement),
            );
          const offset = after
            ? ranked.findIndex((item) => item.placement === after.placement) + 1
            : 0;
          return { revision, rows: ranked.slice(offset, offset + limit + 1) };
        },
        subtree: async (focus: string) => {
          calls.store++;
          const id = placed.find((item) => reply(item.id) === focus)?.id;
          const tree = id === undefined ? [] : descendants(id).map(node);
          // A thread longer than one read: the store returns one row past the bound.
          return options.truncated ? [...tree, ...Array.from({ length: REALM_THREAD_COST.replies + 2 - tree.length },
            (_, index) => node({ id: 1000 + index, parent: id, author: 1 }))] : tree;
        },
        ancestors: async (focus: string) => {
          calls.store++;
          const out: ThreadNode[] = [];
          let current = placed.find((item) => reply(item.id) === focus);
          while (current?.parent && out.length < REALM_THREAD_COST.ancestors) {
            current = byId.get(current.parent); if (current) out.push(node(current));
          }
          return out;
        },
        admitted: async (_realm: string, heads: readonly PlacedHead[]) => {
          calls.admitted++;
          return new Map(heads.flatMap((head) => {
            const item = placed.find((candidate) => reply(candidate.id) === head.reply);
            return item && item.approved !== false ? [[head.reply, node(item)] as const] : [];
          }));
        },
        counts: async (_realm: string, threads: readonly string[]) => {
          calls.counts++;
          return { counts: new Map(threads.map((thread) => [thread, placed.filter(
                  (item) => item.parent
            && reply(item.parent) === thread && item.approved !== false).length])),
          complete: options.countsComplete ?? true };
        },
        votes: async (_epoch: string, ids: readonly string[]) => {
          calls.votes++;
          return new Map(ids.map((id) => {
            const item = placed.find(
                (candidate) => placement(candidate.id, candidate.minutes) === id)!;
            return [id, { score: 0, value: 0, revision: null, open: true, ...options.votes?.[item.id] }] as const;
          }));
        },
      },
    },
  } as unknown as WorkReadSession;
  return { session, calls };
}

test('G-650: Realm threads retain replies rooted on earlier target revisions', async () => {
  const f = world([{ id: 1, author: 1, rootRevision: reply(901) }]);
  expect((await readRealmThreads(f.session, realm, { sort: 'new' })).items).toHaveLength(1);
  expect(await readRealmThread(f.session, realm, reply(1))).toMatchObject({ rootRevision: reply(901) });
});

// 1 opens the thread; 2 and 3 answer it; 4 answers 2; 5 answers 3 but lost its review, so 6 under it is hidden too.
const thread: Placed[] = [
  { id: 1, author: 1, body: 'Chapter one: the letter\nWho left it?' },
  { id: 2, parent: 1, author: 2 }, { id: 3, parent: 1, author: 3, hiddenAuthor: true },
  { id: 4, parent: 2, author: 1 }, { id: 5, parent: 3, author: 2, approved: false }, { id: 6, parent: 5, author: 1 },
];

test('a thread shows its approved replies nested, hides what sits under a withdrawn one and names no hidden author', async () => {
  const { session, calls } = world(thread, { votes: { 2: { score: 3, value: 1 }, 4: { open: false } } });
  const read = await readRealmThread(session, realm, reply(1));
  expect(read).toMatchObject({ profile: 'realm-thread-v1', realm, thread: reply(1), focus: reply(1),
    work: { id: work, title: { value: 'Rainy Night Bookshop' } }, rootRevision: reply(900), ancestors: [],
    complete: true });
  // Depth first: each reply is followed by its own replies, best first.
  expect(read.items.map((item) => [item.reply, item.parent])).toEqual([[reply(1), null], [reply(2), reply(1)],
    [reply(4), reply(2)], [reply(3), reply(1)]]);
  // The opening discussion's first line is its title; its body goes on from there. Replies have no title.
  expect(read.items[0]).toMatchObject({ title: 'Chapter one: the letter', body: 'Who left it?', language: 'en',
    author: { id: agent(1), name: 'Reader 1', handle: null },
    time: new Date(start + 60_000).toISOString() });
  expect(read.items[1]!.vote).toEqual({ score: 3, value: 1, revision: null, open: true });
  expect(read.items[1]).toMatchObject({ title: null, body: 'Title 2\nBody 2' });
  expect(read.items[3]!.author).toBeNull();
  expect(read.items[2]!.vote.open).toBe(false);
  expect(read.work).toMatchObject({ cover: { kind: 'fallback' } });
  // One graph batch, one admission batch, one vote batch and one body batch, whatever the thread's size.
  expect(calls).toMatchObject({ graph: 1, admitted: 1, votes: 1, bodies: 1 });
});

test('a reader who blocked an author gets a collapsed reply without its identity or words', async () => {
  const read = await readRealmThread(world(thread, { blocked: [2] }).session, realm, reply(1));
  const items = new Map(read.items.map((item) => [item.reply, item]));
  expect(items.get(reply(2))).toMatchObject({ blocked: true, author: null, body: '', title: null });
  expect(items.get(reply(4))).toMatchObject({ blocked: false, body: 'Title 4\nBody 4' });
  expect(items.get(reply(3))).toMatchObject({ blocked: false });
});

test('a block changed while reading restarts the thread rather than exposing a stale body', async () => {
  const { session } = world(thread, { blocked: [2] });
  let reads = 0;
  Object.assign(session.deps, { personPreferences: { blockedActors: async () =>
    new Set([agent(++reads === 1 ? 2 : 3)]),
    visibleNameOwners: async (agents: readonly string[]) => new Set(agents) } });
  await expect(readRealmThread(session, realm, reply(1))).rejects.toBeInstanceOf(WorkReadMoved);
});

test('a thread reads in the order asked for: Top by votes, New newest first', async () => {
  const replies: Placed[] = [{ id: 1, author: 1 }, { id: 2, parent: 1, author: 2, minutes: 10 },
    { id: 3, parent: 1, author: 3, minutes: 20 }, { id: 4, parent: 1, author: 1, minutes: 30 }];
  const votes = { 2: { score: 9 }, 3: { score: 4 }, 4: { score: -1 } };
  const order = async (sort: 'top' | 'new') => (await readRealmThread(world(replies, { votes }).session, realm,
    reply(1), sort)).items.map(
      (item) => item.reply);
  expect(await order('top')).toEqual([reply(1), reply(2), reply(3), reply(4)]);
  expect(await order('new')).toEqual([reply(1), reply(4), reply(3), reply(2)]);
});

test('a reply read on its own carries its visible parents, opening discussion first, as context', async () => {
  const { session } = world(thread);
  const read = await readRealmThread(session, realm, reply(4));
  expect(read.thread).toBe(reply(1));
  expect(read.ancestors.map((item) => item.reply)).toEqual([reply(1), reply(2)]);
  expect(read.items.map((item) => item.reply)).toEqual([reply(4)]);
});

test('a reply whose graph parent disagrees with Content, or whose thread is cut off, is not shown as settled', async () => {
  const moved = world([{ id: 1, author: 1 }, { id: 2, parent: 1, author: 2, graphParent: null }]);
  expect((await readRealmThread(moved.session, realm, reply(1))).items.map((item) => item.reply)).toEqual([reply(1)]);
  const long = world(thread, { truncated: true });
  expect((await readRealmThread(long.session, realm, reply(1))).complete).toBe(false);
});

test('an unplaced or withdrawn reply, and any reply in a Realm the reader cannot see, is missing', async () => {
  await expect(readRealmThread(world(thread).session, realm, reply(5))).rejects.toBeInstanceOf(WorkReadMissing);
  await expect(readRealmThread(world(thread).session, realm, reply(42))).rejects.toBeInstanceOf(WorkReadMissing);
  const hidden = world(thread, { privateRealm: true });
  await expect(readRealmThread(hidden.session, realm, reply(1))).rejects.toBeInstanceOf(WorkReadMissing);
  expect(hidden.calls.store).toBe(0);
});

const discussions: Placed[] = [
  { id: 1, author: 1, minutes: 60 * 24 * 1 }, { id: 2, author: 2, minutes: 60 * 24 * 2 },
  { id: 3, author: 3, minutes: 60 * 24 * 3, approved: false }, { id: 4, author: 1, minutes: 60 * 24 * 4 },
  { id: 5, parent: 4, author: 2 }, { id: 6, parent: 4, author: 3 },
];
const now = start + 60 * 24 * 8.5 * 60_000;

test('a Realm lists its discussions newest first, a page at a time, with their reply counts', async () => {
  const { session } = world(discussions);
  const first = await readRealmThreads(session, realm, { sort: 'new', limit: 2, now });
  expect(first).toMatchObject({ profile: 'realm-threads-v1', realm, sort: 'new' });
  expect(first.items.map((item) => item.reply)).toEqual([reply(4)]);
  expect(first.items[0]).toMatchObject({ title: 'Title 4', excerpt: 'Body 4', replies: { value: 2, kind: 'exact' },
    work: { id: work }, author: { name: 'Reader 1' } });
  expect(first.nextCursor).not.toBeNull();
  expect(decodeReadCursor(first.nextCursor!, ['realm-threads-v1', realm, 'new', null], session.position)?.after)
    .toBe(placement(3, 60 * 24 * 3));
});

test('Best weighs votes against age, Top counts votes in the period, and a reordered ranking restarts the next page', async () => {
  const votes = { 1: { score: 5000 }, 2: { score: 1 }, 4: { score: 2 } };
  const best = await readRealmThreads(world(discussions, { votes }).session, realm, { sort: 'best', now });
  expect(best.items.map((item) => item.reply)).toEqual([reply(1), reply(4), reply(2)]);
  const week = await readRealmThreads(world(discussions, { votes }).session, realm, { sort: 'top', window: 'week', now });
  expect(week.items.map((item) => item.reply)).toEqual([reply(4), reply(2)]);
  const all = await readRealmThreads(world(discussions, { votes, countsComplete: false }).session, realm,
    { sort: 'top', window: 'all', limit: 1, now });
  expect(all.items).toMatchObject([{ reply: reply(1), replies: { kind: 'lower-bound' } }]);
  const moved = world(discussions, { votes: { 1: { score: 0 }, 2: { score: 50 } } });
  await expect(readRealmThreads(moved.session, realm, { sort: 'top', window: 'all', limit: 1, now,
    cursor: all.nextCursor! })).rejects.toBeInstanceOf(WorkReadMoved);
});

test('a discussion is titled by its first line, and a first line too long for a title loses no word', () => {
  expect(discussionParts('【本周共读】《雨夜书店》第一章 雨夜\n这周我们读第一章。\n\n我最喜欢开头那句。'))
    .toEqual({ title: '【本周共读】《雨夜书店》第一章 雨夜', body: '这周我们读第一章。\n\n我最喜欢开头那句。' });
  expect(discussionParts('  Share your smallest useful prompt  ')).toEqual({ title: 'Share your smallest useful prompt',
    body: '' });
  const line = '字'.repeat(320);
  const { title, body } = discussionParts(`${line}\nsecond`);
  expect(Array.from(title)).toHaveLength(301);
  expect(`${title.slice(0, -1)}${body}`).toBe(`${line}\nsecond`);
});
