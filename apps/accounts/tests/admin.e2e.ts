import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';

// The operator journeys against a live Accounts app and its stack:
// REZICS_WEB_AUTH_PRIVATE_PATH names the stack's web-auth private.json, whose
// operator owns the installation (see tests/account-journeys.e2e.ts).

interface Operator { email: string; password: string }
function operator(): Operator | undefined {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  return path ? (JSON.parse(readFileSync(path, 'utf8')) as { operator: Operator }).operator : undefined;
}
const hydrated = (page: Page) => page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });

test('G373 every admin section hydrates with seeded translations and client scopes open from their count', async ({ page, baseURL }) => {
  const admin = operator();
  test.skip(!admin, 'REZICS_WEB_AUTH_PRIVATE_PATH must name the stack’s web-auth private.json');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  expect((await page.request.post('/api/auth/sign-in/email', {
    headers: { origin: new URL(baseURL!).origin }, data: admin })).ok()).toBe(true);
  for (const path of ['/admin?hl=en', '/admin/users', '/admin/clients', '/admin/audit', '/admin/staff', '/admin?hl=ja']) {
    await page.goto(path);
    await hydrated(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (path === '/admin/clients') {
      const count = page.getByRole('button', { name: /^\d+ scopes?$/ }).first();
      await expect(count).toHaveAttribute('aria-expanded', 'false');
      await count.click();
      await expect(count).toHaveAttribute('aria-expanded', 'true');
      const detailsId = await count.getAttribute('aria-controls');
      await expect(page.locator(`[id="${detailsId}"]`)).toBeVisible();
    }
    expect(errors).toEqual([]);
  }
});

/** Someone new signs up; the operator signs in (a fresh sign-in admits staff changes). */
async function setUp(page: Page, origin: string, admin: Operator, count = 1) {
  const id = randomBytes(5).toString('hex');
  const members = Array.from({ length: count }, (_, index) => ({ name: `Mallory ${id}${index ? ` ${index + 1}` : ''}`,
    email: `mallory-${id}-${index}@example.test`, password: `pass phrase ${id}` }));
  for (const member of members) {
    expect((await page.request.post('/api/auth/sign-up/email', { headers: { origin }, data: { ...signupPolicyFixture, ...member } })).ok()).toBe(true);
  }
  expect((await page.request.post('/api/auth/sign-in/email', { headers: { origin },
    data: { email: admin.email, password: admin.password } })).ok()).toBe(true);
  return { id, members };
}

test('an operator finds a user, suspends them with a reason, and their story and the audit log record it', async ({ page, baseURL }) => {
  const admin = operator();
  test.skip(!admin, 'REZICS_WEB_AUTH_PRIVATE_PATH must name the stack’s web-auth private.json');
  const origin = new URL(baseURL!).origin;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { id, members: [member] } = await setUp(page, origin, admin!);

  // Search as you type; the row opens the user.
  await page.goto('/admin/users');
  await hydrated(page);
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Search users' })).toBeFocused();
  await page.keyboard.type(`Mallory ${id}`);
  await expect(page).toHaveURL(new RegExp(`q=Mallory\\+${id}`));
  const row = page.getByRole('row').filter({ hasText: member!.email });
  await expect(row).toHaveCount(1);
  await row.getByRole('link', { name: member!.name }).click();
  await expect(page.getByRole('heading', { level: 1, name: member!.name })).toBeVisible();
  await hydrated(page);

  // Suspending is the most damaging action: reason, typed email, password.
  await page.getByRole('button', { name: 'Suspend…' }).click();
  const dialog = page.getByRole('alertdialog', { name: `Suspend ${member!.name}?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Suspend' }).click();
  await expect(dialog.getByText('Choose a reason').last()).toBeVisible();
  await dialog.getByLabel('Reason', { exact: true }).selectOption('spam');
  await dialog.getByLabel('Details for the audit log').fill('Posted the same link in forty Realms');
  await dialog.getByLabel('Message to the user (optional)').fill('Your account was suspended for spam.');
  await dialog.getByLabel('Duration').selectOption('day');
  await dialog.getByLabel(`Type ${member!.email} to confirm`).fill(member!.email);
  await dialog.getByLabel('Your password').fill(admin!.password);
  await dialog.getByRole('button', { name: 'Suspend' }).click();
  // Nothing changes on the page until the service confirms.
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText(`${member!.name} is suspended`)).toBeVisible();
  const request = (await page.getByText(/^Request [0-9a-f-]{36}$/).first().textContent())!.slice('Request '.length);
  await hydrated(page);
  const status = page.getByRole('region', { name: 'Status' });
  await expect(status.getByText('Posted the same link in forty Realms')).toBeVisible();

  // The account's story shows who did what, why, and what the user was told.
  const story = page.getByRole('region', { name: 'Timeline' });
  await expect(story.getByText('Your account was suspended for spam.')).toBeVisible();
  await story.getByRole('button', { name: 'Staff' }).click();
  await expect(page).toHaveURL(/\?show=staff$/);
  await expect(story.getByText('Posted the same link in forty Realms')).toBeVisible();
  await expect(story.getByText('Device signed out')).toHaveCount(0);
  await page.getByRole('link', { name: 'Audit', exact: true }).click();
  await hydrated(page);
  const entry = page.getByRole('listitem').filter({ hasText: 'Posted the same link in forty Realms' });
  await expect(entry.getByText('Suspended', { exact: true })).toBeVisible();
  await expect(entry.getByText('Spam', { exact: true })).toBeVisible();

  // The request ID from the confirmation finds its one record, opened.
  await page.goto('/admin/audit');
  await hydrated(page);
  await page.getByRole('searchbox', { name: 'Search the audit log' }).fill(request);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`request=${request}`));
  await expect(page.getByRole('row').filter({ hasText: member!.name }).getByText('Succeeded')).toBeVisible();
  await expect(page.getByText(`Request ${request}`)).toBeVisible();
  expect(errors).toEqual([]);
});

test('a burst of failed sign-ins waits on the overview until an operator reviews it', async ({ page, baseURL }) => {
  const admin = operator();
  test.skip(!admin, 'REZICS_WEB_AUTH_PRIVATE_PATH must name the stack’s web-auth private.json');
  const origin = new URL(baseURL!).origin;
  const { id, members: [member] } = await setUp(page, origin, admin!);
  const checked = `Owner ${id} forgot the password; reset by email`;
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.request.post('/api/auth/sign-in/email', { headers: { origin }, data: { email: member!.email, password: 'wrong guess' } });
  }
  await page.goto('/admin');
  await hydrated(page);
  const signal = page.getByRole('list', { name: 'Needs review' }).getByRole('listitem').filter({ hasText: member!.email });
  await expect(signal.getByText('5 failed sign-ins in a day')).toBeVisible();
  await signal.getByRole('button', { name: /^Review:/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark as reviewed' });
  await dialog.getByLabel('What you checked (optional)').fill(checked);
  await dialog.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(signal).toHaveCount(0);
  await page.goto('/admin/audit?action=signal_reviewed');
  await hydrated(page);
  await expect(page.getByRole('row').filter({ hasText: checked })).toHaveCount(1);
});

test('a bulk sign-out waits out its undo window, and Undo changes no one', async ({ page, baseURL }) => {
  const admin = operator();
  test.skip(!admin, 'REZICS_WEB_AUTH_PRIVATE_PATH must name the stack’s web-auth private.json');
  const origin = new URL(baseURL!).origin;
  const { id, members } = await setUp(page, origin, admin!, 2);
  await page.goto(`/admin/users?q=${encodeURIComponent(`Mallory ${id}`)}`);
  await hydrated(page);
  for (const member of members) await page.getByRole('checkbox', { name: `Select ${member.name}`, exact: true }).check();
  await page.getByRole('toolbar', { name: '2 selected' }).getByRole('button', { name: 'Sign out everywhere…' }).click();
  const form = page.getByRole('alertdialog', { name: 'Sign 2 users out everywhere?' });
  await expect(form.getByText('2 will change')).toBeVisible();
  await form.getByLabel('Reason', { exact: true }).selectOption('support');
  await form.getByLabel('Details for the audit log').fill('Lost laptops');
  await form.getByRole('button', { name: 'Sign out everywhere' }).click();
  const job = page.getByRole('dialog', { name: 'Sign 2 users out everywhere?' });
  await expect(job.getByText(/Starts in \d+ seconds?\. Nothing has changed yet\./)).toBeVisible();
  await job.getByRole('button', { name: 'Undo' }).click();
  await expect(job.getByText('Stopped: 0 done, 2 not changed')).toBeVisible();
  await expect(job.getByText('Not changed', { exact: true })).toHaveCount(2);
});
