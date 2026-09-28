import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { symmetricDecrypt } from 'better-auth/crypto';
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
  const payloads: unknown[] = [];
  const pool = { query: async (sql: string, args?: unknown[]) => {
    if (sql.startsWith('SELECT email')) return { rows: [{ email: 'daniel@example.test',
      emailVerified: true, locale: 'zh-Hans' }] };
    if (sql.includes('INSERT INTO rezics_account_email')) {
      identities.push(args?.[0]); payloads.push(args?.[2]); lifetimes.push(args?.[3]);
    }
    return { rows: [] };
  } } as unknown as Pool;
  const app = notificationDigestApi(pool, secret, main, 'http://account.local');
  expect((await app.handle(request(main))).status).toBe(204);
  expect((await app.handle(request(main))).status).toBe(204);
  expect(identities).toHaveLength(2);
  expect(identities[0]).toBe(identities[1]);
  expect(lifetimes).toEqual([1_440, 1_440]);
  const queued = JSON.parse(await symmetricDecrypt({ key: secret, data: String(payloads[0]) })) as { locale: string; message: string };
  expect(queued).toMatchObject({ locale: 'zh-Hans', message: '2 次提及' });
});

test('digest does not invent English when the account has no language', async () => {
  const statements: string[] = [];
  const pool = { query: async (sql: string) => {
    statements.push(sql);
    return { rows: [{ email: 'daniel@example.test', emailVerified: true, locale: null, signup_locale: null }] };
  } } as unknown as Pool;
  const errors: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const app = notificationDigestApi(pool, secret, main, 'http://account.local');
    expect((await app.handle(request(main))).status).toBe(204);
  } finally { console.error = error; }
  expect(statements.some(sql => sql.includes('INSERT'))).toBe(false);
  expect(errors.some(args => args.join(' ').includes('language is not recorded'))).toBe(true);
  expect(errors.some(args => args.join(' ').includes('daniel'))).toBe(false);
});

test('digest copy is localized and treats summaries as plain text', () => {
  const rendered = renderAccountEmail('digest', 'zh-Hans', 'http://account.local', '<script>');
  expect(rendered.subject).toContain('通知摘要');
  expect(rendered.text).toContain('<script>');
  expect(rendered.html).toContain('&lt;script&gt;');
  expect(rendered.html).not.toContain('<script>');
});
