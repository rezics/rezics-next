import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { resourceWorkCards } from '../src/modules/query/work-cards.ts';
import { resourceWorkCard, RESOURCE_WORK_CARD_COST } from '../src/modules/query/resource-contract.ts';
import { WorkReadLimit, WorkReadUnavailable, type WorkReadSession, type ReadRow } from '../src/modules/work/read-session.ts';
import { FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded } from '../src/infrastructure/fuseki.ts';
import type { AuthorName } from '../src/modules/source/author-name.ts';
import { RV } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jane = 'https://rezics.com/id/01a0e909-4963-77c2-b398-535b22259bec';
const credit = 'https://rezics.com/id/01a0e909-4bc4-760b-9bb8-48409ce3ea97';
const key = '/authors/OL113362A';
const field = (value: string) => ({ type: 'uri', value });
const author: AuthorName = { displayName: 'Charlotte Brontë', nameSource: {
  record: id(101), observation: id(102), revision: id(103), sourceRevision: 'open-library-revision:1',
  digest: 'a'.repeat(64), url: `https://openlibrary.org${key}.json`,
  fetchedAt: '2026-10-19T00:00:00.000Z', basis: 'facts', field: '/name',
} };

/** Actual query, discovery-credit and Source report readers, with controlled
 * owner ports. This does not establish installed public/native composition. */
function fixture(works: string[] = [jane]) {
  const queries: Array<{ query: string; limit: number }> = [];
  const sourceReads: string[][] = [], nameReads: string[][] = [];
  let projectionReads = 0, withdrawn = false, sourceFailure = false, hidden = false;
  let nativeFailure: Error | null = null, nativeRows: ReadRow[] = [];
  let bindingReads = 0, nameCalls = 0, moveBinding = false, removeNameAfter = Infinity;
  let withdrawAfterNames = Infinity;
  const references = new Map(works.map((work, n) => [work, [{ id: n ? id(n + 1000) : credit, key, ordinal: 0 }]]));
  const session = { position: { dataEpoch: 'epoch', sequence: '11954' }, displayLanguages: ['en'],
    checkDeadline() {}, deps: {
      discovery: {
        async active() { return { generation_id: 'stale-generation', stale: true }; },
        async resourceCardPayloads() { projectionReads++; throw new Error('Stale payload must not be used'); },
      },
      sourceAdoptions: { async authorReferences(selected: readonly string[]) {
        bindingReads++;
        sourceReads.push([...selected]);
        if (sourceFailure) throw new Error('Source bindings unavailable');
        return new Map(selected.flatMap(work => withdrawn || moveBinding && bindingReads > 1 || nameCalls >= withdrawAfterNames
          ? [] : [[work, references.get(work)!]]));
      } },
      sourceAuthorNames: { async batch(selected: readonly string[]) {
        nameCalls++;
        nameReads.push([...selected]);
        return new Map(selected.flatMap(selectedKey => nameCalls > removeNameAfter
          ? [] : [[selectedKey, author]]));
      } },
      profiles: { async agentFences(agents: readonly string[]) {
        return new Map(agents.map(agent => [agent, 'live']));
      } },
      personPreferences: { async visibleNameOwners(agents: readonly string[]) {
        return new Set(hidden ? [] : agents);
      } },
    },
    async query(query: string, limit: number) {
      queries.push({ query, limit });
      if (query.includes('GlobalRatingContext')) return [];
      if (query.includes('NativeAgentCreditRevision')) {
        if (nativeFailure) throw nativeFailure;
        return nativeRows;
      }
      return [{ agent: field(id(11)), agentKind: field(`${RV}PersonAgent`),
        displayName: field('Native author'), agentHead: field(id(12)) }];
    },
  } as unknown as WorkReadSession;
  return { session, queries, sourceReads, nameReads, references,
    projectionReads: () => projectionReads,
    native: (rows: ReadRow[]) => { nativeRows = rows; },
    nativeFailure: (error: Error) => { nativeFailure = error; },
    withdraw: () => { withdrawn = true; }, sourceFailure: () => { sourceFailure = true; },
    moveBinding: () => { moveBinding = true; }, removeName: (after = 1) => { removeNameAfter = after; },
    withdrawDuringNames: () => { withdrawAfterNames = 3; },
    hide: () => { hidden = true; },
  };
}

test('a stale resource preview reads the current Jane attribution and factual name without a rebuild', async () => {
  const f = fixture();
  const card = (await resourceWorkCards(f.session, [jane])).get(jane)!;
  expect(card.primaryCredits).toEqual([{ id: credit, role: 'author', participantKind: 'external-reference',
    provider: 'open-library', key, ordinal: 0, agent: null, displayName: author.displayName, handle: null,
    confirmation: 'source-reported', nameSource: author.nameSource }]);
  expect(card.creditCount).toEqual({ value: 1, kind: 'at-least' });
  expect(card.rating).toBeNull();
  expect(Value.Check(resourceWorkCard, card)).toBe(true);
  expect(f.projectionReads()).toBe(0);
  expect(f.sourceReads).toEqual([[jane], [jane], [jane]]);
});

test('stale preview credits share one bounded native seek and Source owner batches across the card window', async () => {
  const works = Array.from({ length: RESOURCE_WORK_CARD_COST.works }, (_, n) => id(n + 2000));
  const f = fixture(works);
  const cards = await resourceWorkCards(f.session, works);
  expect(cards.size).toBe(works.length);
  expect([...cards.values()].every(card => card.primaryCredits.length === 1)).toBe(true);
  const native = f.queries.filter(row => row.query.includes('NativeAgentCreditRevision'));
  expect(native).toHaveLength(1);
  expect(native[0]!.limit).toBe(works.length * RESOURCE_WORK_CARD_COST.credits);
  expect(native[0]!.query.match(/LIMIT 3/g)).toHaveLength(works.length);
  expect(native[0]!.query).toContain('rv:editControl rv:HumanConfirmed');
  expect(native[0]!.query).toContain('rv:creditRevision ?revision');
  expect(native[0]!.query).toContain('rv:ErasedRevision');
  expect(native[0]!.query).toContain('rv:retiredBy');
  expect(native[0]!.query).not.toMatch(/COUNT\(|OFFSET/u);
  expect(f.sourceReads).toEqual([works, works, works]);
  expect(f.nameReads.every(batch => batch.length <= 192)).toBe(true);
  expect(f.projectionReads()).toBe(0);
});

test('stale previews coalesce only the exact current qualified credit and preserve its native identity', async () => {
  const f = fixture();
  f.native([{ work: field(jane), id: field(id(15)), role: field('author'), provider: field('open-library'),
    namespace: field('author'), key: field(key), ordinal: field('0') }]);
  const card = (await resourceWorkCards(f.session, [jane])).get(jane)!;
  expect(card.primaryCredits).toHaveLength(1);
  expect(card.primaryCredits[0]).toMatchObject({ id: id(15), provider: 'open-library', key,
    displayName: author.displayName, nameSource: author.nameSource });
  expect(card.creditCount).toEqual({ value: 1, kind: 'at-least' });
});

test('other qualified participants do not request Open Library author names for colliding keys', async () => {
  for (const qualified of [
    { provider: 'other-provider', namespace: 'author' },
    { provider: 'open-library', namespace: 'other-namespace' },
  ]) {
    const f = fixture();
    f.withdraw();
    f.native([{ work: field(jane), id: field(id(15)), role: field('author'),
      provider: field(qualified.provider), namespace: field(qualified.namespace),
      key: field(key), ordinal: field('0') }]);
    const card = (await resourceWorkCards(f.session, [jane])).get(jane)!;
    expect(card.primaryCredits).toHaveLength(1);
    expect(card.primaryCredits[0]).toMatchObject({ id: id(15), ...qualified, key, displayName: null });
    expect(card.primaryCredits[0]).not.toHaveProperty('nameSource');
    expect(card.creditCount).toEqual({ value: 1, kind: 'at-least' });
    expect(f.nameReads).toEqual([]);
  }
});

test('a shared preview key names only the exact Open Library author participant', async () => {
  const f = fixture();
  f.withdraw();
  const qualified = [
    { provider: 'open-library', namespace: 'author' },
    { provider: 'other-provider', namespace: 'author' },
    { provider: 'open-library', namespace: 'other-namespace' },
  ];
  f.native(qualified.map((participant, ordinal) => ({ work: field(jane), id: field(id(15 + ordinal)),
    role: field('author'), provider: field(participant.provider), namespace: field(participant.namespace),
    key: field(key), ordinal: field(String(ordinal)) })));
  const card = (await resourceWorkCards(f.session, [jane])).get(jane)!;
  expect(card.primaryCredits).toHaveLength(3);
  qualified.forEach((participant, ordinal) => {
    const preview = card.primaryCredits.find(row => row.id === id(15 + ordinal));
    expect(preview).toMatchObject({ id: id(15 + ordinal), ...participant, key, ordinal,
      displayName: ordinal === 0 ? author.displayName : null });
    if (ordinal === 0) expect(preview).toHaveProperty('nameSource', author.nameSource);
    else expect(preview).not.toHaveProperty('nameSource');
  });
  expect(card.creditCount).toEqual({ value: 3, kind: 'at-least' });
  expect(f.nameReads).toEqual([[key], [key]]);
  expect(card.rating).toBeNull();
  expect(Value.Check(resourceWorkCard, card)).toBe(true);
});

test('withdrawn or changed Source bindings never resurrect a stale credit or exact empty inventory', async () => {
  for (const change of ['withdraw', 'moveBinding', 'sourceFailure', 'withdrawDuringNames'] as const) {
    const f = fixture();
    f[change]();
    const card = (await resourceWorkCards(f.session, [jane])).get(jane)!;
    expect(card.primaryCredits).toEqual([]);
    expect(card.creditCount).toEqual({ value: 0, kind: 'at-least' });
  }
});

test('removed Source names retain the attribution key without a stale name or its name provenance', async () => {
  for (const after of [1, 3]) {
    const f = fixture();
    f.removeName(after);
    const card = (await resourceWorkCards(f.session, [jane])).get(jane)!;
    expect(card.primaryCredits).toHaveLength(1);
    expect(card.primaryCredits[0]).toMatchObject({ id: credit, key, displayName: null });
    expect(card.primaryCredits[0]).not.toHaveProperty('nameSource');
  }
});

test('a Source outage preserves confirmed native credits while current private names stay withheld', async () => {
  for (const hidden of [false, true]) {
    const f = fixture();
    f.sourceFailure();
    f.native([{ work: field(jane), id: field(id(10)), role: field('author'), agent: field(id(11)) }]);
    if (hidden) f.hide();
    const card = (await resourceWorkCards(f.session, [jane])).get(jane)!;
    expect(card.primaryCredits.map(row => row.displayName)).toEqual(hidden ? [] : ['Native author']);
    expect(card.creditCount).toEqual({ value: hidden ? 0 : 1, kind: 'at-least' });
  }
});

test('stale preview recovery cannot swallow the enclosing call, byte or deadline allocation', async () => {
  for (const error of [new WorkReadLimit('rows'), new FusekiReadBudgetExceeded('calls'),
    new FusekiQueryResponseTooLarge('bytes')]) {
    const f = fixture();
    f.nativeFailure(error);
    await expect(resourceWorkCards(f.session, [jane])).rejects.toBe(error);
  }
  const f = fixture();
  f.nativeFailure(new Error('Owner unavailable'));
  f.session.checkDeadline = () => { throw new WorkReadUnavailable('deadline'); };
  await expect(resourceWorkCards(f.session, [jane])).rejects.toThrow('deadline');
});
