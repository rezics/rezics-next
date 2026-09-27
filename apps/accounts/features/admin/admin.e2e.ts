import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

// The operator journey against a live Accounts app and its stack:
// REZICS_WEB_AUTH_PRIVATE_PATH names the stack's web-auth private.json, whose
// operator owns the installation (see tests/account-journeys.e2e.ts).

interface Operator { email: string; password: string }
function operator(): Operator | undefined {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  return path ? (JSON.parse(readFileSync(path, 'utf8')) as { operator: Operator }).operator : undefined;
}
const hydrated = (page: Page) => page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });

test('an operator finds a user, suspends them with a reason, and the audit log records it', async ({ page, baseURL }) => {
  const admin = operator();
  test.skip(!admin, 'REZICS_WEB_AUTH_PRIVATE_PATH must name the stack’s web-auth private.json');
  const origin = new URL(baseURL!).origin;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  // Someone signs up; the operator signs in.
  const id = randomBytes(5).toString('hex');
  const member = { name: `Mallory ${id}`, email: `mallory-${id}@example.test`, password: `pass phrase ${id}` };
  const signedUp = await page.request.post('/api/auth/sign-up/email', { headers: { origin }, data: member });
  expect(signedUp.ok()).toBe(true);
  const signedIn = await page.request.post('/api/auth/sign-in/email', { headers: { origin },
    data: { email: admin!.email, password: admin!.password } });
  expect(signedIn.ok()).toBe(true);

  // Search as you type; the row opens the user.
  await page.goto('/admin/users');
  await hydrated(page);
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Search users' })).toBeFocused();
  await page.keyboard.type(`Mallory ${id}`);
  await expect(page).toHaveURL(new RegExp(`q=Mallory\\+${id}`));
  const row = page.getByRole('row').filter({ hasText: member.email });
  await expect(row).toHaveCount(1);
  await row.getByRole('link', { name: member.name }).click();
  await expect(page.getByRole('heading', { level: 1, name: member.name })).toBeVisible();
  await hydrated(page);

  // Suspending is the most damaging action: reason, typed email, password.
  await page.getByRole('button', { name: 'Suspend…' }).click();
  const dialog = page.getByRole('alertdialog', { name: `Suspend ${member.name}?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Suspend' }).click();
  await expect(dialog.getByText('Choose a reason').last()).toBeVisible();
  await dialog.getByLabel('Reason', { exact: true }).selectOption('spam');
  await dialog.getByLabel('Details for the audit log').fill('Posted the same link in forty Realms');
  await dialog.getByLabel('Message to the user (optional)').fill('Your account was suspended for spam.');
  await dialog.getByLabel('Duration').selectOption('day');
  await dialog.getByLabel(`Type ${member.email} to confirm`).fill(member.email);
  await dialog.getByLabel('Your password').fill(admin!.password);
  await dialog.getByRole('button', { name: 'Suspend' }).click();
  // Nothing changes on the page until the service confirms.
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText(`${member.name} is suspended`)).toBeVisible();
  await hydrated(page);
  await expect(page.getByText('Suspended').first()).toBeVisible();
  await expect(page.getByText('Posted the same link in forty Realms')).toBeVisible();

  // The sanction history and the audit log show who, what and why.
  await page.getByRole('link', { name: 'Sanctions' }).click();
  await expect(page.getByText('Your account was suspended for spam.')).toBeVisible();
  await page.getByRole('link', { name: 'Audit', exact: true }).click();
  await hydrated(page);
  const entry = page.getByRole('listitem').filter({ hasText: 'Posted the same link in forty Realms' });
  await expect(entry.getByText('Suspended', { exact: true })).toBeVisible();
  await expect(entry.getByText('Spam', { exact: true })).toBeVisible();
  await page.goto(`/admin/audit?action=suspend`);
  await hydrated(page);
  await expect(page.getByRole('row').filter({ hasText: member.name }).getByText('Succeeded')).toBeVisible();
  expect(errors).toEqual([]);
});
