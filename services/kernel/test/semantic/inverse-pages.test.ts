import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { valueSchema, type Release } from '@rezics/definitions';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createRealAccess } from './real-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const access = await createRealAccess(admin, { editor: newId(32000) }, [
  'definitions:publish',
  'definitions:activate',
  'subject:create',
  'subject:read',
]);
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) };
const kernel = createKernel({
  pool,
  access: access.access,
  writeRate: createWriteRateLimiter({
    secret: 'inverse-pages-test-secret-with-32-bytes',
    overrides: JSON.stringify({ 'new-account': { write: { maximum: 1000, seconds: 60 } } }),
  }),
  tokens: ring,
  routeKey: new Uint8Array(32).fill(81),
});
const projection = linkProjection(pool);
const holders = new Set<string>();
const property = (datatype: 'wikibase-item' | 'quantity' | 'time', extra = {}) => ({
  iri: 'https://example.test/property',
  labels: { en: 'Property' },
  mappings: [],
  datatype,
  multivalued: true,
  qualifiers: [],
  value: valueSchema(datatype, datatype === 'quantity' ? { units: ['1'], integer: true } : {}),
  ...extra,
});
const release: Release = {
  format: 'https://rezics.com/definitions/release/1',
  catalogue: { id: 'https://example.test/inverse', version: '1' },
  generator: { name: 'test', version: '1' },
  prefixes: { ex: 'https://example.test/', schema: 'http://schema.org/' },
  types: Object.fromEntries(
    ['Work', 'Novel', 'Person'].map((name) => [
      `ex:${name}`,
      {
        iri: `https://example.test/${name}`,
        labels: { en: name },
        mappings: [],
        bases: name === 'Novel' ? ['ex:Work'] : [],
        facets: [],
        properties: ['ex:date', 'ex:name', 'ex:position', 'schema:datePublished'],
      },
    ]),
  ),
  properties: {
    ...Object.fromEntries(
      ['position', 'date', 'name'].map((order) => [
        `ex:${order}`,
        property('wikibase-item', {
          iri: `https://example.test/${order}`,
          targets: ['ex:Person'],
          qualifiers: ['ex:role', 'schema:position'],
          relation: { group: 'association', inverse: 'none', order, filter: 'ex:role' },
        }),
      ]),
    ),
    'ex:role': property('wikibase-item', { iri: 'https://example.test/role', targets: ['ex:Person'] }),
    'schema:position': property('quantity', { iri: 'http://schema.org/position', units: ['1'] }),
    'schema:datePublished': property('time', { iri: 'http://schema.org/datePublished' }),
  },
};
async function call(method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${access.bearer('editor')}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': `"${randomUUID()}"` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const result = (await response.json()) as any;
  if (response.status !== 200 && response.status !== 201)
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value', content } });
const statement = (id: string, content: unknown, qualifiers: unknown[] = []) => ({
  ...snak(id, content),
  qualifiers,
  references: [],
});
async function create(label: string, statements = {}, type = 'ex:Work') {
  const result = await call('POST', '/v1/subjects', {
    type,
    labels: { en: label, ja: `${label} Japanese` },
    statements,
  });
  holders.add(result.subject.id);
  return result.subject.id as string;
}
async function catchUp() {
  for (const partition of new Set([...holders].map((id) => routeOf(id)! >>> 4))) {
    for (;;) {
      const result = await projection.run(partition);
      if (result.status !== 'read' || result.envelopes === 0) break;
    }
  }
}
async function page(anchor: string, property: string, query = '') {
  return call('GET', `/v1/subjects/${anchor}/links?property=${encodeURIComponent(property)}${query}`);
}
let anchor: string;
let roleA: string;
let roleB: string;
beforeAll(async () => {
  for (const action of ['definitions:publish', 'definitions:activate', 'subject:create'])
    await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'gate:definition_publication');
  const published = await call('POST', '/v1/definitions/releases', { release });
  await call('POST', `/v1/definitions/releases/${published.digest}:activate`, { expected_head: null });
  anchor = await create('Anchor', {}, 'ex:Person');
  roleA = await create('Role A', {}, 'ex:Person');
  roleB = await create('Role B', {}, 'ex:Person');
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

test("an inverse page is ordered by the property's declared key and continues where it stopped", async () => {
  for (const order of ['position', 'date', 'name']) {
    const target = await create(`Anchor ${order}`, {}, 'ex:Person');
    const ids: string[] = [];
    for (const [index, label] of ['Zulu', 'alpha', 'ALPHA', 'Missing'].entries()) {
      const facts: Record<string, unknown> = {
        [`ex:${order}`]: [
          statement(
            `ex:${order}`,
            target,
            index === 3 ? [] : [snak('schema:position', { amount: index === 0 ? '+10' : '+2', unit: '1' })],
          ),
        ],
      };
      if (index !== 3)
        facts['schema:datePublished'] = [
          statement('schema:datePublished', {
            time: index === 0 ? '+2020-01-01T00:00:00Z' : '+2000-01-01T00:00:00Z',
            precision: 11,
            calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
          }),
        ];
      ids.push(await create(label, facts));
    }
    await catchUp();
    const tied = [ids[1]!, ids[2]!].sort();
    const expected = order === 'name' ? [...tied, ids[3]!, ids[0]!] : [...tied, ids[0]!, ids[3]!];
    const found: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await page(target, `ex:${order}`, `&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(result).not.toHaveProperty('count');
      expect(result.links[0].type).toBe('ex:Work');
      expect(typeof result.links[0].label).toBe('string');
      found.push(...result.links.map((link: any) => link.subject));
      cursor = result.next;
    } while (cursor);
    expect(found).toEqual(expected);
  }
});

test('an inverse page filters by the declared qualifier and by holder type', async () => {
  const target = await create('Filtered anchor', {}, 'ex:Person');
  const first = await create(
    'A',
    { 'ex:name': [statement('ex:name', target, [snak('ex:role', roleA), snak('ex:role', roleB)])] },
    'ex:Novel',
  );
  await create('B', { 'ex:name': [statement('ex:name', target, [snak('ex:role', roleB)])] });
  for (let i = 0; i < 12; i++) await create(`C${i}`, { 'ex:name': [statement('ex:name', target)] }, 'ex:Person');
  const last = await create('Z', { 'ex:name': [statement('ex:name', target)] }, 'ex:Novel');
  await catchUp();
  expect(await page(target, 'ex:name')).not.toHaveProperty('count');
  expect((await page(target, 'ex:name', `&filter=${roleA}`)).links.map((link: any) => link.subject)).toEqual([first]);
  expect(await page(target, 'ex:name', `&filter=${roleB}`)).not.toHaveProperty('count');
  const filtered = await page(target, 'ex:name', '&type=ex%3AWork&limit=2');
  expect(filtered.links.map((link: any) => link.subject)).toEqual([first, expect.any(String)]);
  expect(filtered).not.toHaveProperty('count');
  const sparse = await page(target, 'ex:name', '&type=ex%3ANovel&limit=2');
  expect(sparse.links.map((link: any) => link.subject)).toEqual([first]);
  expect(sparse.next).not.toBeNull();
  let cursor = sparse.next;
  const rest: string[] = [];
  while (cursor) {
    const result = await page(target, 'ex:name', `&type=ex%3ANovel&limit=2&cursor=${cursor}`);
    rest.push(...result.links.map((link: any) => link.subject));
    cursor = result.next;
  }
  expect(rest).toEqual([last]);
});

test('an inverse page omits stored totals outside its bounded current proof', async () => {
  const source = await create('Count holder', { 'ex:name': [statement('ex:name', anchor)] }, 'ex:Novel');
  await catchUp();
  const route = routeOf(anchor)!;
  await admin.query(
    `INSERT INTO semantic.inbound_link(route,subject_id,property,source_subject_id,statement_id,source_revision,present,recorded_transaction_id,source_type,order_key)
    SELECT $1,$2,'ex:name',$3,gen_random_uuid(),1,true,gen_random_uuid(),'ex:Novel','0count' FROM generate_series(1,1000)`,
    [route, anchor, source],
  );
  await admin.query(
    `INSERT INTO semantic.inbound_link_count(route,subject_id,property,filter_value,value) VALUES ($1,$2,'ex:name','00000000-0000-0000-0000-000000000000',1001)
    ON CONFLICT(route,subject_id,property,filter_value) DO UPDATE SET value=1001`,
    [route, anchor],
  );
  expect(await page(anchor, 'ex:name')).not.toHaveProperty('count');
  expect(await page(anchor, 'ex:name', '&type=ex%3AWork')).not.toHaveProperty('count');
});

test("an inverse page follows a holder's label change once the projection catches up", async () => {
  const { updateSubjectIdentity } = await import('../../src/semantic/subject.ts');
  const { releaseDigest } = await import('@rezics/definitions');
  const target = await create('Rename anchor', {}, 'ex:Person');
  const first = await create('Alpha', { 'ex:name': [statement('ex:name', target)] });
  const second = await create('Beta', { 'ex:name': [statement('ex:name', target)] });
  await catchUp();
  expect((await page(target, 'ex:name')).links.map((link: any) => link.subject)).toEqual([first, second]);
  await updateSubjectIdentity(pool, {
    subject: first,
    labels: { en: 'Zulu' },
    release: { digest: releaseDigest(release), release },
    authorize: async () => true,
  });
  await catchUp();
  const result = await page(target, 'ex:name');
  expect(result.links.map((link: any) => link.subject)).toEqual([second, first]);
  expect(result.links[1].label).toBe('Zulu');
});
