import { expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { chromium, type Page } from '@playwright/test';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { markEmailChangeStep } from '../src/account-settings.ts';

const link = (text: string) => /https?:\/\/\S+/.exec(text)![0];

test('G261 settings: the account language is validated, returned with the session and used for Account email', async () => {
  const f = await accountFixture();
  try {
    const body = { email: 'lang@example.test', name: 'Lang', password: 'a sufficiently long password', locale: 'zh-CN' };
    expect((await f.request('/api/auth/sign-up/email', { ...body, email: 'fr@example.test', locale: 'fr' })).status).toBe(400);
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
    expect(await session()).toBe('zh-CN');
    expect((await f.request('/api/auth/update-user', { locale: 'fr' }, cookie)).status).toBe(400);
    expect(await session()).toBe('zh-CN');
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
