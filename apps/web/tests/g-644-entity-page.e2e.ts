import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

// The resources are written once into this isolated QA stack through Main's routes (`g-644-seed.ts`): a web serial with
// a chapter occurrence and a release, a character, a resource of a type nobody registered (named in Arabic) and a
// community. The browser reads them on the generic page, on desktop and on a phone, in English, Traditional Chinese
// and a right-to-left content language, and starts a discussion from the chapter.
interface Seeded { work: string; occurrence: string; release: string; character: string; hologram: string; realm: string }
let seeded: Seeded;
const started = Date.now();
const lap = (step: string) => console.log(`[g-644] ${step} at ${Math.round((Date.now() - started) / 1000)}s`);
test.beforeAll(async () => {
  test.setTimeout(300_000);
  const result = spawnSync('bun', ['apps/web/tests/g-644-seed.ts'], { cwd: process.cwd(), env: process.env,
    encoding: 'utf8', timeout: 240_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`G-644 seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  seeded = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Seeded;
  lap('seeded');
  // Main keeps processing the seed's events for a while, moving the graph under every read (409).
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${uuid(seeded.work)}`;
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 90_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main).catch(() => null);
    const position = response?.ok ? JSON.stringify((await response.json() as { sourcePosition: unknown }).sourcePosition) : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise(done => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for 90 seconds after the seed');
  lap('graph still');
});

const uuid = (iri: string) => iri.slice(-36);
const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 860 };
const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
const bookControls = /^(read|start reading|continue reading)$/i;

/** One screenshot per viewport, none with horizontal overflow. */
async function shoot(page: Page, path: string, name: string, info: TestInfo) {
  for (const [label, viewport] of [['desktop', desktop], ['phone', phone]] as const) {
    await page.setViewportSize(viewport);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(await overflows(page), `${name} ${label}`).toBe(false);
    await page.screenshot({ path: info.outputPath(`${name}-${label}.png`), fullPage: true });
  }
  await page.setViewportSize(desktop);
}

test('any admitted resource has a page, and a discussion starts from it', async ({ page }, info) => {
  test.setTimeout(420_000);
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  const { member } = JSON.parse(readFileSync(path, 'utf8')) as { member: { email: string; password: string } };
  const at = (resource: string, locale = 'en') => `/${locale}/e/${uuid(resource)}`;
  await page.setViewportSize(desktop);

  // Signed out: Main answers a public Work's chapter alike to everyone. Where it answers, the page reads, relations ask
  // for a sign-in and "Discuss" leads to sign-in rather than a dead end; where it does not, the page is a plain 404.
  const anonymous = await fetch(`http://127.0.0.1:${process.env.MAIN_PORT}/v1/resources/${uuid(seeded.occurrence)}/page`);
  info.annotations.push({ type: 'anonymous-occurrence', description: String(anonymous.status) });
  const first = await page.goto(at(seeded.occurrence));
  expect(first?.status()).toBe(anonymous.status === 200 ? 200 : 404);
  if (anonymous.status === 200) {
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sword Art Online');
    await expect(page.getByText('Sign in to see what this is related to.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Discuss this list item' }).first()).toHaveAttribute('href', /\/auth\/start\?next=/);
  } else {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nothing here');
  }
  lap('signed-out page');
  await signInAtAccounts(page, at(seeded.occurrence), member);
  lap('signed in');

  // Start a discussion on the chapter occurrence, reload, and come back to it.
  await expect(page.getByRole('heading', { name: 'Discussion' })).toBeVisible();
  await page.getByRole('link', { name: 'Discuss this list item' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/en/submit\\?target=${uuid(seeded.occurrence)}$`));
  await page.getByRole('searchbox', { name: 'Find a community' }).fill('Aincrad');
  await page.getByRole('button', { name: 'Aincrad readers' }).click();
  // The target is fixed by the page that asked; it cannot be searched away.
  await expect(page.getByRole('heading', { name: 'Work' })).toBeVisible();
  await expect(page.getByText('Sword Art Online (web)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change Work' })).toHaveCount(0);
  await page.locator('#post-title').fill('Who is Asuna in chapter one?');
  await page.getByRole('textbox', { name: 'Your post' }).fill('Does anyone else think chapter one is slow on purpose?');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/r/${uuid(seeded.realm)}/discussions/`), { timeout: 60_000 });
  lap('posted');
  await page.goto(at(seeded.occurrence));
  const reply = page.getByRole('article').filter({ hasText: 'chapter one is slow on purpose' });
  await expect(reply).toBeVisible();
  await page.reload();
  await expect(reply).toBeVisible();
  await expect(page.getByRole('link', { name: 'View in thread' })).toBeVisible();
  // Signed in, relations are Main's to answer and the section no longer asks for sign-in.
  await expect(page.getByText('Sign in to see what this is related to.')).toHaveCount(0);

  lap('discussion reloaded');
  // A release, a character and a resource of an unregistered type: each a page with no book controls.
  await page.goto(at(seeded.release));
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Sword Art Online 1: Aincrad');
  await expect(page.locator('[data-entity-type]')).toHaveText('Release');
  await expect(page.getByRole('link', { name: 'Discuss this release' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ratings' })).toBeVisible();
  await expect(page.getByRole('link', { name: bookControls })).toHaveCount(0);
  await page.goto(at(seeded.character));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kirito');
  await expect(page.locator('[data-entity-type]')).toHaveText('Character');
  await expect(page.getByText('キリト')).toBeVisible();
  await page.goto(at(seeded.hologram));
  const name = page.getByRole('heading', { level: 1 });
  await expect(name).toHaveText('معرض الهولوغرام');
  await expect(name.locator('span')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('[data-entity-type]')).toHaveText('Resource');
  await expect(page.getByRole('heading', { name: 'Ratings' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: bookControls })).toHaveCount(0);
  await expect(page.getByRole('button', { name: bookControls })).toHaveCount(0);

  // A missing resource and a Work at /e: the first is a 404, the second moves to the Work's own host.
  expect((await page.goto(`/en/e/${crypto.randomUUID()}`))?.status()).toBe(404);
  await page.goto(at(seeded.work));
  await expect(page).toHaveURL(`/en/w/${uuid(seeded.work)}`);

  // The same pages in Traditional Chinese keep the content in its own language and the interface in the reader's.
  await page.goto(at(seeded.character, 'zh-Hant'));
  await expect(page.locator('[data-entity-type]')).toHaveText('角色');
  await expect(page.getByRole('heading', { name: '討論' })).toBeVisible();
  await expect(page.getByRole('link', { name: '討論此角色' }).first()).toBeVisible();

  lap('pages read');
  await shoot(page, at(seeded.occurrence), 'occurrence', info);
  await shoot(page, at(seeded.release), 'release', info);
  await shoot(page, at(seeded.character), 'character', info);
  await shoot(page, at(seeded.hologram), 'hologram-rtl', info);
  await shoot(page, at(seeded.occurrence, 'zh-Hant'), 'occurrence-zh-Hant', info);
});

