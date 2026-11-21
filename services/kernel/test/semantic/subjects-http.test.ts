import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { beginIdentityBirthTransaction } from '../../src/command/gate.ts';
import { startRelays } from '../../src/events/relays.ts';
import { Admission } from '../../src/http/admission.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { createRealAccess } from './real-access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { subjectTarget } from '../../src/semantic/subject.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';

import { observeSql } from '../content/support/sql-observer.ts';
import initializePublication from '../../src/semantic/subject-page-publication-initialize.sql';
import lockPublication from '../../src/semantic/subject-page-publication-lock.sql';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const projection = linkProjection(pool);
const relays = startRelays(pool, [projection], { intervalMs: 50 });
afterAll(async () => {
  await relays.stop();
  await pool.end();
  await admin.end();
});

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) };
const routeKey = new Uint8Array(32).fill(13);
const accounts = {
  writer: '019a1b2c-3d4e-7f00-8a00-5ab1ec700001',
  reader: '019a1b2c-3d4e-7f00-8a00-4eade0000002',
  moderator: '019a1b2c-3d4e-7f00-8a00-0d0000000012',
};
const realAccess = await createRealAccess(admin, accounts, ['subject:create', 'subject:read', 'moderation:hide']);
const kernel = createKernel({ pool, access: realAccess.access, tokens, routeKey, writeRate: realAccess.writeRate });

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'writer', 'subject:create');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'moderator', 'moderation:hide');
});

async function call(
  method: string,
  path: string,
  options: { token?: string; key?: string; body?: unknown; session?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token) {
    const credential = Object.hasOwn(accounts, options.token)
      ? realAccess.bearer(options.token as keyof typeof accounts)
      : options.token;
    headers.authorization = `Bearer ${credential}`;
  }
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
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

async function catchUpLinks(id: string): Promise<void> {
  const route = routeOf(id)!;
  for (let step = 0; step < 200; step++) {
    const result = await projection.run(partitionOf(route));
    if (result.status === 'busy') {
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }
    if (result.envelopes === 0) return;
  }
  throw new Error('Semantic link projection did not catch up');
}

const create = (body: Record<string, unknown>, key = `"${randomUUID()}"`, token = 'writer') =>
  call('POST', '/v1/subjects', { token, key, body: { type: 'schema:Book', ...body } });
const author = (id: string) => ({ property: { id: 'schema:author' }, value: { type: 'value', content: id } });

test('a create is 201 with its location and session token, and its key replays it', async () => {
  const key = `"${randomUUID()}"`;
  const book = { type: 'schema:Book', labels: { en: 'Botchan', ja: '坊っちゃん' } };
  const first = await create(book, key);
  expect(first.response.status).toBe(201);
  const id = first.body.subject.id as string;
  expect(first.body).toEqual({
    subject: expect.objectContaining({
      id,
      type: 'schema:Book',
      revision: 1,
      context: GLOBAL_CONTEXT,
      labels: book.labels,
      descriptions: {},
      aliases: {},
      statements: {},
    }),
  });
  expect(first.response.headers.get('location')).toBe(`/v1/subjects/${id}`);
  expect(first.response.headers.get('etag')).toBe('"1"');
  const session = first.response.headers.get(SESSION_HEADER)!;
  expect(decodeSession(tokens, `account:${accounts.writer}`, session)).toHaveLength(1);

  // A different replica may already be writing on this basis shard. A persisted
  // receipt still receives current authorization and its original digest check.
  const competing = await admin.connect();
  try {
    expect(await beginIdentityBirthTransaction(competing, partitionOf(routeOf(id)!))).toBe('writer');
    const again = await create({ labels: { ja: '坊っちゃん', en: 'Botchan' } }, key);
    expect(again.response.status).toBe(201);
    expect(again.body.subject.id).toBe(id);
    expect(again.response.headers.get('location')).toBe(`/v1/subjects/${id}`);

    const reused = await create({ labels: { en: 'Kokoro' } }, key);
    expect(reused.response.status).toBe(422);
    expect(reused.body).toMatchObject({ code: 'idempotency_conflict', effect_status: 'not_applied' });
  } finally {
    await competing.query('ROLLBACK');
    competing.release();
  }
});

test('a queued creation checks the parent grant again after the competing writer releases its shard', async () => {
  const rawKey = randomUUID();
  const label = rawKey;
  const target = subjectTarget(routeKey, accounts.writer, rawKey);
  const parent = { route: 0, id: GLOBAL_CONTEXT };
  const holder = await admin.connect();
  let pending: ReturnType<typeof create> | undefined;
  try {
    expect(await beginIdentityBirthTransaction(holder, partitionOf(target.route))).toBe('writer');
    const { pid } = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]!;
    pending = create({ labels: { en: label } }, JSON.stringify(rawKey));
    const waitForWriter = async () => {
      let waiting = false;
      const until = Date.now() + 1800;
      while (!waiting && Date.now() < until) {
        waiting = (
          await admin.query(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND $1::integer=ANY(pg_blocking_pids(pid))) AS waiting",
            [pid],
          )
        ).rows[0]!.waiting;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
    };
    await waitForWriter();
    await realAccess.revoke(parent, 'writer', 'subject:create');
    await holder.query('ROLLBACK');
    expect((await pending).response.status).toBe(403);
    expect(
      (await admin.query('SELECT 1 FROM semantic.subject WHERE route=$1 AND canonical_name=$2', [target.route, label]))
        .rowCount,
    ).toBe(0);

    await realAccess.grant(parent, 'writer', 'subject:create');
    expect(await beginIdentityBirthTransaction(holder, partitionOf(target.route))).toBe('writer');
    pending = create({ labels: { en: label } }, JSON.stringify(rawKey));
    await waitForWriter();
    await holder.query('ROLLBACK');
    const resumed = await pending;
    expect(resumed.response.status).toBe(201);
    expect(resumed.response.headers.get('location')).toBe(`/v1/subjects/${resumed.body.subject.id}`);
    expect(
      (
        await admin.query('SELECT subject_id AS id FROM semantic.subject WHERE route=$1 AND canonical_name=$2', [
          target.route,
          label,
        ])
      ).rows,
    ).toEqual([{ id: resumed.body.subject.id }]);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await pending?.catch(() => {});
    await realAccess.grant(parent, 'writer', 'subject:create');
  }
});

test('a fresh Book publishes its first label on its original locked point and receipt replay leaves the publication intact', async () => {
  const key = JSON.stringify(randomUUID());
  const book = { labels: { en: 'Initial publication' } };
  const observer = observeSql(pool);
  try {
    const first = await create(book, key);
    expect(first.response.status).toBe(201);
    const id = first.body.subject.id as string;
    const point = async () =>
      (
        await admin.query(
          'SELECT readiness, generation::text, completed_position::text, change_position::text, public_effective_at, evidence, ctid::text AS version FROM semantic.subject_page_publication WHERE route=$1 AND subject_id=$2',
          [routeOf(id), id],
        )
      ).rows[0];
    const created = await point();
    expect(created).toMatchObject({
      readiness: 'ready',
      evidence: 'known',
      completed_position: '1',
      change_position: '1',
    });
    expect(created.public_effective_at).toBeInstanceOf(Date);
    const replay = await create(book, key);
    expect(replay.response.status).toBe(201);
    expect(replay.body.subject.id).toBe(id);
    expect(await point()).toEqual(created);
    const subjectReads = observer.records.filter(({ parameters }) => parameters.includes(id));
    expect(
      subjectReads.filter(({ statement }) => statement === initializePublication['~standard'].query.text),
    ).toHaveLength(1);
    expect(subjectReads.filter(({ statement }) => statement === lockPublication['~standard'].query.text)).toHaveLength(
      0,
    );
  } finally {
    await observer.close();
  }
}, 60_000);

test('a create needs an account, a structured idempotency key, a valid item and the create grant', async () => {
  const book = { type: 'schema:Book', labels: { en: 'Kokoro' } };
  const anonymous = await call('POST', '/v1/subjects', { key: `"${randomUUID()}"`, body: book });
  expect(anonymous.response.status).toBe(401);
  expect(anonymous.body.code).toBe('authentication_required');
  expect(anonymous.response.headers.get('www-authenticate')).toBe('Bearer');

  for (const key of [undefined, 'unquoted', '""']) {
    const refused = await call('POST', '/v1/subjects', { token: 'writer', body: book, ...(key ? { key } : {}) });
    expect(refused.response.status).toBe(400);
    expect(refused.body.code).toBe('invalid_request');
  }

  const invalid = await create({ labels: { en: ' padded' } });
  expect(invalid.response.status).toBe(400);
  expect(invalid.body).toMatchObject({
    code: 'invalid_request',
    errors: [{ pointer: '/labels/en', code: 'invalid_format' }],
  });

  const key = `"${randomUUID()}"`;
  const forbidden = await create(book, key, 'reader');
  expect(forbidden.response.status).toBe(403);
  expect(forbidden.body).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
  expect(realAccess.checks.at(-1)).toEqual({
    persona: 'reader',
    action: 'subject:create',
    resource: { route: 0, id: GLOBAL_CONTEXT },
  });
});

test('a public subject read completes its permission checks with one normal permit', async () => {
  const created = await create({ type: 'schema:Book', labels: { en: 'Single permit' } });
  expect(created.response.status).toBe(201);
  const id = created.body.subject.id as string;
  await catchUpLinks(id);
  const admission = new Admission({ permits: 1, reserved: 1, queue: 2 });
  const app = createKernel({ pool, access: realAccess.access, tokens, routeKey, admission });
  const result = await app.handle(new Request(`http://kernel.test/v1/subjects/${id}`));
  expect(result.status).toBe(200);
  expect((await result.json()).subject.id).toBe(id);
  expect(admission.running.normal).toBe(0);
  expect(admission.waiting).toBe(0);
});

test('a read returns the subject, its session token and the labels of its properties and readable subjects', async () => {
  const soseki = (await create({ type: 'schema:Person', labels: { en: 'Natsume Sōseki' } })).body.subject.id as string;
  const secret = (await create({ type: 'schema:Person', labels: { en: 'Unreadable' } })).body.subject.id as string;
  const source = { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/kokoro' } };
  const created = await create({
    type: 'schema:Book',
    labels: { en: 'Kokoro' },
    statements: { 'schema:author': [{ ...author(soseki), references: [{ parts: [source] }] }, author(secret)] },
  });
  const id = created.body.subject.id as string;
  const hidden = await call('POST', `/v1/subjects/${secret}:hide`, {
    token: 'moderator',
    key: `"${randomUUID()}"`,
    body: { reason: 'Hidden for the read test.' },
  });
  expect(hidden.response.status).toBe(200);

  await catchUpLinks(id);
  const page = { language: 'en', limit: '12', context: GLOBAL_CONTEXT };
  const relations = await call(
    'GET',
    `/v1/subjects/${id}/relations?${new URLSearchParams({ ...page, property: 'schema:author' })}`,
  );
  expect(relations.response.status).toBe(200);
  expect(relations.body.relations.map((relation: any) => relation.target)).toEqual([soseki]);
  const inbound = await call(
    'GET',
    `/v1/subjects/${soseki}/links?${new URLSearchParams({ ...page, property: 'schema:author' })}`,
  );
  expect(inbound.response.status).toBe(200);
  expect(inbound.body.links.map((link: any) => [link.subject, link.property])).toEqual([[id, 'schema:author']]);
  const emptyRelations = await call(
    'GET',
    `/v1/subjects/${id}/relations?${new URLSearchParams({ ...page, property: 'schema:exampleOfWork' })}`,
  );
  expect(emptyRelations.response.status).toBe(200);
  expect(emptyRelations.body.relations).toEqual([]);
  const emptyInbound = await call(
    'GET',
    `/v1/subjects/${soseki}/links?${new URLSearchParams({ ...page, property: 'rezics:alternativeVersion' })}`,
  );
  expect(emptyInbound.response.status).toBe(200);
  expect(emptyInbound.body.links).toEqual([]);

  const read = await call('GET', `/v1/subjects/${id}`, { session: created.response.headers.get(SESSION_HEADER)! });
  expect(read.response.status).toBe(200);
  expect(read.response.headers.get('etag')).toBe('"1"');
  expect(read.body.subject).toEqual({
    ...created.body.subject,
    statements: { 'schema:author': [created.body.subject.statements['schema:author'][0]] },
  });
  expect(read.body.account).toBeNull();
  expect(read.body.related).toEqual({
    'schema:author': { labels: bundledRelease.properties['schema:author']!.labels },
    'schema:url': { labels: bundledRelease.properties['schema:url']!.labels },
    [soseki]: {
      labels: { en: 'Natsume Sōseki' },
      type: 'schema:Person',
      types: ['schema:Person', ...bundledRelease.types['schema:Person']!.bases],
      cover: null,
    },
  });
  expect(decodeSession(tokens, 'anonymous', read.response.headers.get(SESSION_HEADER)!)).toHaveLength(1);
  expect(
    realAccess.readChecks.filter(({ action }) => action === 'subject:read').map(({ resource }) => resource.id),
  ).toEqual(expect.arrayContaining([id, soseki]));
  expect(
    realAccess.readChecks.filter(({ action }) => action === 'subject:read').map(({ resource }) => resource.id),
  ).not.toContain(secret);

  const platform = (await create({ type: 'skos:Concept', labels: { en: 'Test platform' } })).body.subject.id as string;
  const gamePlatform = {
    property: { id: 'schema:gamePlatform' },
    value: { type: 'value', content: platform },
    qualifiers: [{ property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'ja' } }],
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/vn-platform' } },
        ],
      },
    ],
  };
  const game = await create({
    type: 'schema:VideoGame',
    labels: { en: 'VN game work' },
    statements: { 'schema:gamePlatform': [gamePlatform] },
  });
  const gameId = game.body.subject.id as string;
  await catchUpLinks(gameId);
  const reader = await call(
    'GET',
    `/v1/subjects/${gameId}?${new URLSearchParams({
      context: GLOBAL_CONTEXT,
      language: 'en',
      includeViewerActions: 'true',
    })}`,
  );
  expect(reader.response.status).toBe(200);
  expect(reader.body.subject).toMatchObject({ id: gameId, type: 'schema:VideoGame' });
  expect(reader.body.subject.release).toBe(game.body.subject.release);
  expect(reader.body.subject.statements).toEqual(game.body.subject.statements);
  expect(reader.body.related[platform]).toMatchObject({
    labels: { en: 'Test platform' },
    type: 'skos:Concept',
    types: expect.arrayContaining(['skos:Concept']),
    cover: null,
  });
  expect(reader.body.viewerActions).toEqual({ state: 'available', actions: [] });
  expect(
    realAccess.readChecks.filter(({ action }) => action === 'subject:read').map(({ resource }) => resource.id),
  ).toEqual(expect.arrayContaining([gameId, platform]));
});

test('anonymous inverse relation pages keep current summaries and continuation across source homes', async () => {
  const person = (await create({ type: 'schema:Person', labels: { en: 'Cross-home author' } })).body.subject
    .id as string;
  const homes = new Set<number>();
  const books: string[] = [];
  for (let index = 0; index < 3; index++) {
    let key = '';
    for (let attempt = 0; attempt < 10_000; attempt++) {
      const value = randomUUID();
      const home = partitionOf(subjectTarget(routeKey, accounts.writer, value).route);
      if (homes.has(home)) continue;
      homes.add(home);
      key = `"${value}"`;
      break;
    }
    if (!key) throw new Error('Unable to select distinct source homes for the inverse page fixture');
    const created = await create(
      {
        labels: { en: `Cross-home book ${index}` },
        statements: { 'schema:author': [author(person)] },
      },
      key,
    );
    const id = created.body.subject.id as string;
    books.push(id);
    await catchUpLinks(id);
  }

  const query = new URLSearchParams({ property: 'schema:author', language: 'en', limit: '2' });
  const path = `/v1/subjects/${person}/links?${query}`;
  const first = await call('GET', path);
  expect(first.response.status).toBe(200);
  expect(first.body.links).toHaveLength(2);
  expect(first.body.next).toBeString();
  const second = await call('GET', `${path}&${new URLSearchParams({ cursor: first.body.next })}`);
  expect(second.response.status).toBe(200);
  expect(second.body.links).toHaveLength(1);
  expect(second.body.next).toBeNull();
  const links = [...first.body.links, ...second.body.links];
  expect(new Set(links.map((link) => link.subject))).toEqual(new Set(books));
  expect(links.every((link) => link.summary?.type === 'schema:Book' && link.label.startsWith('Cross-home book '))).toBe(
    true,
  );
});

test('a malformed, missing or unreadable subject is the same 404', async () => {
  const id = (await create({ type: 'schema:Person', labels: { en: 'Sanshirō' } })).body.subject.id as string;
  const hidden = await call('POST', `/v1/subjects/${id}:hide`, {
    token: 'moderator',
    key: `"${randomUUID()}"`,
    body: { reason: 'Hidden for the 404 test.' },
  });
  expect(hidden.response.status).toBe(200);
  const answers = await Promise.all(
    ['not-an-id', newId(0x0042), id].map((subject) => call('GET', `/v1/subjects/${subject}`, { token: 'reader' })),
  );
  for (const { response, body } of answers) {
    expect(response.status).toBe(404);
    expect(response.headers.get(SESSION_HEADER)).toBeNull();
    const { request_id: _, ...problem } = body;
    expect(problem).toEqual({
      type: 'https://rezics.com/problems/not_found',
      title: 'Not Found',
      status: 404,
      code: 'not_found',
      retryable: false,
      effect_status: 'not_applicable',
    });
  }
});

test('the kernel contract documents both subject operations with their actions and problems', () => {
  const paths = openApiDocument(kernel).paths;
  const created = paths['/v1/subjects']!.post!;
  expect(created).toMatchObject({
    operationId: 'subject.create',
    'x-action': 'subject:create',
    security: [{ bearerAuth: [] }],
  });
  expect(Object.keys(created.responses!).sort()).toEqual(['201', '400', '401', '403', '422', '503']);
  expect(created.parameters).toEqual(
    expect.arrayContaining([expect.objectContaining({ in: 'header', name: 'idempotency-key', required: true })]),
  );
  const read = paths['/v1/subjects/{id}']!.get!;
  expect(read).toMatchObject({
    operationId: 'subject.get',
    'x-action': 'subject:read',
    security: [{ bearerAuth: [] }, {}],
  });
  expect(Object.keys(read.responses!).sort()).toEqual(['200', '308', '401', '404', '503']);
});
