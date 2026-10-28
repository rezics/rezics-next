import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { valueSchema, type Release } from '@rezics/definitions';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { runCommand } from '../../src/command/command.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { LINKS_CHANGED } from '../../src/semantic/events.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { readSubjectRelationCounts } from '../../src/semantic/counts.ts';
import { createRealAccess } from './real-access.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const projection = linkProjection(pool);
const accounts = {
  editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001',
  reader: '019a1b2c-3d4e-7f00-8a00-ed170e000002',
};
const access = await createRealAccess(admin, accounts, [
  'definitions:publish',
  'definitions:activate',
  'subject:create',
  'subject:read',
  'moderation:takedown',
]);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(42)]]) };
const kernel = createKernel({
  pool,
  access: access.access,
  tokens,
  routeKey: new Uint8Array(32).fill(43),
  writeRate: access.writeRate,
});
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const relationProperties = {
  'schema:exampleOfWork': 'derivation',
  'schema:character': 'appearance',
  'schema:author': 'credit',
  'ex:sequel': 'order',
} as const;
const relationProperty = (property: string, group?: (typeof relationProperties)[keyof typeof relationProperties]) => ({
  iri: property.startsWith('schema:')
    ? `http://schema.org/${property.slice('schema:'.length)}`
    : `https://example.test/${property.slice(3)}`,
  labels: { en: property },
  mappings: [],
  datatype: 'wikibase-item' as const,
  multivalued: true,
  targets: ['ex:Subject'],
  qualifiers: [],
  value: valueSchema('wikibase-item'),
  ...(group ? { relation: { group, inverse: 'none' } } : {}),
});
const release: Release = {
  format: 'https://rezics.com/definitions/release/1',
  catalogue: { id: 'https://example.test/view-counts', version: randomUUID() },
  generator: { name: 'view-counts-test', version: '1' },
  prefixes: { ex: 'https://example.test/', schema: 'http://schema.org/' },
  types: {
    'ex:Subject': {
      iri: 'https://example.test/Subject',
      labels: { en: 'Subject' },
      mappings: [],
      bases: [],
      properties: [...Object.keys(relationProperties), 'ex:plainLink'].toSorted(),
      facets: [],
    },
  },
  properties: {
    ...Object.fromEntries(
      Object.entries(relationProperties).map(([property, group]) => [property, relationProperty(property, group)]),
    ),
    'ex:plainLink': relationProperty('ex:plainLink'),
  },
};
let growthDatabase: GrowthDatabase | undefined;

afterAll(async () => {
  await growthDatabase?.close();
  await pool.end();
  await admin.end();
});

beforeAll(async () => {
  await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'definitions:publish');
  await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'definitions:activate');
  await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'moderation:takedown');

  const published = await call('POST', '/v1/definitions/releases', {
    token: 'editor',
    key: key(),
    body: { release },
  });
  if (published.response.status !== 201) throw new Error(JSON.stringify(published.body));
  const digest = published.body.digest as string;
  const activated = await call('POST', `/v1/definitions/releases/${digest}:activate`, {
    token: 'editor',
    key: key(),
    body: { expected_head: null },
  });
  expect(activated.response.status).toBe(200);
});

function key(): string {
  return `"${randomUUID()}"`;
}

async function call(
  method: string,
  path: string,
  options: { token?: keyof typeof accounts; key?: string; body?: unknown; session?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${access.bearer(options.token)}`;
  if (options.key) headers['idempotency-key'] = options.key;
  if (options.session) headers[SESSION_HEADER] = options.session;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

const statement = (property: string, target: string) => ({
  property: { id: property },
  value: { type: 'value', content: target },
});

async function create(label: string, statements: Record<string, unknown[]> = {}) {
  const result = await call('POST', '/v1/subjects', {
    token: 'editor',
    key: key(),
    body: { type: 'ex:Subject', labels: { en: label }, statements },
  });
  expect(result.response.status).toBe(201);
  return result;
}

async function catchUpLinks(ids: readonly string[]): Promise<void> {
  for (const partition of new Set(ids.map((id) => partitionOf(routeOf(id)!)))) {
    let caughtUp = false;
    for (let step = 0; step < 200; step++) {
      const result = await projection.run(partition);
      if (result.status === 'busy') {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      if (result.envelopes === 0) {
        caughtUp = true;
        break;
      }
    }
    if (!caughtUp) throw new Error('Semantic link projection did not catch up');
  }
}

async function countRead(id: string, session?: string) {
  return call('GET', `/v1/subjects/${id}/counts`, { token: 'reader', ...(session ? { session } : {}) });
}

test('one view-count read omits unproved public aggregates while its stored counters remain exact', async () => {
  const previous = (await create('Previous work')).body.subject.id as string;
  const characterOne = (await create('Character one')).body.subject.id as string;
  const characterTwo = (await create('Character two')).body.subject.id as string;
  const author = (await create('Author')).body.subject.id as string;
  const sequel = (await create('Sequel')).body.subject.id as string;
  await create('Incoming character');
  await create('Incoming author');
  await create('Incoming sequel');
  await create('Plain link');

  const workCreate = await create('Work', {
    'schema:exampleOfWork': [statement('schema:exampleOfWork', previous)],
    'schema:character': [statement('schema:character', characterOne), statement('schema:character', characterTwo)],
    'schema:author': [statement('schema:author', author)],
    'ex:sequel': [statement('ex:sequel', sequel)],
  });
  const work = workCreate.body.subject.id as string;
  const editionOne = await create('Edition one', {
    'schema:exampleOfWork': [statement('schema:exampleOfWork', work)],
  });
  const editionTwo = await create('Edition two', {
    'schema:exampleOfWork': [statement('schema:exampleOfWork', work)],
  });
  const incomingCharacterCreate = await create('Incoming character relation', {
    'schema:character': [statement('schema:character', work)],
  });
  const incomingAuthorCreate = await create('Incoming author relation', {
    'schema:author': [statement('schema:author', work)],
  });
  const incomingSequelCreate = await create('Incoming sequel relation', {
    'ex:sequel': [statement('ex:sequel', work)],
  });
  const plainLinkCreate = await create('Plain item link relation', {
    'ex:plainLink': [statement('ex:plainLink', work)],
  });

  await catchUpLinks([
    work,
    editionOne.body.subject.id,
    editionTwo.body.subject.id,
    incomingCharacterCreate.body.subject.id,
    incomingAuthorCreate.body.subject.id,
    incomingSequelCreate.body.subject.id,
    plainLinkCreate.body.subject.id,
  ]);
  const workRoute = routeOf(work)!;
  await access.grant({ route: workRoute, id: work }, 'reader', 'subject:read');

  const expectedStored = {
    properties: {
      'schema:exampleOfWork': { out: 1, in: 2 },
      'schema:character': { out: 2, in: 1 },
      'schema:author': { out: 1, in: 1 },
      'ex:sequel': { out: 1, in: 1 },
    },
    groups: {
      derivation: { out: 1, in: 2 },
      appearance: { out: 2, in: 1 },
      credit: { out: 1, in: 1 },
      order: { out: 1, in: 1 },
    },
    content: null,
  };
  access.readChecks.length = 0;
  const result = await countRead(work, workCreate.response.headers.get(SESSION_HEADER) ?? undefined);
  expect(result.response.status).toBe(200);
  expect(result.body).toEqual({ content: null });
  const stored = await readSubjectRelationCounts(pool, { subject: work, release, authorize: async () => true });
  expect(stored.counts).toEqual(expectedStored);
  expect(access.readChecks).toEqual([
    { persona: 'reader', action: 'subject:read', resource: { route: workRoute, id: work } },
  ]);
  expect(openApiDocument(kernel).paths['/v1/subjects/{id}/counts']!.get).toMatchObject({
    operationId: 'subject.counts',
    'x-action': 'subject:read',
    security: [{ bearerAuth: [] }, {}],
  });

  const added = await create('Edition added later', {
    'schema:exampleOfWork': [statement('schema:exampleOfWork', work)],
  });
  const addedId = added.body.subject.id as string;
  const addedStatement = added.body.subject.statements['schema:exampleOfWork'][0].id as string;
  await catchUpLinks([addedId]);
  const afterAdd = await countRead(work, workCreate.response.headers.get(SESSION_HEADER) ?? undefined);
  expect(afterAdd.body).toEqual({ content: null });
  const storedAfterAdd = await readSubjectRelationCounts(pool, { subject: work, release, authorize: async () => true });
  expect(storedAfterAdd.counts.properties['schema:exampleOfWork']).toEqual({ out: 1, in: 3 });
  expect(storedAfterAdd.counts.groups.derivation).toEqual({ out: 1, in: 3 });

  const addedRoute = routeOf(addedId)!;
  const { rows } = await admin.query<{ slot_id: string; source_order_key: string }>(
    `SELECT slot_id, source_order_key FROM semantic.outbound_link
     WHERE route = $1 AND subject_id = $2 AND property = $3 AND filter_value = $4
       AND statement_id = $5 AND present`,
    [addedRoute, addedId, 'schema:exampleOfWork', NIL_UUID, addedStatement],
  );
  expect(rows).toHaveLength(1);
  const countered = await runCommand(pool, { partition: partitionOf(addedRoute) }, async () => ({
    value: null,
    events: [
      {
        type: LINKS_CHANGED,
        subject: addedId,
        data: {
          subject: addedId,
          revision: 2,
          security_revision: 0,
          changes: [
            {
              property: 'schema:exampleOfWork',
              statement: addedStatement,
              target: work,
              present: false,
              project_outbound: true,
              relation: true,
              slot_id: rows[0]!.slot_id,
              external: null,
              value: 'value',
              outbound_order: null,
              outbound_order_key: '',
              source_type: 'ex:Subject',
              order_key: rows[0]!.source_order_key,
              filter_value: NIL_UUID,
            },
          ],
        },
      },
    ],
  }));
  expect(countered.replayed).toBe(false);
  await catchUpLinks([addedId]);
  const afterRetract = await countRead(work, workCreate.response.headers.get(SESSION_HEADER) ?? undefined);
  expect(afterRetract.body).toEqual({ content: null });
  const storedAfterRetract = await readSubjectRelationCounts(pool, {
    subject: work,
    release,
    authorize: async () => true,
  });
  expect(storedAfterRetract.counts).toEqual(expectedStored);

  const hiddenSource = incomingCharacterCreate.body.subject.id as string;
  const hidden = await call('POST', `/v1/subjects/${hiddenSource}:takedown`, {
    token: 'editor',
    key: key(),
    body: { notice: { complaint: 'Withhold this source.', received_at: '2026-10-28T00:00:00Z' } },
  });
  expect(hidden.response.status).toBe(200);
  const afterTakedown = await countRead(work, workCreate.response.headers.get(SESSION_HEADER) ?? undefined);
  expect(afterTakedown.response.status).toBe(200);
  expect(afterTakedown.body).toEqual({ content: null });
  expect(
    (await readSubjectRelationCounts(pool, { subject: work, release, authorize: async () => true })).counts,
  ).toEqual(expectedStored);

  await access.grant({ route: addedRoute, id: addedId }, 'reader', 'subject:read');
  const addedSubject = await countRead(addedId);
  expect(addedSubject.body).toEqual({ content: null });
});

test("the view-count read costs the same whatever the subject's relation count", async () => {
  growthDatabase = await openGrowthDatabase(databaseUrl);
  const anchor = (await create('Growth anchor')).body.subject.id as string;
  const route = routeOf(anchor)!;
  const properties = Object.keys(relationProperties);
  const bounds = { rows: 'constant', blocks: 'constant', statements: 'constant' } as const;

  const report = await checkGrowth(growthDatabase, {
    name: 'View-count read',
    scales: [64, 512, 4096],
    warmups: 1,
    bounds,
    grow: async (_db: GrowthDatabase, scale: number, previous: number) => {
      await growthDatabase!.admin.query(
        `WITH relation_rows AS (
           SELECT n,
             CASE n % 4
               WHEN 0 THEN 'schema:exampleOfWork'
               WHEN 1 THEN 'schema:character'
               WHEN 2 THEN 'schema:author'
               ELSE 'ex:sequel'
             END AS property,
             md5('filter-' || n::text)::uuid AS filter_value,
             md5('source-' || n::text)::uuid AS source_id,
             md5('target-' || n::text)::uuid AS target_id,
             md5('statement-' || n::text)::uuid AS statement_id,
             md5('slot-' || n::text)::uuid AS slot_id
           FROM generate_series($3::int, $4::int) n
         )
         INSERT INTO semantic.inbound_link(
           route, subject_id, property, source_subject_id, statement_id, source_revision,
           present, recorded_transaction_id, source_type, order_key, filter_value
         )
         SELECT $1, $2, property, source_id, statement_id, 1, true, gen_random_uuid(), 'ex:Subject', '', filter_value
         FROM relation_rows`,
        [route, anchor, previous + 1, scale],
      );
      await growthDatabase!.admin.query(
        `WITH relation_rows AS (
           SELECT n,
             CASE n % 4
               WHEN 0 THEN 'schema:exampleOfWork'
               WHEN 1 THEN 'schema:character'
               WHEN 2 THEN 'schema:author'
               ELSE 'ex:sequel'
             END AS property,
             md5('filter-' || n::text)::uuid AS filter_value,
             md5('target-' || n::text)::uuid AS target_id,
             md5('statement-' || n::text)::uuid AS statement_id,
             md5('slot-' || n::text)::uuid AS slot_id
           FROM generate_series($3::int, $4::int) n
         )
         INSERT INTO semantic.outbound_link(
           route, subject_id, property, filter_value, order_key, target_subject_id, statement_id, slot_id,
           relation, source_type, source_order_key, outbound_order, source_revision, source_security_revision,
           target_revision, target_type, external, value, present, recorded_transaction_id
         )
         SELECT $1, $2, property, filter_value, '', target_id, statement_id, slot_id,
           true, 'ex:Subject', '', NULL, 1, 0, 0, 'ex:Subject', NULL, 'value', true, gen_random_uuid()
         FROM relation_rows`,
        [route, anchor, previous + 1, scale],
      );
      for (const table of ['inbound_link_count', 'outbound_link_count'] as const) {
        await growthDatabase!.admin.query(
          `WITH relation_rows AS (
             SELECT n,
               CASE n % 4
                 WHEN 0 THEN 'schema:exampleOfWork'
                 WHEN 1 THEN 'schema:character'
                 WHEN 2 THEN 'schema:author'
                 ELSE 'ex:sequel'
               END AS property,
               md5('filter-' || n::text)::uuid AS filter_value
             FROM generate_series($3::int, $4::int) n
           ), grouped AS (
             SELECT property, count(*) AS value FROM relation_rows GROUP BY property
           )
           INSERT INTO semantic.${table}(route, subject_id, property, filter_value, value)
           SELECT $1, $2, property, $5::uuid, value FROM grouped
           ON CONFLICT (route, subject_id, property, filter_value)
           DO UPDATE SET value = semantic.${table}.value + EXCLUDED.value`,
          [route, anchor, previous + 1, scale, NIL_UUID],
        );
        await growthDatabase!.admin.query(
          `WITH relation_rows AS (
             SELECT n,
               CASE n % 4
                 WHEN 0 THEN 'schema:exampleOfWork'
                 WHEN 1 THEN 'schema:character'
                 WHEN 2 THEN 'schema:author'
                 ELSE 'ex:sequel'
               END AS property,
               md5('filter-' || n::text)::uuid AS filter_value
             FROM generate_series($3::int, $4::int) n
           )
           INSERT INTO semantic.${table}(route, subject_id, property, filter_value, value)
           SELECT $1, $2, property, filter_value, 1 FROM relation_rows
           ON CONFLICT (route, subject_id, property, filter_value) DO NOTHING`,
          [route, anchor, previous + 1, scale],
        );
      }
    },
    operation: async () => {
      const result = await readSubjectRelationCounts(growthDatabase!.pool, {
        subject: anchor,
        release,
        authorize: async () => true,
      });
      const totalOut = Object.values(result.counts.properties).reduce((sum, count) => sum + (count.out ?? 0), 0);
      const totalIn = Object.values(result.counts.properties).reduce((sum, count) => sum + (count.in ?? 0), 0);
      expect(totalOut).toBeGreaterThan(0);
      expect(totalIn).toBe(totalOut);
      expect(Object.keys(result.counts.properties).toSorted()).toEqual(properties.toSorted());
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
}, 60_000);
