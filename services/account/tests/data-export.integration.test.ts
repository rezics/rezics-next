import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { exportCaps } from '../src/data-export.ts';

interface Archive {
  format: string; account: { id: string; email: string };
  signInMethods: { password: boolean };
  devices: { items: Record<string, unknown>[]; truncated: boolean };
  connectedApps: { items: { clientId: string }[]; truncated: boolean };
  securityActivity: { items: { action: string }[]; truncated: boolean };
}

test('G411 download your data: a recent sign-in, the person\'s own records only, no secrets, and a trace', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const member = await f.signup('export@example.test');
    const peer = await f.signup('export-peer@example.test');
    const app = await oauth.createClient();
    await oauth.issue(app.client_id, member.cookie);
    const download = (cookie?: string, headers: HeadersInit = {}) =>
      f.request('/api/account/data-export', {}, cookie, headers);

    expect((await download()).status).toBe(401);
    expect(await (await download(member.cookie, { origin: 'https://evil.example' })).json()).toEqual({ error: 'invalid_origin' });
    // A session older than five minutes must confirm it's the person first.
    await f.pool.query(`UPDATE "session" SET "createdAt" = now() - interval '1 hour' WHERE "userId" = $1`, [member.id]);
    const stale = await download(member.cookie);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: 'step_up_required' });
    expect((await f.request('/api/account/reauthenticate', { password: member.password }, member.cookie)).status).toBe(200);

    const response = await download(member.cookie, { 'user-agent': 'Mozilla/5.0 (Macintosh) Firefox/140.0' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="rezics-account-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = await response.text();
    const archive = JSON.parse(text) as Archive;
    expect(archive).toMatchObject({ format: 'rezics-account-export/1', account: { id: member.id, email: member.email },
      signInMethods: { password: true } });
    expect(archive.connectedApps.items.map(item => item.clientId)).toEqual([app.client_id]);
    expect(archive.securityActivity.items.map(item => item.action)).toContain('sign_in');
    expect(archive.devices.items.length).toBeGreaterThan(0);
    expect(archive.devices.items.every(item => !('token' in item) && !('groupKey' in item))).toBe(true);
    // Nothing of the peer, and no credential material of the member.
    expect(text).not.toContain(peer.email);
    const secrets = await f.pool.query<{ password: string }>(`SELECT password FROM account WHERE "userId" = $1
      AND password IS NOT NULL`, [member.id]);
    const tokens = await f.pool.query<{ token: string }>('SELECT token FROM "session" WHERE "userId" = $1', [member.id]);
    for (const secret of [...secrets.rows.map(row => row.password), ...tokens.rows.map(row => row.token)]) {
      expect(text).not.toContain(secret);
    }
    // The download shows in the person's own activity, where "Wasn't you?" can follow it.
    const events = await f.pool.query<{ action: string; detail: { device: { browser: string } } }>(`SELECT action, detail
      FROM rezics_account_security_event WHERE user_id = $1 AND action = 'data_exported'`, [member.id]);
    expect(events.rows).toEqual([{ action: 'data_exported', detail: expect.objectContaining({
      device: expect.objectContaining({ browser: 'Firefox', platform: 'macOS' }) }) }]);
  } finally { await f.close(); }
}, 60_000);

test('G411 download your data: capped sections say they were truncated, and repeated downloads are limited', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('export-many@example.test');
    await f.pool.query(`INSERT INTO rezics_account_security_event (user_id, action, detail, occurred_at)
      SELECT $1, 'sign_in_failed', '{}', now() - n * interval '1 minute' FROM generate_series(1, $2::int) n`,
    [member.id, exportCaps.events + 1]);
    const first = await (await f.request('/api/account/data-export', {}, member.cookie)).json() as Archive;
    expect(first.securityActivity.items).toHaveLength(exportCaps.events);
    expect(first.securityActivity.truncated).toBe(true);
    expect(first.devices.truncated).toBe(false);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      statuses.push((await f.request('/api/account/data-export', {}, member.cookie)).status);
    }
    expect(statuses.slice(0, 9).every(status => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  } finally { await f.close(); }
}, 60_000);
