import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createRealAccess } from './real-access.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { readCandidateDisclosure } from '../../src/semantic/disclosure.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

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

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const ACTIONS = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'moderation:hide',
  'moderation:takedown',
];
const accounts = {
  editor: '019a1b2c-3d4e-7f00-8a00-ed170e000091',
  moderator: '019a1b2c-3d4e-7f00-8a00-0d0000000092',
  hider: '019a1b2c-3d4e-7f00-8a00-41de00000093',
};
const realAccess = await createRealAccess(admin, accounts, ACTIONS);
beforeAll(async () => {
  for (const action of ['subject:create', 'statement:propose', 'context:accept', 'context:adopt'])
    await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
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

const sessions: Record<string, string> = {};
async function catchUpLinks(id: string): Promise<void> {
  const route = routeOf(id);
  if (route === null) throw new Error('Subject id must carry a route');
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
async function call(method: string, path: string, options: { as?: string; key?: string; body?: unknown } = {}) {
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
  const response = await kernel.handle(
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
const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const value = (content: unknown) => ({ type: 'value', content });
const statement = (property: string, content: unknown) => ({ property: { id: property }, value: value(content) });
const source = { parts: [statement('schema:url', 'https://example.org/record')] };
async function created(body: unknown): Promise<Record<string, any>> {
  const answer = await call('POST', '/v1/subjects', { as: 'editor', key: key(), body });
  expect(answer.response.status).toBe(201);
  await catchUpLinks(answer.body.subject.id as string);
  return answer.body.subject;
}
const person = (name: string) => created({ type: 'schema:Person', labels: { en: name } });
const moderate = (path: string, verb: 'hide' | 'takedown' | 'restore', body: unknown, as = 'moderator', k = key()) =>
  call('POST', `/v1/subjects/${path}:${verb}`, { as, key: k, body });
const notice = { complaint: 'Rights holder notice for this statement.', received_at: '2026-10-25T09:00:00Z' };
const ids = (subject: Record<string, any>, property: string) =>
  ((subject.statements[property] ?? []) as { id: string }[]).map(({ id }) => id);
const comparable = (body: Record<string, any>) => {
  const { instance: _instance, request_id: _request, ...rest } = body;
  return rest;
};
async function read(id: string) {
  const answer = await call('GET', `/v1/subjects/${id}`);
  expect(answer.response.status).toBe(200);
  expect(answer.response.headers.get('cache-control')).toBe('no-cache');
  return answer.body;
}
async function links(id: string, as = 'moderator') {
  const answer = await call('GET', `/v1/subjects/${id}/links`, { as });
  expect(answer.response.status).toBe(200);
  expect(answer.body.freshness.caught_up).toBe(true);
  return (answer.body.links as { subject: string; statement: string }[]).map((link) => link.statement);
}

test('a hidden or taken-down statement leaves every view and listing until its moderator restores it', async () => {
  const soseki = await person('Natsume Soseki');
  const work = await created({
    type: 'schema:Book',
    labels: { ja: '吾輩は猫である' },
    statements: {
      'schema:author': [statement('schema:author', soseki.id)],
      'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
    },
  });
  const [language] = ids(work, 'schema:inLanguage');
  const before = await read(work.id);

  const hidden = await moderate(`${work.id}/candidates/${language}`, 'hide', { reason: 'spam' });
  expect([hidden.response.status, hidden.body]).toEqual([
    200,
    { subject: work.id, candidate: language, visibility: 'hidden', security_revision: 1 },
  ]);
  const disclosure = async (candidate: string) => {
    const client = await admin.connect();
    try {
      return await readCandidateDisclosure(client, { subject: work.id, candidate });
    } finally {
      client.release();
    }
  };
  expect(await disclosure(language!)).toEqual({ disclosed: false, security_revision: 1 });
  expect(await disclosure(randomUUID())).toBeNull();
  const during = await read(work.id);
  expect(ids(during.subject, 'schema:inLanguage')).toEqual([]);
  expect(ids(during.subject, 'schema:author')).toEqual(ids(work, 'schema:author'));
  expect(during.subject.revision).toBe(work.revision);
  const listing = await call('GET', `/v1/subjects/${work.id}/candidates?property=schema%3AinLanguage`);
  expect([listing.response.status, listing.body.candidates]).toEqual([200, []]);

  const takenDown = await moderate(`${work.id}/candidates/${language}`, 'takedown', { notice });
  expect(takenDown.body).toEqual({
    subject: work.id,
    candidate: language,
    visibility: 'taken_down',
    security_revision: 2,
  });
  const appeal = { reason: 'Counter-notice accepted.' };
  expect((await moderate(`${work.id}/candidates/${language}`, 'restore', appeal, 'hider')).response.status).toBe(403);
  const restored = await moderate(`${work.id}/candidates/${language}`, 'restore', appeal);
  expect(restored.body).toEqual({ subject: work.id, candidate: language, visibility: 'visible', security_revision: 3 });
  expect(await disclosure(language!)).toEqual({ disclosed: true, security_revision: 3 });
  const after = await read(work.id);
  expect([after.subject, after.related]).toEqual([before.subject, before.related]);

  const { rows: events } = await admin.query(
    `SELECT data FROM core.outbox
     WHERE partition_no = $1 AND subject = $2 AND type = 'com.rezics.subject.statement_visibility_changed.v1'
     ORDER BY position, event_seq`,
    [routeOf(work.id)! >> 4, work.id],
  );
  expect(events.map(({ data }) => data)).toEqual([
    { id: work.id, candidate: language, visibility: 'hidden', security_revision: 1 },
    { id: work.id, candidate: language, visibility: 'taken_down', security_revision: 2 },
    { id: work.id, candidate: language, visibility: 'visible', security_revision: 3 },
  ]);
  const { rows } = await admin.query(
    `SELECT security_revision::int AS security_revision, candidate_id, action, visibility
     FROM semantic.moderation WHERE route = $1 AND subject_id = $2 ORDER BY security_revision`,
    [routeOf(work.id), work.id],
  );
  expect(rows).toEqual([
    { security_revision: 1, candidate_id: language, action: 'hide', visibility: 'hidden' },
    { security_revision: 2, candidate_id: language, action: 'take_down', visibility: 'taken_down' },
    { security_revision: 3, candidate_id: language, action: 'restore', visibility: 'visible' },
  ]);
});

test('statement moderation needs its action and treats hidden statements as unknown to decisions', async () => {
  const author = await person('Mori Ogai');
  const other = await person('Higuchi Ichiyo');
  const proposed = await call('POST', `/v1/subjects/${author.id}/candidates`, {
    as: 'editor',
    key: key(),
    body: {
      statement: {
        property: { id: 'schema:birthDate' },
        value: value({ time: '+1862-02-17T00:00:00Z', precision: 11, calendarmodel: GREGORIAN }),
        references: [source],
      },
    },
  });
  expect(proposed.response.status).toBe(201);
  const candidate = proposed.body.candidate as string;
  const path = `${author.id}/candidates/${candidate}`;

  const unknownSubject = await moderate(randomUUID(), 'hide', { reason: 'spam' });
  expect(unknownSubject.response.status).toBe(404);
  for (const target of [
    `${author.id}/candidates/${randomUUID()}`,
    `${author.id}/candidates/nope`,
    `${other.id}/candidates/${candidate}`,
  ]) {
    const answer = await moderate(target, 'hide', { reason: 'spam' });
    expect([target, answer.response.status, comparable(answer.body)]).toEqual([
      target,
      404,
      comparable(unknownSubject.body),
    ]);
  }
  expect((await moderate(path, 'hide', { reason: 'spam' }, 'editor')).response.status).toBe(403);
  expect((await moderate(path, 'hide', { reason: '' })).body.code).toBe('invalid_request');
  expect((await moderate(path, 'restore', { reason: 'nothing to restore' })).response.status).toBe(409);

  const k = key();
  const first = await moderate(path, 'hide', { reason: 'spam' }, 'moderator', k);
  const replay = await moderate(path, 'hide', { reason: 'spam' }, 'moderator', k);
  expect([first.response.status, replay.response.status]).toEqual([200, 200]);
  expect(replay.body).toEqual(first.body);
  expect((await moderate(path, 'hide', { reason: 'spam' })).response.status).toBe(409);
  expect((await moderate(path, 'takedown', { notice }, 'hider')).response.status).toBe(403);

  const accepted = await call('POST', `/v1/subjects/${path}:accept`, {
    as: 'editor',
    key: key(),
    body: { context: GLOBAL_CONTEXT, expected_head: null },
  });
  expect([accepted.response.status, accepted.body.code]).toEqual([404, 'not_found']);
  const adopted = await call('POST', `/v1/subjects/${author.id}:adopt`, {
    as: 'editor',
    key: key(),
    body: {
      context: GLOBAL_CONTEXT,
      property: 'schema:birthDate',
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
      expected_head: null,
    },
  });
  expect([adopted.response.status, adopted.body.errors]).toEqual([
    400,
    [{ pointer: '/selection/0/candidate', code: 'unsupported' }],
  ]);

  await moderate(author.id, 'hide', { reason: 'spam' });
  const restored = await moderate(path, 'restore', { reason: 'appeal' });
  expect(restored.body).toEqual({ subject: author.id, candidate, visibility: 'visible', security_revision: 3 });
  const { rows } = await admin.query(
    'SELECT count(*)::int AS hidden FROM semantic.hidden_candidate WHERE route = $1 AND subject_id = $2',
    [routeOf(author.id), author.id],
  );
  expect(rows).toEqual([{ hidden: 0 }]);
});

test('a statement or subject that is not visible leaves the links of its target until it is restored', async () => {
  const kokoro = await created({ type: 'schema:Book', labels: { en: 'Kokoro' } });
  const penguin = await created({
    type: 'bf:Instance',
    labels: { en: 'Kokoro, Penguin Classics' },
    statements: { 'schema:exampleOfWork': [statement('schema:exampleOfWork', kokoro.id)] },
  });
  const [link] = ids(penguin, 'schema:exampleOfWork');
  expect(await links(kokoro.id, 'editor')).toEqual([link!]);

  expect((await moderate(`${penguin.id}/candidates/${link}`, 'hide', { reason: 'spam' })).response.status).toBe(200);
  expect(await links(kokoro.id)).toEqual([]);
  expect((await moderate(`${penguin.id}/candidates/${link}`, 'restore', { reason: 'appeal' })).response.status).toBe(
    200,
  );
  expect(await links(kokoro.id)).toEqual([link!]);

  expect((await moderate(penguin.id, 'takedown', { notice })).response.status).toBe(200);
  expect(await links(kokoro.id)).toEqual([]);
  const unknown = await call('GET', `/v1/subjects/${randomUUID()}/links`);
  const gone = await call('GET', `/v1/subjects/${penguin.id}/links`);
  expect([gone.response.status, comparable(gone.body)]).toEqual([404, comparable(unknown.body)]);
  expect((await moderate(penguin.id, 'restore', { reason: 'appeal' })).response.status).toBe(200);
  expect(await links(kokoro.id)).toEqual([link!]);

  const { rows } = await admin.query(
    `SELECT present, source_security_revision::int AS source_security_revision FROM semantic.inbound_link
     WHERE route = $1 AND subject_id = $2`,
    [routeOf(kokoro.id), kokoro.id],
  );
  expect(rows).toEqual([{ present: true, source_security_revision: 4 }]);
});
