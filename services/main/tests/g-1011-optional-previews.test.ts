import { expect, test } from 'bun:test';
import { resourceWorkCards } from '../src/modules/query/work-cards.ts';
import { optionalPreview } from '../src/modules/query/optional-preview.ts';
import { WorkReadLimit, WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';
import { FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded } from '../src/infrastructure/fuseki.ts';
import { RecommendationUnavailable } from '../src/modules/recommendation/derived-generation.ts';
import { allocateAgentHandle } from '../src/modules/agent/handle.ts';
import { RV } from '../src/modules/work/activate.ts';
import { resourceWorkCard } from '../src/modules/query/resource-contract.ts';
import { Value } from 'typebox/value';
import { readAgentCards } from '../src/modules/profiles/read.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const field = (value: string) => ({ type: 'uri', value });
const credit = (agent: number) => ({ id: id(agent + 100), role: 'author', participantKind: 'agent',
  agent: id(agent), provider: null, key: null, ordinal: null, displayName: null, handle: null });
const rating = { context: id(99), count: 2, sum: 8, mean: 4, scale: { min: 1 as const, max: 5 as const } };
function fixture(fault: 'credits' | 'rating' | 'profile' | 'missing' | 'rating-owner' | 'projection-owner'
  | 'source-owner' | 'source-moved' | 'profile-moved' | 'none' = 'none') {
  let sourceReads = 0, fenceReads = 0;
  const queries: string[] = [];
  const batches: string[][] = [];
  const external = { id: id(110), role: 'author', participantKind: 'external-reference', agent: null,
    provider: 'open-library', key: '/authors/OL1A', ordinal: 1,
    displayName: 'Saved secret source name', handle: null, confirmation: 'source-reported' };
  const session = { position: { dataEpoch: 'epoch', sequence: '1' }, displayLanguages: ['en'],
    checkDeadline() {}, deps: {
      discovery: {
        async active(basis: { context: string | null }) {
          if (basis.context && fault === 'rating-owner') throw new RecommendationUnavailable('Rating owner down');
          return { generation_id: basis.context ? 'rated' : 'base', stale: false };
        },
        async resourceCardPayloads(_generations: unknown, works: string[]) {
          batches.push(works);
          if (fault === 'projection-owner') throw new RecommendationUnavailable('Projection owner down');
          return new Map<string, Map<string, { primaryCredits: unknown[]; rating: unknown }>>([
            ['base', new Map(works.flatMap((work, index) => fault === 'missing' && index === 0 ? [] : [[work, {
              primaryCredits: fault.startsWith('source-') && index === 0 ? [external]
                : fault === 'credits' && index === 0 ? [1, 2, 3, 4].map(credit) : [credit(index + 1)], rating: null,
            }]]))],
            ['rated', new Map(works.map((work, index) => [work, { primaryCredits: [],
              rating: fault === 'rating' && index === 0 ? { ...rating, mean: 5 } : rating }]))],
          ]);
        },
      },
      profiles: { async agentFences(agents: string[]) {
        fenceReads++;
        return new Map(agents.map(agent => [agent, fault === 'profile-moved' && fenceReads > 1
          && agent === id(1) ? 'changed' : 'live']));
      } },
      sourceAuthorNames: { async batch() {
        sourceReads++;
        if (fault === 'source-owner') throw new Error('Source database down');
        return new Map([['/authors/OL1A', { displayName: fault === 'source-moved' && sourceReads > 1
          ? 'Changed source name' : 'Current source name' }]]);
      } },
    },
    async query(query: string) {
      queries.push(query);
      if (query.includes('GlobalRatingContext')) return [{ context: field(id(99)) }];
      return [1, 2].filter(n => query.includes(`<${id(n)}>`)).map(n => ({
        agent: field(id(n)), displayName: field(fault === 'profile' && n === 1 ? '' : `Author ${n}`),
        agentKind: field(`${RV}PersonAgent`), handle: field(allocateAgentHandle(id(n))),
        agentHead: field(id(n + 200)),
      }));
    },
  } as unknown as WorkReadSession;
  return { session, queries, batches };
}

test('G1011: invalid or missing item credits preserve its rating and the healthy neighbour', async () => {
  for (const fault of ['credits', 'missing'] as const) {
    const f = fixture(fault);
    const cards = await resourceWorkCards(f.session, [id(9), id(10)]);
    expect(cards.get(id(9))).toEqual({ primaryCredits: [], creditCount: { value: 0, kind: 'at-least' }, rating });
    expect(cards.get(id(10))!.primaryCredits[0]!.displayName).toBe('Author 2');
    expect(cards.get(id(10))!.rating).toEqual(rating);
    expect(f.batches).toEqual([[id(9), id(10)]]);
    expect(f.queries).toHaveLength(2);
    for (const card of cards.values()) expect(Value.Check(resourceWorkCard, card)).toBe(true);
  }
});
test('G1011: invalid ratings preserve credits and neighbouring ratings', async () => {
  const cards = await resourceWorkCards(fixture('rating').session, [id(9), id(10)]);
  expect(cards.get(id(9))!.rating).toBeNull();
  expect(cards.get(id(9))!.primaryCredits[0]!.displayName).toBe('Author 1');
  expect(cards.get(id(10))!.rating).toEqual(rating);
});
test('G1011: unavailable rating and projection owners do not reject card previews', async () => {
  const ratingFailure = await resourceWorkCards(fixture('rating-owner').session, [id(9), id(10)]);
  expect(ratingFailure.get(id(9))!.primaryCredits[0]!.displayName).toBe('Author 1');
  expect(ratingFailure.get(id(9))!.rating).toBeNull();
  const ownerFailure = await resourceWorkCards(fixture('projection-owner').session, [id(9), id(10)]);
  for (const card of ownerFailure.values()) expect(card).toEqual({
    primaryCredits: [], creditCount: { value: 0, kind: 'at-least' }, rating: null,
  });
});
test('G1011: invalid or concurrently changed author profiles omit only that author', async () => {
  for (const fault of ['profile', 'profile-moved'] as const) {
    const f = fixture(fault);
    const cards = await resourceWorkCards(f.session, [id(9), id(10)]);
    expect(cards.get(id(9))!.primaryCredits).toEqual([]);
    expect(cards.get(id(10))!.primaryCredits[0]!.displayName).toBe('Author 2');
    expect(f.queries).toHaveLength(2);
  }
});
test('G1011: required profile reads still reject malformed author state', async () => {
  await expect(readAgentCards(fixture('profile').session, [id(1), id(2)]))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
});
test('G1011: source-name failures and changes never reveal saved projection names', async () => {
  for (const fault of ['source-owner', 'source-moved'] as const) {
    const cards = await resourceWorkCards(fixture(fault).session, [id(9), id(10)]);
    expect(cards.get(id(9))!.primaryCredits[0]!.displayName).toBeNull();
    expect(JSON.stringify([...cards])).not.toContain('Saved secret source name');
    expect(JSON.stringify([...cards])).not.toContain('Current source name');
    expect(cards.get(id(10))!.primaryCredits[0]!.displayName).toBe('Author 2');
  }
});
test('G1011: optional hydration still enforces graph, byte and deadline budgets', async () => {
  const session = fixture().session;
  for (const error of [new WorkReadLimit('rows'), new FusekiReadBudgetExceeded('calls'),
    new FusekiQueryResponseTooLarge('bytes')]) {
    await expect(optionalPreview(session, async () => { throw error; })).rejects.toBe(error);
  }
  session.checkDeadline = () => { throw new WorkReadUnavailable('deadline'); };
  await expect(optionalPreview(session, async () => { throw new Error('owner down'); }))
    .rejects.toThrow('deadline');
});
