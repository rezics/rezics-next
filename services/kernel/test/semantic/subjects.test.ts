import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createRealAccess } from './real-access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const projection = linkProjection(pool);
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const accounts = {
  editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001',
  reader: '019a1b2c-3d4e-7f00-8a00-4eade0000002',
};
const realAccess = await createRealAccess(admin, accounts, ['subject:create', 'subject:read']);
beforeAll(() => realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create'));

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens,
  routeKey: new Uint8Array(32).fill(4),
  writeRate: realAccess.writeRate,
});

async function call(method: string, path: string, options: { token?: string; key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) {
    const credential = Object.hasOwn(accounts, options.token)
      ? realAccess.bearer(options.token as keyof typeof accounts)
      : options.token;
    headers.authorization = `Bearer ${credential}`;
  }
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
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
const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const MINUTE = 'http://www.wikidata.org/entity/Q7727';
const value = (content: unknown) => ({ type: 'value', content });
const statement = (property: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  property: { id: property },
  value: value(content),
  ...extra,
});
const aozora = { parts: [statement('schema:url', 'https://www.aozora.gr.jp/cards/000148/card773.html')] };
const date = (time: string, precision = 11) => ({ time, precision, calendarmodel: GREGORIAN });
const create = async (body: unknown, token: string | null = 'editor') => {
  const result = await call('POST', '/v1/subjects', { ...(token ? { token } : {}), key: `"${randomUUID()}"`, body });
  const id = result.body.subject?.id;
  const route = typeof id === 'string' ? routeOf(id) : null;
  if (route !== null) {
    for (let step = 0; step < 200; step++) {
      const projected = await projection.run(partitionOf(route));
      if (projected.status !== 'busy' && projected.envelopes === 0) break;
      if (step === 199) throw new Error('Semantic link projection did not catch up');
    }
  }
  return result;
};
async function created(body: unknown): Promise<string> {
  const answer = await create(body);
  expect(answer.response.status).toBe(201);
  return answer.body.subject.id as string;
}
async function errors(body: unknown): Promise<unknown> {
  const answer = await create(body);
  expect(answer.response.status).toBe(400);
  return answer.body.errors;
}
async function subjectCount(): Promise<number> {
  const { rows } = await admin.query('SELECT count(*)::int AS n FROM semantic.subject');
  return rows[0].n;
}

test('without an active release a create is 503 semantic_not_ready and writes nothing', async () => {
  const refused = await create({ type: 'schema:Person', labels: { en: 'Natsume Sōseki' } });
  expect(refused.response.status).toBe(503);
  expect(refused.body.code).toBe('semantic_not_ready');
  expect(await subjectCount()).toBe(0);
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});

test('a work, its edition and a recipe are subjects of release types with no code of their own', async () => {
  const soseki = await created({ type: 'schema:Person', labels: { en: 'Natsume Sōseki', ja: '夏目漱石' } });
  const shinchosha = await created({ type: 'schema:Organization', labels: { ja: '新潮社' } });
  const work = await created({
    type: 'schema:Book',
    labels: { en: 'Kokoro', ja: 'こゝろ' },
    statements: {
      'schema:author': [
        statement('schema:author', soseki, { references: [aozora], qualifiers: [statement('schema:position', '1')] }),
      ],
      'schema:datePublished': [statement('schema:datePublished', date('+1914-09-20T00:00:00Z'))],
      'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
    },
  });
  const edition = await create({
    type: 'bf:Instance',
    labels: { ja: 'こころ（新潮文庫）' },
    statements: {
      'schema:exampleOfWork': [statement('schema:exampleOfWork', work)],
      'schema:isbn': [statement('schema:isbn', '978-4-10-101013-7', { references: [aozora] })],
      'schema:publisher': [statement('schema:publisher', shinchosha)],
      'schema:numberOfPages': [statement('schema:numberOfPages', { amount: '+384', unit: '1' })],
      'schema:datePublished': [statement('schema:datePublished', date('+1952-00-00T00:00:00Z', 9))],
    },
  });
  expect(edition.response.status).toBe(201);
  const id = edition.body.subject.id as string;
  expect(edition.response.headers.get('location')).toBe(`/v1/subjects/${id}`);
  expect(edition.response.headers.get('etag')).toBe('"1"');
  const recipe = await created({
    type: 'schema:Recipe',
    labels: { ja: '肉じゃが' },
    statements: {
      'schema:recipeIngredient': [
        statement('schema:recipeIngredient', { text: 'じゃがいも', language: 'ja' }),
        statement('schema:recipeIngredient', { text: '牛肉', language: 'ja' }),
      ],
      'schema:cookTime': [statement('schema:cookTime', { amount: '+30', unit: MINUTE })],
    },
  });

  const read = await call('GET', `/v1/subjects/${id}`);
  expect(read.response.status).toBe(200);
  expect(read.response.headers.get('etag')).toBe('"1"');
  expect(read.body.subject).toEqual(edition.body.subject);
  const subject = read.body.subject;
  expect(subject).toMatchObject({
    id,
    type: 'bf:Instance',
    revision: 1,
    release: bundledDigest,
    context: GLOBAL_CONTEXT,
    resolution: {},
  });
  expect(subject.statements['schema:isbn'][0]).toMatchObject({
    rank: 'normal',
    property: { id: 'schema:isbn', data_type: 'external-id' },
    value: value('978-4-10-101013-7'),
    rezics: { release: bundledDigest, revision: 1 },
  });
  expect(subject.statements['schema:exampleOfWork'][0].property.data_type).toBe('wikibase-item');
  expect(read.body.related).toEqual({
    'schema:datePublished': { labels: bundledRelease.properties['schema:datePublished']!.labels },
    'schema:exampleOfWork': { labels: bundledRelease.properties['schema:exampleOfWork']!.labels },
    'schema:isbn': { labels: bundledRelease.properties['schema:isbn']!.labels },
    'schema:numberOfPages': { labels: bundledRelease.properties['schema:numberOfPages']!.labels },
    'schema:publisher': { labels: bundledRelease.properties['schema:publisher']!.labels },
    'schema:url': { labels: bundledRelease.properties['schema:url']!.labels },
    [work]: {
      labels: { en: 'Kokoro', ja: 'こゝろ' },
      type: 'schema:Book',
      types: ['schema:Book', 'schema:CreativeWork', 'schema:Thing'],
      cover: null,
    },
    [shinchosha]: {
      labels: { ja: '新潮社' },
      type: 'schema:Organization',
      types: ['schema:Organization', 'schema:Thing'],
      cover: null,
    },
  });
  const { rows } = await admin.query(
    'SELECT type FROM semantic.subject WHERE subject_id = ANY($1::uuid[]) ORDER BY type',
    [[soseki, work, id, recipe]],
  );
  expect(rows.map((row) => row.type)).toEqual(['bf:Instance', 'schema:Book', 'schema:Person', 'schema:Recipe']);
});

test('values are checked by the value schemas of the release', async () => {
  const work = await created({ type: 'schema:Book', labels: { en: 'Botchan' } });
  const edition = (statements: Record<string, unknown>) => ({
    type: 'bf:Instance',
    labels: { en: 'Botchan' },
    statements: { 'schema:exampleOfWork': [statement('schema:exampleOfWork', work)], ...statements },
  });
  const pages = (amount: string, unit = '1') =>
    edition({ 'schema:numberOfPages': [statement('schema:numberOfPages', { amount, unit })] });
  expect(await errors(edition({ 'schema:isbn': [statement('schema:isbn', '4-10-101013-0')] }))).toEqual([
    { pointer: '/statements/schema:isbn/0/value/content', code: 'invalid_format' },
  ]);
  expect(await errors(pages('+0'))).toEqual([
    { pointer: '/statements/schema:numberOfPages/0/value/content/amount', code: 'out_of_range' },
  ]);
  expect(await errors(pages('+12.5'))).toEqual([
    { pointer: '/statements/schema:numberOfPages/0/value/content/amount', code: 'invalid_format' },
  ]);
  expect(await errors(pages('+120', MINUTE))).toEqual([
    { pointer: '/statements/schema:numberOfPages/0/value/content/unit', code: 'invalid_format' },
  ]);
  expect(
    await errors(
      edition({ 'schema:datePublished': [statement('schema:datePublished', date('+1906-02-30T00:00:00Z'))] }),
    ),
  ).toEqual([{ pointer: '/statements/schema:datePublished/0/value/content/time', code: 'invalid_format' }]);
  expect(await errors(edition({ 'schema:url': [statement('schema:url', 'ftp://example.org/botchan')] }))).toEqual([
    { pointer: '/statements/schema:url/0/value/content', code: 'invalid_format' },
  ]);
  const ingredient = { 'schema:recipeIngredient': [statement('schema:recipeIngredient', { text: 'potato' })] };
  expect(await errors({ type: 'schema:Recipe', labels: { en: 'Nikujaga' }, statements: ingredient })).toEqual([
    { pointer: '/statements/schema:recipeIngredient/0/value/content/language', code: 'required' },
  ]);
  const unknownPages = { property: { id: 'schema:numberOfPages' }, value: { type: 'somevalue' } };
  expect(await created(edition({ 'schema:numberOfPages': [unknownPages] }))).toBeString();
});

test('a type, property, qualifier, rank or count the release does not allow is refused', async () => {
  const soseki = await created({ type: 'schema:Person', labels: { en: 'Natsume Sōseki' } });
  const work = await created({ type: 'schema:Book', labels: { en: 'Kokoro' } });
  const book = (statements: Record<string, unknown>) => ({ type: 'schema:Book', labels: { en: 'Kokoro' }, statements });
  expect(await errors({ type: 'schema:NotInRelease', labels: { en: 'Kokoro (1955)' } })).toEqual([
    { pointer: '/type', code: 'unsupported' },
  ]);
  expect(await errors(book({ 'schema:isbn': [statement('schema:isbn', '978-4-10-101013-7')] }))).toEqual([
    { pointer: '/statements/schema:isbn', code: 'unsupported' },
  ]);
  const isbn = statement('schema:isbn', '978-4-10-101013-7');
  expect(await errors(book({ 'schema:author': [statement('schema:author', soseki, { qualifiers: [isbn] })] }))).toEqual(
    [{ pointer: '/statements/schema:author/0/qualifiers/0/property/id', code: 'unsupported' }],
  );
  const unknownSource = { parts: [statement('schema:homepage', 'https://example.org')] };
  expect(
    await errors(book({ 'schema:author': [statement('schema:author', soseki, { references: [unknownSource] })] })),
  ).toEqual([{ pointer: '/statements/schema:author/0/references/0/parts/0/property/id', code: 'unsupported' }]);
  expect(await errors(book({ 'schema:author': [statement('schema:author', soseki, { rank: 'deprecated' })] }))).toEqual(
    [{ pointer: '/statements/schema:author/0/rank', code: 'unsupported' }],
  );
  const twice = {
    'schema:exampleOfWork': [statement('schema:exampleOfWork', work), statement('schema:exampleOfWork', work)],
  };
  expect(await errors({ type: 'bf:Instance', labels: { en: 'Kokoro' }, statements: twice })).toEqual([
    { pointer: '/statements/schema:exampleOfWork/1', code: 'out_of_range' },
  ]);
});

test('item values name existing subjects of a target type', async () => {
  const recipe = await created({ type: 'schema:Recipe', labels: { ja: '肉じゃが' } });
  const person = await created({ type: 'schema:Person', labels: { en: 'Natsume Sōseki' } });
  const before = await subjectCount();
  const authors = [person, recipe, newId(0x0042)].map((id) => statement('schema:author', id));
  expect(
    await errors({ type: 'schema:Book', labels: { en: 'Kokoro' }, statements: { 'schema:author': authors } }),
  ).toEqual([
    { pointer: '/statements/schema:author/1/value/content', code: 'out_of_range' },
    { pointer: '/statements/schema:author/2/value/content', code: 'out_of_range' },
  ]);
  const ofPerson = { 'schema:exampleOfWork': [statement('schema:exampleOfWork', person)] };
  expect(await errors({ type: 'bf:Instance', labels: { en: 'Kokoro' }, statements: ofPerson })).toEqual([
    { pointer: '/statements/schema:exampleOfWork/0/value/content', code: 'out_of_range' },
  ]);
  expect(await subjectCount()).toBe(before);
});

test('a create authorizes subject:create on the Global Context and a denied one writes nothing', async () => {
  const before = await subjectCount();
  realAccess.checks.length = 0;
  expect((await create({ type: 'schema:Person', labels: { en: 'Mori Ōgai' } }, 'reader')).response.status).toBe(403);
  expect(realAccess.checks.filter(({ action }) => action === 'subject:create')).toEqual([
    {
      persona: 'reader',
      action: 'subject:create',
      resource: { route: 0, id: GLOBAL_CONTEXT },
    },
  ]);
  expect((await create({ type: 'schema:Person', labels: { en: 'Mori Ōgai' } }, null)).response.status).toBe(401);
  expect(await subjectCount()).toBe(before);
});

test("a create is revision 1 recording its release, in the subject's partition", async () => {
  const { subject } = (await create({ type: 'schema:Person', labels: { en: 'Higuchi Ichiyō' } })).body;
  const { rows } = await admin.query(
    `SELECT r.revision, r.kind, r.release, r.recorded_transaction_id = s.recorded_transaction_id AS same_command
     FROM semantic.revision r JOIN semantic.subject s ON s.route = r.route AND s.subject_id = r.subject_id
     WHERE r.route = $1 AND r.subject_id = $2`,
    [routeOf(subject.id), subject.id],
  );
  expect(rows).toEqual([{ revision: 1, kind: 'create', release: bundledDigest, same_command: true }]);
  const { rows: key } = await admin.query(
    `SELECT array_agg(a.attname ORDER BY k.ordinality)::text[] AS columns
     FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indrelid = 'semantic.revision'::regclass AND i.indisprimary`,
  );
  expect(key[0].columns).toEqual(['route', 'subject_id', 'revision']);
});
