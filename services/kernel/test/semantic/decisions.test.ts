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
import { testReceiptKeys } from '../support/receipt-keys.ts';
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
const ACTIONS = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:create',
  'context:accept',
  'context:adopt',
  'context:read',
];
const accounts = {
  editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001',
  acceptor: '019a1b2c-3d4e-7f00-8a00-acce97000002',
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
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'context:create');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', 'context:accept');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', 'context:adopt');
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
  await call('GET', `/v1/subjects/${newId(0x51ff)}`);
});
const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens,
  receiptKeys: testReceiptKeys(),
  routeKey: new Uint8Array(32).fill(4),
  writeRate: realAccess.writeRate,
  requestDeadlineMs: 30_000,
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
type Options = { token?: string | null; key?: string };
const as = (options: Options, fallback: string) => ({
  ...(options.token === null ? {} : { token: options.token ?? fallback }),
  key: options.key ?? key(),
});
const key = () => `"${randomUUID()}"`;
const relationTargets = new Map<string, Set<string>>();
const candidateTargets = new Map<string, string>();
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
const statement = (property: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  property: { id: property },
  value: value(content),
  ...extra,
});
const aozora = { parts: [statement('schema:url', 'https://www.aozora.gr.jp/cards/000148/card773.html')] };
const cited = (property: string, content: unknown, extra: Record<string, unknown> = {}) =>
  statement(property, content, { references: [aozora], ...extra });
const date = (time: string) => ({ time, precision: 11, calendarmodel: GREGORIAN });
const pick = (candidate: string, rank = 'normal') => ({ candidate, rank });
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
async function proposed(id: string, input: unknown): Promise<string> {
  const answer = await call('POST', `/v1/subjects/${id}/candidates`, {
    token: 'editor',
    key: key(),
    body: { statement: input },
  });
  expect(answer.response.status).toBe(201);
  const candidate = answer.body.candidate as string;
  const parsed = input as { property?: { id?: string }; value?: { type?: string; content?: unknown } };
  if (parsed.property?.id && parsed.value?.type === 'value' && typeof parsed.value.content === 'string') {
    candidateTargets.set(candidate, parsed.value.content);
    rememberTarget(id, parsed.property.id, parsed.value.content);
  }
  return candidate;
}
const decide = (
  id: string,
  candidate: string,
  verb: 'accept' | 'reject',
  context: string,
  expected: number | null,
  options: Options = {},
) =>
  call('POST', `/v1/subjects/${id}/candidates/${candidate}:${verb}`, {
    ...as(options, 'acceptor'),
    body: { context, expected_head: expected },
  });
const adopt = (id: string, body: Record<string, unknown>, options: Options = {}) => {
  const selection = Array.isArray(body.selection) ? (body.selection as { candidate: string }[]) : [];
  const selectedTargets = new Set(selection.map((entry) => candidateTargets.get(entry.candidate)).filter(Boolean));
  const property = String(body.property);
  const isRelation = relationGroups.has(bundledRelease.properties[property]?.relation?.group ?? '');
  const knownTargets = isRelation ? relationTargets.get(relationKey(id, property)) : undefined;
  const target = isRelation
    ? selectedTargets.size === 1
      ? [...selectedTargets][0]
      : knownTargets?.size === 1
        ? [...knownTargets][0]
        : undefined
    : undefined;
  return call('POST', `/v1/subjects/${id}:adopt`, {
    ...as(options, 'acceptor'),
    body: { context: GLOBAL_CONTEXT, ...body, ...(body.target === undefined && target ? { target } : {}) },
  });
};
async function view(id: string, context?: string) {
  await catchUpLinks(id);
  const answer = await call('GET', `/v1/subjects/${id}${context ? `?context=${context}` : ''}`);
  expect(answer.response.status).toBe(200);
  expect(answer.response.headers.get('etag')).toBe(`"${answer.body.subject.revision}"`);
  return answer.body;
}
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
    'SELECT revision, kind, route FROM semantic.revision WHERE subject_id = $1 ORDER BY revision',
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
async function community(_near: string, granted = true): Promise<string> {
  const created = await call('POST', '/v1/contexts', {
    token: 'editor',
    key: key(),
    body: { labels: { en: 'Literature readers' } },
  });
  expect(created.response.status).toBe(201);
  const id = created.body.context.id as string;
  if (granted) {
    const route = routeOf(id);
    if (route === null) throw new Error('Community Context id must carry its route');
    for (const action of ['context:accept', 'context:adopt']) await realAccess.grant({ route, id }, 'acceptor', action);
    await admin.query(
      `INSERT INTO access.resource_role_grant(route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
VALUES ($1,$2,'identity',$3,'','semantic.context.owner','(,)',$3)`,
      [route, id, accounts.acceptor],
    );
  }
  return id;
}

test('Global acceptance and adoption turn a proposal into a ranked statement, one revision each', async () => {
  const soseki = await person('Natsume Sōseki');
  const collective = await created({ type: 'schema:Organization', labels: { en: 'Kokoro editorial collective' } });
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Kokoro' },
    statements: { 'schema:author': [cited('schema:author', soseki.id, { rank: 'preferred' })] },
  });
  const original = book.statements['schema:author'][0];
  const candidate = await proposed(book.id, cited('schema:author', collective.id));
  const token = key();
  const accepted = await decide(book.id, candidate, 'accept', GLOBAL_CONTEXT, null, { key: token });
  expect(accepted.response.status).toBe(200);
  expect(accepted.body).toEqual({
    acceptance: { context: GLOBAL_CONTEXT, candidate, decision: 'accept', head: 1 },
    revision: 3,
  });
  expect(realAccess.checks.at(-1)).toEqual({
    persona: 'acceptor',
    action: 'context:accept',
    resource: { route: 0, id: GLOBAL_CONTEXT },
  });
  expect((await decide(book.id, candidate, 'accept', GLOBAL_CONTEXT, null, { key: token })).body).toEqual(
    accepted.body,
  );
  const conflict = await decide(book.id, candidate, 'reject', GLOBAL_CONTEXT, null, { key: token });
  expect([conflict.response.status, conflict.body.code]).toEqual([422, 'idempotency_conflict']);
  const stale = await decide(book.id, candidate, 'accept', GLOBAL_CONTEXT, null);
  expect([stale.response.status, stale.body.code]).toEqual([409, 'stale_editorial_head']);
  expect((await view(book.id)).subject.statements).toEqual(book.statements);
  const pending = (await listed(book.id, 'schema:author', `&target=${collective.id}`)).candidates[0];
  expect([pending.id, pending.decision, pending.head, pending.rank]).toEqual([candidate, 'accepted', 1, null]);
  const selection = [pick(candidate)];
  const adopted = await adopt(book.id, { property: 'schema:author', mode: 'replace', selection, expected_head: null });
  expect(adopted.response.status).toBe(200);
  expect(adopted.body).toEqual({
    adoption: { context: GLOBAL_CONTEXT, property: 'schema:author', mode: 'replace', selection, head: 1 },
    revision: 4,
  });
  expect(realAccess.checks.at(-1)).toEqual({
    persona: 'acceptor',
    action: 'context:adopt',
    resource: { route: 0, id: GLOBAL_CONTEXT },
  });
  const shown = await view(book.id);
  expect(shown.subject.revision).toBe(4);
  const authorStatements = shown.subject.statements['schema:author']
    .map((s: any) => [s.id, s.rank, s.rezics.revision])
    .sort(([left]: any[], [right]: any[]) => String(left).localeCompare(String(right)));
  expect(authorStatements).toEqual(
    [
      [original.id, 'preferred', 1],
      [candidate, 'normal', 2],
    ].sort(([left]: any[], [right]: any[]) => String(left).localeCompare(String(right))),
  );
  expect(shown.related[collective.id]).toEqual({
    labels: collective.labels,
    type: 'schema:Organization',
    types: ['schema:Organization', 'schema:Thing'],
    cover: null,
  });
  const listing = await listed(book.id, 'schema:author', `&target=${collective.id}`);
  expect(listing.adoption).toEqual({ mode: 'replace', head: 1 });
  expect(listing.candidates.map((x: any) => [x.id, x.decision, x.head, x.rank])).toEqual([
    [candidate, 'accepted', 1, 'normal'],
  ]);
  expect((await revisions(book.id)).map((row) => row.kind)).toEqual(['create', 'propose', 'accept', 'adopt']);
});

test('a Global rejection keeps last adopted public facts and records the candidate as deprecated with references', async () => {
  const work = await created({ type: 'schema:Book', labels: { en: 'Kokoro' } });
  const edition = await created({
    type: 'bf:Instance',
    labels: { en: 'Kokoro, Penguin Classics' },
    statements: {
      'schema:exampleOfWork': [statement('schema:exampleOfWork', work.id)],
      'schema:datePublished': [cited('schema:datePublished', date('+2010-02-23T00:00:00Z'))],
    },
  });
  const originalDate = edition.statements['schema:datePublished'][0];
  const originalWork = edition.statements['schema:exampleOfWork'][0];
  const wrongDate = await proposed(edition.id, cited('schema:datePublished', date('+1914-09-20T00:00:00Z')));
  const rejected = await decide(edition.id, wrongDate, 'reject', GLOBAL_CONTEXT, null);
  expect(rejected.body).toEqual({
    acceptance: { context: GLOBAL_CONTEXT, candidate: wrongDate, decision: 'reject', head: 1 },
    revision: 3,
  });
  const dates = (await view(edition.id)).subject.statements['schema:datePublished'];
  expect(dates.map((s: any) => [s.id, s.rank, s.rezics.revision])).toEqual([[originalDate.id, 'normal', 1]]);
  expect(JSON.stringify(dates)).not.toContain(wrongDate);
  const rejectedCandidate = (await listed(edition.id, 'schema:datePublished')).candidates[1];
  expect(rejectedCandidate).toMatchObject({
    id: wrongDate,
    decision: 'rejected',
    head: 1,
    rank: 'deprecated',
  });
  expect(rejectedCandidate.statement.references).toMatchObject(originalDate.references);
  const alternative = await proposed(edition.id, cited('schema:exampleOfWork', work.id, { rank: 'preferred' }));
  const before = await revisions(edition.id);
  for (const [property, candidate] of [
    ['schema:datePublished', wrongDate],
    ['schema:exampleOfWork', alternative],
  ] as const) {
    const refused = await adopt(edition.id, {
      property,
      mode: 'replace',
      selection: [pick(candidate)],
      expected_head: 1,
    });
    expect([property, refused.response.status, refused.body.code]).toEqual([property, 409, 'conflict']);
  }
  const adoptedRejection = await decide(edition.id, originalDate.id, 'reject', GLOBAL_CONTEXT, 1);
  expect([adoptedRejection.response.status, adoptedRejection.body.code]).toEqual([409, 'conflict']);
  expect(await revisions(edition.id)).toEqual(before);
  expect((await decide(edition.id, alternative, 'accept', GLOBAL_CONTEXT, null)).response.status).toBe(200);
  const both = await adopt(edition.id, {
    property: 'schema:exampleOfWork',
    mode: 'replace',
    selection: [pick(originalWork.id), pick(alternative)],
    expected_head: 1,
  });
  expect(both.response.status).toBe(400);
  expect(both.body.errors).toContainEqual({ pointer: '/selection', code: 'out_of_range' });
  const one = await adopt(edition.id, {
    property: 'schema:exampleOfWork',
    mode: 'replace',
    selection: [pick(alternative)],
    expected_head: 1,
  });
  expect(one.response.status).toBe(200);
  expect((await view(edition.id)).subject.statements['schema:exampleOfWork'].map((s: any) => s.id)).toEqual([
    alternative,
  ]);
});

test('decisions and adoptions are validated and authorized before anything is written', async () => {
  const soseki = await person('Natsume Sōseki');
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Kokoro' },
    statements: {
      'schema:author': [cited('schema:author', soseki.id)],
      'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
    },
  });
  const author = book.statements['schema:author'][0];
  const language = book.statements['schema:inLanguage'][0];
  const context = await community(book.id);
  const before = await revisions(book.id);
  const invalid: [Record<string, unknown>, string, string][] = [
    [{ property: 'schema:author', mode: 'inherit', selection: [], expected_head: 1 }, '/mode', 'unsupported'],
    [{ property: 'schema:author', mode: 'suppress', selection: [], expected_head: 1 }, '/mode', 'unsupported'],
    [
      { context, property: 'schema:author', mode: 'inherit', selection: [pick(author.id)], expected_head: null },
      '/selection',
      'out_of_range',
    ],
    [
      { property: 'schema:recipeIngredient', mode: 'replace', selection: [], expected_head: null },
      '/property',
      'unsupported',
    ],
    [
      { property: 'schema:author', mode: 'replace', selection: [pick(language.id)], expected_head: 1 },
      '/selection/0/candidate',
      'unsupported',
    ],
    [
      { property: 'schema:author', mode: 'replace', selection: [pick(newId(routeOf(book.id)!))], expected_head: 1 },
      '/selection/0/candidate',
      'unsupported',
    ],
    [
      { property: 'schema:author', mode: 'replace', selection: [pick(author.id, 'deprecated')], expected_head: 1 },
      '/selection/0/rank',
      'unsupported',
    ],
    [
      {
        property: 'schema:author',
        mode: 'replace',
        selection: [pick(author.id), pick(author.id, 'preferred')],
        expected_head: 1,
      },
      '/selection/1/candidate',
      'invalid_format',
    ],
  ];
  for (const [body, pointer, code] of invalid) {
    const answer = await adopt(book.id, body);
    expect([pointer, answer.response.status]).toEqual([pointer, 400]);
    expect(answer.body.errors).toContainEqual({ pointer, code });
  }
  for (const [token, status, code] of [
    [null, 401, 'authentication_required'],
    ['editor', 403, 'forbidden'],
    ['outsider', 403, 'forbidden'],
  ] as const) {
    const decision = await decide(book.id, author.id, 'reject', GLOBAL_CONTEXT, 1, { token });
    const adoption = await adopt(
      book.id,
      { property: 'schema:author', mode: 'replace', selection: [], expected_head: 1 },
      { token },
    );
    expect([token, decision.response.status, decision.body.code, adoption.response.status, adoption.body.code]).toEqual(
      [token, status, code, status, code],
    );
  }
  const unknownCandidate = await decide(book.id, newId(routeOf(book.id)!), 'accept', GLOBAL_CONTEXT, null);
  expect([unknownCandidate.response.status, unknownCandidate.body.code]).toEqual([404, 'not_found']);
  const otherBook = await created({
    type: 'schema:Book',
    labels: { en: 'Botchan' },
    statements: { 'schema:author': [statement('schema:author', soseki.id)] },
  });
  const foreignCandidate = await decide(
    book.id,
    otherBook.statements['schema:author'][0].id,
    'accept',
    GLOBAL_CONTEXT,
    null,
  );
  expect([foreignCandidate.response.status, foreignCandidate.body.code]).toEqual([404, 'not_found']);
  for (const id of [newId(routeOf(book.id)!), 'not-an-id']) {
    const decision = await decide(id, author.id, 'accept', GLOBAL_CONTEXT, null);
    const adoption = await adopt(id, { property: 'schema:author', mode: 'replace', selection: [], expected_head: 1 });
    expect([id, decision.response.status, adoption.response.status]).toEqual([id, 404, 404]);
  }
  const unknownContext = await decide(book.id, author.id, 'accept', newId(routeOf(book.id)!), null);
  expect([unknownContext.response.status, unknownContext.body.code]).toEqual([403, 'forbidden']);
  expect((await decide(book.id, author.id, 'accept', 'not-a-context', null)).response.status).toBe(400);
  expect(await revisions(book.id)).toEqual(before);
  expect(await expansions(book.id, 'schema:author')).toBe(0);
});

test('concurrent adoptions at one expected head commit exactly once and replay the winner', async () => {
  const soseki = await person('Natsume Sōseki');
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Kokoro' },
    statements: { 'schema:author': [statement('schema:author', soseki.id, { rank: 'preferred' })] },
  });
  const author = book.statements['schema:author'][0];
  const bodies = [[pick(author.id, 'preferred')], [pick(author.id)]].map((selection) => ({
    property: 'schema:author',
    mode: 'replace',
    selection,
    expected_head: 1,
  }));
  const keys = [key(), key()];
  const results = await Promise.all(bodies.map((body, i) => adopt(book.id, body, { key: keys[i]! })));
  expect(results.map((r) => r.response.status).sort()).toEqual([200, 409]);
  const winner = results.findIndex((r) => r.response.status === 200);
  expect(results[1 - winner]!.body.code).toBe('stale_editorial_head');
  expect((await revisions(book.id)).map((row) => row.revision)).toEqual([1, 2]);
  expect((await adopt(book.id, bodies[winner]!, { key: keys[winner]! })).body).toEqual(results[winner]!.body);
  const conflict = await adopt(book.id, bodies[1 - winner]!, { key: keys[winner]! });
  expect([conflict.response.status, conflict.body.code]).toEqual([422, 'idempotency_conflict']);
  expect(await expansions(book.id, 'schema:author')).toBe(1);
});

test('a community Context inherits, rejects, suppresses and replaces without changing the Global view', async () => {
  const soseki = await person('Natsume Sōseki');
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Kokoro' },
    statements: {
      'schema:author': [cited('schema:author', soseki.id, { rank: 'preferred' })],
      'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
    },
  });
  const original = book.statements['schema:author'][0];
  const global = await view(book.id);
  const context = await community(soseki.id);
  expect((await view(book.id, context)).subject).toEqual({ ...global.subject, context });
  const rejected = await decide(book.id, original.id, 'reject', context, null);
  expect(rejected.body.acceptance).toEqual({ context, candidate: original.id, decision: 'reject', head: 1 });
  const contextRoute = routeOf(context);
  if (contextRoute === null) throw new Error('Community Context id must carry its route');
  expect(realAccess.checks.at(-1)).toEqual({
    persona: 'acceptor',
    action: 'context:accept',
    resource: { route: contextRoute, id: context },
  });
  expect((await listed(book.id, 'schema:author', `&context=${context}`)).candidates).toMatchObject([
    { id: original.id, decision: 'rejected', head: 1, rank: null },
  ]);
  expect((await listed(book.id, 'schema:author')).candidates).toMatchObject([
    { id: original.id, decision: 'accepted', head: 1, rank: 'preferred' },
  ]);
  const contested = (await view(book.id, context)).subject;
  expect(contested.statements['schema:author'] ?? []).toEqual([]);
  expect(contested.statements['schema:inLanguage']).toEqual(global.subject.statements['schema:inLanguage']);
  expect(contested.resolution).toEqual({ 'schema:author': 'unresolved' });
  const suppress = await adopt(book.id, {
    context,
    property: 'schema:author',
    mode: 'suppress',
    selection: [],
    expected_head: null,
  });
  expect(suppress.body.adoption).toEqual({
    context,
    property: 'schema:author',
    mode: 'suppress',
    selection: [],
    head: 1,
  });
  const suppressed = (await view(book.id, context)).subject;
  expect(suppressed.statements['schema:author'] ?? []).toEqual([]);
  expect(suppressed.resolution).toEqual({ 'schema:author': 'suppressed' });
  expect((await decide(book.id, original.id, 'accept', context, 1)).body.acceptance.head).toBe(2);
  expect(
    (await adopt(book.id, { context, property: 'schema:author', mode: 'inherit', selection: [], expected_head: 1 }))
      .response.status,
  ).toBe(200);
  const restored = (await view(book.id, context)).subject;
  expect(restored.statements).toEqual(global.subject.statements);
  expect(restored.resolution).toEqual({});
  const replaced = await adopt(book.id, {
    context,
    property: 'schema:author',
    mode: 'replace',
    selection: [pick(original.id)],
    expected_head: 2,
  });
  expect(replaced.body.adoption.head).toBe(3);
  expect((await view(book.id, context)).subject.statements['schema:author'].map((s: any) => [s.id, s.rank])).toEqual([
    [original.id, 'normal'],
  ]);
  expect((await listed(book.id, 'schema:author', `&context=${context}`)).adoption).toEqual({
    mode: 'replace',
    head: 3,
  });
  const after = await view(book.id);
  expect(after.subject.statements).toEqual(global.subject.statements);
  expect(after.subject.revision).toBe(6);
  const rows = await revisions(book.id);
  expect(rows.map((row) => row.kind)).toEqual(['create', 'reject', 'adopt', 'accept', 'adopt', 'adopt']);
  expect(rows.every((row) => row.route === routeOf(book.id))).toBe(true);
  const other = await community(soseki.id, false);
  const denied = [
    await decide(book.id, original.id, 'accept', other, null),
    await adopt(book.id, {
      context: other,
      property: 'schema:author',
      mode: 'suppress',
      selection: [],
      expected_head: null,
    }),
  ];
  expect(denied.map((d) => [d.response.status, d.body.code])).toEqual([
    [403, 'forbidden'],
    [403, 'forbidden'],
  ]);
  expect(await revisions(book.id)).toEqual(rows);
  const nowhere = newId(routeOf(book.id)!);
  for (const path of [
    `/v1/subjects/${book.id}?context=${nowhere}`,
    `/v1/subjects/${book.id}/candidates?property=schema:author&context=${nowhere}`,
  ]) {
    const answer = await call('GET', path);
    expect([path, answer.response.status, answer.body.code]).toEqual([path, 404, 'not_found']);
  }
});

test('the kernel contract documents decisions and adoption at their custom-method paths', () => {
  const paths = openApiDocument(kernel).paths;
  for (const [path, operationId] of [
    ['/v1/subjects/{id}/candidates/{candidate}:accept', 'subject.accept_candidate'],
    ['/v1/subjects/{id}/candidates/{candidate}:reject', 'subject.reject_candidate'],
    ['/v1/subjects/{id}:adopt', 'subject.adopt'],
  ] as const) {
    const operation = paths[path]!.post!;
    expect([path, operation.operationId]).toEqual([path, operationId]);
    expect(Object.keys(operation.responses!).sort()).toEqual(['200', '400', '401', '403', '404', '409', '422', '503']);
  }
});
