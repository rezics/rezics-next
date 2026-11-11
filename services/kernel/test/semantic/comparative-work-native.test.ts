import { afterAll, expect, test } from 'bun:test';
import { compileCurrentFilter } from '../../src/search/current-filter-plan.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';
import type { HttpResponse, Subject } from '../../../../specs/semantic-driver.ts';

const comparison = 'rezics:stylisticallyComparableTo';
const inverse = (target: string) =>
  `/v1/subjects/${target}/links?${new URLSearchParams({ property: comparison, limit: '10' })}`;
const forward = (source: string) =>
  `/v1/subjects/${source}/relations?${new URLSearchParams({ property: comparison, limit: '10' })}`;

let fixture: ReleasedDiscoveryFixture | undefined;

afterAll(async () => {
  await fixture?.close();
});

function status(response: HttpResponse, expected: number): HttpResponse['body'] {
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  return response.body;
}

function currentSubject(response: HttpResponse): Subject {
  return status(response, 200).subject as Subject;
}

function statements(subject: Subject, property: string) {
  return subject.statements[property] ?? [];
}

async function currentSearch(
  target: ReleasedDiscoveryFixture,
  filter: unknown,
  expected: readonly string[],
): Promise<string[]> {
  const deadline = Date.now() + 60_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const response = await target.request('anonymous', 'POST', '/v1/subjects:search', {
      representation: 'discovery-v1',
      filter,
      sort: 'id',
      limit: 20,
    });
    if (response.status === 200) {
      const ids = (response.body.subjects as { id: string }[]).map(({ id }) => id).sort();
      last = ids;
      if (JSON.stringify(ids) === JSON.stringify([...expected].sort())) return ids;
    } else {
      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(['index_not_ready', 'semantic_not_ready']).toContain(response.body.code as string);
      expect(response.headers.get('retry-after')).toBeTruthy();
      last = response.body;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Native comparative Work filter did not converge: ${JSON.stringify(last)}`);
}

async function lifecycleAndPages(): Promise<void> {
  const api = await createReleasedDiscoveryFixture({ version: 1 });
  fixture = api;
  const title = 'The Work With the Same Name';
  const source = await api.createSubject('schema:Book', title);
  const game = await api.createSubject('wd:Q689445', title);
  const sameNameBook = await api.createSubject('schema:Book', title);
  expect(new Set([source.id, game.id, sameNameBook.id]).size).toBe(3);

  const proposal = await api.request(
    'editor',
    'POST',
    `/v1/subjects/${source.id}/candidates`,
    { statement: discoveryStatement(comparison, game.id) },
    discoveryKey(),
  );
  const proposed = status(proposal, 201);
  const candidate = proposed.candidate as string;
  await api.catchUp([source, game, sameNameBook]);

  expect(statements(currentSubject(await api.read(source)), comparison)).toEqual([]);
  expect(status(await api.request('anonymous', 'GET', forward(source.id)), 200).relations as unknown[]).toEqual([]);
  expect(status(await api.request('anonymous', 'GET', inverse(game.id)), 200).links as unknown[]).toEqual([]);

  const accepted = await api.request(
    'acceptor',
    'POST',
    `/v1/subjects/${source.id}/candidates/${candidate}:accept`,
    { context: '00000000-0000-8000-8000-000000000000', expected_head: null },
    discoveryKey(),
  );
  expect(status(accepted, 200).acceptance).toMatchObject({ candidate, decision: 'accept' });
  expect(statements(currentSubject(await api.read(source)), comparison)).toEqual([]);

  const adopted = await api.request(
    'acceptor',
    'POST',
    `/v1/subjects/${source.id}:adopt`,
    {
      context: '00000000-0000-8000-8000-000000000000',
      property: comparison,
      target: game.id,
      mode: 'replace',
      selection: [{ candidate, rank: 'preferred' }],
      expected_head: null,
    },
    discoveryKey(),
  );
  expect(status(adopted, 200).adoption).toMatchObject({ property: comparison, mode: 'replace' });
  await api.catchUp([source, game, sameNameBook]);

  const direct = status(await api.request('anonymous', 'GET', forward(source.id)), 200).relations as {
    target: string;
    statement: { id: string; references: { parts: { value: { content: unknown } }[] }[] };
  }[];
  expect(direct.map(({ target }) => target)).toEqual([game.id]);
  expect(direct[0]!.statement.id).toBe(candidate);
  expect(direct[0]!.statement.references[0]!.parts[0]!.value.content).toBe(
    'https://example.org/released-discovery/v1/controlled-assertions',
  );
  const reverse = status(await api.request('anonymous', 'GET', inverse(game.id)), 200).links as {
    subject: string;
    statement: string;
  }[];
  expect(reverse.map(({ subject, statement }) => [subject, statement])).toEqual([[source.id, candidate]]);
  expect(status(await api.request('anonymous', 'GET', inverse(sameNameBook.id)), 200).links as unknown[]).toEqual([]);

  for (const persona of ['anonymous', 'editor', 'acceptor'] as const) {
    const subject = currentSubject(await api.read(source, persona));
    expect(subject.type).toBe('schema:Book');
    expect(statements(subject, comparison).map(({ value }) => value.content)).toEqual([game.id]);
  }
  const suspended = await api.read(source, 'suspended');
  expect(suspended.status).toBe(401);
  expect(suspended.body.code).toBe('invalid_credentials');

  await api.grant('editor', ['moderation:hide'], '00000000-0000-8000-8000-000000000000');
  const hidden = await api.request(
    'editor',
    'POST',
    `/v1/subjects/${game.id}:hide`,
    { reason: 'Comparative Work target disclosure control' },
    discoveryKey(),
  );
  expect(status(hidden, 200)).toMatchObject({ subject: game.id, visibility: 'hidden' });
  await api.catchUp([source, game]);
  expect(status(await api.request('anonymous', 'GET', forward(source.id)), 200).relations as unknown[]).toEqual([]);

  const retained = await api.inspect(
    `SELECT body FROM semantic.fact
     WHERE subject_id = $1 AND statement_id = $2 AND kind = 'statement' AND operation = 'assert'
     ORDER BY log_seq DESC LIMIT 1`,
    [source.id, candidate],
  );
  expect(retained.rows).toHaveLength(1);
  const body = retained.rows[0]!.body as {
    value: { content: string };
    references: { parts: { value: { content: string } }[] }[];
  };
  expect(body.value.content).toBe(game.id);
  expect(body.references[0]!.parts[0]!.value.content).toBe(
    'https://example.org/released-discovery/v1/controlled-assertions',
  );

  const withheldNegation = compileCurrentFilter({
    not: { statement: { property: comparison, in: [game.id] } },
  });
  expect(withheldNegation.evaluate(['not_proven'])).toBe('not_proven');
  await api.close();
  fixture = undefined;
}

async function sharedSearchFilter(): Promise<void> {
  const search = await createReleasedDiscoveryFixture({ version: 1, search: 'native' });
  fixture = search;
  expect(search.search).toBeDefined();
  await search.setup.openFeatures(['search', 'search_advanced']);

  const title = `ComparativeFilter${crypto.randomUUID().replaceAll('-', '')}`;
  const game = await search.createSubject('wd:Q689445', `${title} comparable game`);
  const comparisonBook = await search.createSubject('schema:Book', `${title} comparison`);
  const keywordBook = await search.createSubject('schema:Book', `${title} keyword`);
  const genreBook = await search.createSubject('schema:Book', `${title} excluded genre`);
  const keyword = await search.createSubject('skos:Concept', `${title} keyword Concept`);
  const genre = await search.createSubject('skos:Concept', `${title} genre Concept`);

  await search.adopt(comparisonBook, discoveryStatement(comparison, game.id));
  await search.adopt(keywordBook, discoveryStatement('schema:keywords', keyword.id));
  await search.adopt(genreBook, discoveryStatement('schema:genre', genre.id));
  const filter = {
    and: [
      { type: { in: ['schema:Book'] } },
      {
        or: [
          { statement: { property: comparison, in: [game.id] } },
          { statement: { property: 'schema:keywords', in: [keyword.id] } },
        ],
      },
      { not: { statement: { property: 'schema:genre', in: [genre.id] } } },
    ],
  } as const;
  const plan = compileCurrentFilter(filter);
  expect(plan.leaves).toHaveLength(4);
  await search.catchUp([game, comparisonBook, keywordBook, genreBook, keyword, genre]);

  const expected = [comparisonBook.id, keywordBook.id].sort();
  expect(await currentSearch(search, filter, expected)).toEqual(expected);
  const editor = status(
    await search.request('editor', 'POST', '/v1/subjects:search', {
      representation: 'discovery-v1',
      filter,
      sort: 'id',
      limit: 20,
    }),
    200,
  );
  expect((editor.subjects as { id: string }[]).map(({ id }) => id).sort()).toEqual(expected);
  const suspended = await search.request('suspended', 'POST', '/v1/subjects:search', {
    representation: 'discovery-v1',
    filter,
    sort: 'id',
    limit: 20,
  });
  expect(suspended.status).toBe(401);
  expect(suspended.body.code).toBe('invalid_credentials');
  await search.close();
  fixture = undefined;
}

test('comparative Works use sourced adoption, inverse pages and the shared typed filter', async () => {
  await lifecycleAndPages();
  await sharedSearchFilter();
}, 240_000);
