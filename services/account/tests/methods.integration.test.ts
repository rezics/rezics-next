import { expect, test } from 'bun:test';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createOTP } from '@better-auth/utils/otp';
import { chromium } from '@playwright/test';
import { accountFixture } from './account-fixture.ts';

const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

test('G205 methods: TOTP enrollment, rename, sign-in challenge, backup consumption and stale step-up', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('totp@example.test');
    const enable = await f.request('/api/auth/two-factor/enable', { password: member.password }, member.cookie);
    expect(enable.status).toBe(200);
    const enrollment = await enable.json() as { totpURI: string; backupCodes: string[] };
    expect(enrollment.backupCodes).toHaveLength(10);
    expect(enrollment.totpURI).toStartWith('otpauth://totp/');
    const secret = await symmetricDecrypt({ key: f.secret,
      data: (await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [member.id])).rows[0].secret });
    const invalid = await f.request('/api/auth/two-factor/verify-totp', { code: 'invalid' }, member.cookie);
    expect(invalid.ok).toBe(false);
    const verified = await f.request('/api/auth/two-factor/verify-totp', { code: await createOTP(secret).totp() }, member.cookie);
    expect(verified.status).toBe(200);
    const cookie = cookies(verified);
    expect((await f.request('/api/account/methods/totp/name', { name: 'Phone authenticator' }, cookie)).status).toBe(200);
    expect(await (await f.request('/api/account/methods', undefined, cookie)).json()).toMatchObject({
      password: true, passkeys: [], totp: { name: 'Phone authenticator', verified: true } });
    const passwordSignIn = await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password });
    expect(await passwordSignIn.json()).toMatchObject({ twoFactorRedirect: true });
    const challengeCookie = cookies(passwordSignIn);
    expect(await (await f.request('/api/auth/get-session', undefined, challengeCookie)).json()).toBeNull();
    const backup = await f.request('/api/auth/two-factor/verify-backup-code', { code: enrollment.backupCodes[0] }, challengeCookie);
    expect(backup.status).toBe(200);
    expect((await f.request('/api/auth/two-factor/verify-backup-code', { code: enrollment.backupCodes[0] }, challengeCookie)).ok).toBe(false);
    await f.pool.query('UPDATE "session" SET "createdAt" = now() - interval \'10 minutes\' WHERE "userId" = $1', [member.id]);
    expect((await f.request('/api/auth/two-factor/disable', { password: member.password }, cookie)).status).toBe(403);
    expect((await f.request('/api/account/reauthenticate', { password: 'incorrect' }, cookie)).status).toBe(403);
    expect((await f.request('/api/account/reauthenticate', { password: member.password }, cookie)).status).toBe(403);
    expect((await f.request('/api/account/reauthenticate', { password: member.password,
      totpCode: await createOTP(secret).totp() }, cookie)).status).toBe(200);
    expect((await f.request('/api/auth/two-factor/disable', { password: member.password }, cookie)).status).toBe(200);
    const current = await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password });
    expect((await f.request('/api/account/methods/password/remove', {}, current.headers.get('set-cookie')!)).status).toBe(409);
  } finally { await f.close(); }
}, 60_000);

test('G205 methods: real WebAuthn enrollment and sign-in, rename, foreign removal and last-method concurrency', async () => {
  const f = await accountFixture({}, 'localhost');
  const browser = await chromium.launch({ headless: true });
  try {
    const member = await f.signup('passkey@example.test');
    const peer = await f.signup('peer@example.test');
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`${f.baseURL}/health/live`);
    const registration = await f.request('/api/auth/passkey/generate-register-options', undefined, member.cookie);
    expect(registration.status).toBe(200);
    const registrationOptions = await registration.json();
    const registered = await page.evaluate(async raw => {
      const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
      const options = raw as PublicKeyCredentialCreationOptions;
      options.challenge = decode(String(options.challenge));
      options.user.id = decode(String(options.user.id));
      options.excludeCredentials = options.excludeCredentials?.map(item => ({ ...item, id: decode(String(item.id)) }));
      const credential = await navigator.credentials.create({ publicKey: options }) as PublicKeyCredential;
      return credential.toJSON();
    }, registrationOptions);
    const registrationCookie = `${member.cookie}; ${registration.headers.get('set-cookie')}`;
    const registeredResponse = await f.request('/api/auth/passkey/verify-registration', { response: registered, name: 'Laptop' }, registrationCookie);
    expect(registeredResponse.status).toBe(200);
    const passkey = await registeredResponse.json() as { id: string };
    expect((await f.request('/api/auth/passkey/update-passkey', { id: passkey.id, name: 'Work laptop' }, member.cookie)).status).toBe(200);
    expect((await f.request('/api/auth/passkey/delete-passkey', { id: passkey.id }, peer.cookie)).ok).toBe(false);
    const authentication = await f.request('/api/auth/passkey/generate-authenticate-options');
    const assertion = await page.evaluate(async raw => {
      const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
      const options = raw as PublicKeyCredentialRequestOptions;
      options.challenge = decode(String(options.challenge));
      options.userVerification = 'required';
      const credential = await navigator.credentials.get({ publicKey: options }) as PublicKeyCredential;
      return credential.toJSON();
    }, await authentication.json());
    const signed = await f.request('/api/auth/passkey/verify-authentication', { response: assertion }, authentication.headers.get('set-cookie')!);
    expect(signed.status).toBe(200);
    const signedCookie = signed.headers.get('set-cookie')!;
    const replay = await f.request('/api/auth/passkey/verify-authentication', { response: assertion }, authentication.headers.get('set-cookie')!);
    expect(replay.ok).toBe(false);
    const removals = await Promise.all([
      f.request('/api/auth/passkey/delete-passkey', { id: passkey.id }, signedCookie),
      f.request('/api/account/methods/password/remove', {}, signedCookie),
    ]);
    expect(removals.filter(response => response.ok)).toHaveLength(1);
    const methods = await (await f.request('/api/account/methods', undefined, signedCookie)).json() as { password: boolean; passkeys: unknown[] };
    expect(Number(methods.password) + methods.passkeys.length).toBe(1);
  } finally { await browser.close(); await f.close(); }
}, 60_000);
