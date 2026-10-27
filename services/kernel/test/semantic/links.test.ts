import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { createRealAccess } from './real-access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const relays = startRelays(pool, [linkProjection(pool)], { intervalMs: 50 });
afterAll(async () => {
  await relays.stop();
  await pool.end();
  await admin.end();
});

const accounts = {
  editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001',
  acceptor: '019a1b2c-3d4e-7f00-8a00-acce97000002',
};
const actions = ['subject:create', 'subject:read', 'statement:propose', 'context:accept', 'context:adopt'];
const realAccess = await createRealAccess(admin, accounts, actions);
beforeAll(async () => {
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'statement:propose');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', 'context:accept');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', 'context:adopt');
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens,
  routeKey: new Uint8Array(32).fill(4),
  writeRate: realAccess.writeRate,
});

const sessions: Record<string, string> = {};
async function call(
  method: string,
  path: string,
  options: { as?: string; key?: string; body?: unknown; kernel?: typeof kernel } = {},
) {
  const headers: Record<string, string> = {};
  if (options.as) {
    const credential = Object.hasOwn(accounts, options.as)
      ? realAccess.bearer(options.as as keyof typeof accounts)
      : options.as;
    headers.authorization = `Bearer ${credential}`;
    const session = sessions[options.as];
    if (session) headers['rezics-session-token'] = session;
  }
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await (options.kernel ?? kernel).handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const session = response.headers.get('rezics-session-token');
  if (options.as && session) sessions[options.as] = session;
  return { response, body: (await response.json()) as Record<string, any> };
}
const key = () => `"${randomUUID()}"`;
const statement = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});
const reference = { parts: [statement('schema:url', 'https://www.aozora.gr.jp/cards/000148/card773.html')] };
async function created(body: unknown, target = kernel): Promise<Record<string, any>> {
  const answer = await call('POST', '/v1/subjects', { as: 'editor', key: key(), body, kernel: target });
  expect(answer.response.status).toBe(201);
  return answer.body.subject;
}
const work = (title: string, statements: Record<string, unknown> = {}) =>
  created({ type: 'schema:Book', labels: { en: title }, statements });
const edition = (title: string, workId: string, statements: Record<string, unknown> = {}) =>
  created({
    type: 'bf:Instance',
    labels: { en: title },
    statements: { 'schema:exampleOfWork': [statement('schema:exampleOfWork', workId)], ...statements },
  });
const linkOf = (source: Record<string, any>, property: string, includeLabels = true) => ({
  subject: source.id as string,
  property,
  statement: source.statements[property][0].id as string,
  ...(includeLabels
    ? {
        type: source.type as string,
        label: source.labels.en as string,
        summary: {
          id: source.id,
          type: source.type,
          types: [source.type, ...bundledRelease.types[source.type]!.bases],
          label: { value: source.labels.en, language: 'en' },
          creativeWork:
            bundledRelease.types[source.type]!.bases.includes('schema:CreativeWork') ||
            source.type === 'schema:CreativeWork',
          cover: null,
        },
      }
    : {}),
});
const fresh = (caught_up: boolean) => ({ consistency: 'eventual', target_seconds: 10, caught_up });
async function links(id: string, persona?: string, query = '') {
  const answer = await call('GET', `/v1/subjects/${id}/links${query}`, persona ? { as: persona } : {});
  expect(answer.response.status).toBe(200);
  return answer.body;
}
async function inbound(id: string) {
  const { rows } = await admin.query(
    `SELECT route, property, source_subject_id, statement_id, present FROM semantic.inbound_link
     WHERE subject_id = $1 ORDER BY property, source_subject_id, statement_id`,
    [id],
  );
  return rows;
}

test('an item-valued statement becomes an incoming link in the target partition only after the projection applies it', async () => {
  const kokoro = await work('Kokoro');
  await relays.pause();
  try {
    const penguin = await edition('Kokoro, Penguin Classics', kokoro.id);
    const link = linkOf(penguin, 'schema:exampleOfWork');
    expect(await inbound(kokoro.id)).toEqual([]);
    expect(await links(kokoro.id)).toEqual({ links: [], freshness: fresh(true), next: null });
    const started = performance.now();
    const stale = await links(kokoro.id, 'editor');
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(stale).toEqual({ links: [], freshness: fresh(false), next: null });
    relays.resume();
    expect(await links(kokoro.id, 'editor')).toEqual({ links: [link], freshness: fresh(true), next: null });
    expect(await inbound(kokoro.id)).toEqual([
      {
        route: routeOf(kokoro.id),
        property: 'schema:exampleOfWork',
        source_subject_id: penguin.id,
        statement_id: link.statement,
        present: true,
      },
    ]);
    expect(await inbound(penguin.id)).toEqual([]);
  } finally {
    relays.resume();
  }
});

test('a stale links read leaves at least half of the request deadline to authorization and the read', async () => {
  const boundedKernel = createKernel({
    pool,
    access: realAccess.access,
    tokens,
    routeKey: new Uint8Array(32).fill(4),
    writeRate: realAccess.writeRate,
    requestDeadlineMs: 2_000,
  });
  await relays.pause();
  try {
    const kokoro = await created({ type: 'schema:Book', labels: { en: 'Kokoro' } }, boundedKernel);
    await created(
      {
        type: 'bf:Instance',
        labels: { en: 'Kokoro, Penguin Classics' },
        statements: { 'schema:exampleOfWork': [statement('schema:exampleOfWork', kokoro.id)] },
      },
      boundedKernel,
    );
    const started = performance.now();
    const stale = await call('GET', `/v1/subjects/${kokoro.id}/links`, {
      as: 'editor',
      kernel: boundedKernel,
    });
    const elapsed = performance.now() - started;
    expect(stale.response.status).toBe(200);
    expect(stale.body).toEqual({ links: [], freshness: fresh(false), next: null });
    expect(elapsed).toBeLessThan(1_500);
  } finally {
    relays.resume();
  }
});

test('a Global adoption is scoped to the target slot and replaying the whole log keeps both links', async () => {
  const kokoro = await work('Kokoro');
  const botchan = await work('Botchan');
  const penguin = await edition('Kokoro, Penguin Classics', kokoro.id);
  const original = linkOf(penguin, 'schema:exampleOfWork');
  expect((await links(kokoro.id, 'editor')).links).toEqual([original]);
  const proposal = await call('POST', `/v1/subjects/${penguin.id}/candidates`, {
    as: 'editor',
    key: key(),
    body: { statement: { ...statement('schema:exampleOfWork', botchan.id), references: [reference] } },
  });
  expect(proposal.response.status).toBe(201);
  const candidate = proposal.body.candidate as string;
  expect(await links(botchan.id, 'editor')).toEqual({ links: [], freshness: fresh(true), next: null });
  const accepted = await call('POST', `/v1/subjects/${penguin.id}/candidates/${candidate}:accept`, {
    as: 'acceptor',
    key: key(),
    body: { context: GLOBAL_CONTEXT, expected_head: null },
  });
  expect(accepted.response.status).toBe(200);
  expect((await links(kokoro.id, 'acceptor')).links).toEqual([original]);
  const adopted = await call('POST', `/v1/subjects/${penguin.id}:adopt`, {
    as: 'acceptor',
    key: key(),
    body: {
      context: GLOBAL_CONTEXT,
      property: 'schema:exampleOfWork',
      target: botchan.id,
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
      expected_head: null,
    },
  });
  expect(adopted.response.status).toBe(200);
  const moved = { ...original, statement: candidate };
  expect(await links(kokoro.id, 'acceptor')).toEqual({ links: [original], freshness: fresh(true), next: null });
  expect(await links(botchan.id, 'acceptor')).toEqual({ links: [moved], freshness: fresh(true), next: null });
  await relays.pause();
  await admin.query("UPDATE core.consumer_checkpoint SET epoch = NULL, position = 0 WHERE consumer = 'semantic_links'");
  relays.resume();
  expect(await links(botchan.id, 'acceptor')).toEqual({ links: [moved], freshness: fresh(true), next: null });
  expect(await links(kokoro.id, 'acceptor')).toEqual({ links: [original], freshness: fresh(true), next: null });
  expect((await inbound(kokoro.id)).map((row) => [row.statement_id, row.present])).toEqual([
    [original.statement, true],
  ]);
  expect((await inbound(botchan.id)).map((row) => [row.statement_id, row.present])).toEqual([[candidate, true]]);
});

test('links are filtered by property and paged in declared order', async () => {
  const soseki = await created({ type: 'schema:Person', labels: { en: 'Natsume Sōseki' } });
  const books: Record<string, any>[] = [];
  for (const title of ['Kokoro', 'Botchan', 'Sanshirō']) {
    books.push(await work(title, { 'schema:author': [statement('schema:author', soseki.id)] }));
  }
  const translated = await edition('Kokoro, translated', books[0]!.id, {
    'schema:translator': [statement('schema:translator', soseki.id)],
  });
  const authored = books
    .map((book) => linkOf(book, 'schema:author', true))
    .sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
  const translation = linkOf(translated, 'schema:translator', true);
  expect(await links(soseki.id, 'editor')).toEqual({
    links: [...authored, translation],
    freshness: fresh(true),
    next: null,
  });
  const first = await links(soseki.id, 'editor', '?property=schema%3Aauthor&limit=2');
  expect(first).toEqual({
    links: authored.slice(0, 2),
    count: { value: 3, exact: true },
    freshness: fresh(true),
    next: expect.any(String),
  });
  const cursor = encodeURIComponent(first.next);
  expect(await links(soseki.id, 'editor', `?property=schema%3Aauthor&limit=2&cursor=${cursor}`)).toEqual({
    links: authored.slice(2),
    count: { value: 3, exact: true },
    freshness: fresh(true),
    next: null,
  });
  expect(await links(soseki.id, 'editor', '?property=schema%3Atranslator')).toEqual({
    links: [translation],
    count: { value: 1, exact: true },
    freshness: fresh(true),
    next: null,
  });
  expect((await links(books[0]!.id, 'editor')).links).toEqual([linkOf(translated, 'schema:exampleOfWork')]);
  for (const query of [
    `?property=schema%3Atranslator&cursor=${cursor}`,
    `?cursor=${cursor}`,
    '?cursor=forged',
    '?limit=0',
    '?limit=101',
    '?property=schema%3AnotAProperty',
  ]) {
    const answer = await call('GET', `/v1/subjects/${soseki.id}/links${query}`);
    expect([query, answer.response.status]).toEqual([query, 400]);
  }
});

test('unknown and malformed subjects have the same links 404', async () => {
  const unknown = await call('GET', `/v1/subjects/${newId(1234)}/links`);
  const malformed = await call('GET', '/v1/subjects/not-an-id/links');
  for (const answer of [unknown, malformed]) {
    expect([answer.response.status, answer.body.code]).toEqual([404, 'not_found']);
  }
  const { request_id: _unknown, ...a } = unknown.body;
  const { request_id: _malformed, ...b } = malformed.body;
  expect(a).toEqual(b);
});

test('the kernel contract documents the links read', () => {
  const operation = openApiDocument(kernel).paths['/v1/subjects/{id}/links']!.get!;
  expect(operation.operationId).toBe('subject.links');
  expect(Object.keys(operation.responses!)).toEqual(expect.arrayContaining(['200', '400', '401', '404', '503']));
});
