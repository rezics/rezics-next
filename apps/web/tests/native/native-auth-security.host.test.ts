import { expect } from 'bun:test';
import type { Page, Response as PlaywrightResponse } from 'playwright';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';
import { prepareNativeAuthMessages, startAuthStack } from './auth-stack.ts';
import { startNativeWebStack } from './stack.ts';
import { exactShelfRow } from './book-catalogue-browser.ts';
import {
  exactCookie,
  nativeAuthPassword,
  navigationUrls,
  observePasskeySignInOptions,
  provisionNativeAuthSecurityFixture,
  startNativeAuthIssuerProxy,
  submitPasswordSignIn,
  visitLibrarySignIn,
  type NativeAuthIssuerProxy,
  type NativeAuthSecurityFixture,
} from './native-auth-security-fixture.ts';

const lifecycle = new NativeTestLifecycle('native Auth security');
let stack: Awaited<ReturnType<typeof startNativeWebStack>>;
let auth: Awaited<ReturnType<typeof startAuthStack>>;
let issuerProxy: NativeAuthIssuerProxy;
let fixture: NativeAuthSecurityFixture;

nativeBeforeAll(lifecycle, 300_000, async () => {
  await prepareNativeAuthMessages();
  issuerProxy = await startNativeAuthIssuerProxy();
  lifecycle.register({ label: 'Auth issuer proxy', close: () => issuerProxy.stop(), force: () => issuerProxy.stop() });
  stack = await startNativeWebStack({
    issuerOrigin: issuerProxy.origin,
    authClockOffsetSeconds: -601,
    webTls: issuerProxy.webTls,
  });
  issuerProxy.setUpstream(stack.authIssuer);
  fixture = await provisionNativeAuthSecurityFixture(stack);
  auth = await startAuthStack(stack, { preparedMessages: true });
});

nativeAfterAll(lifecycle, 180_000);

nativeTest(
  'served account security journey signs up, steps up, uses passkeys, and revokes both sessions',
  420_000,
  manageAccountSecurity,
  lifecycle,
);

async function manageAccountSecurity() {
  const webOrigin = new URL(stack.web).origin;
  const newcomerContext = await auth.newContext('newcomer');
  const newcomerPage = await newcomerContext.newPage();
  newcomerPage.setDefaultTimeout(15_000);
  const newcomerUrls = navigationUrls(newcomerPage);
  const signupTarget = fixture.libraryTarget;
  await visitLibrarySignIn(newcomerPage, stack, auth, signupTarget, 'signup-entry');
  const authorizationQuery = new URL(newcomerPage.url()).search;
  const authorization = new URLSearchParams(authorizationQuery);
  expect(authorization.get('client_id')).toBe('rezics-website');
  const authorizationState = authorization.get('state');
  expect(Boolean(authorizationState), 'Signup starts with a Website authorization state').toBe(true);
  const signup = newcomerPage.getByRole('link', { name: /create an account|sign up/i }).first();
  await signup.click();
  await newcomerPage.waitForURL((url) => url.origin === auth.origin && url.pathname === '/signup');
  expect(new URL(newcomerPage.url()).search === authorizationQuery, 'Signup preserves the authorization query').toBe(
    true,
  );
  await newcomerPage.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  const fields = newcomerPage.locator('#signup-form input');
  const newcomerHandle = `native-auth-${crypto.randomUUID().slice(0, 8)}`;
  const newcomerEmail = `native-auth-${crypto.randomUUID()}@example.test`;
  const newcomerPassword = `Newcomer-${crypto.randomUUID()}-Secure`;
  await fields.and(newcomerPage.getByLabel('Handle', { exact: true })).fill(newcomerHandle);
  await fields.and(newcomerPage.getByLabel('Email', { exact: true })).fill(newcomerEmail);
  await fields.and(newcomerPage.getByLabel('Password', { exact: true })).fill(newcomerPassword);
  await fields.and(newcomerPage.getByLabel('Confirm password', { exact: true })).fill(newcomerPassword);
  await newcomerPage.getByText('Loading the security check…', { exact: true }).waitFor({ state: 'hidden' });
  const [, callback] = await Promise.all([
    newcomerPage
      .waitForResponse(
        (response) => response.url() === `${auth.origin}/signup` && response.request().method() === 'POST',
      )
      .then((response) => expect(response.status()).toBe(201)),
    newcomerPage.waitForResponse(
      (response) => {
        const { origin, pathname } = new URL(response.url());
        const request = response.request();
        return (
          origin === webOrigin &&
          pathname === '/auth/callback' &&
          request.isNavigationRequest() &&
          request.frame() === newcomerPage.mainFrame()
        );
      },
      { timeout: 30_000 },
    ),
    newcomerPage.getByRole('button', { name: 'Create an account', exact: true }).click(),
  ]);
  const newcomerId = await issuerProxy.signupAccountId(newcomerEmail, newcomerHandle);
  expect([fixture.accountIds.alice, fixture.accountIds.bob]).not.toContain(newcomerId);
  const callbackQuery = new URL(callback.url()).searchParams;
  expect(callbackQuery.get('state') === authorizationState, 'Callback matches the signup authorization state').toBe(
    true,
  );
  expect(
    Boolean(callbackQuery.get('code')) && !callbackQuery.has('error'),
    'Callback carries an authorization code',
  ).toBe(true);
  expect(callback.status()).toBe(303);
  expect(callback.headers().location).toBe(signupTarget);
  await newcomerPage.waitForURL((url) => url.origin === webOrigin && `${url.pathname}${url.search}` === signupTarget, {
    timeout: 30_000,
  });
  await newcomerPage.locator('#account-menu-button').waitFor({ state: 'visible' });
  const newcomerCookie = await exactCookie(newcomerContext, stack.web, '__Host-rezics_session');
  expect(newcomerCookie?.httpOnly).toBe(true);
  expect(newcomerUrls.some((url) => new URL(url).pathname === '/consent')).toBe(false);
  await newcomerPage.reload({ waitUntil: 'domcontentloaded' });
  await newcomerPage.locator('#account-menu-button').waitFor({ state: 'visible' });
  const reloadedNewcomerCookie = await exactCookie(newcomerContext, stack.web, '__Host-rezics_session');
  expect(reloadedNewcomerCookie?.value === newcomerCookie?.value, 'Reload preserves the signup session').toBe(true);
  await newcomerContext.close();

  const aliceContext = await auth.context('alice');
  const alicePage = await aliceContext.newPage();
  alicePage.setDefaultTimeout(15_000);
  const aliceUrls = navigationUrls(alicePage);
  const aliceIdentity = await stack.authPersona('alice');
  await visitLibrarySignIn(alicePage, stack, auth, fixture.libraryTarget, 'alice-password');
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
  await visitLibrarySignIn(bobPage, stack, auth, fixture.libraryTarget, 'bob-password');
  const bobSignIn = await submitPasswordSignIn(
    bobPage,
    { email: bobIdentity.email, password: nativeAuthPassword },
    fixture.libraryTarget,
  );
  expect(bobSignIn.status()).toBe(200);
  const aliceCookie = await exactCookie(aliceContext, stack.web, '__Host-rezics_session');
  const bobCookie = await exactCookie(bobContext, stack.web, '__Host-rezics_session');
  expect(aliceCookie).toBeDefined();
  expect(bobCookie).toBeDefined();
  expect(aliceContext).not.toBe(bobContext);
  expect(aliceCookie?.value !== bobCookie?.value, 'Alice and Bob have distinct Website sessions').toBe(true);
  expect(await auth.context('alice')).toBe(aliceContext);
  expect(await auth.context('bob')).toBe(bobContext);
  const bobReturnUrl = bobPage.url();
  // Keep Bob's signed context while Alice uses the browser for her security changes.
  await bobPage.close();

  await alicePage.locator('#account-menu-button').click();
  await alicePage.locator('[data-account-security-settings]').click();
  await alicePage.waitForURL((url) => url.origin === auth.origin && url.pathname === '/security');
  await alicePage.getByRole('region', { name: 'Sessions', exact: true }).waitFor({ state: 'visible' });
  const loginSession = alicePage.getByRole('listitem').filter({ hasText: 'This device' });
  await loginSession.getByText('REZICS account', { exact: true }).waitFor({ state: 'visible' });
  const sessionResponse = await alicePage.evaluate(async () => {
    const response = await fetch('/sessions', { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  });
  expect(sessionResponse.status).toBe(200);
  expect(sessionResponse.body.sessions).toContainEqual(expect.objectContaining({ client_id: 'login', current: true }));
  expect(new URL(auth.origin).hostname).toBe('auth.native.rezics.com');
  await alicePage.goBack({ waitUntil: 'domcontentloaded' });
  await alicePage.waitForURL((url) => `${url.pathname}${url.search}` === fixture.libraryTarget);

  await alicePage.goto(`${stack.web}${fixture.book.path}`, { waitUntil: 'domcontentloaded' });
  await alicePage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(await alicePage.getByRole('heading', { name: fixture.book.title, exact: true }).count()).toBe(1);
  const library = alicePage.getByRole('region', { name: 'Library', exact: true });
  await library.getByRole('combobox', { name: 'Library state', exact: true }).click();
  await alicePage.getByRole('option', { name: fixture.book.planned.label, exact: true }).click();
  const review = library.getByRole('region', { name: 'Review library state', exact: true });
  await review.getByText('No personal entry', { exact: true }).waitFor({ state: 'visible' });
  await review.getByRole('button', { name: 'Save state', exact: true }).click();
  await library.getByRole('alert').filter({ hasText: 'Library state saved.' }).waitFor();
  const personalRead = await stack.kernel(
    `/v1/libraryEntries/${encodeURIComponent(fixture.book.id)}?view=FULL`,
    {},
    'alice',
  );
  expect(personalRead.status).toBe(200);
  expect(await personalRead.json()).toMatchObject({
    libraryEntry: { subjectId: fixture.book.id, state: fixture.book.planned.id },
  });

  await alicePage.locator('#account-menu-button').click();
  await alicePage.locator('[data-account-security-settings]').click();
  await alicePage.waitForURL((url) => url.origin === auth.origin && url.pathname === '/security');
  await alicePage.getByRole('button', { name: 'Add a passkey', exact: true }).waitFor({ state: 'visible' });
  const beforeStepUp = await alicePage.evaluate(async () => {
    const response = await fetch('/session', { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  });
  expect(beforeStepUp.status).toBe(200);
  expect(beforeStepUp.body.scope).toEqual([]);
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
  const enrollmentPosts: string[] = [];
  alicePage.on('request', (request) => {
    const { origin, pathname } = new URL(request.url());
    if (origin === auth.origin && pathname.startsWith('/passkeys/register') && request.method() === 'POST')
      enrollmentPosts.push(pathname);
  });
  await alicePage.getByRole('button', { name: 'Add a passkey', exact: true }).click();
  await alicePage.waitForURL((url) => url.origin === auth.origin && url.pathname === '/step-up');
  expect(enrollmentPosts).toEqual([]);
  const verifyIdentity = alicePage.getByRole('button', { name: 'Verify your identity', exact: true });
  // The fields render before hydration, and pending Auth advice can clear the password.
  await verifyIdentity.and(alicePage.locator(':enabled')).waitFor({ state: 'visible' });
  await alicePage.getByLabel('Email', { exact: true }).fill(aliceIdentity.email);
  await alicePage.locator('input[name="password"]').fill(nativeAuthPassword);
  const [stepUpResponse] = await Promise.all([
    alicePage.waitForResponse(
      (response) => response.url() === `${auth.origin}/signin` && response.request().method() === 'POST',
    ),
    verifyIdentity.click(),
  ]);
  expect(stepUpResponse.status()).toBe(200);
  await alicePage.waitForURL((url) => url.origin === auth.origin && url.pathname === '/security');
  const afterStepUp = await alicePage.evaluate(async () => {
    const response = await fetch('/session', { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  });
  expect(afterStepUp.status).toBe(200);
  expect(afterStepUp.body.account_id).toBe(fixture.accountIds.alice);
  expect(afterStepUp.body.scope).toEqual(['account:manage']);
  expect(afterStepUp.body.auth_time - beforeStepUp.body.auth_time).toBeGreaterThan(600);

  await alicePage.getByLabel('Passkey name (optional)', { exact: true }).fill('Alice native passkey');
  const registrationOptionsResponse = alicePage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/passkeys/register/options' && response.request().method() === 'POST',
  );
  const registrationResponse = alicePage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/passkeys/register' && response.request().method() === 'POST',
  );
  await alicePage.getByRole('button', { name: 'Add a passkey', exact: true }).click();
  const registrationOptions = await registrationOptionsResponse;
  expect(registrationOptions.status()).toBe(200);
  expect(((await registrationOptions.json()) as { rp?: { id?: string } }).rp?.id).toBe('rezics.com');
  const registered = await registrationResponse;
  expect(registered.status()).toBe(201);
  expect(enrollmentPosts).toEqual(['/passkeys/register/options', '/passkeys/register']);
  const passkeys = alicePage.getByRole('region', { name: 'Passkeys', exact: true });
  const alicePasskey = passkeys.getByRole('listitem').filter({ hasText: 'Alice native passkey' });
  await passkeys
    .getByRole('button', { name: 'Add a passkey', exact: true })
    .and(alicePage.locator(':enabled'))
    .waitFor({ state: 'visible' });
  await alicePage.reload({ waitUntil: 'domcontentloaded' });
  await alicePasskey.waitFor({ state: 'visible' });
  expect(await passkeys.getByRole('listitem').count()).toBe(1);
  expect(await alicePasskey.getByText('Last used', { exact: false }).count()).toBe(0);

  // Step-up replaces the native session. Renew the Website connection through its normal authorization entry.
  await visitLibrarySignIn(alicePage, stack, auth, fixture.libraryTarget, 'renew-website');
  await alicePage.waitForURL(
    (url) => url.origin === webOrigin && `${url.pathname}${url.search}` === fixture.libraryTarget,
    {
      timeout: 30_000,
    },
  );
  await alicePage.locator('#account-menu-button').waitFor({ state: 'visible' });
  // Conditional mediation can use the virtual authenticator's automatic touch without a click.
  const { authenticatorId } = authenticator;
  await webauthn.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
  await signOutWebsiteAndAuth(alicePage);
  await checkLibraryAfterSignOut(alicePage);
  await alicePage.goto(`${stack.web}${fixture.book.path}`, { waitUntil: 'domcontentloaded' });
  await alicePage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(await alicePage.getByRole('heading', { name: fixture.book.title, exact: true }).count()).toBe(1);
  expect(await alicePage.getByRole('combobox', { name: 'Library state', exact: true }).count()).toBe(0);
  expect(await exactCookie(aliceContext, webOrigin, '__Host-rezics_session')).toBeUndefined();
  const anonymousCatalogue = await stack.kernel(`/v1/subjects/${encodeURIComponent(fixture.book.id)}`);
  expect(anonymousCatalogue.status).toBe(200);
  expect(await anonymousCatalogue.text()).toContain(fixture.book.title);

  const passkeySignInOptions = observePasskeySignInOptions(alicePage, auth.origin);
  // The click cancels conditional mediation. Keep the shared options request pending until presence
  // is restored so the explicit ceremony starts with the authenticator ready.
  const releasePasskeyOptions = Promise.withResolvers<void>();
  await alicePage.route(
    `${auth.origin}/signin/passkey/options`,
    async (route) => {
      await releasePasskeyOptions.promise;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await visitLibrarySignIn(alicePage, stack, auth, fixture.libraryTarget, 'passkey');
    expect(await exactCookie(aliceContext, webOrigin, '__Host-rezics_session')).toBeUndefined();
    const [passkeySignInResponse] = await Promise.all([
      alicePage.waitForResponse(
        (response) => response.url() === `${auth.origin}/signin/passkey` && response.request().method() === 'POST',
      ),
      (async () => {
        await alicePage.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
        await webauthn.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
        releasePasskeyOptions.resolve();
      })(),
    ]);
    expect(passkeySignInResponse.status()).toBe(200);
  } finally {
    releasePasskeyOptions.resolve();
  }
  const signInOptions = passkeySignInOptions.at(-1);
  expect(signInOptions?.status()).toBe(200);
  expect(await signInOptions?.json()).toMatchObject({ rpId: 'rezics.com' });
  await alicePage.waitForURL((url) => `${url.pathname}${url.search}` === fixture.libraryTarget, { timeout: 30_000 });
  await alicePage.locator('#account-menu-button').waitFor({ state: 'visible' });
  expect(await exactCookie(aliceContext, stack.web, '__Host-rezics_session')).toBeDefined();
  await alicePage.locator('#account-menu-button').click();
  await alicePage.locator('[data-account-security-settings]').click();
  await alicePage.waitForURL((url) => url.origin === auth.origin && url.pathname === '/security');
  await alicePasskey.getByText('Last used', { exact: false }).waitFor({ state: 'visible' });
  const usedSession = await alicePage.evaluate(async () => {
    const response = await fetch('/session', { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  });
  expect(usedSession.status).toBe(200);
  expect(usedSession.body.account_id).toBe(fixture.accountIds.alice);
  expect(usedSession.body.amr).toContain('pop');
  await webauthn.detach();

  const wrongRpContext = await auth.context('wrong-rp');
  const wrongRpPage = await wrongRpContext.newPage();
  wrongRpPage.setDefaultTimeout(15_000);
  const wrongRpSignInOptions = observePasskeySignInOptions(wrongRpPage, auth.origin);
  await visitLibrarySignIn(wrongRpPage, stack, auth, fixture.libraryTarget, 'wrong-rp-passkey');
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
  const wrongRpAssertionRequests: string[] = [];
  wrongRpPage.on('request', (request) => {
    if (new URL(request.url()).pathname === '/signin/passkey' && request.method() === 'POST')
      wrongRpAssertionRequests.push(request.url());
  });
  await wrongRpPage.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
  await wrongRpPage.locator('form[action="/signin"]').getByRole('alert').waitFor({ state: 'visible', timeout: 30_000 });
  const wrongRpOptions = wrongRpSignInOptions.at(-1);
  expect(wrongRpOptions?.status()).toBe(200);
  expect(await wrongRpOptions?.json()).toMatchObject({ rpId: 'rezics.com' });
  expect(wrongRpAssertionRequests).toEqual([]);
  expect(await exactCookie(wrongRpContext, stack.web, '__Host-rezics_session')).toBeUndefined();
  expect((await wrongRpPage.goto(`${auth.origin}/session`, { waitUntil: 'domcontentloaded' }))?.status()).toBe(401);
  await wrongRpWebAuthn.send('WebAuthn.removeVirtualAuthenticator', {
    authenticatorId: wrongRpAuthenticator.authenticatorId,
  });
  await wrongRpWebAuthn.detach();
  await wrongRpContext.close();

  await alicePage.goto(`${stack.web}${fixture.libraryTarget}`, { waitUntil: 'domcontentloaded' });
  await signOutWebsiteAndAuth(alicePage);
  await alicePage.goto(stack.web, { waitUntil: 'domcontentloaded' });
  await auth.settlePageApp({ requestRetirement: true });
  await alicePage.reload({ waitUntil: 'domcontentloaded' });
  await alicePage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(await alicePage.locator('#account-menu-button').count()).toBe(0);
  await aliceContext.close();

  const bobReloadPage = await bobContext.newPage();
  bobReloadPage.setDefaultTimeout(15_000);
  await bobReloadPage.goto(bobReturnUrl, { waitUntil: 'domcontentloaded' });
  await bobReloadPage.reload({ waitUntil: 'domcontentloaded' });
  await bobReloadPage.locator('#account-menu-button').waitFor({ state: 'visible' });
  const retainedBobCookie = await exactCookie(bobContext, stack.web, '__Host-rezics_session');
  expect(retainedBobCookie?.value === bobCookie?.value, 'Bob keeps his original Website session').toBe(true);
  await bobContext.close();
}

async function checkLibraryAfterSignOut(page: Page): Promise<void> {
  const libraryUrl = `${stack.web}${fixture.libraryTarget}`;
  const signInLocation = `/auth/sign-in?return_to=${encodeURIComponent(fixture.libraryTarget)}`;
  const [restricted, login] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === libraryUrl &&
        response.request().isNavigationRequest() &&
        response.request().frame() === page.mainFrame(),
    ),
    page.goto(libraryUrl, { waitUntil: 'domcontentloaded' }),
  ]);
  expect(restricted.status()).toBe(302);
  expect(await restricted.headerValue('location')).toBe(signInLocation);
  expect(await restricted.headerValue('cache-control')).toBe('private, no-store');
  expect((await restricted.request().headerValue('cookie')) ?? '').not.toMatch(/(?:^|;\s*)__Host-rezics_session=/);

  expect(login?.status()).toBe(200);
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  const loginUrl = new URL(page.url());
  expect(loginUrl.origin).toBe(auth.origin);
  expect(loginUrl.pathname).toBe('/login');
  await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).waitFor({ state: 'visible' });
  expect(await page.locator('#account-menu-button').count()).toBe(0);
  expect(await exactShelfRow(page, { id: fixture.book.id, label: fixture.book.title }).count()).toBe(0);
  expect(await exactCookie(page.context(), stack.web, '__Host-rezics_session')).toBeUndefined();

  const anonymous = await stack.request(libraryUrl, 'anonymous');
  expect(anonymous.status).toBe(302);
  expect(anonymous.headers.get('location')).toBe(signInLocation);
  expect(anonymous.headers.get('cache-control')).toBe('private, no-store');
  expect(await anonymous.text()).not.toContain(fixture.book.title);
}

async function signOutWebsiteAndAuth(page: Page): Promise<void> {
  const webOrigin = new URL(stack.web).origin;
  const returnedToWebsite = (url: URL) => url.origin === webOrigin && /^\/(?:en\/?)?$/.test(url.pathname);
  await page.locator('#account-menu-button').click();
  const signOut = page.waitForResponse(
    (response) => response.url() === `${webOrigin}/auth/sign-out` && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const response = await signOut;
  expect(response.status()).toBe(303);
  const issuerLogout = new URL(response.headers().location ?? '/', webOrigin);
  expect(issuerLogout.origin).toBe(auth.origin);
  expect(issuerLogout.pathname).toBe('/logout');
  await page.waitForURL((url) => returnedToWebsite(url) || (url.origin === auth.origin && url.pathname === '/logout'), {
    waitUntil: 'domcontentloaded',
  });
  if (new URL(page.url()).origin === auth.origin) {
    const route = (url: URL) => {
      if (url.origin === webOrigin) return returnedToWebsite(url) ? 'website-home' : 'website-other';
      if (url.origin !== auth.origin) return 'outside';
      return ['/logout', '/logout/confirm'].includes(url.pathname) ? url.pathname : 'issuer-other';
    };
    const documents: { route: string; status: number }[] = [];
    const recordDocument = (response: PlaywrightResponse) => {
      const request = response.request();
      if (documents.length < 8 && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        documents.push({ route: route(new URL(response.url())), status: response.status() });
      }
    };
    page.on('response', recordDocument);
    try {
      await Promise.all([
        page.waitForURL(returnedToWebsite, { waitUntil: 'commit' }),
        page.getByRole('button', { name: 'Confirm logout', exact: true }).click(),
      ]);
    } catch (error) {
      const outcome = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'failed';
      const evidence = { currentRoute: route(new URL(page.url())), documents };
      throw new Error(`Native Auth logout confirmation ${outcome}. ${JSON.stringify(evidence)}`);
    } finally {
      page.off('response', recordDocument);
    }
  }
  await page.waitForURL(returnedToWebsite, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(await page.locator('#account-menu-button').count()).toBe(0);
  const context = page.context();
  expect(await exactCookie(context, webOrigin, '__Host-rezics_session')).toBeUndefined();
  const issuerPage = await context.newPage();
  try {
    const sessionUrl = `${auth.origin}/session`;
    const session = await issuerPage.goto(sessionUrl, { waitUntil: 'domcontentloaded' });
    expect(session?.url()).toBe(sessionUrl);
    expect(session?.status()).toBe(401);
  } finally {
    await issuerPage.close();
  }
}
