import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import type { EditCatalogue } from './g-839-catalogue.ts';
import { chooseOption } from './g-934-choose.ts';

// The records are written once into this isolated QA stack through Main's routes (`g-839-catalogue.ts`);
// the browser signs in as the stack's web member, an editor of those Works, and maintains their
// parts, relations, realizations and releases on desktop and on a phone.
let catalogue: EditCatalogue;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  const result = spawnSync('bun', ['apps/web/tests/g-839-seed.ts'], { cwd: process.cwd(), env: process.env,
    encoding: 'utf8', timeout: 240_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`G-839 seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  catalogue = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as EditCatalogue;
  // Main keeps processing the seed's events for a while: every Work must read publicly and the graph position hold still.
  const works = [...Object.values(catalogue.index), ...catalogue.sao.volumes, catalogue.readOnly].map(work => uuid(work.work));
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && still < 6;) {
    const answers = await Promise.all(works.map(id => fetch(`http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${id}`).catch(() => null)));
    const positions = await Promise.all(answers.map(async answer => (answer?.ok ? JSON.stringify((await answer.json() as { sourcePosition: unknown }).sourcePosition) : '')));
    const position = positions.every(Boolean) && new Set(positions).size === 1 ? positions[0]! : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise(done => setTimeout(done, 500));
  }
  if (still < 6) throw new Error('Main’s graph kept moving for 120 seconds after the seed');
});

const uuid = (iri: string) => iri.slice(-36);
const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 860 };
const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

/** One screenshot per viewport, none with horizontal overflow. */
async function shoot(page: Page, name: string, info: TestInfo) {
  for (const [label, viewport] of [['desktop', desktop], ['phone', phone]] as const) {
    await page.setViewportSize(viewport);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(await overflows(page), `${name} ${label}`).toBe(false);
    await page.screenshot({ path: info.outputPath(`${name}-${label}.png`), fullPage: true });
  }
  await page.setViewportSize(desktop);
}

/** Main applies a write to its graph a moment after the receipt: read the page again until the record shows. */
async function eventually(page: Page, path: string, check: () => Promise<void>) {
  await expect(async () => {
    await page.goto(path);
    await check();
  }).toPass({ timeout: 100_000 });
}

const receipt = (page: Page) => page.getByText(/Receipt: /);

test('an editor maintains parts, relations, realizations and releases; a reader sees no controls', async ({ page, context }, info) => {
  test.setTimeout(600_000);
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  const { member } = JSON.parse(readFileSync(path, 'utf8')) as { member: { email: string; password: string } };
  const { index, sao, readOnly } = catalogue;
  const at = (work: { work: string }, rest: string) => `/en/w/${uuid(work.work)}/${rest}`;
  await page.setViewportSize(desktop);

  // Signed out, an edit page offers no control, only the way to sign in.
  await page.goto(at(index.newTestament, 'edit/parts'));
  await expect(page.getByRole('heading', { name: 'Sign in to edit' })).toBeVisible();
  await expect(page.locator('#main-content').locator('form, input, select, textarea, button')).toHaveCount(0);
  await signInAtAccounts(page, at(index.newTestament, 'edit/parts'), member);

  // Parts: add "22 Reverse" after "22".
  const list = page.getByRole('list', { name: 'Parts in publication order' });
  await expect(list.locator('[data-part-label]')).toHaveText(['1', '2', '22']);
  await shoot(page, 'parts-before', info);
  const add = page.getByRole('form', { name: 'Add a part' });
  await add.getByRole('textbox', { name: 'Work' }).fill(uuid(index.reverse.work));
  await add.getByRole('textbox', { name: 'Label' }).fill('22 Reverse');
  await chooseOption(add, page, 'Place', 'After 22');
  await add.getByRole('button', { name: 'Add part' }).click();
  await expect(receipt(page)).toBeVisible();
  await expect(list.locator('[data-part-label]')).toHaveText(['1', '2', '22', '22 Reverse']);

  // Move it above "22".
  await page.getByRole('button', { name: 'Move 22 Reverse up' }).click();
  await expect(list.locator('[data-part-label]')).toHaveText(['1', '2', '22 Reverse', '22']);
  await shoot(page, 'parts-after', info);

  // A second tab holds the list as it was: its edit is refused as stale, keeps what was typed, and succeeds after a reload.
  const other = await context.newPage();
  await other.goto(at(index.newTestament, 'edit/parts'));
  const otherList = other.getByRole('list', { name: 'Parts in publication order' });
  await expect(otherList.getByRole('listitem')).toHaveCount(4);
  await page.getByRole('button', { name: 'Move 22 Reverse down' }).click();
  await expect(list.locator('[data-part-label]')).toHaveText(['1', '2', '22', '22 Reverse']);
  await other.locator('summary[aria-label="Edit 22"]').click();
  const label = other.getByRole('textbox', { name: 'Label' }).first();
  await label.fill('22 (rev.)');
  await other.getByRole('button', { name: 'Save' }).click();
  const conflict = other.getByRole('alert');
  await expect(conflict).toContainText('This Work changed since you opened the page');
  await expect(conflict.getByRole('button', { name: 'Reload latest' })).toBeVisible();
  await expect(other.getByRole('textbox', { name: 'Label' }).first()).toHaveValue('22 (rev.)');
  await shoot(other, 'parts-conflict', info);
  await conflict.getByRole('button', { name: 'Reload latest' }).click();
  // The refusal clears once the page has read Main again; what was typed stays for the next submit.
  await expect(other.getByRole('alert')).toHaveCount(0);
  await expect(other.getByRole('textbox', { name: 'Label' }).first()).toHaveValue('22 (rev.)');
  await other.getByRole('button', { name: 'Save' }).click();
  await expect(receipt(other)).toBeVisible();
  await other.close();

  // G-837's Connections page shows the change after a reload.
  await page.goto(at(index.newTestament, 'connections'));
  await expect(page.getByRole('list', { name: 'Parts in publication order' }).getByRole('listitem'))
    .toHaveText([/^1\s*New Testament 1/, /^2\s*New Testament 2/, /^22 \(rev\.\)\s*New Testament 22$/,
      /^22 Reverse\s*New Testament 22 Reverse/]);
  await expect(page.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', `/en/w/${uuid(index.newTestament.work)}/edit/parts`);

  // Relations: Genesis Testament is a Sequel of New Testament, with evidence. Main words every label.
  await page.goto(at(index.genesisTestament, 'edit/relations'));
  const relation = page.getByRole('form', { name: 'Record a relation' });
  await chooseOption(relation, page, 'This Work is', 'Sequel to');
  await relation.getByRole('textbox', { name: 'The other Work' }).fill(uuid(index.newTestament.work));
  await relation.getByRole('textbox', { name: /Evidence/ }).fill('https://example.com/genesis-testament/sequel');
  await shoot(page, 'relations-form', info);
  await relation.getByRole('button', { name: 'Record relation' }).click();
  await expect(receipt(page)).toBeVisible();
  await eventually(page, at(index.genesisTestament, 'connections'), () => expect(page.locator('[data-relation-row]')
    .filter({ hasText: 'Sequel to' })).toContainText('A Certain Magical Index: New Testament', { timeout: 15_000 }));
  await eventually(page, at(index.newTestament, 'connections'), () => expect(page.locator('[data-relation-row]')
    .filter({ hasText: 'Sequel' })).toContainText('Genesis Testament', { timeout: 15_000 }));

  // Editions: a zh-Hans realization of volume 1, then an omnibus release covering volumes 1-3.
  const [volumeOne, volumeTwo, volumeThree] = sao.volumes as [typeof sao.volumes[number], ...typeof sao.volumes];
  await page.goto(at(volumeOne, 'edit/editions'));
  const realization = page.getByRole('form', { name: 'Add a realization' });
  await realization.getByRole('textbox', { name: 'Language', exact: true }).fill('zh-Hans');
  await realization.getByRole('checkbox', { name: 'I am the translator' }).check();
  await chooseOption(realization, page, 'Status', 'Unofficial');
  await realization.getByRole('button', { name: 'Add realization' }).click();
  await expect(receipt(page).first()).toBeVisible();
  // Main applies a write to its graph a moment after the receipt: read again until the record shows.
  await expect(async () => {
    await page.goto(at(volumeOne, 'editions'));
    await expect(page.locator('[data-language-group="zh-Hans"]')).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 45_000 });

  await page.goto(at(volumeOne, 'edit/editions'));
  const release = page.getByRole('form', { name: 'Add a release' });
  await release.getByRole('textbox', { name: 'Title', exact: true }).fill('Sword Art Online: Volumes 1–3 omnibus');
  await release.getByRole('textbox', { name: 'Title language' }).fill('en');
  await release.getByRole('textbox', { name: 'Format or platform' }).fill('ebook');
  await release.getByRole('textbox', { name: 'Territory' }).fill('US');
  // Volume 1 offers its English and Simplified Chinese texts; the omnibus carries the official English ones.
  const own = release.getByRole('group', { name: 'This Work’s realizations' });
  await expect(own.getByRole('checkbox')).toHaveCount(2);
  await own.locator('label', { hasText: 'en' }).getByRole('checkbox').check();
  for (const volume of [volumeTwo, volumeThree]) {
    await release.getByRole('textbox', { name: 'Cover another Work’s realizations' }).fill(uuid(volume.work));
    await release.getByRole('button', { name: 'Load its realizations' }).click();
    const group = release.getByRole('group', { name: `Realizations of ${volume.title}` });
    await group.getByRole('checkbox').check();
  }
  await shoot(page, 'editions-form', info);
  await release.getByRole('button', { name: 'Add release' }).click();
  await expect(receipt(page).last()).toBeVisible();
  await eventually(page, at(volumeOne, 'editions'), () => expect(page.getByRole('region', { name: 'Releases' }).getByText('Covers 3 Works')).toBeVisible({ timeout: 15_000 }));

  // A reader: a Work the member may read but not edit shows no edit link and no control.
  await page.goto(at(readOnly, 'connections'));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
  for (const section of ['parts', 'relations', 'editions']) {
    await page.goto(at(readOnly, `edit/${section}`));
    await expect(page.getByRole('heading', { name: 'You can’t edit this Work' })).toBeVisible();
    await expect(page.locator('#main-content').locator('form, input, select, textarea, button')).toHaveCount(0);
  }
  await shoot(page, 'reader', info);
});
