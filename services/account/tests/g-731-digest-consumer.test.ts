import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { NotificationDigestWorker } from '../../main/src/modules/notification/digest.ts';
import type { NotificationStore } from '../../main/src/modules/notification/store.ts';

test('G-731 digest consumer consumes suppression and retries other conflicts or outages', async () => {
  for (const [status, error, terminal] of [
    [409, 'mail_suppressed', true],
    [409, 'other_conflict', false],
    [503, 'temporarily_unavailable', false],
  ] as const) {
    const calls: string[] = [];
    const issuer = 'https://accounts.example.test/api/auth';
    const pool = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.includes('UPDATE access.notification_digest_day d'))
          return {
            rows: [
              {
                principal_id: 'principal',
                day: '2026-01-01',
                account_subject: 'member',
              },
            ],
          };
        if (sql.includes('FROM access.principal WHERE'))
          return { rows: [{ account_issuer: issuer, active: true }] };
        if (sql.includes('FROM access.notification_digest_candidate'))
          return {
            rows: [
              {
                topic: 'mention',
                purpose: 'social',
                subject_owner: 'graph',
                subject_ref: 'reply',
                subject_revision: 'rev',
                disclosure_basis: 'realm-reply-v1',
                realm: null,
              },
            ],
          };
        if (sql.includes('FROM access.notification_preference'))
          return { rows: [{ topic: 'mention' }] };
        return { rows: [] };
      },
    } as unknown as Pool;
    const notifications = {
      resolveDigestSubject: async () => ({ status: 'available' }),
    } as unknown as NotificationStore;
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ error }, { status })) as unknown as typeof fetch;
    try {
      const worker = new NotificationDigestWorker(
        pool,
        notifications,
        issuer,
        'https://accounts.example.test/api/internal/notification-digest',
        'main-secret',
      );
      if (terminal) expect(await worker.runOnce()).toBe(true);
      else await expect(worker.runOnce()).rejects.toThrow('Account digest intake unavailable');
      expect(calls.some((sql) => sql.includes("SET state = 'sent'"))).toBe(terminal);
      expect(calls.some((sql) => sql.includes("SET state = 'pending'"))).toBe(!terminal);
      expect(
        calls.some((sql) => sql.includes('DELETE FROM access.notification_digest_candidate')),
      ).toBe(terminal);
    } finally {
      globalThis.fetch = original;
    }
  }
});
