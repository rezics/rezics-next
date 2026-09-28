import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { NotificationStore, SETTINGS_NOTIFICATION_TOPICS } from '../src/modules/notification/store.ts';

const principal = { issuer: 'https://account.rezics.test', subject: 'daniel' };
const principalId = '00000000-0000-4000-8000-000000000001';

test('settings list has one bounded read and preserves saved channel revisions', async () => {
  const statements: string[] = [];
  const client = { query: async (sql: string, args?: unknown[]) => {
    statements.push(sql);
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('INSERT INTO access.notification_seen')) return { rows: [{ principal_id: principalId }], rowCount: 1 };
    if (sql.includes('FROM access.principal')) return { rows: [{ id: principalId, active: true }] };
    if (sql.includes('FROM access.notification_preference')) {
      expect(args?.[1]).toEqual(SETTINGS_NOTIFICATION_TOPICS.map(item => item.topic));
      return { rows: [{ purpose: 'social', topic: 'reply', channel: 'inbox',
        state: 'disabled', revision: '3' }] };
    }
    return { rows: [] };
  }, release: () => {} };
  const store = new NotificationStore({ connect: async () => client } as unknown as Pool);
  const choices = await store.readSettingsPreferences(principal);
  expect(choices).toHaveLength(SETTINGS_NOTIFICATION_TOPICS.length * 2);
  expect(choices.find(item => item.topic === 'reply' && item.channel === 'inbox')).toEqual({
    purpose: 'social', topic: 'reply', channel: 'inbox', state: 'disabled', revision: '3' });
  expect(choices.find(item => item.topic === 'reply' && item.channel === 'email')).toEqual({
    purpose: 'social', topic: 'reply', channel: 'email', state: 'disabled', revision: null });
  expect(statements.filter(sql => sql.includes('FROM access.notification_preference'))).toHaveLength(1);
});

test('a disabled reply preference prevents the producer from adding an inbox item', async () => {
  const statements: string[] = [];
  const client = { query: async (sql: string) => {
    statements.push(sql);
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('INSERT INTO access.notification_seen')) return { rows: [{ principal_id: principalId }], rowCount: 1 };
    if (sql.includes('AS inbox') && sql.includes('access.notification_preference')) {
      return { rows: [{ inbox: false, email: false }] };
    }
    return { rows: [] };
  }, release: () => {} };
  const store = new NotificationStore({ connect: async () => client } as unknown as Pool);
  const result = await store.enqueue({ sourceOwner: 'graph', sourceEvent: 'reply:1',
    purpose: 'social', topic: 'reply', subject: { owner: 'graph', ref: 'reply:1', revision: null },
    disclosureBasis: 'realm-reply-v1', recipients: [principalId] });
  expect(result).toEqual([]);
  expect(statements.some(sql => sql.includes('INSERT INTO access.notification_item'))).toBe(false);
});

test('registered email and push endpoints both receive a social item unless their channel is disabled', async () => {
  const statements: string[] = [];
  const client = { query: async (sql: string) => {
    statements.push(sql);
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('INSERT INTO access.notification_seen')) return { rows: [{ principal_id: principalId }], rowCount: 1 };
    if (sql.includes('AS inbox') && sql.includes('access.notification_preference')) {
      return { rows: [{ inbox: true, email: false }] };
    }
    if (sql.includes('SELECT generation::text, head_sequence::text')) {
      return { rows: [{ generation: '1', head_sequence: '0' }] };
    }
    if (sql.includes('INSERT INTO access.notification_delivery')) return { rows: [], rowCount: 2 };
    return { rows: [] };
  }, release: () => {} };
  const store = new NotificationStore({ connect: async () => client } as unknown as Pool);
  const result = await store.enqueue({ sourceOwner: 'graph', sourceEvent: 'reply:direct',
    purpose: 'social', topic: 'reply', subject: { owner: 'graph', ref: 'reply:direct', revision: null },
    disclosureBasis: 'realm-reply-v1', recipients: [principalId] });
  expect(result[0]?.deliveries).toBe(2);
  const delivery = statements.find(sql => sql.includes('INSERT INTO access.notification_delivery'))!;
  expect(delivery).toContain("e.channel, e.generation");
  expect(delivery).toContain('p.channel = e.channel AND p.state = \'disabled\'');
  expect(delivery).not.toContain("e.channel <> 'email'");
});

test('email opt-in records a digest candidate when the inbox is disabled', async () => {
  const statements: string[] = [];
  const client = { query: async (sql: string) => {
    statements.push(sql);
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('INSERT INTO access.notification_seen')) return { rows: [{ principal_id: principalId }], rowCount: 1 };
    if (sql.includes('AS inbox') && sql.includes('access.notification_preference')) {
      return { rows: [{ inbox: false, email: true }] };
    }
    return { rows: [] };
  }, release: () => {} };
  const store = new NotificationStore({ connect: async () => client } as unknown as Pool);
  const result = await store.enqueue({ sourceOwner: 'graph', sourceEvent: 'reply:1',
    purpose: 'social', topic: 'reply', subject: { owner: 'graph', ref: 'reply:1', revision: null },
    disclosureBasis: 'realm-reply-v1', recipients: [principalId] });
  expect(result).toEqual([]);
  expect(statements.some(sql => sql.includes('INSERT INTO access.notification_digest_candidate'))).toBe(true);
  expect(statements.some(sql => sql.includes('INSERT INTO access.notification_item'))).toBe(false);
});

test('replayed old event cannot enter a digest after email is enabled', async () => {
  let first = true;
  let emailEnabled = false;
  const statements: string[] = [];
  const client = { query: async (sql: string) => {
    statements.push(sql);
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('INSERT INTO access.notification_seen')) {
      if (first) { first = false; return { rows: [{ principal_id: principalId }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('AS inbox')) return { rows: [{ inbox: false, email: emailEnabled }] };
    return { rows: [] };
  }, release: () => {} };
  const store = new NotificationStore({ connect: async () => client } as unknown as Pool);
  const event = { sourceOwner: 'graph' as const, sourceEvent: 'reply:old', purpose: 'social' as const,
    topic: 'reply', subject: { owner: 'graph' as const, ref: 'reply:old', revision: null },
    disclosureBasis: 'realm-reply-v1', recipients: [principalId] };
  await store.enqueue(event);
  emailEnabled = true;
  await store.enqueue(event);
  expect(statements.some(sql => sql.includes('INSERT INTO access.notification_digest_candidate'))).toBe(false);
  expect(statements.filter(sql => sql.includes('AS inbox'))).toHaveLength(1);
});
