import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { uuidToSid } from '@rezics/model/address';
import { signInAtAccounts } from './account-sign-in.ts';

interface PublicFixture { actingSubject: string }
interface PrivateFixture { member: { email: string; password: string } }

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const uuid = (iri: string) => iri.slice(-36);

/** The member reads what they write through the QA grant, as the Work journeys do. */
function grantRead(resource: string) {
  const grant = spawnSync('bun', ['apps/web/tests/grant-read.ts'], { cwd: process.cwd(),
    env: { ...process.env, REZICS_QA_WORK: resource }, encoding: 'utf8', timeout: 30_000 });
  if (grant.status !== 0 || grant.error) throw new Error(`QA read grant failed: ${grant.stderr || grant.error?.message}`);
}

test('a chapter written in Studio keeps its old address: it moves for good to the chapter in its Book', async ({ page }) => {
  test.setTimeout(180_000);
  const session = fixture<PublicFixture>('REZICS_WEB_AUTH_PUBLIC_PATH').actingSubject;
  const studio = `/en/studio/@agent-${uuid(session)}`;
  await signInAtAccounts(page, studio, fixture<PrivateFixture>('REZICS_WEB_AUTH_PRIVATE_PATH').member);
  await page.goto(`${studio}/new`);
  await page.getByRole('textbox', { name: 'Title' }).fill(`Chapter address book ${Date.now()}`);
  await page.getByRole('radio', { name: /^Book/ }).check();
  await page.getByRole('combobox', { name: 'Language you’ll write in' }).click();
  await page.getByRole('option', { name: 'Undetermined' }).click();
  await page.getByRole('button', { name: /^Create as / }).click();
  await page.waitForURL(/\/works\/[0-9a-f-]{36}\?tab=chapters$/);
  const book = /\/works\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await page.getByRole('textbox', { name: 'New chapter' }).fill('Rain at the bookshop');
  await page.getByRole('button', { name: 'Add chapter' }).click();
  const write = page.getByRole('link', { name: 'Write “Rain at the bookshop”' });
  await expect(write).toBeVisible();
  // Studio addresses the chapter by its Post: the last segment of the editor's address.
  const post = /\/chapters\/([0-9a-f-]{36})/.exec(await write.getAttribute('href') ?? '')![1]!;
  grantRead(`https://rezics.com/id/${book}`);

  const listed = await page.request.get(`/api/main/v1/me/agents/${uuid(session)}/works/${book}/chapters`);
  expect(listed.status()).toBe(200);
  const occurrence = uuid((await listed.json() as { page: { items: { occurrence: string }[] } }).page.items[0]!.occurrence);

  // Main places the Post in its Book; the Post read says where.
  const read = await page.request.get(`/api/main/v1/posts/${post}?actingSubject=${encodeURIComponent(session)}`);
  expect(read.status()).toBe(200);
  expect(await read.json()).toMatchObject({ profile: 'post-read-v2', placements: [{ occurrence: `https://rezics.com/id/${occurrence}` }] });

  // The address a chapter Work once had still opens the chapter in its Book's reader, in every locale.
  for (const locale of ['en', 'zh-Hant']) {
    await page.goto(`/${locale}/w/${post}`);
    // ast-grep-ignore: web-links-use-address -- Independent SID expectation keeps the route exact without reusing the link builder.
    await page.waitForURL(url => url.pathname === `/${locale}/w/${uuidToSid(book)}/read/${occurrence}`);
  }
  // The Book's reader also accepts the Post, so a link can name the chapter and its Book together.
  await page.goto(`/en/w/${book}/read/${post}`);
  // ast-grep-ignore: web-links-use-address -- Independent SID expectation keeps the route exact without reusing the link builder.
  await page.waitForURL(url => url.pathname === `/en/w/${uuidToSid(book)}/read/${occurrence}`);
});
