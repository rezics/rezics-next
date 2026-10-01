import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';

const web = process.env.WEB_URL ?? 'http://127.0.0.1:3000';
const accounts = process.env.ACCOUNTS_URL ?? 'http://127.0.0.1:3004';
const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

test('joining from home verifies email, resumes REZICS authorization and keeps the home destination', async ({ page }) => {
  const id = randomBytes(6).toString('hex');
  const email = `first-party-${id}@example.test`;
  const password = `pass phrase ${id}`;
  await page.goto(`${web}/en/`);
  const join = page.getByRole('link', { name: 'Join REZICS' });
  await expect(join).toBeVisible();
  const returnTo = new URL((await join.getAttribute('href'))!, web).searchParams.get('next')!;
  await join.click();
  await page.waitForURL(url => /^\/sign-(in|up)$/.test(url.pathname));
  // The shared web app links to the canonical Accounts origin. A worktree
  // checks its own frontend while retaining the signed OAuth request unchanged.
  const destination = new URL(page.url());
  if (destination.origin !== new URL(accounts).origin) {
    await page.goto(new URL(destination.pathname + destination.search, accounts).toString());
  }
  await expect(page.getByRole('heading', { name: 'Create your REZICS Account' })).toBeVisible();
  await page.locator('html[data-hydrated]').waitFor();
  await expect(page.getByText('One account for REZICS and everything that comes next')).toBeVisible();
  await expect(page.getByText('I meet the minimum age in the Terms and have read and accept:'))
    .toBeVisible({ timeout: 20_000 });
  await page.getByRole('textbox', { name: 'Display name' }).fill(`First Party ${id}`);
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm').fill(password);
  await page.getByText('I meet the minimum age in the Terms and have read and accept:').click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  let link: string | undefined;
  await expect.poll(async () => {
    const search = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages } = await search.json() as { messages: { ID: string; Subject: string }[] };
    const message = messages.find(item => /^Verify your email address$/.test(item.Subject));
    if (!message) return undefined;
    const { Text } = await (await fetch(`${mailpit}/api/v1/message/${message.ID}`)).json() as { Text: string };
    link = /https?:\/\/\S+/.exec(Text)?.[0];
    return link;
  }, { timeout: 30_000 }).toBeTruthy();
  await page.goto(link!);
  await expect.poll(() => new URL(page.url()).pathname).toBe('/en/onboarding');
  const welcome = new URL(new URL(page.url()).searchParams.get('next')!, web);
  expect(welcome.pathname).toBe('/en/welcome');
  expect(welcome.searchParams.get('next')).toBe(returnTo);
  // Account's display name does not automatically publish a Main Person.
  await expect(page.getByRole('textbox', { name: 'Public name' })).toHaveAttribute('data-hydrated', 'true');
  await expect(page.getByRole('textbox', { name: 'Public name' })).toHaveValue('');
  await page.getByRole('textbox', { name: 'Public name' }).fill(`Public Reader ${id}`);
  await page.getByRole('textbox', { name: 'Your handle' }).fill(`reader_${id}`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/en/welcome');
  await expect(page.getByRole('heading', { name: 'Which languages do you read?' })).toBeVisible();
  // Welcome has no hydration marker; an early click is inert until React owns it.
  await expect(async () => {
    if (new URL(page.url()).pathname === '/en/welcome')
      await page.getByRole('button', { name: 'Skip setup', exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname.replace(/\/$/, ''), { timeout: 2_000 })
      .toBe(returnTo.replace(/\/$/, ''));
  }).toPass({ timeout: 30_000 });
  await expect.poll(() => new URL(page.url()).pathname.replace(/\/$/, '')).toBe(returnTo.replace(/\/$/, ''));
  await expect(page.getByRole('link', { name: 'Join REZICS' })).toHaveCount(0);

  await page.goto(`${accounts}/connected-apps`);
  await expect(page.getByRole('heading', { name: 'Connected apps' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No apps have access' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'REZICS', exact: true })).toHaveCount(0);
  await page.goto(`${accounts}/security/devices`);
  await expect(page.getByRole('heading', { name: 'Devices and sessions', exact: true })).toBeVisible();
  await expect(page.getByText(/REZICS · Chrome on (Windows|Linux|macOS)/)).toBeVisible();

  await page.goto(`${accounts}/personal-info`);
  await page.locator('html[data-hydrated]').waitFor();
  await expect(page.getByRole('heading', { name: 'Birthday & content' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'General', exact: true })).toBeChecked();
  await expect(page.getByRole('switch', { name: 'R15', exact: true })).not.toBeChecked();
  // Ark's accessible input is visually hidden inside the clickable switch label.
  await page.getByRole('switch', { name: 'R15', exact: true }).locator('..').click();
  await expect(page.getByLabel('Birthday', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'R15', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Edit · Birthday' }).click();
  await page.getByLabel('Birthday', { exact: true }).fill('1990-01-01');
  await page.getByLabel('Country or region').selectOption('US');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'R15', exact: true })).toBeChecked();
  await expect(page.getByRole('switch', { name: 'R18', exact: true })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'R18G', exact: true })).not.toBeChecked();
  await page.getByRole('switch', { name: 'R15', exact: true }).locator('..').click();
  await expect(page.getByRole('button', { name: 'Edit · Birthday' })).toBeEnabled();
  await page.getByRole('button', { name: 'Edit · Birthday' }).click();
  await page.getByLabel('Birthday', { exact: true }).fill('1991-01-01');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('1991-01-01', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'R15', exact: true })).not.toBeChecked();
  await page.getByRole('switch', { name: 'Make birthday public' }).locator('..').click();
  const sharedLink = page.getByRole('link', { name: 'View public birthday' });
  await expect(sharedLink).toBeVisible();
  const birthdayUrl = new URL((await sharedLink.getAttribute('href'))!, accounts).toString();
  const publicPage = await page.context().newPage();
  await publicPage.goto(birthdayUrl);
  await expect(publicPage.locator('time')).toHaveText('1991-01-01');
  await expect(publicPage.getByText(email)).toHaveCount(0);
  await page.getByRole('switch', { name: 'Make birthday public' }).locator('..').click();
  await expect(sharedLink).toHaveCount(0);
  await publicPage.reload();
  await expect(publicPage.getByText('This birthday is unavailable or private.')).toBeVisible();
  await publicPage.close();
});
