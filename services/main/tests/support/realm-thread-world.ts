import { allocateAgentHandle } from '../../src/modules/agent/handle.ts';
import { REALM_THREAD_COST } from '../../src/modules/realm-reply/thread-contract.ts';
import { bestKey } from '../../src/modules/feed/ranking.ts';
import { RealmRankingsIncomplete, type RealmRankKey } from '../../src/modules/rankings/realm-threads.ts';
import type { PlacedHead, ThreadNode, ThreadVote } from '../../src/modules/realm-reply/thread-store.ts';
import { RV } from '../../src/modules/work/activate.ts';
import { WorkReadMissing, WorkReadMoved, type WorkReadSession } from '../../src/modules/work/read-session.ts';

// The selected-session regression needs the owner fixture without registering
// another test module's cases as import side effects.
export const realm = 'https://rezics.com/id/00000000-0000-4000-8000-00000000000a';
export const work = 'https://rezics.com/id/00000000-0000-4000-8000-00000000000b';
const n = (value: number) => value.toString(16).padStart(12, '0');
export const reply = (value: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n(value)}`;
// UUIDv7 placements carry their time: `minutes` after a fixed start.
const start = Date.parse('2026-09-20T00:00:00Z');
const now = start + 60 * 24 * 8.5 * 60_000;
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
  bodyUnavailable?: boolean;
}

export function world(placed: Placed[], options: { privateRealm?: boolean; votes?: Record<number, Partial<ThreadVote>>;
  truncated?: boolean; countsComplete?: boolean; blocked?: number[]; rankingsBehind?: boolean;
  } = {}) {
  if (options.truncated) placed = [...placed, ...Array.from({ length: REALM_THREAD_COST.replies + 2 },
    (_, index) => ({ id: 1000 + index, parent: placed[0]!.id, author: 1 }))];
  const calls = { graph: 0, admitted: 0, votes: 0, bodies: 0, counts: 0, store: 0 };
  const byId = new Map(placed.map((item) => [item.id, item]));
  const siblingOrders = new Map<string, { scores: string; revision: number; arrivals: Set<number> }>();
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
          if (item.bodyUnavailable) return { revisionId: id, status: 'unavailable' };
          const spoiler = item.spoiler === 'bad' ? 'yes' : item.spoiler;
          return { revisionId: id, status: 'available', body: { body: item.body ?? `Title ${item.id}\nBody ${item.id}`,
            ...(spoiler === undefined ? {} : { spoiler }) },
            reference: { resourceId: reply(item.id), language: { kind: 'tag', tag: 'en', originalTag: 'en' } } };
        });
      } },
      realmReplyThreads: {
        assertThreadProjection: async () => {},
        siblingOrderRevisions: async (_epoch: string, _realm: string, parents: readonly string[], sort = 'best') =>
          new Map(parents.map(parent => {
            const children = placed.filter(item => item.parent && reply(item.parent) === parent);
            const scores = sort === 'new' ? '' : JSON.stringify(children
              .map(item => [item.id, options.votes?.[item.id]?.score ?? 0]));
            const scope = `${sort}:${parent}`, previous = siblingOrders.get(scope);
            const arrivals = new Set([...(previous?.arrivals ?? []), ...children.map(item => item.id)]);
            const revision = previous ? previous.revision
              + (previous.scores === scores && previous.arrivals.size === arrivals.size ? 0 : 1) : 0;
            siblingOrders.set(scope, { scores, revision, arrivals });
            return [parent, `00000000-0000-4000-8000-${n(revision)}`];
          })),
        identities: async (ids: readonly string[]) => placed.filter(item => ids.includes(reply(item.id))).map(node),
        focusBasis: async (_epoch: string, _realm: string, focus: string) => {
          let current = placed.find(item => reply(item.id) === focus);
          if (!current) return null;
          let active = current?.approved !== false;
          while (current.parent && byId.has(current.parent)) current = byId.get(current.parent)!;
          let above = placed.find(item => reply(item.id) === focus);
          while (above?.parent) {
            above = byId.get(above.parent);
            if (above?.approved === false) active = false;
          }
          return { thread: reply(current.parent ?? current.id), active };
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
          if (options.rankingsBehind) throw new RealmRankingsIncomplete();
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

