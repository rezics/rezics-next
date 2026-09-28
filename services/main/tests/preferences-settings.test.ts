import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { ControlDenied, ControlInvalid, ControlStale } from '../src/modules/access/topology-control.ts';
import { FollowsStore } from '../src/modules/follows/store.ts';
import { DEFAULT_PERSON_CHOICES, PersonPreferencesStore } from '../src/modules/preferences/store.ts';

const principal = { issuer: 'https://account.rezics.test', subject: 'daniel', emailVerified: true };
const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const owner = '00000000-0000-4000-8000-000000000011';
function pool(answer: (sql: string, args?: unknown[]) => { rows?: unknown[]; rowCount?: number },
  statements: string[]): Pool {
  const client = { query: async (sql: string, args?: unknown[]) => {
    statements.push(sql);
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('FROM access.principal WHERE account_issuer')) return { rows: [{ id: owner, enforcement_epoch: '1' }] };
    if (sql.includes('FROM access.agent_provision')) return { rows: [{ provision_id: owner }] };
    const result = answer(sql, args);
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 };
  }, release: () => {} };
  return { connect: async () => client } as unknown as Pool;
}

test('private profile is absent to strangers and remains readable to its controlling person', async () => {
  const statements: string[] = [];
  const store = new PersonPreferencesStore(pool(sql => sql.includes('SELECT profile_visibility')
    ? { rows: [{ profile_visibility: 'private' }] } : {}, statements));
  expect(await store.profileVisible(agent, null)).toBe(false);
  expect(await store.profileVisible(agent, principal)).toBe(true);
  expect(statements.filter(sql => sql.includes('FROM access.agent_provision'))).toHaveLength(1);
});

test('a blocked author is returned for Home filtering with one bounded indexed lookup', async () => {
  const statements: string[] = [];
  const store = new PersonPreferencesStore(pool(sql => sql.includes('target_agent = ANY')
    ? { rows: [{ target_agent: target }] } : {}, statements));
  expect(await store.blockedActors(principal, agent, [target])).toEqual(new Set([target]));
  expect(statements.filter(sql => sql.includes('target_agent = ANY'))).toHaveLength(1);
});

test('blocking a handle resolves its current Agent inside the Access transaction', async () => {
  const statements: string[] = [];
  let stored = '';
  const store = new PersonPreferencesStore(pool((sql, args) => {
    if (sql.includes('FROM access.agent_handle')) return { rows: [{ agent_id: target }] };
    if (sql.includes('FROM access.authority_subject') && sql.includes('kind')) return { rows: [{ id: target }] };
    if (sql.includes('SELECT count(*)::text AS count FROM access.person_block')) return { rows: [{ count: '0' }] };
    if (sql.includes('INSERT INTO access.person_block (')) stored = String(args?.[1]);
    return {};
  }, statements));
  expect(await store.block(principal, agent, '@ada', true, 'block:1')).toMatchObject({
    target, blocked: true, replayed: false });
  expect(stored).toBe(target);
});

test('a stale person settings write cannot change disclosure', async () => {
  const statements: string[] = [];
  const store = new PersonPreferencesStore(pool(sql => sql.includes('SELECT * FROM access.person_preferences')
    ? { rows: [{ version: 2 }] } : {}, statements));
  await expect(store.write(principal, agent, { ...DEFAULT_PERSON_CHOICES, profileVisibility: 'private' },
    1, 'change:1')).rejects.toBeInstanceOf(ControlStale);
  expect(statements.some(sql => sql.includes('INSERT INTO access.person_preferences ('))).toBe(false);
  expect(statements).toContain('ROLLBACK');
});

test('a saved privacy choice replays its receipt without a second write', async () => {
  const statements: string[] = [];
  let receipt: { request_digest: string; result: unknown } | null = null;
  const saved = { profile_visibility: 'private', follow_policy: 'nobody', hide_reading_activity: true,
    content_languages: ['en'], spoiler_policy: 'show', adult_content: false, version: 1 };
  const store = new PersonPreferencesStore(pool((sql, args) => {
    if (sql.includes('FROM access.person_preferences_receipt')) return { rows: receipt ? [receipt] : [] };
    if (sql.includes('INSERT INTO access.person_preferences (')) return { rows: [saved] };
    if (sql.includes('INSERT INTO access.person_preferences_receipt')) {
      receipt = { request_digest: String(args?.[2]), result: args?.[3] };
    }
    return {};
  }, statements));
  const value = { ...DEFAULT_PERSON_CHOICES, profileVisibility: 'private' as const,
    followPolicy: 'nobody' as const, hideReadingActivity: true, contentLanguages: ['en'],
    spoilerPolicy: 'show' as const };
  expect(await store.write(principal, agent, value, 0, 'privacy:1')).toMatchObject({
    profileVisibility: 'private', followPolicy: 'nobody', version: 1 });
  expect(await store.write(principal, agent, value, 0, 'privacy:1')).toMatchObject({
    profileVisibility: 'private', followPolicy: 'nobody', version: 1, replayed: true });
  expect(statements.filter(sql => sql.includes('INSERT INTO access.person_preferences ('))).toHaveLength(1);
});

test('a person who accepts nobody cannot acquire a new follower', async () => {
  const statements: string[] = [];
  const store = new FollowsStore(pool(sql => {
    if (sql.includes('SELECT follow_policy')) return { rows: [{ follow_policy: 'nobody' }] };
    if (sql.includes('SELECT * FROM access.follow')) return {};
    return {};
  }, statements));
  await expect(store.set(principal, { profile: 'follow-command-v1', actingSubject: agent,
    target, kind: 'agent', following: true, expectedRevision: null }, 'follow:1', async () => {}))
    .rejects.toBeInstanceOf(ControlDenied);
  expect(statements.some(sql => sql.includes('INSERT INTO access.follow ('))).toBe(false);
  expect(statements).toContain('ROLLBACK');
});

test('a new pen-name person with default follow policy accepts a follower through Access', async () => {
  const statements: string[] = [];
  let disclosed = 0;
  const store = new FollowsStore(pool(sql => {
    if (sql.includes('UPDATE access.follow_inventory')) return { rowCount: 1 };
    return {};
  }, statements));
  const result = await store.set(principal, { profile: 'follow-command-v1', actingSubject: agent,
    target, kind: 'agent', following: true, expectedRevision: null }, 'follow:default', async () => {
      disclosed++;
    });
  expect(result.following).toBe(true);
  expect(disclosed).toBe(1);
  expect(statements).toContain('SELECT follow_policy FROM access.person_preferences WHERE agent_id = $1');
  expect(statements.some(sql => sql.includes('INSERT INTO access.follow ('))).toBe(true);
});

test('adult-content opt-in is denied until a source classification can enforce it', async () => {
  const store = new PersonPreferencesStore({} as Pool);
  await expect(store.write(principal, agent, { ...DEFAULT_PERSON_CHOICES, adultContent: true },
    0, 'adult:1')).rejects.toBeInstanceOf(ControlInvalid);
});
