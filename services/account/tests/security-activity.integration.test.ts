import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createOTP } from '@better-auth/utils/otp';

const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

test('authentication failure activity follows the session or signed challenge, never ignored identity fields', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('activity-principal@example.test');
    const peer = await f.signup('activity-forged-target@example.test');
    const failures = async () => (await f.pool.query<{ user_id: string; method: string }>(`SELECT user_id,
      detail->>'method' AS method FROM rezics_account_security_event
      WHERE user_id IN ($1, $2) AND action = 'sign_in_failed' ORDER BY occurred_at, id`, [member.id, peer.id])).rows;
    const forged = { email: peer.email, userId: peer.id };
    const factorPaths = ['/api/auth/two-factor/verify-totp', '/api/auth/two-factor/verify-backup-code'];
    expect((await f.request('/api/auth/two-factor/enable', { password: member.password }, member.cookie)).status).toBe(200);
    for (const path of factorPaths) {
      const invalid = await f.request(path, { code: 'invalid', ...forged }, member.cookie);
      expect(invalid.status).toBe(401);
    }
    expect(await failures()).toEqual(factorPaths.map(path => ({ user_id: member.id, method: path.split('/').at(-1)! })));
    const secret = await symmetricDecrypt({ key: f.secret,
      data: (await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [member.id])).rows[0].secret });
    const verified = await f.request('/api/auth/two-factor/verify-totp', { code: await createOTP(secret).totp() }, member.cookie);
    expect(verified.status).toBe(200);
    const signedCookie = cookies(verified);
    for (const path of factorPaths) {
      expect((await f.request(path, { code: 'invalid', ...forged }, signedCookie)).status).toBe(401);
    }
    const signIn = await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password });
    expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
    const challengeCookie = cookies(signIn);
    for (const path of factorPaths) {
      expect((await f.request(path, { code: 'invalid', ...forged }, challengeCookie)).status).toBe(401);
    }
    expect(await failures()).toEqual(Array.from({ length: 3 }, () => factorPaths.map(path => ({
      user_id: member.id, method: path.split('/').at(-1)!,
    }))).flat());
    for (const path of factorPaths) {
      expect((await f.request(path, { code: 'invalid', ...forged })).ok).toBe(false);
    }
    expect(await failures()).toHaveLength(6);
    const invalidPasskey = { response: { id: 'unknown-credential' }, ...forged };
    expect((await f.request('/api/auth/passkey/verify-authentication', invalidPasskey, signedCookie)).ok).toBe(false);
    expect(await failures()).toHaveLength(6);
    await f.pool.query(`INSERT INTO passkey (id, name, "publicKey", "userId", "credentialID", counter, "deviceType", "backedUp", "createdAt")
      VALUES ('activity-credential', 'Peer credential', 'invalid-proof-fixture', $1, 'peer-credential', 0, 'singleDevice', false, now())`, [peer.id]);
    expect((await f.request('/api/auth/passkey/verify-authentication', {
      response: { id: 'peer-credential' }, email: member.email,
    }, signedCookie)).ok).toBe(false);
    expect((await failures()).at(-1)).toEqual({ user_id: peer.id, method: 'verify-authentication' });
    expect((await f.request('/api/auth/passkey/verify-authentication', invalidPasskey)).ok).toBe(false);
    expect(await failures()).toHaveLength(7);
    expect((await f.request('/api/auth/sign-in/email', { email: peer.email, password: 'incorrect password', userId: member.id })).status).toBe(401);
    expect((await f.request('/api/auth/sign-in/email', { email: peer.email, password: 'incorrect password' }, signedCookie)).status).toBe(401);
    expect((await failures()).filter(row => row.user_id === peer.id)).toEqual([
      { user_id: peer.id, method: 'verify-authentication' }, { user_id: peer.id, method: 'email' },
      { user_id: peer.id, method: 'email' },
    ]);
  } finally { await f.close(); }
}, 60_000);

test('G205 activity: private paginated events, coarse devices, failure summary and session revocation', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('activity@example.test');
    const peer = await f.signup('other@example.test');
    const signed = await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password }, undefined,
      { 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/140.0', 'x-rezics-client-ip': '192.0.2.27',
        'x-forwarded-for': '192.0.2.27' });
    const currentCookie = signed.headers.get('set-cookie')!;
    await f.request('/api/auth/sign-in/email', { email: member.email, password: 'a wrong password' });
    expect((await f.request('/api/account/security-activity')).status).toBe(401);
    const first = await (await f.request('/api/account/security-activity?limit=1', undefined, currentCookie)).json() as {
      items: { action: string; detail: object }[]; nextCursor: string; failedAttemptsLast24Hours: { count: number } };
    expect(first.items[0]!.action).toBe('sign_in_failed');
    expect(first.failedAttemptsLast24Hours.count).toBe(1);
    const next = await (await f.request(`/api/account/security-activity?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
      undefined, currentCookie)).json() as { items: { action: string; detail: object }[] };
    // The direct fixture has no trusted ingress: spoofed client addresses
    // must leave the socket peer's coarse network in the security history.
    expect(next.items[0]).toMatchObject({ action: 'sign_in', detail: { network: '127.0.0.0/24',
      device: { browser: 'Chrome', platform: 'macOS' } } });
    expect((await f.request(`/api/account/security-activity?cursor=${encodeURIComponent(first.nextCursor)}`, undefined, peer.cookie)).status).toBe(400);
    const sessions = await (await f.request('/api/account/sessions', undefined, currentCookie)).json() as {
      items: { id: string; groupKey: string; thisDevice: boolean; token?: string }[] };
    expect(sessions.items).toHaveLength(3);
    expect(sessions.items.filter(item => item.thisDevice)).toHaveLength(1);
    expect(new Set(sessions.items.map(item => item.groupKey)).size).toBe(2);
    expect(new Set(sessions.items.filter(item => !item.thisDevice).map(item => item.groupKey)).size).toBe(1);
    expect(sessions.items.every(item => item.token === undefined)).toBe(true);
    const victim = sessions.items.find(item => !item.thisDevice)!;
    expect(await (await f.request('/api/account/sessions/revoke', { sessionId: victim.id }, peer.cookie)).json()).toEqual({ revoked: 0 });
    const race = await Promise.all([1, 2].map(() => f.request('/api/account/sessions/revoke', { others: true }, currentCookie)));
    const counts = await Promise.all(race.map(async response => (await response.json() as { revoked: number }).revoked));
    expect(counts.sort()).toEqual([0, 2]);
    expect(await (await f.request('/api/auth/get-session', undefined, member.cookie)).json()).toBeNull();
    expect((await f.request('/api/auth/sign-out', {}, currentCookie)).status).toBe(200);
    await expect(f.pool.query('DELETE FROM rezics_account_security_event WHERE user_id = $1', [member.id])).rejects.toThrow('append-only');
    const events = (await f.pool.query('SELECT action FROM rezics_account_security_event WHERE user_id = $1', [member.id])).rows;
    expect(events.map(row => row.action)).toContain('sign_out');
    expect(events.map(row => row.action)).toContain('session_revoked');
    await f.pool.query(`CREATE FUNCTION reject_failure_log_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action = 'sign_in_failed' THEN RAISE EXCEPTION 'log unavailable probe'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER reject_failure_log_probe BEFORE INSERT ON rezics_account_security_event
      FOR EACH ROW EXECUTE FUNCTION reject_failure_log_probe()`);
    const known = await f.request('/api/auth/sign-in/email', { email: member.email, password: 'incorrect password' });
    const unknown = await f.request('/api/auth/sign-in/email', { email: 'unknown@example.test', password: 'incorrect password' });
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
  } finally { await f.close(); }
}, 60_000);
