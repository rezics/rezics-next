import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { AuthenticationError, type Access, type AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
beforeAll(async () => {
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const account = (accountId: string): AccountActor => ({
  kind: 'account',
  accountId,
  clientId: 'web',
  scopes: ['subject:create', 'subject:read', 'statement:propose'],
  requestedBy: null,
  authnEpoch: 1,
});
const actors: Record<string, AccountActor> = {
  editor: account('019a1b2c-3d4e-7f00-8a00-ed170e000001'),
  outsider: account('019a1b2c-3d4e-7f00-8a00-0075de000003'),
};
const access: Access = {
  async authenticate(token) {
    const actor = actors[token];
    if (!actor) throw new AuthenticationError(401, 'Bearer error="invalid_token"');
    return actor;
  },
  async authorize(_client, actor, action, resource) {
    if (action === 'subject:read') return true;
    return (
      ['subject:create', 'statement:propose'].includes(action) &&
      actor.kind === 'account' &&
      actor.accountId === actors.editor!.accountId &&
      resource.id === GLOBAL_CONTEXT
    );
  },
};
const kernel = createKernel({ pool, access, tokens, routeKey: new Uint8Array(32).fill(4) });

async function call(method: string, path: string, options: { token?: string; key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
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
const key = () => `"${randomUUID()}"`;
const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const value = (content: unknown) => ({ type: 'value', content });
const statement = (property: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  property: { id: property },
  value: value(content),
  ...extra,
});
const aozora = { parts: [statement('schema:url', 'https://www.aozora.gr.jp/cards/000148/card773.html')] };
const cited = (property: string, content: unknown, extra: Record<string, unknown> = {}) =>
  statement(property, content, { references: [aozora], ...extra });
const date = (time: string) => ({ time, precision: 11, calendarmodel: GREGORIAN });
async function created(body: unknown): Promise<Record<string, any>> {
  const answer = await call('POST', '/v1/subjects', { token: 'editor', key: key(), body });
  expect(answer.response.status).toBe(201);
  return answer.body.subject;
}
const person = (name: string) => created({ type: 'schema:Person', labels: { en: name } });
const propose = (id: string, input: unknown, options: { token?: string | null; key?: string } = {}) =>
  call('POST', `/v1/subjects/${id}/candidates`, {
    ...(options.token === null ? {} : { token: options.token ?? 'editor' }),
    key: options.key ?? key(),
    body: { statement: input },
  });
async function listed(id: string, property: string, query = '') {
  const answer = await call('GET', `/v1/subjects/${id}/candidates?property=${encodeURIComponent(property)}${query}`);
  expect(answer.response.status).toBe(200);
  return answer.body;
}
async function revisions(id: string) {
  const { rows } = await admin.query(
    'SELECT revision, kind, release, route, recorded_transaction_id::text AS tx FROM semantic.revision WHERE subject_id = $1 ORDER BY revision',
    [id],
  );
  return rows;
}
async function expansions(id: string, property: string): Promise<number> {
  const { rows } = await admin.query(
    "SELECT count(*)::int AS n FROM semantic.fact WHERE subject_id = $1 AND property = $2 AND operation = 'expand'",
    [id, property],
  );
  return rows[0].n;
}

test('a proposal is a pending candidate with its references and leaves the adopted statements unchanged', async () => {
  const soseki = await person('Natsume Sōseki');
  const collective = await created({ type: 'schema:Organization', labels: { en: 'Kokoro editorial collective' } });
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Kokoro' },
    statements: { 'schema:author': [cited('schema:author', soseki.id, { rank: 'preferred' })] },
  });
  const original = book.statements['schema:author'][0];
  const input = cited('schema:author', collective.id);
  const proposed = await propose(book.id, input);
  expect(proposed.response.status).toBe(201);
  expect(proposed.body).toEqual({ candidate: expect.any(String), revision: 2 });
  expect(routeOf(proposed.body.candidate)).toBe(routeOf(book.id));
  const read = await call('GET', `/v1/subjects/${book.id}`);
  expect(read.response.headers.get('etag')).toBe('"2"');
  expect(read.body.subject.revision).toBe(2);
  expect(read.body.subject.statements).toEqual(book.statements);
  expect(await listed(book.id, 'schema:author')).toEqual({
    candidates: [
      {
        id: original.id,
        statement: original,
        release: bundledDigest,
        revision: 1,
        decision: 'accepted',
        head: 1,
        rank: 'preferred',
      },
      {
        id: proposed.body.candidate,
        statement: {
          ...original,
          id: proposed.body.candidate,
          rank: 'normal',
          value: input.value,
          rezics: { release: bundledDigest, revision: 2 },
        },
        release: bundledDigest,
        revision: 2,
        decision: null,
        head: null,
        rank: null,
      },
    ],
    adoption: { mode: 'replace', head: 1 },
    next: null,
  });
  expect(await listed(book.id, 'schema:datePublished')).toEqual({ candidates: [], adoption: null, next: null });
});

test('proposal keys replay without a new revision and conflict on a different statement', async () => {
  const soseki = await person('Natsume Sōseki');
  const kinnosuke = await person('Natsume Kinnosuke');
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Botchan' },
    statements: { 'schema:author': [cited('schema:author', soseki.id)] },
  });
  const token = key();
  const input = cited('schema:author', kinnosuke.id);
  const first = await propose(book.id, input, { key: token });
  expect(first.response.status).toBe(201);
  const replay = await propose(book.id, input, { key: token });
  expect(replay.response.status).toBe(201);
  expect(replay.body).toEqual(first.body);
  const conflict = await propose(book.id, { ...input, rank: 'preferred' }, { key: token });
  expect(conflict.response.status).toBe(422);
  expect(conflict.body.code).toBe('idempotency_conflict');
  expect((await revisions(book.id)).map((row) => row.kind)).toEqual(['create', 'propose']);
  expect((await listed(book.id, 'schema:author')).candidates).toHaveLength(2);
});

test('an invalid, unauthorized or misdirected proposal is refused and writes nothing', async () => {
  const soseki = await person('Natsume Sōseki');
  const recipe = await created({ type: 'schema:Recipe', labels: { en: 'Miso soup' } });
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Kokoro' },
    statements: { 'schema:author': [cited('schema:author', soseki.id)] },
  });
  const edition = await created({ type: 'bf:Instance', labels: { en: 'Kokoro, Penguin Classics' } });
  const before = await revisions(book.id);
  const refused = async (id: string, input: unknown, pointer: string, code: string) => {
    const answer = await propose(id, input);
    expect([pointer, answer.response.status]).toEqual([pointer, 400]);
    expect(answer.body.errors).toContainEqual({ pointer, code });
  };
  await refused(book.id, statement('schema:author', soseki.id), '/statement/references', 'required');
  await refused(
    book.id,
    statement('schema:author', soseki.id, { references: [] }),
    '/statement/references',
    'required',
  );
  await refused(
    book.id,
    cited('schema:recipeIngredient', { language: 'en', text: 'miso' }),
    '/statement/property/id',
    'unsupported',
  );
  await refused(book.id, cited('schema:author', soseki.id, { rank: 'deprecated' }), '/statement/rank', 'unsupported');
  await refused(book.id, cited('schema:author', recipe.id), '/statement/value/content', 'out_of_range');
  await refused(
    book.id,
    cited('schema:author', newId(routeOf(soseki.id)!)),
    '/statement/value/content',
    'out_of_range',
  );
  await refused(
    book.id,
    cited('schema:author', soseki.id, { qualifiers: [statement('schema:isbn', '9780143106036')] }),
    '/statement/qualifiers/0/property/id',
    'unsupported',
  );
  await refused(
    edition.id,
    cited('schema:numberOfPages', { amount: '+0', unit: '1' }),
    '/statement/value/content/amount',
    'out_of_range',
  );
  const valid = cited('schema:author', soseki.id);
  for (const [token, status, code] of [
    [null, 401, 'authentication_required'],
    ['outsider', 403, 'forbidden'],
  ] as const) {
    const answer = await propose(book.id, valid, { token });
    expect([answer.response.status, answer.body.code]).toEqual([status, code]);
  }
  for (const id of [newId(routeOf(book.id)!), 'not-an-id']) {
    const answer = await propose(id, valid);
    expect([id, answer.response.status, answer.body.code]).toEqual([id, 404, 'not_found']);
  }
  expect(await revisions(book.id)).toEqual(before);
  expect(await revisions(edition.id)).toHaveLength(1);
  expect(await expansions(book.id, 'schema:author')).toBe(0);
});

test('a slot expands once when first proposed and expansion changes neither the view nor the heads', async () => {
  const [a, b, c, d] = await Promise.all(
    ['Mori Ōgai', 'Natsume Sōseki', 'Masaoka Shiki', 'Takahama Kyoshi'].map(person),
  );
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Sanshirō' },
    statements: {
      'schema:author': [statement('schema:author', a!.id, { rank: 'preferred' }), statement('schema:author', b!.id)],
      'schema:datePublished': [statement('schema:datePublished', date('+1908-09-01T00:00:00Z'))],
    },
  });
  const authors = book.statements['schema:author'];
  const compact = await listed(book.id, 'schema:author');
  expect(compact.candidates.map((x: any) => [x.id, x.decision, x.head, x.rank])).toEqual([
    [authors[0].id, 'accepted', 1, 'preferred'],
    [authors[1].id, 'accepted', 1, 'normal'],
  ]);
  expect(compact.adoption).toEqual({ mode: 'replace', head: 1 });
  const dates = await listed(book.id, 'schema:datePublished');
  const view = (await call('GET', `/v1/subjects/${book.id}`)).body;
  expect(await expansions(book.id, 'schema:author')).toBe(0);
  const first = await propose(book.id, cited('schema:author', c!.id));
  const second = await propose(book.id, cited('schema:author', d!.id));
  const language = await propose(book.id, cited('schema:inLanguage', 'ja'));
  expect([first.body.revision, second.body.revision, language.body.revision]).toEqual([2, 3, 4]);
  expect(await expansions(book.id, 'schema:author')).toBe(1);
  expect(await expansions(book.id, 'schema:inLanguage')).toBe(1);
  expect(await expansions(book.id, 'schema:datePublished')).toBe(0);
  const expanded = await listed(book.id, 'schema:author');
  expect(expanded.candidates.slice(0, 2)).toEqual(compact.candidates);
  expect(expanded.candidates.slice(2).map((x: any) => [x.id, x.revision, x.decision, x.head, x.rank])).toEqual([
    [first.body.candidate, 2, null, null, null],
    [second.body.candidate, 3, null, null, null],
  ]);
  expect(expanded.adoption).toEqual(compact.adoption);
  expect(await listed(book.id, 'schema:datePublished')).toEqual(dates);
  const languages = await listed(book.id, 'schema:inLanguage');
  expect(languages.adoption).toBeNull();
  expect(languages.candidates.map((x: any) => [x.id, x.decision])).toEqual([[language.body.candidate, null]]);
  const after = (await call('GET', `/v1/subjects/${book.id}`)).body;
  expect(after.subject.statements).toEqual(view.subject.statements);
  expect(after.related).toEqual(view.related);
});

test('concurrent first proposals on one slot both land and expand it once', async () => {
  const [a, b, c] = await Promise.all(['Higuchi Ichiyō', 'Kōda Rohan', 'Ozaki Kōyō'].map(person));
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Takekurabe' },
    statements: { 'schema:author': [statement('schema:author', a!.id)] },
  });
  const results = await Promise.all([b, c].map((x) => propose(book.id, cited('schema:author', x!.id))));
  expect(results.map((r) => r.response.status)).toEqual([201, 201]);
  expect(results.map((r) => r.body.revision).sort()).toEqual([2, 3]);
  expect(await expansions(book.id, 'schema:author')).toBe(1);
  expect((await listed(book.id, 'schema:author')).candidates.map((x: any) => x.revision)).toEqual([1, 2, 3]);
});

test('revisions and candidates page in order and every command is one revision of the subject partition', async () => {
  const [a, b, c] = await Promise.all(['Izumi Kyōka', 'Tokuda Shūsei', 'Shimazaki Tōson'].map(person));
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Kōya Hijiri' },
    statements: { 'schema:author': [statement('schema:author', a!.id)] },
  });
  for (const x of [b, c]) expect((await propose(book.id, cited('schema:author', x!.id))).response.status).toBe(201);
  const rows = await revisions(book.id);
  expect(rows.map((row) => [row.revision, row.kind, row.release, row.route])).toEqual([
    [1, 'create', bundledDigest, routeOf(book.id)],
    [2, 'propose', bundledDigest, routeOf(book.id)],
    [3, 'propose', bundledDigest, routeOf(book.id)],
  ]);
  expect(new Set(rows.map((row) => row.tx)).size).toBe(3);
  const first = await call('GET', `/v1/subjects/${book.id}/revisions?limit=2`);
  expect(first.response.status).toBe(200);
  expect(first.body).toEqual({
    revisions: [
      { revision: 3, kind: 'propose', release: bundledDigest },
      { revision: 2, kind: 'propose', release: bundledDigest },
    ],
    next: expect.any(String),
  });
  const rest = await call(
    'GET',
    `/v1/subjects/${book.id}/revisions?limit=2&cursor=${encodeURIComponent(first.body.next)}`,
  );
  expect(rest.body).toEqual({ revisions: [{ revision: 1, kind: 'create', release: bundledDigest }], next: null });
  const page = await listed(book.id, 'schema:author', '&limit=2');
  expect(page.next).toEqual(expect.any(String));
  const tail = await listed(book.id, 'schema:author', `&limit=2&cursor=${encodeURIComponent(page.next)}`);
  expect(tail.next).toBeNull();
  expect([...page.candidates, ...tail.candidates].map((x: any) => x.revision)).toEqual([1, 2, 3]);
  const misused = await call(
    'GET',
    `/v1/subjects/${book.id}/candidates?property=schema:datePublished&limit=2&cursor=${encodeURIComponent(page.next)}`,
  );
  expect(misused.response.status).toBe(400);
  for (const id of [newId(routeOf(book.id)!), 'not-an-id']) {
    for (const path of [`/v1/subjects/${id}/revisions`, `/v1/subjects/${id}/candidates?property=schema:author`]) {
      const answer = await call('GET', path);
      expect([path, answer.response.status, answer.body.code]).toEqual([path, 404, 'not_found']);
    }
  }
});

test('the kernel contract documents proposals, candidates and revisions', () => {
  const paths = openApiDocument(kernel).paths;
  const operations = [
    [
      paths['/v1/subjects/{id}/candidates']!.post!,
      'subject.propose',
      ['201', '400', '401', '403', '404', '422', '503'],
    ],
    [paths['/v1/subjects/{id}/candidates']!.get!, 'subject.list_candidates', ['200', '400', '401', '404', '503']],
    [paths['/v1/subjects/{id}/revisions']!.get!, 'subject.list_revisions', ['200', '400', '401', '404', '503']],
  ] as const;
  for (const [operation, operationId, responses] of operations) {
    expect(operation.operationId).toBe(operationId);
    expect(Object.keys(operation.responses!).sort()).toEqual([...responses]);
  }
});
