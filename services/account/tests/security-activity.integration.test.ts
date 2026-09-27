import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';

test('G205 activity: private paginated events, coarse devices, failure summary and session revocation', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('activity@example.test');
    const peer = await f.signup('other@example.test');
    const signed = await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password }, undefined,
      { 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/140.0', 'x-rezics-client-ip': '192.0.2.27' });
    const currentCookie = signed.headers.get('set-cookie')!;
    await f.request('/api/auth/sign-in/email', { email: member.email, password: 'a wrong password' });
    expect((await f.request('/api/account/security-activity')).status).toBe(401);
    const first = await (await f.request('/api/account/security-activity?limit=1', undefined, currentCookie)).json() as {
      items: { action: string; detail: object }[]; nextCursor: string; failedAttemptsLast24Hours: { count: number } };
    expect(first.items[0]!.action).toBe('sign_in_failed');
    expect(first.failedAttemptsLast24Hours.count).toBe(1);
    const next = await (await f.request(`/api/account/security-activity?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
      undefined, currentCookie)).json() as { items: { action: string; detail: object }[] };
    expect(next.items[0]).toMatchObject({ action: 'sign_in', detail: { network: '192.0.2.0/24',
      device: { browser: 'Chrome', platform: 'macOS' } } });
    expect((await f.request(`/api/account/security-activity?cursor=${encodeURIComponent(first.nextCursor)}`, undefined, peer.cookie)).status).toBe(400);
    const sessions = await (await f.request('/api/account/sessions', undefined, currentCookie)).json() as {
      items: { id: string; thisDevice: boolean; token?: string }[] };
    expect(sessions.items).toHaveLength(2);
    expect(sessions.items.filter(item => item.thisDevice)).toHaveLength(1);
    expect(sessions.items.every(item => item.token === undefined)).toBe(true);
    const victim = sessions.items.find(item => !item.thisDevice)!;
    expect(await (await f.request('/api/account/sessions/revoke', { sessionId: victim.id }, peer.cookie)).json()).toEqual({ revoked: 0 });
    const race = await Promise.all([1, 2].map(() => f.request('/api/account/sessions/revoke', { others: true }, currentCookie)));
    const counts = await Promise.all(race.map(async response => (await response.json() as { revoked: number }).revoked));
    expect(counts.sort()).toEqual([0, 1]);
    expect(await (await f.request('/api/auth/get-session', undefined, member.cookie)).json()).toBeNull();
    expect((await f.request('/api/auth/sign-out', {}, currentCookie)).status).toBe(200);
    await expect(f.pool.query('DELETE FROM rezics_account_security_event WHERE user_id = $1', [member.id])).rejects.toThrow('append-only');
    const events = (await f.pool.query('SELECT action FROM rezics_account_security_event WHERE user_id = $1', [member.id])).rows;
    expect(events.map(row => row.action)).toContain('sign_out');
    expect(events.map(row => row.action)).toContain('session_revoked');
  } finally { await f.close(); }
}, 60_000);
