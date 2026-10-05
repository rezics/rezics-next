import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

interface PublicFixture { actingSubject: string }
interface PrivateFixture { member: { email: string; password: string } }

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const uuid = (iri: string) => iri.slice(-36);

test('Studio requires a stated language and reads a chapter page', async ({ page }) => {
  test.setTimeout(180_000);
  const session = fixture<PublicFixture>('REZICS_WEB_AUTH_PUBLIC_PATH');
  const member = fixture<PrivateFixture>('REZICS_WEB_AUTH_PRIVATE_PATH').member;
  await signInAtAccounts(page, `/en/studio/@agent-${uuid(session.actingSubject)}`, member);
  const response = await page.request.post('/api/main/v1/agents', {
    headers: { 'idempotency-key': `studio-language-${Date.now()}` },
    data: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Language Writer' },
  });
  expect([200, 201]).toContain(response.status());
  const writer = (await response.json() as { agent: string }).agent;
  const studio = `/en/studio/@agent-${uuid(writer)}`;
  await page.goto(`${studio}/new`);
  await page.getByRole('textbox', { name: 'Title' }).fill('Language chosen by author');
  await page.getByRole('radio', { name: /^Book/ }).check();
  const language = page.getByRole('combobox', { name: 'Language you’ll write in' });
  await expect(language).toHaveText('Choose a language');
  await page.getByRole('button', { name: 'Create as Language Writer' }).click();
  await expect(page).toHaveURL(`${studio}/new`);
  await expect(language).toBeFocused();
  await language.click();
  await page.getByRole('option', { name: 'Undetermined' }).click();
  await page.getByRole('button', { name: 'Create as Language Writer' }).click();
  await page.waitForURL(/\/works\/[0-9a-f-]{36}\?tab=chapters$/);
  const work = /\/works\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await page.getByRole('textbox', { name: 'New chapter' }).fill('An untitled-language chapter');
  await page.getByRole('button', { name: 'Add chapter' }).click();
  await expect(page.getByRole('link', { name: 'Write “An untitled-language chapter”' })).toBeVisible();
  await page.reload();
  const chapter = page.getByRole('region', { name: 'Chapters' }).getByRole('listitem');
  await expect(chapter).toContainText('Not started');
  const read = await page.request.get(`/api/main/v1/me/agents/${uuid(writer)}/works/${work}/chapters`);
  expect(read.status()).toBe(200);
  expect(await read.json()).toMatchObject({ facts: [{ writer, state: 'empty', otherIdentity: false }] });
});
