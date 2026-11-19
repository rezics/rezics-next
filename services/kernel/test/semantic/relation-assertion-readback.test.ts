import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import type { Subject } from '../../../../specs/semantic-driver.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection, listSubjectLinks } from '../../src/semantic/links.ts';
import { fixtureFetch } from '../imports/type-helpers.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from './outcome-driver.ts';

type Account = Awaited<ReturnType<SemanticOutcomeDriver['fixtures']['person']>>;
let driver: SemanticOutcomeDriver;
let owner: Account;
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) };

beforeAll(async () => {
  driver = await createSemanticDriver(undefined, { linkProjection: 'external' });
  owner = await driver.fixtures.person('relation_assertion_owner');
  await driver.fixtures.grantAccount(owner, ['subject:create']);
}, 180_000);
afterAll(async () => {
  await driver?.close();
});

async function create(type: string, label: string, statements: Record<string, unknown[]> = {}) {
  const response = await driver.fixtures.send(
    owner,
    'POST',
    '/v1/subjects',
    { type, labels: { en: label, ja: `日本語 ${label}` }, statements },
    { 'Idempotency-Key': `"${randomUUID()}"` },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.subject as Subject;
}

async function catchUp(ids: readonly string[]) {
  const projection = linkProjection(driver.fixtures.pool);
  const partitions = new Set(
    ids.map((id) => partitionOf(routeOf(id)!)).filter((partition): partition is number => partition !== null),
  );
  for (const partition of partitions) {
    for (let step = 0; step < 200; step++) {
      const result = await projection.run(partition);
      if (result.status !== 'busy' && result.envelopes === 0) break;
      if (step === 199) throw new Error('Semantic link projection did not catch up');
    }
  }
}

function requestAsReader(url: string) {
  return driver.fixtures.handle(
    new Request(url, {
      headers: {
        'accept-language': 'ja, en;q=0.5',
      },
    }),
  );
}

async function request(path: string) {
  const response = await requestAsReader(`https://kernel.test${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const snak = (property: string, content: string) => ({
  property: { id: property },
  value: { type: 'value', content },
});

test('the adopted Bangumi occupation is publicly readable by its native candidate and cited career', async () => {
  const artist = await create('skos:Concept', 'Artist');
  const person = await create('schema:Person', '悠木真一');
  const statement = {
    ...snak('wdt:P106', artist.id),
    references: [
      {
        parts: [
          snak('schema:url', 'https://api.bgm.tv/v0/persons/10760#/career'),
          snak('schema:version', 'unversioned'),
        ],
      },
    ],
  };
  const key = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });
  const path = `/v1/subjects/${person.id}`;
  const proposed = await driver.request('editor', 'POST', `${path}/candidates`, { statement }, key());
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const candidate = proposed.body.candidate as string;
  const context = { context: GLOBAL_CONTEXT, expected_head: null };
  const accepted = await driver.request('acceptor', 'POST', `${path}/candidates/${candidate}:accept`, context, key());
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const adopted = await driver.request(
    'acceptor',
    'POST',
    `${path}:adopt`,
    {
      ...context,
      property: 'wdt:P106',
      target: artist.id,
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
    },
    key(),
  );
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
  await catchUp([person.id, artist.id]);
  const client = createPublicBulkClient({
    origin: 'https://kernel.test',
    fetch: fixtureFetch((input) => requestAsReader(String(input))),
  });
  const expected = { id: candidate, rank: 'normal', ...statement };
  expect((await client.readSubject(person.id)).subject.statements['wdt:P106']).toMatchObject([expected]);
  expect(await client.readSubjectRelations!(person.id, 'wdt:P106')).toMatchObject({
    statements: [expected],
    next: null,
  });
});

test('unqualified Book series windows retain the exact cited assertion and item citation labels in both directions', async () => {
  const series = await create('schema:BookSeries', 'Series');
  const citation = await create('schema:Person', 'Citation source');
  const book = await create('schema:Book', 'Series member', {
    'wdt:P179': [
      {
        property: { id: 'wdt:P179' },
        value: { type: 'value', content: series.id },
        references: [{ parts: [snak('schema:author', citation.id)] }],
      },
    ],
  });
  await catchUp([book.id, series.id, citation.id]);

  const expected = book.statements['wdt:P179']?.[0];
  if (!expected) throw new Error('Created Book does not contain its released wdt:P179 statement');
  expect(expected.qualifiers).toEqual([]);
  expect(expected.value).toEqual({ type: 'value', content: series.id });
  expect(expected.references).toHaveLength(1);
  expect(expected.references[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(expected.references[0]!.parts[0]!.value).toEqual({ type: 'value', content: citation.id });

  const inverse = await request(`/v1/subjects/${series.id}/links?property=wdt%3AP179`);
  expect(inverse.status).toBe(200);
  expect(inverse.body.links).toHaveLength(1);
  const inverseRow = inverse.body.links[0];
  expect(inverseRow).toMatchObject({
    subject: book.id,
    property: 'wdt:P179',
    statement: expected.id,
    assertion: expected,
  });
  expect(Object.keys(inverseRow.related).sort()).toEqual([series.id, citation.id].sort());
  expect(inverseRow.related[citation.id].label).toEqual({ value: '日本語 Citation source', language: 'ja' });
  expect(inverseRow.related[series.id].label).toEqual({ value: '日本語 Series', language: 'ja' });

  const forward = await request(`/v1/subjects/${book.id}/relations?property=wdt%3AP179`);
  expect(forward.status).toBe(200);
  expect(forward.body.relations).toHaveLength(1);
  const forwardRow = forward.body.relations[0];
  expect(forwardRow).toMatchObject({ target: series.id, statement: expected });
  expect(Object.keys(forwardRow.related).sort()).toEqual([series.id, citation.id].sort());
  expect(forwardRow.related[citation.id].label).toEqual({ value: '日本語 Citation source', language: 'ja' });
  expect(forwardRow.summary.label).toEqual({ value: '日本語 Series', language: 'ja' });
  const client = createPublicBulkClient({
    origin: 'https://kernel.test',
    fetch: fixtureFetch((input) => requestAsReader(String(input))),
  });
  expect(await client.readSubjectRelations!(book.id, 'wdt:P179')).toEqual({
    statements: [expected],
    next: null,
  });

  const crossProperty = await listSubjectLinks(driver.fixtures.pool, tokens, {
    routeKey: Buffer.from(driver.fixtures.runtime.routeKey, 'base64url'),
    subject: series.id,
    property: null,
    limit: 20,
    release: bundledRelease,
    authorize: async () => true,
    authorizeSummary: async () => true,
    seen: [],
    caughtUp: true,
  });
  expect(crossProperty.links[0]).not.toHaveProperty('assertion');
  expect(crossProperty.links[0]).not.toHaveProperty('related');

  const withoutLabels = await listSubjectLinks(driver.fixtures.pool, tokens, {
    routeKey: Buffer.from(driver.fixtures.runtime.routeKey, 'base64url'),
    subject: series.id,
    property: 'wdt:P179',
    limit: 20,
    includeLabels: false,
    release: bundledRelease,
    authorize: async () => true,
    authorizeSummary: async () => true,
    seen: [],
    caughtUp: true,
  });
  expect(withoutLabels.links).toEqual([{ subject: book.id, property: 'wdt:P179', statement: expected.id }]);
});
