import { migrationVersion, schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { Elysia } from 'elysia';
import { Pool } from 'pg';
import { preferencesRoutes } from '../src/routes/preferences.ts';
import { feedRoutes } from '../src/routes/feed.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { DEFAULT_PERSON_CHOICES, PersonPreferencesStore } from '../src/modules/preferences/store.ts';
import { defaultPreferences, HomePersonalStore } from '../src/modules/feed/personal.ts';
import { canonicalLanguage } from '../src/modules/display-language/select.ts';

const root = resolve(import.meta.dir, '../../..');
const accessDir = join(root, 'services/main/migrations/access');
const migration = '875_reading_languages.sql';
let cluster: PostgresCluster | undefined;
let pool: Pool;
const principal = { issuer: 'https://account.rezics.test', subject: 'g-514', emailVerified: true };
const owner = randomUUID(), agent = `https://rezics.com/id/${randomUUID()}`, representation = randomUUID();
const secondaryAgent = `https://rezics.com/id/${randomUUID()}`;
const feedOnlyOwner = randomUUID(), feedOnlyAgent = `https://rezics.com/id/${randomUUID()}`;
const feedOnlyPrincipal = { ...principal, subject: 'g-514-feed-only' };
let home: HomePersonalStore, person: PersonPreferencesStore, app: Pick<Elysia, 'handle'>;
const languages = ['ar', 'zh-TW', 'yue-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'he', 'sr-Latn', 'pa-Arab'];

async function provisionPerson(principalId: string, personAgent: string, control: string, createdAt: string) {
  await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [personAgent]);
  await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`, [control, principalId, personAgent]);
  await pool.query(`INSERT INTO access.agent_provision (id, principal_id, idempotency_key, request_digest,
    agent_id, agent_kind, display_name, principal_epoch, state, graph_data_epoch, graph_sequence, representation_id,
    created_at) VALUES ($1,$2,$3,$4,$5,'person','Reader',0,'active','epoch',0,$6,$7)`,
    [randomUUID(), principalId, `g-514-provision:${randomUUID()}`, 'a'.repeat(64), personAgent, control, createdAt]);
}

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 6 });
  for (const file of schemaFiles(root, 'access').filter(file => migrationVersion(file) < migrationVersion(migration))) {
    await pool.query(readFileSync(join(accessDir, file), 'utf8'));
  }
  await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [owner, principal.issuer, principal.subject]);
  await provisionPerson(owner, agent, representation, '2026-01-01T00:00:00Z');
  await provisionPerson(owner, secondaryAgent, randomUUID(), '2026-01-02T00:00:00Z');
  await pool.query(`INSERT INTO access.person_preferences (agent_id, content_languages, version, profile_visibility)
    VALUES ($1,$2,1,'private')`, [agent, ['en', 'zh-tw', 'iw']]);
  await pool.query('INSERT INTO access.home_state (principal_id, revision, preferences) VALUES ($1,$2,$3)',
    [owner, randomUUID(), { ...defaultPreferences, contentLanguages: ['ar', 'zh-TW', 'yue-hant', 'he'] }]);
  await pool.query(`INSERT INTO access.person_preferences (agent_id, content_languages, version)
    VALUES ($1,$2,1)`, [secondaryAgent, ['de']]);
  await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [feedOnlyOwner, feedOnlyPrincipal.issuer, feedOnlyPrincipal.subject]);
  await provisionPerson(feedOnlyOwner, feedOnlyAgent, randomUUID(), '2026-01-01T00:00:00Z');
  await pool.query('INSERT INTO access.home_state (principal_id, revision, preferences) VALUES ($1,$2,$3)',
    [feedOnlyOwner, randomUUID(), { ...defaultPreferences, contentLanguages: ['ar', 'zh-tw', 'yue-hant', 'ar'] }]);
  expect((await pool.query('SELECT 1 FROM access.person_preferences WHERE agent_id = $1', [feedOnlyAgent]))
    .rowCount).toBe(0);
  await pool.query(readFileSync(join(accessDir, migration), 'utf8'));
  home = new HomePersonalStore(pool); person = new PersonPreferencesStore(pool);
  const work = { homePersonal: home, personPreferences: person,
    account: { verify: async () => principal } } as unknown as MainWorkDependencies;
  app = new Elysia().use(preferencesRoutes(work)).use(feedRoutes(work));
}, 120_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

async function call(path: string, body?: object, key?: string) {
  return app.handle(new Request(`http://main.test${path}`, { method: body ? 'PUT' : 'GET',
    headers: { authorization: 'Bearer test', ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'idempotency-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined }));
}
const settings = () => person.read(principal, agent);
const personal = () => home.read(principal, agent);

test('G-514: migration merges settings first, canonicalizes and deduplicates Home-only languages', async () => {
  expect((await settings()).contentLanguages).toEqual(['en', 'zh-TW', 'he', 'ar', 'yue-Hant']);
  expect((await personal()).preferences.contentLanguages).toEqual(['en', 'zh-TW', 'he', 'ar', 'yue-Hant']);
  expect((await settings()).profileVisibility).toBe('private');
  for (const language of ['eng', 'fra', 'in', 'iw', 'ji', 'zh-hant-tw', 'yue-hant', 'en-bu', 'en-x-Rezics']) {
    expect((await pool.query('SELECT pg_temp.reading_language($1) AS language', [language])).rows[0].language)
      .toBe(canonicalLanguage(language));
  }
  expect((await pool.query('SELECT preferences FROM access.home_state WHERE principal_id = $1', [owner]))
    .rows[0].preferences).not.toHaveProperty('contentLanguages');
  await expect(pool.query(`UPDATE access.home_state SET preferences = preferences || '{"contentLanguages":["en"]}'`
    + ' WHERE principal_id = $1', [owner])).rejects.toMatchObject({ code: '23514' });
});

test('G-514 R2: migration creates settings for a reader with only feed languages', async () => {
  expect(await person.read(feedOnlyPrincipal, feedOnlyAgent)).toMatchObject({ ...DEFAULT_PERSON_CHOICES,
    version: 1, contentLanguages: ['ar', 'zh-TW', 'yue-Hant'] });
  expect((await home.read(feedOnlyPrincipal, feedOnlyAgent)).preferences.contentLanguages)
    .toEqual(['ar', 'zh-TW', 'yue-Hant']);
  expect(await person.languagesForReader(feedOnlyPrincipal)).toEqual(['ar', 'zh-TW', 'yue-Hant']);
  expect((await pool.query('SELECT preferences FROM access.home_state WHERE principal_id = $1', [feedOnlyOwner]))
    .rows[0].preferences).not.toHaveProperty('contentLanguages');
});

test('G-514: settings API writes twelve ordered languages; feed and onboarding shared read see them', async () => {
  const before = await settings(), feedBefore = await personal();
  const body = { ...DEFAULT_PERSON_CHOICES, actingSubject: agent, expectedVersion: before.version,
    contentLanguages: languages };
  const response = await call('/v1/me/person-preferences', body, 'settings:12');
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await response.json()).contentLanguages).toEqual(languages);
  expect(await person.languagesForReader(principal)).toEqual(languages);
  const feedResponse = await call(`/v1/me/feed-preferences?actingSubject=${encodeURIComponent(agent)}`);
  expect(feedResponse.status).toBe(200);
  expect((await feedResponse.json()).preferences.contentLanguages).toEqual(languages);
  expect((await personal()).revision).not.toBe(feedBefore.revision);
  const replay = await call('/v1/me/person-preferences', body, 'settings:12');
  expect(replay.status).toBe(200);
  expect((await replay.json()).replayed).toBe(true);
  const stale = await call('/v1/me/feed-preferences', { actingSubject: agent, expectedRevision: feedBefore.revision,
    preferences: { ...defaultPreferences, contentLanguages: ['de'] } }, 'feed:stale');
  expect(stale.status).toBe(409);
});

test('G-514: feed API writes one store, preserves unrelated choices and invalidates settings CAS', async () => {
  const before = await settings(), feedBefore = await personal();
  const body = { actingSubject: agent, expectedRevision: feedBefore.revision,
    preferences: { ...defaultPreferences, contentLanguages: [...languages].reverse() } };
  const response = await call('/v1/me/feed-preferences', body, 'feed:12');
  expect(response.status, await response.clone().text()).toBe(200);
  const saved = await settings();
  expect(saved.contentLanguages).toEqual([...languages].reverse());
  expect(saved.profileVisibility).toBe(before.profileVisibility);
  expect(saved.version).toBe(before.version + 1);
  const replay = await call('/v1/me/feed-preferences', body, 'feed:12');
  expect(replay.status).toBe(200);
  expect((await replay.json()).replayed).toBe(true);
  expect((await settings()).version).toBe(saved.version);
  const stale = await call('/v1/me/person-preferences', { ...DEFAULT_PERSON_CHOICES, actingSubject: agent,
    expectedVersion: before.version, contentLanguages: ['de'] }, 'settings:stale');
  expect(stale.status).toBe(409);
  const conflict = await call('/v1/me/feed-preferences', { ...body,
    preferences: { ...body.preferences, contentLanguages: ['de'] } }, 'feed:12');
  expect(conflict.status).toBe(409);
});

test('G-514: display and feed use the primary Person languages while acting as a different Person', async () => {
  const before = await settings(), feedBefore = await home.read(principal, secondaryAgent);
  expect((await person.read(principal, secondaryAgent)).contentLanguages).toEqual(['de']);
  expect(feedBefore.preferences.contentLanguages).toEqual(before.contentLanguages);
  expect(feedBefore.preferences.contentLanguages).toEqual(await person.languagesForReader(principal));
  const response = await call('/v1/me/feed-preferences', { actingSubject: secondaryAgent,
    expectedRevision: feedBefore.revision, preferences: { ...defaultPreferences, contentLanguages: ['ja', 'ar'] } },
  'feed:secondary');
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await settings()).contentLanguages).toEqual(['ja', 'ar']);
  expect((await settings()).version).toBe(before.version + 1);
  expect(await person.languagesForReader(principal)).toEqual(['ja', 'ar']);
  const read = await call(`/v1/me/feed-preferences?actingSubject=${encodeURIComponent(secondaryAgent)}`);
  expect(read.status).toBe(200);
  expect((await read.json()).preferences.contentLanguages).toEqual(['ja', 'ar']);
  expect((await person.read(principal, secondaryAgent)).contentLanguages).toEqual(['de']);
});

test('G-514: concurrent settings/feed writes with the same old state produce one winner and one 409', async () => {
  const before = await settings(), feedBefore = await personal();
  const responses = await Promise.all([
    call('/v1/me/person-preferences', { ...DEFAULT_PERSON_CHOICES, actingSubject: agent,
      expectedVersion: before.version, contentLanguages: ['ar'] }, 'race:settings'),
    call('/v1/me/feed-preferences', { actingSubject: secondaryAgent, expectedRevision: feedBefore.revision,
      preferences: { ...defaultPreferences, contentLanguages: ['yue-Hant'] } }, 'race:feed'),
  ]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  expect((await settings()).contentLanguages).toEqual((await personal()).preferences.contentLanguages);
  expect((await settings()).version).toBe(before.version + 1);
});

test('G-514: concurrent writes through either individual API use its CAS and replay once', async () => {
  for (const route of ['settings', 'feed'] as const) {
    const before = await settings(), feedBefore = await personal();
    const path = route === 'settings' ? '/v1/me/person-preferences' : '/v1/me/feed-preferences';
    const body = (tag: string) => route === 'settings'
      ? { ...DEFAULT_PERSON_CHOICES, actingSubject: agent, expectedVersion: before.version, contentLanguages: [tag] }
      : { actingSubject: agent, expectedRevision: feedBefore.revision,
        preferences: { ...defaultPreferences, contentLanguages: [tag] } };
    const responses = await Promise.all(['ar', 'zh-TW'].map((tag, index) =>
      call(path, body(tag), `same-route:${route}:${index}`)));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = responses.findIndex(response => response.status === 200);
    const replay = await call(path, body(winner === 0 ? 'ar' : 'zh-TW'), `same-route:${route}:${winner}`);
    expect(replay.status).toBe(200);
    expect((await replay.json()).replayed).toBe(true);
    expect((await settings()).version).toBe(before.version + 1);
  }
});

test('G-514: denied owner and recovery-held commands leave both preference revisions unchanged', async () => {
  const before = await settings(), feedBefore = await personal();
  const denied = { ...principal, subject: 'not-the-owner' };
  await expect(person.write(denied, agent, { ...DEFAULT_PERSON_CHOICES, contentLanguages: ['ar'] },
    before.version, 'denied:settings')).rejects.toThrow();
  await expect(home.preferences(denied, { actingSubject: agent, expectedRevision: feedBefore.revision,
    preferences: { ...defaultPreferences, contentLanguages: ['ar'] } }, 'denied:feed')).rejects.toThrow();
  await pool.query('UPDATE access.recovery_fence SET open = false WHERE id');
  try {
    const response = await call('/v1/me/feed-preferences', { actingSubject: agent,
      expectedRevision: feedBefore.revision, preferences: { ...defaultPreferences, contentLanguages: ['ar'] } }, 'held:feed');
    expect(response.status).toBe(503);
  } finally { await pool.query('UPDATE access.recovery_fence SET open = true WHERE id'); }
  expect((await settings()).version).toBe(before.version);
  expect((await personal()).revision).toBe(feedBefore.revision);
});
