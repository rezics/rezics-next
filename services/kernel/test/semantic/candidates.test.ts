import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { createRealAccess } from './real-access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const ACTIONS = ['subject:create', 'subject:read', 'statement:propose'];
const accounts = {
  editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001',
  outsider: '019a1b2c-3d4e-7f00-8a00-0075de000003',
};
const originalWriteRateOverrides = process.env.KERNEL_WRITE_RATE_OVERRIDES;
process.env.KERNEL_WRITE_RATE_OVERRIDES = '{"new-account":{"write":{"maximum":1000,"seconds":60}}}';
const realAccess = await createRealAccess(admin, accounts, ACTIONS);
if (originalWriteRateOverrides === undefined) delete process.env.KERNEL_WRITE_RATE_OVERRIDES;
else process.env.KERNEL_WRITE_RATE_OVERRIDES = originalWriteRateOverrides;
beforeAll(async () => {
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'statement:propose');
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});
const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens,
  routeKey: new Uint8Array(32).fill(4),
  writeRate: realAccess.writeRate,
});
const projection = linkProjection(pool);
async function catchUpLinks(id: string): Promise<void> {
  const partition = partitionOf(routeOf(id)!);
  for (let step = 0; step < 200; step++) {
    const result = await projection.run(partition);
    if (result.status === 'busy') {
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }
    if (result.envelopes === 0) return;
  }
  throw new Error('Semantic link projection did not catch up');
}

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
const key = () => `"${randomUUID()}"`;
const relationTargets = new Map<string, Set<string>>();
const relationKey = (subject: string, property: string) => `${subject}\0${property}`;
const relationGroups = new Set(['order', 'derivation', 'world', 'membership', 'association', 'credit', 'appearance']);
function rememberTarget(subject: string, property: string, target: unknown): void {
  if (typeof target !== 'string') return;
  const targets = relationTargets.get(relationKey(subject, property)) ?? new Set<string>();
  targets.add(target);
  relationTargets.set(relationKey(subject, property), targets);
}
const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const value = (content: unknown) => ({ type: 'value', content });
const statement = (
  property: string,
  content: unknown,
  extra: Record<string, unknown> = {},
): { property: { id: string }; value: ReturnType<typeof value>; [key: string]: unknown } => ({
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
  const subject = answer.body.subject as Record<string, any>;
  for (const [property, statements] of Object.entries(subject.statements as Record<string, any[]>))
    for (const entry of statements)
      if (entry.value?.type === 'value') rememberTarget(subject.id, property, entry.value.content);
  return subject;
}
const person = (name: string) => created({ type: 'schema:Person', labels: { en: name } });
const propose = async (id: string, input: unknown, options: { token?: string | null; key?: string } = {}) => {
  const answer = await call('POST', `/v1/subjects/${id}/candidates`, {
    ...(options.token === null ? {} : { token: options.token ?? 'editor' }),
    key: options.key ?? key(),
    body: { statement: input },
  });
  const parsed = input as { property?: { id?: string }; value?: { type?: string; content?: unknown } };
  if (parsed.property?.id && parsed.value?.type === 'value')
    rememberTarget(id, parsed.property.id, parsed.value.content);
  return answer;
};
async function listed(id: string, property: string, query = '') {
  const knownTargets = relationTargets.get(relationKey(id, property));
  const target =
    relationGroups.has(bundledRelease.properties[property]?.relation?.group ?? '') &&
    !/[?&](?:target|sameAs)=/.test(query) &&
    knownTargets?.size === 1
      ? `&target=${[...knownTargets][0]}`
      : '';
  const answer = await call(
    'GET',
    `/v1/subjects/${id}/candidates?property=${encodeURIComponent(property)}${target}${query}`,
  );
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
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Kokoro' },
    statements: { 'schema:author': [cited('schema:author', soseki.id, { rank: 'preferred' })] },
  });
  const original = book.statements['schema:author'][0];
  const input = statement('schema:author', soseki.id, {
    references: [{ parts: [statement('schema:url', 'https://example.org/independent-review')] }],
  });
  const proposed = await propose(book.id, input);
  expect(proposed.response.status).toBe(201);
  expect(proposed.body).toEqual({ candidate: expect.any(String), revision: 2 });
  expect(routeOf(proposed.body.candidate)).toBe(routeOf(book.id));
  await catchUpLinks(book.id);
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
        source: null,
        retracted: null,
        retraction: null,
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
          references: [
            {
              hash: '70e68e8bf255605036ec89892e8cd8b3ca67a11c23db27a90fc2354e2f99c218',
              parts: [
                {
                  property: { id: 'schema:url', data_type: 'url' },
                  value: { type: 'value', content: 'https://example.org/independent-review' },
                },
              ],
            },
          ],
          rezics: { release: bundledDigest, revision: 2 },
        },
        release: bundledDigest,
        revision: 2,
        source: null,
        retracted: null,
        retraction: null,
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
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Botchan' },
    statements: { 'schema:author': [cited('schema:author', soseki.id)] },
  });
  const token = key();
  const input = statement('schema:author', soseki.id, {
    references: [{ parts: [statement('schema:url', 'https://example.org/second-edition')] }],
  });
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
  const [a, b] = await Promise.all(['Mori Ōgai', 'Natsume Sōseki'].map(person));
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Sanshirō' },
    statements: {
      'schema:author': [statement('schema:author', a!.id, { rank: 'preferred' }), statement('schema:author', b!.id)],
      'schema:datePublished': [statement('schema:datePublished', date('+1908-09-01T00:00:00Z'))],
    },
  });
  const authors = book.statements['schema:author'];
  const targetQuery = `&target=${a!.id}`;
  const compact = await listed(book.id, 'schema:author', targetQuery);
  expect(compact.candidates.map((x: any) => [x.id, x.decision, x.head, x.rank])).toEqual([
    [authors[0].id, 'accepted', 1, 'preferred'],
  ]);
  expect(compact.adoption).toEqual({ mode: 'replace', head: 1 });
  const otherTarget = await listed(book.id, 'schema:author', `&target=${b!.id}`);
  expect(otherTarget.candidates.map((x: any) => [x.id, x.decision, x.head, x.rank])).toEqual([
    [authors[1].id, 'accepted', 1, 'normal'],
  ]);
  const dates = await listed(book.id, 'schema:datePublished');
  await catchUpLinks(book.id);
  const view = (await call('GET', `/v1/subjects/${book.id}`)).body;
  expect(await expansions(book.id, 'schema:author')).toBe(0);
  const first = await propose(
    book.id,
    statement('schema:author', a!.id, { references: [{ parts: [statement('schema:url', 'https://example.org/c')] }] }),
  );
  const second = await propose(
    book.id,
    statement('schema:author', a!.id, { references: [{ parts: [statement('schema:url', 'https://example.org/d')] }] }),
  );
  const language = await propose(book.id, cited('schema:inLanguage', 'ja'));
  expect([first.body.revision, second.body.revision, language.body.revision]).toEqual([2, 3, 4]);
  expect(await expansions(book.id, 'schema:author')).toBe(1);
  expect(await expansions(book.id, 'schema:inLanguage')).toBe(1);
  expect(await expansions(book.id, 'schema:datePublished')).toBe(0);
  const expanded = await listed(book.id, 'schema:author', targetQuery);
  expect(expanded.candidates.slice(0, 1)).toEqual(compact.candidates);
  expect(expanded.candidates.slice(1).map((x: any) => [x.id, x.revision, x.decision, x.head, x.rank])).toEqual([
    [first.body.candidate, 2, null, null, null],
    [second.body.candidate, 3, null, null, null],
  ]);
  expect(expanded.adoption).toEqual(compact.adoption);
  expect(await listed(book.id, 'schema:datePublished')).toEqual(dates);
  const languages = await listed(book.id, 'schema:inLanguage');
  expect(languages.adoption).toBeNull();
  expect(languages.candidates.map((x: any) => [x.id, x.decision])).toEqual([[language.body.candidate, null]]);
  await catchUpLinks(book.id);
  const after = (await call('GET', `/v1/subjects/${book.id}`)).body;
  expect(after.subject.statements).toEqual(view.subject.statements);
  expect(after.related).toEqual(view.related);
});

test('concurrent first proposals on one slot both land and expand it once', async () => {
  const [a] = await Promise.all(['Higuchi Ichiyō'].map(person));
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Takekurabe' },
    statements: { 'schema:author': [statement('schema:author', a!.id)] },
  });
  const results = await Promise.all(
    ['b', 'c'].map((suffix) =>
      propose(
        book.id,
        statement('schema:author', a!.id, {
          references: [{ parts: [statement('schema:url', `https://example.org/${suffix}`)] }],
        }),
      ),
    ),
  );
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
  for (const x of [b, c])
    expect(
      (
        await propose(
          book.id,
          statement('schema:author', a!.id, {
            references: [{ parts: [statement('schema:url', `https://example.org/${x!.id}`)] }],
          }),
        )
      ).response.status,
    ).toBe(201);
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
      { revision: 3, kind: 'propose', release: bundledDigest, source: null },
      { revision: 2, kind: 'propose', release: bundledDigest, source: null },
    ],
    next: expect.any(String),
  });
  const rest = await call(
    'GET',
    `/v1/subjects/${book.id}/revisions?limit=2&cursor=${encodeURIComponent(first.body.next)}`,
  );
  expect(rest.body).toEqual({
    revisions: [{ revision: 1, kind: 'create', release: bundledDigest, source: null }],
    next: null,
  });
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
  expect(paths['/v1/subjects/{id}/candidates']!.post).toMatchObject({
    operationId: 'subject.propose',
    'x-resource-types': ['semantic.revision'],
    'x-authority-resource-types': ['semantic.context'],
    'x-authority-resource-id': '00000000-0000-8000-8000-000000000000',
  });
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
