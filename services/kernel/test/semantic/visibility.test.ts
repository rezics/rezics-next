import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createRealAccess } from './real-access.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
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

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const ACTIONS = ['subject:create', 'subject:read', 'statement:propose', 'moderation:hide', 'moderation:takedown'];
const accounts = {
  editor: '019a1b2c-3d4e-7f00-8a00-ed170e000081',
  moderator: '019a1b2c-3d4e-7f00-8a00-0d0000000082',
  hider: '019a1b2c-3d4e-7f00-8a00-41de00000083',
};
const realAccess = await createRealAccess(admin, accounts, ACTIONS);
beforeAll(async () => {
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'statement:propose');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'moderator', 'moderation:hide');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'moderator', 'moderation:takedown');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'hider', 'moderation:hide');
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});
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
const key = () => `"${randomUUID()}"`;
const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const value = (content: unknown) => ({ type: 'value', content });
const source = { parts: [{ property: { id: 'schema:url' }, value: value('https://example.org/record') }] };
async function created(body: unknown): Promise<Record<string, any>> {
  const answer = await call('POST', '/v1/subjects', { token: 'editor', key: key(), body });
  expect(answer.response.status).toBe(201);
  const route = routeOf(answer.body.subject.id as string)!;
  for (let step = 0; step < 200; step++) {
    const projected = await projection.run(partitionOf(route));
    if (projected.status !== 'busy' && projected.envelopes === 0) break;
    if (step === 199) throw new Error('Semantic link projection did not catch up');
  }
  return answer.body.subject;
}
const person = (name: string) => created({ type: 'schema:Person', labels: { en: name } });
const moderate = (id: string, verb: 'hide' | 'takedown' | 'restore', body: unknown, token = 'moderator', k = key()) =>
  call('POST', `/v1/subjects/${id}:${verb}`, { token, key: k, body });
const hide = (id: string, token?: string) => moderate(id, 'hide', { reason: 'spam' }, token);
const notice = { complaint: 'Rights holder notice for the cover and summary.', received_at: '2026-10-25T09:00:00Z' };
const comparable = (body: Record<string, any>) => {
  const { instance: _instance, request_id: _request, ...rest } = body;
  return rest;
};
async function events(id: string): Promise<{ type: string; data: Record<string, unknown> }[]> {
  const route = routeOf(id);
  if (route === null) throw new Error('Subject id must carry its route');
  const { rows } = await admin.query<{ type: string; data: Record<string, unknown> }>(
    `SELECT type, data FROM core.outbox
     WHERE partition_no = $1 AND subject = $2 AND type = 'com.rezics.subject.visibility_changed.v1'
     ORDER BY position, event_seq`,
    [route >> 4, id],
  );
  return rows;
}

test('a hidden or taken-down subject reads as unknown and its moderator restores it', async () => {
  const subject = await person('Soseki');
  const unknown = await call('GET', `/v1/subjects/${randomUUID()}`);
  expect(unknown.response.status).toBe(404);

  const hidden = await hide(subject.id);
  expect([hidden.response.status, hidden.body]).toEqual([
    200,
    { subject: subject.id, visibility: 'hidden', security_revision: 1 },
  ]);
  for (const path of [`/v1/subjects/${subject.id}`, `/v1/subjects/${subject.id}/revisions`]) {
    const answer = await call('GET', path);
    expect([path, answer.response.status, comparable(answer.body)]).toEqual([path, 404, comparable(unknown.body)]);
  }
  const candidates = await call('GET', `/v1/subjects/${subject.id}/candidates?property=schema:birthDate`);
  expect([candidates.response.status, candidates.body.code]).toEqual([404, 'not_found']);

  const takenDown = await moderate(subject.id, 'takedown', { notice });
  expect(takenDown.body).toEqual({ subject: subject.id, visibility: 'taken_down', security_revision: 2 });
  expect((await call('GET', `/v1/subjects/${subject.id}`)).response.status).toBe(404);

  const restored = await moderate(subject.id, 'restore', { reason: 'Counter-notice accepted.' });
  expect(restored.body).toEqual({ subject: subject.id, visibility: 'visible', security_revision: 3 });
  const read = await call('GET', `/v1/subjects/${subject.id}`);
  expect(read.response.status).toBe(200);
  expect(read.body.subject.revision).toBe(subject.revision);
  expect(read.response.headers.get('etag')).toBe(`"${subject.revision}"`);

  expect((await events(subject.id)).map(({ data }) => data)).toEqual([
    { id: subject.id, visibility: 'hidden', security_revision: 1 },
    { id: subject.id, visibility: 'taken_down', security_revision: 2 },
    { id: subject.id, visibility: 'visible', security_revision: 3 },
  ]);
  const { rows } = await admin.query(
    `SELECT security_revision::int AS security_revision, action, visibility, body
     FROM semantic.moderation WHERE route = $1 AND subject_id = $2 ORDER BY security_revision`,
    [routeOf(subject.id), subject.id],
  );
  expect(rows).toEqual([
    { security_revision: 1, action: 'hide', visibility: 'hidden', body: { reason: 'spam' } },
    { security_revision: 2, action: 'take_down', visibility: 'taken_down', body: { notice } },
    { security_revision: 3, action: 'restore', visibility: 'visible', body: { reason: 'Counter-notice accepted.' } },
  ]);
});

test('moderation needs its action, refuses the same state and invalid input, and replays by key', async () => {
  const subject = await person('Ogai');
  const state = async () =>
    (
      await admin.query(
        'SELECT visibility, security_revision::int AS security_revision FROM semantic.subject WHERE route = $1 AND subject_id = $2',
        [routeOf(subject.id), subject.id],
      )
    ).rows[0];

  expect((await hide(subject.id, 'editor')).response.status).toBe(403);
  expect((await moderate(subject.id, 'hide', { reason: 'spam' }, '')).response.status).toBe(401);
  for (const [verb, body, pointer] of [
    ['hide', {}, '/reason'],
    ['hide', { reason: '' }, '/reason'],
    ['takedown', {}, '/notice'],
    ['takedown', { notice: { ...notice, received_at: 'yesterday' } }, '/notice/received_at'],
  ] as const) {
    const answer = await moderate(subject.id, verb, body);
    expect([verb, answer.response.status, answer.body.code]).toEqual([verb, 400, 'invalid_request']);
    expect(JSON.stringify(answer.body.errors)).toContain(pointer);
  }
  expect((await moderate(subject.id, 'restore', { reason: 'nothing to restore' })).response.status).toBe(409);
  expect((await hide(randomUUID())).response.status).toBe(404);
  expect(await state()).toEqual({ visibility: 'visible', security_revision: 0 });

  const k = key();
  const first = await moderate(subject.id, 'hide', { reason: 'spam' }, 'moderator', k);
  const replay = await moderate(subject.id, 'hide', { reason: 'spam' }, 'moderator', k);
  expect([first.response.status, replay.response.status]).toEqual([200, 200]);
  expect(replay.body).toEqual(first.body);
  expect((await hide(subject.id)).response.status).toBe(409);
  expect(await state()).toEqual({ visibility: 'hidden', security_revision: 1 });

  expect((await moderate(subject.id, 'takedown', { notice }, 'hider')).response.status).toBe(403);
  expect((await moderate(subject.id, 'takedown', { notice })).response.status).toBe(200);
  expect((await moderate(subject.id, 'restore', { reason: 'appeal' }, 'hider')).response.status).toBe(403);
  expect(await state()).toEqual({ visibility: 'taken_down', security_revision: 2 });
});

test('writes and references treat a subject that is not visible as unknown', async () => {
  const author = await person('Akutagawa');
  const book = await created({
    type: 'schema:Book',
    labels: { ja: '羅生門' },
    statements: { 'schema:author': [{ property: { id: 'schema:author' }, value: value(author.id) }] },
  });
  const before = await call('GET', `/v1/subjects/${book.id}`);
  expect(before.body.related[author.id]).toBeDefined();

  expect((await hide(author.id)).response.status).toBe(200);
  const after = await call('GET', `/v1/subjects/${book.id}`);
  expect(after.response.status).toBe(200);
  expect(after.body.related[author.id]).toBeUndefined();
  expect(after.body.subject.statements['schema:author'][0].value.content).toBe(author.id);

  const referencing = await call('POST', '/v1/subjects', {
    token: 'editor',
    key: key(),
    body: {
      type: 'schema:Book',
      labels: { ja: '鼻' },
      statements: { 'schema:author': [{ property: { id: 'schema:author' }, value: value(author.id) }] },
    },
  });
  expect([referencing.response.status, referencing.body.errors]).toEqual([
    400,
    [{ pointer: '/statements/schema:author/0/value/content', code: 'out_of_range' }],
  ]);

  const proposal = await call('POST', `/v1/subjects/${author.id}/candidates`, {
    token: 'editor',
    key: key(),
    body: {
      statement: {
        property: { id: 'schema:birthDate' },
        value: value({ time: '+1892-03-01T00:00:00Z', precision: 11, calendarmodel: GREGORIAN }),
        references: [source],
      },
    },
  });
  expect([proposal.response.status, proposal.body.code]).toEqual([404, 'not_found']);
  const { rows } = await admin.query(
    'SELECT count(*)::int AS revisions FROM semantic.revision WHERE route = $1 AND subject_id = $2',
    [routeOf(author.id), author.id],
  );
  expect(rows[0].revisions).toBe(1);
});
