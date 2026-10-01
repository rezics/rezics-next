import { expect, test } from 'bun:test';
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { createOTP } from '@better-auth/utils/otp';
import { symmetricDecrypt } from 'better-auth/crypto';
import { chromium, type Page } from '@playwright/test';
import type { PoolClient } from 'pg';
import { accountLocales } from '../src/account-settings.ts';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { markEmailChangeStep, passkeyRelyingParty } from '../src/account-settings.ts';
import { parseActivity, parseConnectedApps, parseMethods, parseSession,
  parseSessions } from '../../../apps/accounts/features/api/account-data.ts';

const link = (text: string) => /https?:\/\/\S+/.exec(text)![0];

test('G288 settings: all interface locales validate and unsupported stored choices are rejected', async () => {
  const f = await accountFixture();
  try {
    const body = { email: 'lang@example.test', name: 'Lang', password: 'a sufficiently long password', locale: 'zh-Hans' };
    expect((await f.request('/api/auth/sign-up/email', { ...body, email: 'unsupported-locale@example.test', locale: 'zh-CN' })).status)
      .toBe(400);
    const signedUp = await f.request('/api/auth/sign-up/email', body, undefined, { 'accept-language': 'en' });
    // A chosen language changes nothing about the enumeration-safe answer.
    expect(await signedUp.json()).toEqual({ status: true });
    await f.email.drain();
    const verification = f.messages.find(message => message.to === body.email)!;
    expect(verification.subject).toBe('验证邮箱地址');
    expect((await f.request(link(verification.text))).status).toBe(302);
    const signedIn = await f.request('/api/auth/sign-in/email', { email: body.email, password: body.password });
    const cookie = signedIn.headers.get('set-cookie')!;
    const session = async () => (await (await f.request('/api/auth/get-session', undefined, cookie)).json() as {
      user: { locale: string | null } }).user.locale;
    expect(await session()).toBe('zh-Hans');
    for (const locale of accountLocales) {
      expect((await f.request('/api/auth/update-user', { locale }, cookie)).status).toBe(200);
      expect(await session()).toBe(locale);
    }
    expect((await f.request('/api/auth/update-user', { locale: 'zh-CN' }, cookie)).status).toBe(400);
    expect((await f.request('/api/auth/update-user', { locale: 'en' }, cookie)).status).toBe(200);
    expect(await session()).toBe('en');
    // The stored choice outranks the language of whichever browser asks.
    await f.request('/api/auth/request-password-reset', { email: body.email, redirectTo: '/reset-password' },
      undefined, { 'accept-language': 'zh-CN' });
    await f.email.drain();
    expect(f.messages.at(-1)).toMatchObject({ to: body.email, subject: 'Reset your password' });
  } finally { await f.close(); }
}, 60_000);

test('G261 settings: an email change marks its confirmation and verification steps for the landing page', async () => {
  expect(markEmailChangeStep('http://a.test/api/auth/verify-email?token=t&callbackURL=%2Fverify-email', 'requested'))
    .toBe('http://a.test/api/auth/verify-email?token=t&callbackURL=%2Fverify-email');
  expect(markEmailChangeStep('http://a.test/v?callbackURL=https%3A%2F%2Fevil.test%2F%3Fchange%3Demail', 'verified'))
    .toBe('http://a.test/v?callbackURL=https%3A%2F%2Fevil.test%2F%3Fchange%3Demail');
  const f = await accountFixture();
  try {
    const member = await f.signup('before@example.test');
    const changed = await f.request('/api/auth/change-email', { newEmail: 'after@example.test',
      callbackURL: '/verify-email?change=email' }, member.cookie);
    expect(changed.status).toBe(200);
    await f.email.drain();
    const confirmation = f.messages.at(-1)!;
    expect(confirmation).toMatchObject({ to: 'before@example.test', subject: 'Confirm your email change' });
    const confirmed = await f.request(link(confirmation.text), undefined, member.cookie);
    expect(confirmed.headers.get('location')).toBe('/verify-email?change=requested');
    await f.email.drain();
    const verification = f.messages.at(-1)!;
    expect(verification).toMatchObject({ to: 'after@example.test', subject: 'Verify your email address' });
    const verified = await f.request(link(verification.text), undefined, member.cookie);
    expect(verified.headers.get('location')).toBe('/verify-email?change=verified');
    expect((await f.pool.query('SELECT email FROM "user" WHERE id = $1', [member.id])).rows[0].email)
      .toBe('after@example.test');
  } finally { await f.close(); }
}, 60_000);

test('G261 contract: the Accounts site reads every account-centre response the service returns', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const member = await f.signup('contract@example.test');
    const client = await oauth.createClient();
    await oauth.issue(client.client_id, member.cookie);
    await f.request('/api/auth/sign-in/email', { email: member.email, password: 'not the password' });
    const read = async (path: string) => (await f.request(path, undefined, member.cookie)).json() as Promise<unknown>;
    expect(parseSession(await read('/api/auth/get-session'))).toMatchObject({ user: { email: member.email,
      locale: null, twoFactorEnabled: false } });
    expect(parseMethods(await read('/api/account/methods'))).toEqual({ password: true,
      passwordChangedAt: expect.any(String), passkeys: [], totp: null });
    expect(parseSessions(await read('/api/account/sessions'))?.items)
      .toContainEqual(expect.objectContaining({ thisDevice: true }));
    const activity = parseActivity(await read('/api/account/security-activity'));
    expect(activity?.items.map(item => item.action)).toEqual(expect.arrayContaining(['sign_in', 'sign_in_failed',
      'consent_granted']));
    expect(activity?.failedLast24Hours).toEqual({ count: 1, capped: false });
    expect(parseConnectedApps(await read('/api/account/connected-apps'))?.items).toEqual([expect.objectContaining({
      clientId: client.client_id, name: 'Notes', trusted: false, withdrawn: false, lastUsedAt: null,
      scopes: expect.arrayContaining([expect.objectContaining({ scope: 'work:read',
        description: expect.objectContaining({ en: 'Read works', 'zh-Hans': '读取作品', de: 'Werke lesen' }) })]) })]);
  } finally { await f.close(); }
}, 60_000);

test('G261 activity: confirming a new authenticator app is enrollment, not a sign-in', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('enroll@example.test');
    expect((await f.request('/api/auth/two-factor/enable', { password: member.password }, member.cookie)).status).toBe(200);
    const secret = await symmetricDecrypt({ key: f.secret, data: (await f.pool.query(
      'SELECT secret FROM "twoFactor" WHERE "userId" = $1', [member.id])).rows[0].secret });
    const confirmed = await f.request('/api/auth/two-factor/verify-totp', { code: await createOTP(secret).totp() },
      member.cookie);
    expect(confirmed.status).toBe(200);
    const actions = async () => (await f.pool.query<{ action: string; method: string | null }>(`SELECT action,
      detail->>'method' AS method FROM rezics_account_security_event WHERE user_id = $1 ORDER BY occurred_at`,
    [member.id])).rows;
    expect(await actions()).toContainEqual({ action: 'totp_added', method: null });
    expect((await actions()).filter(row => row.method === 'verify-totp')).toEqual([]);
    // The second step of a later sign-in is one.
    const challenge = await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password });
    const cookie = challenge.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    await Bun.sleep(1_000 * (30 - (Date.now() / 1000) % 30) + 50);
    expect((await f.request('/api/auth/two-factor/verify-totp', { code: await createOTP(secret).totp() }, cookie)).status)
      .toBe(200);
    expect((await actions()).filter(row => row.method === 'verify-totp')).toEqual([{ action: 'sign_in', method: 'verify-totp' }]);
  } finally { await f.close(); }
}, 90_000);

test('G261 settings: /sign-in can name the App from the signed authorization request only', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const client = await oauth.createClient();
    const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id,
      redirect_uri: 'https://notes.example.test/callback', scope: 'openid work:read', state: 'prelogin',
      code_challenge: createHash('sha256').update(randomBytes(32)).digest('base64url'),
      code_challenge_method: 'S256' });
    const authorized = await f.request(`/api/auth/oauth2/authorize?${query}`);
    const signIn = new URL(authorized.headers.get('location')!, f.baseURL);
    expect(signIn.pathname).toBe('/sign-in');
    const named = await f.request('/api/auth/oauth2/public-client-prelogin',
      { client_id: client.client_id, oauth_query: signIn.searchParams.toString() });
    expect(named.status).toBe(200);
    expect(await named.json()).toMatchObject({ client_id: client.client_id, client_name: 'Notes' });
    signIn.searchParams.set('state', 'tampered');
    expect((await f.request('/api/auth/oauth2/public-client-prelogin',
      { client_id: client.client_id, oauth_query: signIn.searchParams.toString() })).status).toBe(400);
    expect((await f.request('/api/auth/oauth2/public-client-prelogin', { client_id: client.client_id })).ok).toBe(false);
  } finally { await f.close(); }
}, 60_000);

test('G261 settings: a loopback issuer names passkeys for localhost, which WebAuthn accepts', () => {
  expect(passkeyRelyingParty('https://accounts.rezics.example')).toEqual({ rpID: 'accounts.rezics.example',
    origin: 'https://accounts.rezics.example' });
  expect(passkeyRelyingParty('http://localhost:3004')).toEqual({ rpID: 'localhost', origin: 'http://localhost:3004' });
  expect(passkeyRelyingParty('http://127.0.0.1:3004/')).toEqual({ rpID: 'localhost',
    origin: ['http://localhost:3004', 'http://127.0.0.1:3004'] });
});

async function createPasskey(page: Page, options: unknown) {
  return page.evaluate(async raw => {
    const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
    const options = raw as PublicKeyCredentialCreationOptions;
    options.challenge = decode(String(options.challenge));
    options.user.id = decode(String(options.user.id));
    options.excludeCredentials = options.excludeCredentials?.map(item => ({ ...item, id: decode(String(item.id)) }));
    return (await navigator.credentials.create({ publicKey: options }) as PublicKeyCredential).toJSON();
  }, options);
}

async function assertPasskey(page: Page, options: unknown) {
  return page.evaluate(async raw => {
    const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
    const options = raw as PublicKeyCredentialRequestOptions;
    options.challenge = decode(String(options.challenge));
    options.allowCredentials = options.allowCredentials?.map(item => ({ ...item, id: decode(String(item.id)) }));
    options.userVerification = 'required';
    return (await navigator.credentials.get({ publicKey: options }) as PublicKeyCredential).toJSON();
  }, options);
}

test('G261 settings: passkey step-up proves the person again without a second session; passkeys show provider and last use', async () => {
  const f = await accountFixture({}, 'localhost');
  const browser = await chromium.launch({ headless: true });
  try {
    const member = await f.signup('step-up@example.test');
    const peer = await f.signup('step-up-peer@example.test');
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`${f.baseURL}/health/live`);
    const agent = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0 Safari/537.36' };
    const register = async (cookie: string) => {
      const options = await f.request('/api/auth/passkey/generate-register-options', undefined, cookie);
      const response = await createPasskey(page, await options.json());
      const created = await f.request('/api/auth/passkey/verify-registration', { response },
        `${cookie}; ${options.headers.get('set-cookie')}`, agent);
      expect(created.status).toBe(200);
      return (await created.json() as { id: string }).id;
    };
    const assertion = async (cookie?: string) => {
      const options = await f.request('/api/auth/passkey/generate-authenticate-options', undefined, cookie);
      return { response: await assertPasskey(page, await options.json()),
        challenge: options.headers.get('set-cookie')!.split(';')[0]! };
    };
    // A browser's same-origin GET carries no Origin header; registration must still start.
    const browserGet = await fetch(`${f.baseURL}/api/auth/passkey/generate-register-options`,
      { headers: { cookie: member.cookie } });
    expect(browserGet.status).toBe(200);
    const passkeyId = await register(member.cookie);
    await register(peer.cookie);
    const methods = async () => (await (await f.request('/api/account/methods', undefined, member.cookie)).json() as {
      passwordChangedAt: string | null; passkeys: { name: string; provider: string | null; lastUsedAt: string | null }[] });
    // A virtual authenticator reports no known AAGUID, so the device names it.
    expect((await methods()).passkeys).toEqual([expect.objectContaining({ name: 'Chrome · macOS', provider: null,
      lastUsedAt: null })]);
    expect((await methods()).passwordChangedAt).toBeString();

    await f.pool.query(`UPDATE "session" SET "createdAt" = now() - interval '10 minutes' WHERE "userId" = $1`, [member.id]);
    const rename = () => f.request('/api/auth/passkey/update-passkey', { id: passkeyId, name: 'Work laptop' }, member.cookie);
    expect(await (await rename()).json()).toEqual({ error: 'step_up_required' });
    const sessions = async () => (await f.pool.query('SELECT count(*)::int AS n FROM "session" WHERE "userId" = ANY($1)',
      [[member.id, peer.id]])).rows[0].n as number;
    const before = await sessions();

    // Someone else's passkey never confirms this account.
    const foreign = await assertion(peer.cookie);
    expect((await f.request('/api/account/reauthenticate/passkey', { response: foreign.response },
      `${member.cookie}; ${foreign.challenge}`)).status).toBe(403);
    const own = await assertion(member.cookie);
    const stepUp = await f.request('/api/account/reauthenticate/passkey', { response: own.response },
      `${member.cookie}; ${own.challenge}`);
    expect(stepUp.status).toBe(200);
    const verifiedCounter = Buffer.from((own.response as { response: { authenticatorData: string } })
      .response.authenticatorData, 'base64url').readUInt32BE(33);
    expect(verifiedCounter).toBeGreaterThan(0);
    expect((await f.pool.query('SELECT counter FROM passkey WHERE id = $1', [passkeyId])).rows[0].counter)
      .toBe(verifiedCounter);
    expect(await stepUp.json()).toMatchObject({ verifiedUntil: expect.any(String) });
    expect(stepUp.headers.getSetCookie().some(value => value.includes('session_token'))).toBe(false);
    expect(await sessions()).toBe(before);
    expect((await rename()).status).toBe(200);
    expect((await methods()).passkeys[0]).toMatchObject({ name: 'Work laptop', lastUsedAt: expect.any(String) });
    // The challenge was consumed: the same assertion cannot confirm again.
    expect((await f.request('/api/account/reauthenticate/passkey', { response: own.response },
      `${member.cookie}; ${own.challenge}`)).status).toBe(403);
    expect((await f.request('/api/account/reauthenticate/passkey', { response: { id: 'x' } }, member.cookie)).status)
      .toBe(400);

    // Outside a step-up the same ceremony is an ordinary passkey sign-in (the
    // authenticator picks either discoverable credential).
    const signIn = await assertion();
    const signedIn = await f.request('/api/auth/passkey/verify-authentication', { response: signIn.response },
      signIn.challenge);
    expect(signedIn.status).toBe(200);
    expect(await sessions()).toBe(before + 1);
  } finally { await browser.close(); await f.close(); }
}, 90_000);

test('SR-5: concurrent passkey step-ups preserve the highest counter; cloned regressions fail without a new session', async () => {
  const f = await accountFixture({}, 'localhost');
  const browser = await chromium.launch({ headless: true });
  let blocker: PoolClient | undefined;
  try {
    const member = await f.signup('counter-race@example.test');
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`${f.baseURL}/health/live`);
    const options = await f.request('/api/auth/passkey/generate-register-options', undefined, member.cookie);
    const registered = await f.request('/api/auth/passkey/verify-registration', {
      response: await createPasskey(page, await options.json()),
    }, `${member.cookie}; ${options.headers.get('set-cookie')}`);
    expect(registered.status).toBe(200);
    const passkeyId = (await registered.json() as { id: string }).id;
    const assertion = async () => {
      const options = await f.request('/api/auth/passkey/generate-authenticate-options', undefined, member.cookie);
      const response = await assertPasskey(page, await options.json());
      return { response, cookie: `${member.cookie}; ${options.headers.get('set-cookie')}`,
        counter: Buffer.from((response as { response: { authenticatorData: string } }).response.authenticatorData,
          'base64url').readUInt32BE(33) };
    };
    const stepUp = (proof: Awaited<ReturnType<typeof assertion>>) =>
      f.request('/api/account/reauthenticate/passkey', { response: proof.response }, proof.cookie);
    const sessions = async () => (await f.pool.query('SELECT id FROM "session" WHERE "userId" = $1 ORDER BY id', [member.id])).rows;
    const before = await sessions();
    const initial = await assertion();
    expect((await stepUp(initial)).status).toBe(200);
    const lower = await assertion();
    const higher = await assertion();
    expect(higher.counter).toBeGreaterThan(lower.counter);
    blocker = await f.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM passkey WHERE id = $1 FOR UPDATE', [passkeyId]);
    const waiting = async (count: number) => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const rows = await f.pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
          AND query LIKE 'UPDATE passkey SET counter%'`);
        if (rows.rowCount === count) return;
        await Bun.sleep(10);
      }
      throw new Error('passkey counter writes did not wait');
    };
    const first = stepUp(higher);
    await waiting(1);
    const second = stepUp(lower);
    await waiting(2);
    await blocker.query('COMMIT'); blocker.release(); blocker = undefined;
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(403);
    expect((await f.pool.query('SELECT counter FROM passkey WHERE id = $1', [passkeyId])).rows[0].counter).toBe(higher.counter);
    // Model a cloned authenticator whose signature is valid but counter is old.
    const credential = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials[0]!;
    await cdp.send('WebAuthn.removeCredential', { authenticatorId, credentialId: credential.credentialId });
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { ...credential, signCount: 0 } });
    expect((await stepUp(await assertion())).status).toBe(403);
    // An ordinary provider sign-in cannot overwrite a higher step-up counter.
    await expect(f.pool.query('UPDATE passkey SET counter = $2 WHERE id = $1', [passkeyId, lower.counter]))
      .rejects.toThrow('stale_passkey_counter');
    expect(await sessions()).toEqual(before);
  } finally {
    if (blocker) { await blocker.query('ROLLBACK'); blocker.release(); }
    await browser.close(); await f.close();
  }
}, 90_000);

test('SR-5: a counterless authenticator can step up; failed persistence grants no proof', async () => {
  const f = await accountFixture({}, 'localhost');
  const browser = await chromium.launch({ headless: true });
  try {
    const member = await f.signup('counterless@example.test');
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`${f.baseURL}/health/live`);
    const options = await f.request('/api/auth/passkey/generate-register-options', undefined, member.cookie);
    const registered = await f.request('/api/auth/passkey/verify-registration', {
      response: await createPasskey(page, await options.json()),
    }, `${member.cookie}; ${options.headers.get('set-cookie')}`);
    expect(registered.status).toBe(200);
    const passkeyId = (await registered.json() as { id: string }).id;
    // Chromium increments counters; re-sign with its test credential to model
    // an authenticator that implements the standard's always-zero alternative.
    // Seed its registration at zero without bypassing the monotonic UPDATE
    // constraint (the password keeps removal from being the last method).
    const stored = (await f.pool.query('DELETE FROM passkey WHERE id = $1 RETURNING *', [passkeyId])).rows[0];
    await f.pool.query('INSERT INTO passkey SELECT * FROM jsonb_populate_record(NULL::passkey, $1::jsonb)',
      [JSON.stringify({ ...stored, counter: 0 })]);
    const credential = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials[0]!;
    const key = createPrivateKey({ key: Buffer.from(credential.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    const assertion = async () => {
      const options = await f.request('/api/auth/passkey/generate-authenticate-options', undefined, member.cookie);
      const response = await assertPasskey(page, await options.json()) as { response: {
        authenticatorData: string; clientDataJSON: string; signature: string } };
      const data = Buffer.from(response.response.authenticatorData, 'base64url');
      data.writeUInt32BE(0, 33);
      response.response.authenticatorData = data.toString('base64url');
      response.response.signature = sign(key.asymmetricKeyType === 'ed25519' ? null : 'sha256', Buffer.concat([data,
        createHash('sha256').update(Buffer.from(response.response.clientDataJSON, 'base64url')).digest()]), key)
        .toString('base64url');
      return f.request('/api/account/reauthenticate/passkey', { response },
        `${member.cookie}; ${options.headers.get('set-cookie')}`);
    };
    const sessions = (await f.pool.query('SELECT id FROM "session" WHERE "userId" = $1 ORDER BY id', [member.id])).rows;
    await f.pool.query(`CREATE FUNCTION reject_counter_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'counter unavailable'; END $$;
      CREATE TRIGGER reject_counter_write BEFORE UPDATE ON passkey
      FOR EACH ROW EXECUTE FUNCTION reject_counter_write()`);
    expect((await assertion()).status).toBe(403);
    expect((await f.pool.query('SELECT 1 FROM rezics_account_step_up')).rowCount).toBe(0);
    await f.pool.query('DROP TRIGGER reject_counter_write ON passkey');
    expect((await assertion()).status).toBe(200);
    expect((await assertion()).status).toBe(200);
    expect((await f.pool.query('SELECT counter, "rezicsLastUsedAt" FROM passkey WHERE id = $1', [passkeyId])).rows)
      .toEqual([{ counter: 0, rezicsLastUsedAt: expect.any(Date) }]);
    expect((await f.pool.query('SELECT id FROM "session" WHERE "userId" = $1 ORDER BY id', [member.id])).rows).toEqual(sessions);
  } finally { await browser.close(); await f.close(); }
}, 90_000);
