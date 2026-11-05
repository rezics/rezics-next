import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startAuthStack } from './auth-stack.ts';
import { startNativeWebStack } from './stack.ts';
import {
  exactCookie,
  nativeAuthPassword,
  navigationUrls,
  provisionNativeAuthSecurityFixture,
  startNativeAuthIssuerProxy,
  visitLibrarySignIn,
  type NativeAuthIssuerProxy,
  type NativeAuthSecurityFixture,
  submitPasswordSignIn,
} from './native-auth-security-fixture.ts';

let stack: Awaited<ReturnType<typeof startNativeWebStack>>;
let auth: Awaited<ReturnType<typeof startAuthStack>>;
let issuerProxy: NativeAuthIssuerProxy;
let fixture: NativeAuthSecurityFixture;

beforeAll(async () => {
  issuerProxy = await startNativeAuthIssuerProxy();
  stack = await startNativeWebStack({
    issuerOrigin: issuerProxy.origin,
    authClockOffsetSeconds: -601,
    webTls: issuerProxy.webTls,
  });
  issuerProxy.setUpstream(stack.authIssuer);
  fixture = await provisionNativeAuthSecurityFixture(stack);
  auth = await startAuthStack(stack);
}, 300_000);

afterAll(async () => {
  await auth?.stop();
  await stack?.stop();
  await issuerProxy?.stop();
}, 180_000);

test('served account security journey signs up, steps up, uses passkeys, and revokes both sessions', async () => {
  const newcomerContext = await auth.context('newcomer');
  const newcomerPage = await newcomerContext.newPage();
  newcomerPage.setDefaultTimeout(15_000);
  const newcomerUrls = navigationUrls(newcomerPage);
  const signupTarget = fixture.libraryTarget;
  await visitLibrarySignIn(newcomerPage, stack, signupTarget);
  const signup = newcomerPage.getByRole('link', { name: /create an account|sign up/i }).first();
  await signup.click();
  await newcomerPage.waitForURL((url) => new URL(url).pathname === '/signup');
  await newcomerPage.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  await newcomerPage.getByLabel('Handle', { exact: true }).fill(`native-auth-${crypto.randomUUID().slice(0, 8)}`);
  await newcomerPage.getByLabel('Email', { exact: true }).fill(`native-auth-${crypto.randomUUID()}@example.test`);
  await newcomerPage.getByLabel('Password', { exact: true }).fill(`Newcomer-${crypto.randomUUID()}-Secure`);
  const signupResponse = newcomerPage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/signup' && response.request().method() === 'POST',
  );
  await newcomerPage.getByRole('button', { name: 'Create an account', exact: true }).click();
  const created = await signupResponse;
  expect(created.status()).toBe(201);
  const newcomerId = ((await created.json()) as { accountId?: unknown }).accountId;
  expect(typeof newcomerId).toBe('string');
  expect([fixture.accountIds.alice, fixture.accountIds.bob]).not.toContain(newcomerId);
  await newcomerPage.waitForURL((url) => `${url.pathname}${url.search}` === signupTarget, { timeout: 30_000 });
  await newcomerPage.locator('#account-menu-button').waitFor({ state: 'visible' });
  expect(await exactCookie(newcomerContext, stack.web, '__Host-rezics_session')).toBeDefined();
  expect(newcomerUrls.some((url) => new URL(url).pathname === '/consent')).toBe(false);
  expect(new URL(newcomerPage.url()).origin).toBe(new URL(stack.web).origin);
  expect(new URL(newcomerPage.url()).pathname + new URL(newcomerPage.url()).search).toBe(signupTarget);

  const aliceContext = await auth.context('alice');
  const alicePage = await aliceContext.newPage();
  alicePage.setDefaultTimeout(15_000);
  const aliceUrls = navigationUrls(alicePage);
  const aliceIdentity = await stack.authPersona('alice');
  await visitLibrarySignIn(alicePage, stack, fixture.libraryTarget);
  const aliceSignIn = await submitPasswordSignIn(
    alicePage,
    { email: aliceIdentity.email, password: nativeAuthPassword },
    fixture.libraryTarget,
  );
  expect(aliceSignIn.status()).toBe(200);
  await alicePage.locator('#account-menu-button').waitFor({ state: 'visible' });
  expect(await exactCookie(aliceContext, stack.web, '__Host-rezics_session')).toBeDefined();
  expect(aliceUrls.some((url) => new URL(url).pathname === '/consent')).toBe(false);

  const bobContext = await auth.context('bob');
  const bobPage = await bobContext.newPage();
  bobPage.setDefaultTimeout(15_000);
  const bobIdentity = await stack.authPersona('bob');
  await visitLibrarySignIn(bobPage, stack, fixture.libraryTarget);
  const bobSignIn = await submitPasswordSignIn(
    bobPage,
    { email: bobIdentity.email, password: nativeAuthPassword },
    fixture.libraryTarget,
  );
  expect(bobSignIn.status()).toBe(200);
  expect(aliceContext).not.toBe(bobContext);
  expect((await exactCookie(aliceContext, stack.web, '__Host-rezics_session'))?.value).not.toBe(
    (await exactCookie(bobContext, stack.web, '__Host-rezics_session'))?.value,
  );
  expect(auth.context('alice')).toBe(aliceContext);
  expect(auth.context('bob')).toBe(bobContext);

  await alicePage.locator('#account-menu-button').click();
  const firstPasskeyList = alicePage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/passkeys' && response.request().method() === 'GET',
  );
  await alicePage.locator('[data-account-security-settings]').click();
  await alicePage.waitForURL((url) => url.origin === auth.origin && url.pathname === '/security');
  expect((await firstPasskeyList).status()).toBe(200);
  await alicePage.getByRole('region', { name: 'Sessions', exact: true }).waitFor({ state: 'visible' });
  const websiteSession = alicePage.getByRole('listitem').filter({ hasText: 'REZICS' });
  await websiteSession.first().waitFor({ state: 'visible' });
  const sessionResponse = await alicePage.evaluate(async () => {
    const response = await fetch('/sessions', { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  });
  expect(sessionResponse.status).toBe(200);
  expect(sessionResponse.body.sessions).toContainEqual(expect.objectContaining({ client_id: 'rezics-website' }));
  expect(new URL(auth.origin).hostname).toBe('auth.native.rezics.com');
  expect((await alicePage.goBack({ waitUntil: 'domcontentloaded' }))?.status()).toBe(200);
  await alicePage.waitForURL((url) => `${url.pathname}${url.search}` === fixture.libraryTarget);

  await alicePage.goto(`${stack.web}${fixture.book.path}`, { waitUntil: 'domcontentloaded' });
  await alicePage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(await alicePage.getByRole('heading', { name: fixture.book.title, exact: true }).count()).toBe(1);
  const state = alicePage.getByRole('combobox', { name: 'Library state', exact: true });
  await state.click();
  await alicePage.getByRole('option', { name: 'Planned', exact: true }).click();
  await alicePage.getByRole('alert').filter({ hasText: 'Library state saved.' }).waitFor();
  const personalRead = await stack.kernel(
    `/v1/libraryEntries?subjectId=${encodeURIComponent(fixture.book.id)}&view=FULL`,
    {},
    'alice',
  );
  expect(personalRead.status).toBe(200);
  expect(await personalRead.text()).toContain('planned');

  await alicePage.locator('#account-menu-button').click();
  const stalePasskeyList = alicePage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/passkeys' && response.request().method() === 'GET',
  );
  await alicePage.locator('[data-account-security-settings]').click();
  await alicePage.waitForURL((url) => url.origin === auth.origin && url.pathname === '/security');
  expect((await stalePasskeyList).status()).toBe(200);
  await alicePage.getByRole('button', { name: 'Add a passkey', exact: true }).waitFor({ state: 'visible' });
  const beforeStepUp = await alicePage.evaluate(async () => {
    const response = await fetch('/session', { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  });
  expect(beforeStepUp.status).toBe(200);
  const webauthn = await aliceContext.newCDPSession(alicePage);
  await webauthn.send('WebAuthn.enable');
  const authenticator = await webauthn.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await stack.advanceAuthClock(601);
  const staleOptionsResponse = alicePage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/passkeys/register/options' && response.request().method() === 'POST',
  );
  await alicePage.getByRole('button', { name: 'Add a passkey', exact: true }).click();
  const staleOptions = await staleOptionsResponse;
  expect(staleOptions.status()).toBe(401);
  expect(await staleOptions.json()).toMatchObject({ error: 'step_up_required' });
  await alicePage.waitForURL((url) => url.origin === auth.origin && url.pathname === '/step-up');
  await alicePage.getByLabel('Email', { exact: true }).fill(aliceIdentity.email);
  await alicePage.locator('input[name="password"]').fill(nativeAuthPassword);
  const stepUpResponse = alicePage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/signin' && response.request().method() === 'POST',
  );
  await alicePage.getByRole('button', { name: 'Verify your identity', exact: true }).click();
  expect((await stepUpResponse).status()).toBe(200);
  await alicePage.waitForURL((url) => url.origin === auth.origin && url.pathname === '/security');
  const afterStepUp = await alicePage.evaluate(async () => {
    const response = await fetch('/session', { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  });
  expect(afterStepUp.status).toBe(200);
  expect(afterStepUp.body.auth_time - beforeStepUp.body.auth_time).toBeGreaterThan(600);

  const registrationOptionsResponse = alicePage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/passkeys/register/options' && response.request().method() === 'POST',
  );
  const registrationResponse = alicePage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/passkeys/register' && response.request().method() === 'POST',
  );
  await alicePage.getByLabel('Passkey name (optional)', { exact: true }).fill('Alice native passkey');
  await alicePage.getByRole('button', { name: 'Add a passkey', exact: true }).click();
  const registrationOptions = await registrationOptionsResponse;
  expect(registrationOptions.status()).toBe(200);
  expect(((await registrationOptions.json()) as { rp?: { id?: string } }).rp?.id).toBe('rezics.com');
  const registered = await registrationResponse;
  expect(registered.status()).toBe(201);
  await alicePage.getByRole('alert').filter({ hasText: 'Passkey added.' }).waitFor({ state: 'visible' });
  await alicePage.reload({ waitUntil: 'domcontentloaded' });
  await alicePage.getByRole('region', { name: 'Passkeys', exact: true }).waitFor({ state: 'visible' });
  const nativePasskeys = await alicePage.evaluate(async () => {
    const response = await fetch('/passkeys', { credentials: 'include', cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  expect(nativePasskeys.status).toBe(200);
  expect(nativePasskeys.body.passkeys).toHaveLength(1);
  expect(await alicePage.getByRole('listitem').filter({ hasText: 'Alice native passkey' }).count()).toBe(1);

  await alicePage.goto(`${stack.web}${fixture.libraryTarget}`, { waitUntil: 'domcontentloaded' });
  await alicePage.locator('#account-menu-button').waitFor({ state: 'visible' });
  await alicePage.locator('#account-menu-button').click();
  const websiteSignOut = alicePage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/auth/sign-out' && response.request().method() === 'POST',
  );
  await alicePage.getByRole('button', { name: 'Sign out', exact: true }).click();
  const websiteSignOutResponse = await websiteSignOut;
  expect(websiteSignOutResponse.status()).toBeGreaterThanOrEqual(300);
  expect(websiteSignOutResponse.status()).toBeLessThan(400);
  expect(await exactCookie(aliceContext, stack.web, '__Host-rezics_session')).toBeUndefined();
  expect((await alicePage.goto(`${auth.origin}/session`, { waitUntil: 'domcontentloaded' }))?.status()).toBe(401);
  await alicePage.reload({ waitUntil: 'domcontentloaded' });
  expect(await alicePage.locator('#account-menu-button').count()).toBe(0);
  await alicePage.goto(`${stack.web}${fixture.libraryTarget}`, { waitUntil: 'domcontentloaded' });
  await alicePage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(await alicePage.locator('#account-menu-button').count()).toBe(0);
  const anonymousLibrary = await stack.request(`${stack.web}${fixture.libraryTarget}`, 'anonymous');
  expect(anonymousLibrary.status).toBe(200);
  expect(await anonymousLibrary.text()).not.toContain(fixture.book.title);
  await alicePage.goto(`${stack.web}${fixture.book.path}`, { waitUntil: 'domcontentloaded' });
  await alicePage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(await alicePage.getByRole('heading', { name: fixture.book.title, exact: true }).count()).toBe(1);
  expect(await alicePage.getByRole('combobox', { name: 'Library state', exact: true }).count()).toBe(0);
  const anonymousCatalogue = await stack.kernel(`/v1/subjects/${encodeURIComponent(fixture.book.id)}`);
  expect(anonymousCatalogue.status).toBe(200);
  expect(await anonymousCatalogue.text()).toContain(fixture.book.title);

  await visitLibrarySignIn(alicePage, stack, fixture.libraryTarget);
  await alicePage.getByRole('button', { name: 'Sign in with a passkey', exact: true }).waitFor({ state: 'visible' });
  const passkeySignInOptionsResponse = alicePage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/signin/passkey/options' && response.request().method() === 'POST',
  );
  const passkeySignInResponse = alicePage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/signin/passkey' && response.request().method() === 'POST',
  );
  await alicePage.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
  const signInOptions = await passkeySignInOptionsResponse;
  expect(signInOptions.status()).toBe(200);
  expect(((await signInOptions.json()) as { rpId?: string }).rpId).toBe('rezics.com');
  expect((await passkeySignInResponse).status()).toBe(200);
  await alicePage.waitForURL((url) => `${url.pathname}${url.search}` === fixture.libraryTarget, { timeout: 30_000 });
  await alicePage.locator('#account-menu-button').waitFor({ state: 'visible' });
  expect(await exactCookie(aliceContext, stack.web, '__Host-rezics_session')).toBeDefined();
  await alicePage.locator('#account-menu-button').click();
  const usedPasskeyList = alicePage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/passkeys' && response.request().method() === 'GET',
  );
  await alicePage.locator('[data-account-security-settings]').click();
  await alicePage.waitForURL((url) => url.origin === auth.origin && url.pathname === '/security');
  expect((await usedPasskeyList).status()).toBe(200);
  const usedPasskeyRead = await alicePage.evaluate(async () => {
    const sessionResponse = await fetch('/session', { credentials: 'include' });
    const passkeysResponse = await fetch('/passkeys', { credentials: 'include', cache: 'no-store' });
    return {
      session: { status: sessionResponse.status, body: await sessionResponse.json() },
      passkeys: { status: passkeysResponse.status, body: await passkeysResponse.json() },
    };
  });
  expect(usedPasskeyRead.session.status).toBe(200);
  expect(usedPasskeyRead.session.body.amr).toContain('pop');
  expect(usedPasskeyRead.passkeys.status).toBe(200);
  expect(usedPasskeyRead.passkeys.body.passkeys[0].last_used_at).toBeString();

  const wrongRpContext = await auth.context('wrong-rp');
  const wrongRpPage = await wrongRpContext.newPage();
  wrongRpPage.setDefaultTimeout(15_000);
  await visitLibrarySignIn(wrongRpPage, stack, fixture.libraryTarget);
  await wrongRpPage.getByRole('button', { name: 'Sign in with a passkey', exact: true }).waitFor({ state: 'visible' });
  const wrongRpWebAuthn = await wrongRpContext.newCDPSession(wrongRpPage);
  await wrongRpWebAuthn.send('WebAuthn.enable');
  const wrongRpAuthenticator = await wrongRpWebAuthn.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const { generateKeyPairSync, randomBytes } = await import('node:crypto');
  const wrongRpKey = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  await wrongRpWebAuthn.send('WebAuthn.addCredential', {
    authenticatorId: wrongRpAuthenticator.authenticatorId,
    credential: {
      credentialId: randomBytes(32).toString('base64'),
      isResidentCredential: true,
      rpId: 'other.rezics.net',
      privateKey: wrongRpKey.privateKey.toString('base64'),
      signCount: 0,
      userHandle: randomBytes(16).toString('base64'),
      backupEligibility: false,
      backupState: false,
    },
  });
  const wrongRpOptionsResponse = wrongRpPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/signin/passkey/options' && response.request().method() === 'POST',
  );
  const wrongRpAssertionRequests: string[] = [];
  wrongRpPage.on('request', (request) => {
    if (new URL(request.url()).pathname === '/signin/passkey' && request.method() === 'POST')
      wrongRpAssertionRequests.push(request.url());
  });
  await wrongRpPage.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
  const wrongRpOptions = await wrongRpOptionsResponse;
  expect(wrongRpOptions.status()).toBe(200);
  expect(((await wrongRpOptions.json()) as { rpId?: string }).rpId).toBe('rezics.com');
  await wrongRpPage.getByRole('alert').waitFor({ state: 'visible', timeout: 30_000 });
  expect(wrongRpAssertionRequests).toEqual([]);
  expect(await exactCookie(wrongRpContext, stack.web, '__Host-rezics_session')).toBeUndefined();
  expect((await wrongRpPage.goto(`${auth.origin}/session`, { waitUntil: 'domcontentloaded' }))?.status()).toBe(401);

  await alicePage.locator('#account-menu-button').click();
  const finalSignOut = alicePage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/auth/sign-out' && response.request().method() === 'POST',
  );
  await alicePage.getByRole('button', { name: 'Sign out', exact: true }).click();
  const finalSignOutResponse = await finalSignOut;
  expect(finalSignOutResponse.status()).toBeGreaterThanOrEqual(300);
  expect(finalSignOutResponse.status()).toBeLessThan(400);
  expect(await exactCookie(aliceContext, stack.web, '__Host-rezics_session')).toBeUndefined();
  expect((await alicePage.goto(`${auth.origin}/session`, { waitUntil: 'domcontentloaded' }))?.status()).toBe(401);
  await alicePage.goto(stack.web, { waitUntil: 'domcontentloaded' });
  await alicePage.reload({ waitUntil: 'domcontentloaded' });
  expect(await alicePage.locator('#account-menu-button').count()).toBe(0);

  await wrongRpWebAuthn.send('WebAuthn.removeVirtualAuthenticator', {
    authenticatorId: wrongRpAuthenticator.authenticatorId,
  });
  await wrongRpWebAuthn.detach();
  await webauthn.detach();
  await wrongRpContext.close();
  await aliceContext.close();
  await bobContext.close();
  await newcomerContext.close();
}, 420_000);
