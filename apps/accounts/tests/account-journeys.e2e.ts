import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

// Dev-mode pages hydrate after load; forms are typed into only once React owns them.
const hydrated = (page: Page) => page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });

async function open(page: Page, path: string) {
  await page.goto(path);
  await hydrated(page);
}

function newPerson() {
  const id = randomBytes(6).toString('hex');
  return { name: `Ada ${id}`, email: `accounts-${id}@example.test`, password: `pass phrase ${id}` };
}
type Person = ReturnType<typeof newPerson>;

// The stack's Mailpit (`task urls`); Account delivers its queue every second.
const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

test('G288 Accounts Japanese locale query keeps English fallback strings', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/?hl=ja');
  await hydrated(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

/** The newest link in the newest email to `to` whose subject matches. */
async function emailLink(to: string, subject: RegExp): Promise<string> {
  let link: string | undefined;
  await expect.poll(async () => {
    const search = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages } = await search.json() as { messages: { ID: string; Subject: string }[] };
    const message = messages.find(item => subject.test(item.Subject));
    if (!message) return undefined;
    const { Text } = await (await fetch(`${mailpit}/api/v1/message/${message.ID}`)).json() as { Text: string };
    link = /https?:\/\/\S+/.exec(Text)?.[0];
    return link;
  }, { timeout: 30_000, message: `an email to ${to} matching ${subject}` }).toBeTruthy();
  return link!;
}

async function fillSignUp(page: Page, person: Person) {
  await page.getByRole('textbox', { name: 'Name' }).fill(person.name);
  await page.getByRole('textbox', { name: 'Email' }).fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(person.password);
  await page.getByLabel('Confirm').fill(person.password);
  await page.getByRole('button', { name: 'Next' }).click();
}

async function signIn(page: Page, person: Person, path = '/sign-in') {
  await open(page, path);
  await page.getByRole('textbox', { name: 'Email' }).fill(person.email);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Enter your password').fill(person.password);
  await page.getByRole('button', { name: 'Next' }).click();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Your REZICS Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

/** Sign up and verify, then reset the browser for journeys that begin signed out. */
async function newAccount(page: Page, person = newPerson()) {
  await open(page, '/sign-up');
  await fillSignUp(page, person);
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await emailLink(person.email, /^Verify your email address$/));
  await expect(page.getByRole('heading', { name: 'Your email is verified' })).toBeVisible();
  await page.context().clearCookies();
  return person;
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from the base32 key the setup dialog shows. */
function totp(key: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of key.replace(/\s|=/g, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const secret = Buffer.from(bits.match(/.{8}/g)!.map(byte => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest.at(-1)! & 0xf;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test('sign up with email verification, the account centre and sign out', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const person = newPerson();

  await open(page, '/sign-up');
  await fillSignUp(page, person);
  // No session until the email is verified: the same answer as for an existing email.
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await signIn(page, person);
  await expect(page.getByText('Verify your email before signing in.', { exact: false })).toBeVisible();
  await page.goto(await emailLink(person.email, /^Verify your email address$/));
  await expect(page.getByRole('heading', { name: 'Your email is verified' })).toBeVisible();

  await open(page, '/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Welcome, ${person.name}`);
  await hydrated(page);
  // A password alone is the one thing to improve; the checkup says so.
  await expect(page.getByRole('heading', { name: 'One way to make your account safer' })).toBeVisible();

  const sections = page.getByRole('navigation', { name: 'Account sections' }).first();
  await sections.getByRole('link', { name: 'Security & sign-in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Security & sign-in' })).toBeVisible();
  await expect(page.getByText('This device')).toBeVisible();
  await expect(page.getByText('You’re not signed in anywhere else.')).toBeVisible();
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible();

  await open(page, '/personal-info');
  await page.getByRole('button', { name: 'Edit · Name' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill(`${person.name} Byron`);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`${person.name} Byron`)).toBeVisible();
  // The language is stored on the account and follows it to a new browser.
  await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-Hans');
  await expect(page.getByRole('heading', { level: 1, name: '个人信息' })).toBeVisible();
  await page.context().clearCookies({ name: 'rezics_locale' });
  await open(page, '/personal-info');
  await expect(page.getByRole('heading', { level: 1, name: '个人信息' })).toBeVisible();
  await page.getByRole('combobox', { name: '语言' }).selectOption('en');
  await expect(page.getByRole('heading', { level: 1, name: 'Personal info' })).toBeVisible();

  await open(page, '/connected-apps');
  await expect(page.getByRole('heading', { name: 'No apps have access' })).toBeVisible();

  await signOut(page);
  await open(page, '/security');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();

  await open(page, '/sign-in?next=%2Fsecurity');
  await page.getByRole('textbox', { name: 'Email' }).fill(person.email);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Enter your password').fill('not the password');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Wrong email or password. Try again or reset your password.')).toBeVisible();
  await page.getByLabel('Enter your password').fill(person.password);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page).toHaveURL(/\/security$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Security & sign-in' })).toBeVisible();
  await hydrated(page);
  await expect(page.getByText('Failed sign-in attempt')).toBeVisible();

  await signOut(page);
  expect(errors).toEqual([]);
});

test('password reset and email change through the email links', async ({ page }) => {
  const person = await newAccount(page);

  await open(page, `/forgot-password?email=${encodeURIComponent(person.email)}`);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await emailLink(person.email, /^Reset your password$/));
  await expect(page).toHaveURL(/\/reset-password\?token=/);
  await hydrated(page);
  const reset = `${person.password} renewed`;
  await page.getByLabel('Password', { exact: true }).fill(reset);
  await page.getByLabel('Confirm').fill(reset);
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('heading', { name: 'Your password was changed' })).toBeVisible();
  await signIn(page, { ...person, password: reset });
  await expect(page).toHaveURL(/\/$/);

  await open(page, '/personal-info');
  const next = `renamed-${randomBytes(4).toString('hex')}@example.test`;
  await page.getByRole('button', { name: 'Change email' }).click();
  await page.getByRole('textbox', { name: 'New email' }).fill(next);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`To confirm, open the link we sent to ${person.email}.`, { exact: false })).toBeVisible();
  await page.goto(await emailLink(person.email, /^Confirm your email change$/));
  await expect(page.getByRole('heading', { name: 'Now check your new inbox' })).toBeVisible();
  await page.goto(await emailLink(next, /^Verify your email address$/));
  await expect(page.getByRole('heading', { name: 'Your email address was changed' })).toBeVisible();
  await open(page, '/personal-info');
  await expect(page.getByText(next)).toBeVisible();
  await open(page, '/security/activity');
  await expect(page.getByText('Email address changed')).toBeVisible();
  await expect(page.getByText('Password changed')).toBeVisible();
});

test('passkeys: create with a virtual authenticator, sign in with it, rename and last-method protection', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const person = await newAccount(page);
  await signIn(page, person);
  await expect(page).toHaveURL(/\/$/);

  await open(page, '/security/passkeys');
  await expect(page.getByRole('heading', { name: 'No passkeys yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(page.getByText('Passkey created. You can use it the next time you sign in.')).toBeVisible();
  await expect(page.getByText(/Created .* · Not used yet/)).toBeVisible();
  // Named after the device that created it, since the virtual authenticator has no known provider.
  await expect(page.getByRole('button', { name: /^Rename · Chrome/ })).toBeVisible();
  await page.getByRole('button', { name: /^Rename · / }).click();
  await page.getByRole('dialog', { name: 'Rename passkey' }).getByRole('textbox', { name: 'Name' }).fill('Test laptop');
  await page.getByRole('dialog', { name: 'Rename passkey' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Test laptop')).toBeVisible();

  await signOut(page);
  // A virtual authenticator answers autofill requests without a tap, which no
  // browser does; turn autofill off so the button's request is the only one.
  await page.addInitScript(() => { PublicKeyCredential.isConditionalMediationAvailable = async () => false; });
  await open(page, '/sign-in?next=%2Fsecurity%2Fpasskeys');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(/\/security\/passkeys$/);
  await hydrated(page);
  await expect(page.getByText(/Last used/)).toBeVisible();

  // With a passkey, the password may go; then the passkey is the last way in.
  await open(page, '/security');
  await page.getByRole('button', { name: 'Remove password' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove password' }).click();
  await expect(page.getByText('Not set: you sign in with passkeys')).toBeVisible();
  await open(page, '/security/passkeys');
  await expect(page.getByRole('button', { name: 'Remove · Test laptop' })).toBeDisabled();
  await open(page, '/security/activity');
  await expect(page.getByText('Signed in with a passkey')).toBeVisible();
  await expect(page.getByText('Passkey created')).toBeVisible();
  await expect(page.getByText('Password removed')).toBeVisible();
});

test('2-Step Verification: set up an authenticator app, then sign in with a code and a backup code', async ({ page }) => {
  const person = await newAccount(page);
  await signIn(page, person);
  await expect(page).toHaveURL(/\/$/);
  await open(page, '/security/two-step-verification');
  await page.getByRole('button', { name: 'Turn on' }).click();
  const setup = page.getByRole('dialog');
  await setup.getByLabel('Current password').fill(person.password);
  await setup.getByRole('button', { name: 'Next' }).click();
  await expect(setup.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const key = (await setup.locator('p.font-mono').textContent())!;
  await setup.getByRole('textbox', { name: 'Code from your authenticator app' }).fill(totp(key));
  await setup.getByRole('button', { name: 'Verify' }).click();
  await expect(setup.getByRole('heading', { name: '2-Step Verification is on' })).toBeVisible();
  const backupCodes = await setup.getByRole('list', { name: 'Backup codes' }).getByRole('listitem').allTextContents();
  expect(backupCodes).toHaveLength(10);
  await setup.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { level: 2, name: '2-Step Verification is on' })).toBeVisible();

  await signOut(page);
  await signIn(page, person, '/sign-in?next=%2Fsecurity');
  await expect(page.getByRole('heading', { level: 1, name: '2-Step Verification' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Enter code' }).fill('000000');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Wrong code. Try again.')).toBeVisible();
  // A fresh window's code, so the one used at setup is never replayed.
  await page.getByRole('textbox', { name: 'Enter code' }).fill(totp(key, Date.now() + 30_000));
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page).toHaveURL(/\/security$/);

  await hydrated(page);
  await signOut(page);
  await signIn(page, person);
  await page.getByRole('button', { name: 'Use a backup code' }).click();
  await page.getByRole('textbox', { name: 'Backup code' }).fill(backupCodes[0]!);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page).toHaveURL(/\/$/);
  await open(page, '/security/activity');
  await expect(page.getByText('Signed in with a backup code')).toBeVisible();
  await expect(page.getByText('Signed in with an authenticator code')).toBeVisible();
  await expect(page.getByText('2-Step Verification turned on')).toBeVisible();
});

interface Operator { email: string; password: string }

function operator(): Operator | undefined {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  return path ? (JSON.parse(readFileSync(path, 'utf8')) as { operator: Operator }).operator : undefined;
}

test('an app’s OAuth request continues through sign-up, verification and consent', async ({ page, browser, baseURL }) => {
  const admin = operator();
  test.skip(!admin, 'REZICS_WEB_AUTH_PRIVATE_PATH must name the stack’s web-auth private.json');
  const origin = new URL(baseURL!).origin;

  // An operator registers a public client that requires consent.
  const operatorContext = await browser.newContext({ baseURL });
  const signedIn = await operatorContext.request.post('/api/auth/sign-in/email', {
    headers: { origin }, data: { email: admin!.email, password: admin!.password } });
  expect(signedIn.ok()).toBe(true);
  const callback = 'http://127.0.0.1:9/callback';
  const appName = `Consent journey ${randomBytes(3).toString('hex')}`;
  const created = await operatorContext.request.post('/api/auth/oauth2/create-client', {
    headers: { origin, 'x-account-reason': 'Accounts e2e consent journey' }, data: { client_name: appName,
      redirect_uris: [callback], application_type: 'native', token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope: 'openid profile email work:read' } });
  expect(created.ok()).toBe(true);
  const client = await created.json() as { client_id: string };
  await operatorContext.close();

  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL('/api/auth/oauth2/authorize', origin);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: client.client_id,
    redirect_uri: callback, scope: 'openid profile email work:read', state: 'journey-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
  const arrivals: URL[] = [];
  await page.route(`${callback}**`, async route => {
    arrivals.push(new URL(route.request().url()));
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'callback' });
  });

  await page.goto(authorize.toString());
  await expect(page).toHaveURL(/\/sign-in\?/);
  await hydrated(page);
  // The signed request names the App before anyone signs in.
  await expect(page.getByText(`to continue to ${appName}`)).toBeVisible();
  await page.getByRole('link', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/sign-up\?.*sig=/);
  await hydrated(page);
  const person = newPerson();
  await fillSignUp(page, person);
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await emailLink(person.email, /^Verify your email address$/));
  await expect(page.getByRole('heading', { name: 'Your email is verified' })).toBeVisible();
  // Email links use the issuer's origin; the person continues, and stays signed in, there.
  const accountOrigin = new URL(page.url()).origin;
  await page.getByRole('link', { name: 'Sign in to continue' }).click();
  await hydrated(page);
  await expect(page.getByText(`to continue to ${appName}`)).toBeVisible();
  await page.getByRole('textbox', { name: 'Email' }).fill(person.email);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Enter your password').fill(person.password);
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page).toHaveURL(/\/consent\?/);
  await hydrated(page);
  await expect(page.getByRole('heading', { level: 1 }))
    .toHaveText(`${appName} wants to access your REZICS Account`);
  await expect(page.getByText(person.email)).toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();
  await page.waitForURL(`${callback}?**`);
  expect(arrivals).toHaveLength(1);
  expect(arrivals[0]!.searchParams.get('state')).toBe('journey-state');
  expect(arrivals[0]!.searchParams.get('code')).toBeTruthy();
  const { issuer } = await (await fetch(`${origin}/api/auth/.well-known/openid-configuration`)).json() as
    { issuer: string };
  expect(arrivals[0]!.searchParams.get('iss')).toBe(issuer);

  // The grant is listed in the account centre with what it may do, and can be removed.
  await open(page, `${accountOrigin}/connected-apps`);
  await expect(page.getByRole('heading', { name: appName })).toBeVisible();
  await expect(page.getByText('Read your email address and verification status')).toBeVisible();
  await page.getByRole('button', { name: 'Remove access' }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { name: 'No apps have access' })).toBeVisible();

  // Without consent the app must ask again, and Cancel returns an error to it.
  await page.goto(`${accountOrigin}${authorize.pathname}${authorize.search}`);
  await expect(page).toHaveURL(/\/consent\?/);
  await hydrated(page);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForURL(url => url.href.startsWith(callback) && url.searchParams.has('error'));
  expect(arrivals).toHaveLength(2);
  expect(arrivals[1]!.searchParams.get('error')).toBe('access_denied');
});
