import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { notificationDigestApi } from '../src/notification-digest.ts';
import { renderAccountEmail } from '../src/email.ts';

const secret = 'a'.repeat(32);
const main = 'main-client-secret';
const input = { userId: 'daniel-account', day: '2026-01-02',
  counts: [{ topic: 'mention', count: 2 }], more: false };
const request = (token: string, body = input) => new Request('http://account.local/api/internal/notification-digest', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body) });

test('digest intake requires Main credential and a currently verified account', async () => {
  const statements: string[] = [];
  const pool = { query: async (sql: string) => {
    statements.push(sql);
    return { rows: [{ email: 'daniel@example.test', emailVerified: false, locale: 'en' }] };
  } } as unknown as Pool;
  const app = notificationDigestApi(pool, secret, main, 'http://account.local');
  expect((await app.handle(request('wrong'))).status).toBe(403);
  expect(statements).toHaveLength(0);
  expect((await app.handle(request(main))).status).toBe(204);
  expect(statements).toHaveLength(1);
});

test('digest intake queues one stable email identity on replay', async () => {
  const identities: unknown[] = [];
  const lifetimes: unknown[] = [];
  const pool = { query: async (sql: string, args?: unknown[]) => {
    if (sql.startsWith('SELECT email')) return { rows: [{ email: 'daniel@example.test',
      emailVerified: true, locale: 'zh-Hans' }] };
    if (sql.includes('INSERT INTO rezics_account_email')) {
      identities.push(args?.[0]); lifetimes.push(args?.[3]);
    }
    return { rows: [] };
  } } as unknown as Pool;
  const app = notificationDigestApi(pool, secret, main, 'http://account.local');
  expect((await app.handle(request(main))).status).toBe(204);
  expect((await app.handle(request(main))).status).toBe(204);
  expect(identities).toHaveLength(2);
  expect(identities[0]).toBe(identities[1]);
  expect(lifetimes).toEqual([1_440, 1_440]);
});

test('digest copy is localized and treats summaries as plain text', () => {
  const rendered = renderAccountEmail('digest', 'zh-Hans', 'http://account.local', '<script>');
  expect(rendered.subject).toContain('通知摘要');
  expect(rendered.text).toContain('<script>');
  expect(rendered.html).toContain('&lt;script&gt;');
  expect(rendered.html).not.toContain('<script>');
});
