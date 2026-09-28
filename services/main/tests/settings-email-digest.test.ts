import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { NotificationDigestWorker } from '../src/modules/notification/digest.ts';
import type { NotificationStore } from '../src/modules/notification/store.ts';

const principal = '00000000-0000-4000-8000-000000000001';
const day = '2026-01-02';
const account = 'https://account.rezics.test/api/auth';

test('email digest rechecks source disclosure and current email choices before Account intake', async () => {
  const calls: string[] = [];
  const pool = { query: async (sql: string) => {
    calls.push(sql);
    if (sql.includes('UPDATE access.notification_digest_day d')) return { rows: [{
      principal_id: principal, day, account_subject: 'daniel' }] };
    if (sql.includes('FROM access.principal WHERE')) return { rows: [{ account_issuer: account, active: true }] };
    if (sql.includes('FROM access.notification_digest_candidate')) return { rows: [
      { topic: 'mention', purpose: 'social', subject_owner: 'graph', subject_ref: 'reply:1',
        subject_revision: 'rev:1', disclosure_basis: 'realm-reply-v1', realm: null },
      { topic: 'reply', purpose: 'social', subject_owner: 'graph', subject_ref: 'reply:2',
        subject_revision: 'rev:2', disclosure_basis: 'realm-reply-v1', realm: null },
    ] };
    if (sql.includes('FROM access.notification_preference')) return { rows: [{ topic: 'mention' }] };
    return { rows: [] };
  } } as unknown as Pool;
  const notifications = { resolveDigestSubject: async (input: { ref: string }) =>
    ({ status: input.ref === 'reply:1' ? 'available' : 'undisclosed' }) } as unknown as NotificationStore;
  const original = globalThis.fetch;
  const sent: unknown[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  try {
    const worker = new NotificationDigestWorker(pool, notifications, account,
      'http://account.local/api/internal/notification-digest', 'secret');
    expect(await worker.runOnce()).toBe(true);
    expect(sent).toEqual([{ userId: 'daniel', day, counts: [{ topic: 'mention', count: 1 }], more: false }]);
    expect(calls.some(sql => sql.includes("SET state = 'sent'"))).toBe(true);
  } finally { globalThis.fetch = original; }
});

test('Account intake failure leaves the digest pending for retry', async () => {
  const calls: string[] = [];
  const pool = { query: async (sql: string) => {
    calls.push(sql);
    if (sql.includes('UPDATE access.notification_digest_day d')) return { rows: [{
      principal_id: principal, day, account_subject: 'daniel' }] };
    if (sql.includes('FROM access.principal WHERE')) return { rows: [{ account_issuer: account, active: true }] };
    if (sql.includes('FROM access.notification_digest_candidate')) return { rows: [{
      topic: 'mention', purpose: 'social', subject_owner: 'graph', subject_ref: 'reply:1',
      subject_revision: 'rev:1', disclosure_basis: 'realm-reply-v1', realm: null }] };
    if (sql.includes('FROM access.notification_preference')) return { rows: [{ topic: 'mention' }] };
    return { rows: [] };
  } } as unknown as Pool;
  const notifications = { resolveDigestSubject: async () => ({ status: 'available' }) } as unknown as NotificationStore;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  try {
    const worker = new NotificationDigestWorker(pool, notifications, account,
      'http://account.local/api/internal/notification-digest', 'secret');
    await expect(worker.runOnce()).rejects.toThrow('Account digest intake unavailable');
    expect(calls.some(sql => sql.includes("SET state = 'pending'"))).toBe(true);
  } finally { globalThis.fetch = original; }
});
