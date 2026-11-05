import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { FilterDocument } from '@rezics/filter';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type DiscoveryPersona,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

// One owned native driver for the whole journey: setup is expensive and the driver admits one live instance.
let fixture: ReleasedDiscoveryFixture;
beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1 });
}, 300_000);
afterAll(async () => {
  await fixture?.close();
}, 300_000);

/** Walks every native page one subject at a time; a repeated cursor or an unbounded walk fails. */
async function members(persona: DiscoveryPersona, filter: FilterDocument): Promise<string[]> {
  const found: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 64; page++) {
    const response = await fixture.request(persona, 'POST', '/v1/subjects:search', {
      filter,
      sort: 'id',
      limit: 1,
      ...(cursor === undefined ? {} : { cursor }),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    found.push(...(response.body.subjects as { id: string }[]).map((subject) => subject.id));
    const next = response.body.next as string | null;
    if (next === null) {
      expect(new Set(found).size, `${persona} duplicated a member`).toBe(found.length);
      return found.sort();
    }
    expect(cursors.has(next)).toBe(false);
    cursors.add(next);
    cursor = next;
  }
  throw new Error(`${persona} did not exhaust the filter in 64 one-subject pages`);
}

const ids = (group: Record<string, CreatedSubject>, names: readonly string[]) =>
  names.map((name) => group[name]!.id).sort();

test('released Book and Recipe jobs keep the same public membership for every reader across one-subject pages', async () => {
  const books = await fixture.books();
  const recipes = await fixture.recipes();
  const filters = fixture.filters(await fixture.classification(), await fixture.diet());
  const expected = {
    words: ids(books.subjects, ['B-long']),
    formHarem: ids(books.subjects, ['B-long', 'B-edge', 'B-characters']),
    combined: ids(books.subjects, ['B-long']),
    dietTime: ids(recipes.subjects, ['R-quick', 'R-edge', 'R-cooked', 'R-other-cooked']),
  } as const;
  for (const persona of ['anonymous', 'editor', 'acceptor', 'alice', 'bob', 'outsider'] as const)
    for (const job of Object.keys(expected) as (keyof typeof expected)[])
      expect(await members(persona, filters[job]), `${persona} ${job}`).toEqual(expected[job]);

  // The bearer held from before suspension is rejected on the public search surface, not treated as anonymous.
  const suspended = await fixture.request('suspended', 'POST', '/v1/subjects:search', {
    filter: filters.words,
    sort: 'id',
    limit: 1,
  });
  expect(suspended.status, JSON.stringify(suspended.body)).toBe(401);
  expect(suspended.body).toMatchObject({ code: 'invalid_credentials' });
  expect(suspended.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
}, 300_000);

test('negated released predicates exclude known matches and keep unknown evidence out of the complement', async () => {
  const books = await fixture.books();
  const recipes = await fixture.recipes();
  const c = await fixture.classification();
  const d = await fixture.diet();
  const { meaning } = fixture;
  const notWords: FilterDocument = {
    and: [
      { type: { in: ['schema:Book'] } },
      { not: { statement: { property: meaning.words, range: { gte: 1000001, unit: '1' } } } },
    ],
  };
  const notForm: FilterDocument = {
    and: [{ type: { in: ['schema:Book'] } }, { not: { statement: { property: meaning.form, in: [c.lightNovel.id] } } }],
  };
  const notDiet: FilterDocument = {
    and: [
      { type: { in: ['schema:Recipe'] } },
      { not: { statement: { property: meaning.diet, in: [d.vegetarian.id] } } },
    ],
  };
  const notTime: FilterDocument = {
    and: [
      { type: { in: ['schema:Recipe'] } },
      { not: { statement: { property: meaning.time, range: { lte: 30, unit: meaning.minuteFilter } } } },
    ],
  };
  const cases = [
    // B-unknown, B-characters, B-tag-only and B-form-only have no word count, so they cannot enter the complement.
    [notWords, ids(books.subjects, ['B-edge', 'B-short'])],
    // B-unknown has no form at all; only the explicitly other form is a known complement.
    [notForm, ids(books.subjects, ['B-tag-only'])],
    // R-unknown has no diet; R-meat is the only explicit nonvegetarian control.
    [notDiet, ids(recipes.subjects, ['R-meat'])],
    [notTime, ids(recipes.subjects, ['R-slow'])],
  ] as const;
  for (const persona of ['anonymous', 'alice'] as const)
    for (const [filter, expected] of cases)
      expect(await members(persona, filter), `${persona} ${JSON.stringify(filter)}`).toEqual(expected);
}, 300_000);

test('an adopted contribution joins the same membership and reads back, while an unadopted competitor stays out', async () => {
  const books = await fixture.books();
  const filters = fixture.filters(await fixture.classification(), await fixture.diet());
  const before = ids(books.subjects, ['B-long']);

  const exact = await fixture.createSubject('schema:Book', 'Journey exact one-million-one word contribution');
  const adopted = await fixture.adopt(
    exact,
    discoveryStatement(fixture.meaning.words, { amount: '+1000001', unit: '1' }),
  );
  expect(adopted).toMatchObject({ subject: exact.id, property: fixture.meaning.words });
  await fixture.catchUp([exact]);
  const joined = [...before, exact.id].sort();
  expect(await members('anonymous', filters.words)).toEqual(joined);
  expect(await members('alice', filters.words)).toEqual(joined);

  const read = await fixture.read(exact);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(read.body.subject).toMatchObject({
    statements: {
      [fixture.meaning.words]: [
        expect.objectContaining({ value: { type: 'value', content: { amount: '+1000001', unit: '1' } } }),
      ],
    },
  });

  // A proposal that is never accepted or adopted is a competitor, not membership.
  const pending = await fixture.createSubject('schema:Book', 'Journey unadopted word-count competitor');
  const proposal = await fixture.request(
    'editor',
    'POST',
    `/v1/subjects/${pending.id}/candidates`,
    { statement: discoveryStatement(fixture.meaning.words, { amount: '+1200002', unit: '1' }) },
    discoveryKey(),
  );
  expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
  await fixture.catchUp([pending]);
  expect(await members('anonymous', filters.words)).toEqual(joined);
  const pendingRead = await fixture.read(pending);
  expect(pendingRead.status).toBe(200);
  expect(pendingRead.body.subject).not.toHaveProperty(['statements', fixture.meaning.words]);
}, 300_000);
