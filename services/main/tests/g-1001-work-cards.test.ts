import { expect, test } from 'bun:test';
import { resourceWorkCards } from '../src/modules/query/work-cards.ts';
import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';
import { allocateAgentHandle } from '../src/modules/agent/handle.ts';
import { RV } from '../src/modules/work/activate.ts';
import { Value } from 'typebox/value';
import { resourceWorkCard, RESOURCE_WORK_CARD_COST } from '../src/modules/query/resource-contract.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const field = (value: string) => ({ type: 'uri', value });
const nativeCredit = (n: number) => ({ id: id(n + 100), role: 'author', participantKind: 'agent',
  agent: id(n), provider: null, key: null, ordinal: null, displayName: null, handle: null });
function fixture(options: { credits?: unknown[]; context?: boolean; stale?: boolean; moved?: boolean;
  missing?: boolean; hidden?: boolean; invalidRating?: boolean } = {}) {
  const queries: string[] = [], batches: string[][] = [];
  let activeCalls = 0;
  const payload = { primaryCredits: options.credits ?? [nativeCredit(1)], rating: null };
  const session = { position: { dataEpoch: 'epoch', sequence: '1' }, displayLanguages: ['en'],
    checkDeadline() {}, deps: {
      discovery: {
        async active(basis: { context: string | null }) {
          activeCalls++;
          return { generation_id: basis.context ? 'rated' : 'base', stale: options.stale || (options.moved && activeCalls > 1) };
        },
        async resourceCardPayloads(_generations: unknown, works: string[]) {
          batches.push(works);
          return new Map<string, Map<string, { primaryCredits: unknown[]; rating: unknown }>>([
            ['base', new Map(options.missing ? [] : works.map(work => [work, payload]))],
            ['rated', new Map(works.map(work => [work, { primaryCredits: [], rating: {
              context: id(99), mean: 4.5, count: options.invalidRating ? 101 : 2, sum: 9, scale: { min: 1, max: 5 },
            } }]))],
          ]);
        },
      },
      profiles: { async agentFences(agents: string[]) { return new Map(agents.map(agent => [agent, 'live'])); } },
    },
    async query(query: string) {
      queries.push(query);
      if (query.includes('GlobalRatingContext')) return options.context ? [{ context: field(id(99)) }] : [];
      return options.hidden ? [] : [1, 2, 3].filter(n => query.includes(`<${id(n)}>`)).map(n => ({
        agent: field(id(n)), displayName: field(`Author ${n}`), agentKind: field(`${RV}PersonAgent`),
        handle: field(allocateAgentHandle(id(n))), agentHead: field(id(n + 200)),
      }));
    },
  } as unknown as WorkReadSession;
  return { session, queries, batches };
}

test('G1001: projected credits retain order, current public names and the Global summary', async () => {
  const f = fixture({ credits: [nativeCredit(3), nativeCredit(1)], context: true });
  const card = (await resourceWorkCards(f.session, [id(9)])).get(id(9))!;
  expect(card.primaryCredits.map(credit => credit.displayName)).toEqual(['Author 3', 'Author 1']);
  expect(card.creditCount).toEqual({ value: 2, kind: 'exact' });
  expect(card.rating).toMatchObject({ context: id(99), count: 2, mean: 4.5, scale: { max: 5 } });
  expect(Value.Check(resourceWorkCard, card)).toBe(true);
  expect(f.batches).toEqual([[id(9)]]);
  expect(f.queries.every(query => !/NativeAgentCredit|RatingObservation|COUNT\(/.test(query))).toBe(true);
});
test('G1001: a full projected prefix is a lower bound, with no live credit count', async () => {
  const f = fixture({ credits: [nativeCredit(1), nativeCredit(2), nativeCredit(3)] });
  const card = (await resourceWorkCards(f.session, [id(9)])).get(id(9))!;
  expect(card.creditCount).toEqual({ value: 3, kind: 'at-least' });
  expect(card.primaryCredits).toHaveLength(3);
  expect(card.rating).toBeNull();
});
test('G1001: a private author is withheld without falling back to a saved display name', async () => {
  const f = fixture({ credits: [{ ...nativeCredit(1), displayName: 'Saved private author' }], hidden: true });
  const card = (await resourceWorkCards(f.session, [id(9)])).get(id(9))!;
  expect(card.primaryCredits).toEqual([]);
  expect(JSON.stringify(card)).not.toContain('Saved private author');
});
test('G1001: stale, concurrent, missing and malformed projection states never become exact empty cards', async () => {
  for (const options of [{ stale: true }, { moved: true }, { missing: true },
    { credits: [1, 2, 3, 4].map(nativeCredit) }, { context: true, invalidRating: true }]) {
    const f = fixture(options);
    await expect(resourceWorkCards(f.session, [id(9)])).rejects.toBeInstanceOf(
      options.stale || options.moved ? WorkReadMoved : WorkReadUnavailable,
    );
  }
  const recovered = fixture();
  expect((await resourceWorkCards(recovered.session, [id(9)])).get(id(9))!.primaryCredits).toHaveLength(1);
});
test('G1001: an empty page reads no projections and excess/duplicate Work inputs are refused', async () => {
  const f = fixture();
  expect(await resourceWorkCards(f.session, [])).toEqual(new Map());
  expect(f.queries).toEqual([]);
  expect(f.batches).toEqual([]);
  for (const works of [[id(1), id(1)], Array.from({ length: RESOURCE_WORK_CARD_COST.works + 1 }, (_, n) => id(n))])
    await expect(resourceWorkCards(f.session, works)).rejects.toBeInstanceOf(WorkReadUnavailable);
});
