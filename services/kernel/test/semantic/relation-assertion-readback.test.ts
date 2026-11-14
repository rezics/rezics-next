import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { accessCheck, actorOf, type AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection, listSubjectLinks } from '../../src/semantic/links.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 3 });
const accounts = { owner: newId(65_536), reader: newId(65_536) };
const actions = ['subject:create', 'subject:read'];
const real = await createRealAccess(admin, accounts, actions);
const access = real.access({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
const routeKey = new Uint8Array(32).fill(81);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) };
const kernel = createKernel({ pool, routeKey, tokens, access: real.access, writeRate: real.writeRate });
const projection = linkProjection(pool);

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'subject:create');
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function actor(persona: keyof typeof accounts): Promise<AccountActor> {
  return (await actorOf(
    access,
    new Request('https://kernel.test', { headers: { authorization: `Bearer ${real.bearer(persona)}` } }),
    { pool, deadline: Date.now() + DEFAULT_REQUEST_DEADLINE_MS },
  )) as AccountActor;
}

async function create(type: string, label: string, statements: Record<string, unknown[]> = {}) {
  const owner = await actor('owner');
  const route = randomInt(1_000, 4_000) * 16;
  const id = newId(route);
  const authorize = await accessCheck(
    access,
    owner,
    'subject:create',
    { route: 0, id: GLOBAL_CONTEXT },
    { pool, deadline: Date.now() + DEFAULT_REQUEST_DEADLINE_MS },
  );
  const result = await createSubject(pool, {
    actor: owner,
    target: { route, id },
    idempotencyKey: randomUUID(),
    digest: createHash('sha256').update(id).digest(),
    release: { digest: bundledDigest, release: bundledRelease },
    authorize,
    item: {
      type,
      labels: { en: label, ja: `日本語 ${label}` },
      statements,
    },
  });
  await real.grant({ route, id }, 'reader', 'subject:read');
  return result.subject;
}

async function catchUp(ids: readonly string[]) {
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

async function request(path: string) {
  const response = await kernel.handle(
    new Request(`https://kernel.test${path}`, {
      headers: {
        authorization: `Bearer ${real.bearer('reader')}`,
        'accept-language': 'ja, en;q=0.5',
      },
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const snak = (property: string, content: string) => ({
  property: { id: property },
  value: { type: 'value', content },
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

  const crossProperty = await listSubjectLinks(pool, tokens, {
    routeKey,
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

  const withoutLabels = await listSubjectLinks(pool, tokens, {
    routeKey,
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
