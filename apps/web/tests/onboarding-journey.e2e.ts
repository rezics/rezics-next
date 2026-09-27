import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';

const accountsOrigin = process.env.ACCOUNT_ORIGIN ?? 'http://127.0.0.1:3004';
const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

async function verificationLink(email: string): Promise<string> {
  let link = '';
  await expect.poll(async () => {
    const response = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages } = await response.json() as { messages: { ID: string; Subject: string }[] };
    const newest = messages.find(item => /^Verify your email address$/.test(item.Subject));
    if (!newest) return false;
    const { Text } = await (await fetch(`${mailpit}/api/v1/message/${newest.ID}`)).json() as { Text: string };
    link = /https?:\/\/\S+/.exec(Text)?.[0] ?? '';
    return Boolean(link);
  }, { timeout: 30_000 }).toBe(true);
  return link;
}

test('new person chooses a handle, returns home and keeps the acting profile after sign-in', async ({ page }) => {
  const suffix = randomBytes(6).toString('hex');
  const person = { name: `Reader ${suffix}`, email: `onboarding-${suffix}@example.test`,
    password: `pass phrase ${suffix}`, handle: `reader_${suffix}` };
  await page.goto('/auth/start?create=1&next=%2Fen');
  await expect(page).toHaveURL(url => url.origin === new URL(accountsOrigin).origin && url.pathname === '/sign-up');
  await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
  await page.getByRole('textbox', { name: 'Name' }).fill(person.name);
  await page.getByRole('textbox', { name: 'Email' }).fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(person.password);
  await page.getByLabel('Confirm').fill(person.password);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await verificationLink(person.email));
  await page.getByRole('link', { name: 'Sign in to continue' }).click();
  await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
  await page.getByRole('textbox', { name: 'Email' }).fill(person.email);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Enter your password').fill(person.password);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page).toHaveURL(/\/en\/onboarding\?next=/);
  await expect(page.getByText(person.name)).toBeVisible();
  await page.getByRole('textbox', { name: 'Your handle' }).fill(person.handle);
  await expect(page.getByRole('status')).toHaveText('This handle is available.');
  await page.getByRole('button', { name: 'Continue to home' }).click();
  await expect(page).toHaveURL('/en');
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account menu' }))
    .toContainText(`@${person.handle}`);
  await page.reload();
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account menu' }))
    .toContainText(`@${person.handle}`);
  await page.getByRole('banner').getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Profile settings' }).click();
  await expect(page).toHaveURL('/en/settings');
  await expect(page.getByRole('main').getByText(`@${person.handle}`)).toBeVisible();
  await page.getByRole('textbox', { name: 'Your handle' }).fill(`another_${suffix}`);
  await expect(page.getByRole('status')).toHaveText('This handle is available.');
  await page.getByRole('button', { name: 'Change handle' }).click();
  await expect(page.getByText(/30 days after your last change/)).toBeVisible();
  await page.getByRole('banner').getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/en');
  await page.goto('/auth/start?next=%2Fen');
  if (new URL(page.url()).origin === new URL(accountsOrigin).origin) {
    await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
    await page.getByRole('textbox', { name: 'Email' }).fill(person.email);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Enter your password').fill(person.password);
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await expect(page).toHaveURL('/en');
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account menu' }))
    .toContainText(`@${person.handle}`);
});
