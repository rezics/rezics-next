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
  await expect(page.getByRole('heading', { name: 'Create your REZICS Account' })).toBeVisible();
  await page.locator('html[data-hydrated]').waitFor();
  await expect(page.getByText('starting with REZICS', { exact: false })).toBeVisible();
  await page.getByRole('textbox', { name: 'Name' }).fill(`First Party ${id}`);
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm').fill(password);
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
  expect(new URL(page.url()).searchParams.get('next')).toBe(returnTo);
  await expect(page.getByRole('button', { name: 'Continue to home' })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue to home' }).click();
  await expect.poll(() => new URL(page.url()).pathname.replace(/\/$/, '')).toBe(returnTo.replace(/\/$/, ''));
  await expect(page.getByRole('link', { name: 'Join REZICS' })).toHaveCount(0);

  await page.goto(`${accounts}/connected-apps`);
  await expect(page.getByRole('heading', { name: 'Connected apps' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'REZICS' })).toBeVisible();
  await expect(page.getByText('Manage access, rights and moderation when you are authorized')).toBeVisible();
  await page.goto(`${accounts}/security`);
  await expect(page.getByRole('heading', { name: 'Security & sign-in' })).toBeVisible();
  await expect(page.getByText(/REZICS on Chrome · (Windows|Linux|macOS)/)).toBeVisible();
});
