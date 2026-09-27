import { createHash, randomBytes } from 'node:crypto';
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

async function signUp(page: Page, person: ReturnType<typeof newPerson>) {
  await page.getByRole('textbox', { name: 'Name' }).fill(person.name);
  await page.getByRole('textbox', { name: 'Email' }).fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(person.password);
  await page.getByLabel('Confirm').fill(person.password);
  await page.getByRole('button', { name: 'Next' }).click();
}

test('sign up, sign in, the account centre and sign out', async ({ page }) => {
  const person = newPerson();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  await open(page, '/sign-up');
  await signUp(page, person);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Welcome, ${person.name}`);
  await hydrated(page);
  await expect(page.getByText('Email not verified')).toBeVisible();

  const sections = page.getByRole('navigation', { name: 'Account sections' }).first();
  await sections.getByRole('link', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  await expect(page.getByText('This device')).toBeVisible();
  await expect(page.getByText('You’re not signed in anywhere else.')).toBeVisible();

  await open(page, '/personal-info');
  await page.getByRole('button', { name: 'Edit · Name' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill(`${person.name} Byron`);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`${person.name} Byron`)).toBeVisible();

  await open(page, '/connected-apps');
  await expect(page.getByRole('heading', { name: 'No apps have access' })).toBeVisible();

  await page.getByRole('button', { name: 'Your REZICS Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
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
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  await hydrated(page);

  await page.getByRole('button', { name: 'Your REZICS Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(errors).toEqual([]);
});

interface Operator { email: string; password: string }

function operator(): Operator | undefined {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  return path ? (JSON.parse(readFileSync(path, 'utf8')) as { operator: Operator }).operator : undefined;
}

test('an app’s OAuth request continues through sign-up and consent', async ({ page, browser, baseURL }) => {
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
    headers: { origin }, data: { client_name: appName, redirect_uris: [callback],
      application_type: 'native', token_endpoint_auth_method: 'none',
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
  await expect(page.getByText('An app is asking you to sign in with your REZICS Account')).toBeVisible();
  await page.getByRole('link', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/sign-up\?.*sig=/);
  await hydrated(page);
  const person = newPerson();
  await signUp(page, person);

  await expect(page).toHaveURL(/\/consent\?/);
  await hydrated(page);
  await expect(page.getByRole('heading', { level: 1 }))
    .toHaveText(`${appName} wants to access your REZICS Account`);
  await expect(page.getByText(person.email)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Know who you are' })).toBeVisible();
  await expect(page.getByText('See works, including ones you can see privately')).toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();
  await page.waitForURL(`${callback}?**`);
  expect(arrivals).toHaveLength(1);
  expect(arrivals[0]!.searchParams.get('state')).toBe('journey-state');
  expect(arrivals[0]!.searchParams.get('code')).toBeTruthy();
  expect(arrivals[0]!.searchParams.get('iss')).toBe(`${origin}/api/auth`);

  // The grant is listed in the account centre and can be removed.
  await open(page, '/connected-apps');
  await expect(page.getByRole('heading', { name: appName })).toBeVisible();
  await page.getByRole('button', { name: 'Remove access' }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { name: 'No apps have access' })).toBeVisible();

  // Without consent the app must ask again, and Cancel returns an error to it.
  await page.goto(authorize.toString());
  await expect(page).toHaveURL(/\/consent\?/);
  await hydrated(page);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForURL(url => url.href.startsWith(callback) && url.searchParams.has('error'));
  expect(arrivals).toHaveLength(2);
  expect(arrivals[1]!.searchParams.get('error')).toBe('access_denied');
});
