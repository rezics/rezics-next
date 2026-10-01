import { readFileSync, writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { checkReflow, checkScreen, chooseRadio, composeCjk, expectClean, type Findings, keyboardReach, locales, motionRunning, pressByKeyboard } from './g-743-matrix.ts';
import { act, device, type LoopRecords, loopRecords } from './g-743-stack.ts';

// Launch journey `propose-review-inbox`: a contributor proposes a correction, a steward reviews a proposal in the
// review composer, and the inbox tells each of them (G-704's records and steps, `g-704-contribution-loop.e2e.ts`;
// the other people act between the browser's steps through `g-704-act.ts`). The matrix of `g-743-matrix.ts` on each
// screen, every control reached and operated by keyboard under reduced motion, CJK IME composition in the proposal
// form and the review composer, and the same screens in Japanese.
let seed: LoopRecords;
/** G-926 owns the wiki bundle proposal page's overflow (G-704 finding F1); `…G-926` below fails until it lands. */
const bundleKnown = { knownOverflow: 'G-926 F1' };
const imeText = '一間只在雨夜開門的書店。';
test.use({ actionTimeout: 15_000 });
test.beforeAll(async () => {
  test.setTimeout(480_000);
  seed = await loopRecords();
});

const inboxItem = (page: Page, text: string, id: string) => page.getByRole('listitem')
  .filter({ has: page.locator(`a[href*="/proposals/${id}"]`) }).filter({ hasText: text });
/** Reads the page again until `check` holds: Main delivers notifications a moment after the write. */
async function eventually(page: Page, path: string, check: () => Promise<void>) {
  await expect(async () => {
    await page.goto(path);
    await check();
  }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 3_000] });
}

/** The proposal the first test files, kept in a file: a failed test restarts the worker, and the rest still need it. */
const proposalFile = () => `.temp/g743-proposal-${process.env.REZICS_QA_RUN_ID}.txt`;

test('propose-review-inbox: a contributor proposes and finds the answer in the inbox, by keyboard, in the Latin locale', async ({ browser }, info) => {
  test.setTimeout(360_000);
  const found: Findings = [];
  const page = await device(browser, info, `/${locales.latin}/proposals/new?work=${seed.sagan.id}`, { reducedMotion: true });
  await expect(page.getByText('Correcting Sagan om ringen')).toBeVisible();
  await checkScreen(page, 'proposal-form', found, info);

  // The synopsis is written the way a CJK input method writes it, then the form is sent without the mouse.
  const synopsis = page.getByLabel('Synopsis');
  await keyboardReach(page, synopsis, found, 'Synopsis');
  const composed = await composeCjk(page, synopsis, imeText);
  expect(composed.duringComposition, 'the preedit is shown while composing').not.toBe('');
  expect(composed.value, 'the committed text is what the field holds').toBe(imeText);
  expect(composed.submitted, 'an Enter that belongs to the composition does not submit the form').toBe(false);
  await page.getByLabel('Source', { exact: true }).fill('https://example.test/sv-utgava');
  await pressByKeyboard(page, page.getByRole('button', { name: 'Submit correction' }), found, 'Submit correction');
  await expect(page).toHaveURL(/\/en\/proposals\/[0-9a-f-]{36}$/);
  const proposal = page.url().slice(-36);
  writeFileSync(proposalFile(), proposal);
  await expect(page.getByText(imeText)).toBeVisible();
  await checkScreen(page, 'proposal-page', found, info);
  expect(await motionRunning(page), 'running animations under reduced motion').toEqual([]);

  // A reviewer asks for changes; the contributor finds it in the inbox, saves it and marks it done, by keyboard.
  expect(act(seed.statePath, { as: 'steward', method: 'POST', path: `/v1/editorial/proposals/${proposal}/reviews`,
    body: { profile: 'editorial-proposal-review-v1', revision: 1, outcome: 'request_changes', message: 'Cite the edition',
      actingSubject: seed.roles.steward.actor } })).toMatchObject({ status: 200 });
  const item = () => inboxItem(page, 'Changes were requested on your correction', proposal);
  await eventually(page, `/${locales.latin}/notifications`, async () => { await expect(item()).toBeVisible({ timeout: 2_000 }); });
  await checkScreen(page, 'inbox', found, info);
  await pressByKeyboard(page, item().getByRole('button', { name: 'Save' }), found, 'Save');
  await expect(page.getByText('Saved.')).toBeVisible();
  await pressByKeyboard(page, item().getByRole('button', { name: 'Mark done' }), found, 'Mark done');
  await expect(page.getByText('Marked done.')).toBeVisible();
  await expect(item()).toHaveCount(0);
  await page.goto(`/${locales.latin}/notifications?view=done`);
  await expect(item()).toBeVisible();
  await checkScreen(page, 'inbox-done', found, info);
  await page.context().close();
  expectClean(found);
});

test('propose-review-inbox: a steward writes a review in the composer, by keyboard, with CJK input', async ({ browser }, info) => {
  test.setTimeout(360_000);
  const found: Findings = [];
  const bundle = seed.wiki.bundleProposal;
  const page = await device(browser, info, `/${locales.latin}/proposals/${bundle}`, { reducedMotion: true });
  await expect(page.getByText('Wiki bundle', { exact: true })).toBeVisible();
  await checkScreen(page, 'review-proposal', found, info, bundleKnown);

  await pressByKeyboard(page, page.locator('[data-action="review"]'), found, 'Review');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await checkScreen(page, 'review-composer', found, info, bundleKnown);
  // Focus stays inside the composer.
  for (let stop = 0; stop < 8; stop += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(element => element.contains(document.activeElement)), 'focus stays in the review composer').toBe(true);
  }
  await chooseRadio(page, dialog.getByRole('radio', { name: /Request changes/ }), found, 'Request changes');
  const message = dialog.getByLabel('Message');
  await keyboardReach(page, message, found, 'Message');
  const composed = await composeCjk(page, message, imeText);
  expect(composed.duringComposition, 'the preedit is shown while composing').not.toBe('');
  expect(composed.value, 'the committed text is what the field holds').toBe(imeText);
  expect(composed.submitted, 'an Enter that belongs to the composition does not submit the review').toBe(false);
  await expect(dialog).toBeVisible();
  await pressByKeyboard(page, dialog.getByRole('button', { name: 'Send' }), found, 'Send');
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Changes requested', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(imeText)).toBeVisible();
  await checkScreen(page, 'review-sent', found, info, bundleKnown);
  await page.context().close();
  expectClean(found);
});

test('propose-review-inbox: the wiki bundle proposal page does not scroll sideways on a phone or at 400% zoom (G-926 F1)', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const found: Findings = [];
  const page = await device(browser, info, `/${locales.latin}/proposals/${seed.wiki.bundleProposal}`);
  await expect(page.getByText('Wiki bundle', { exact: true })).toBeVisible();
  await checkReflow(page, 'wiki bundle proposal', found);
  await page.context().close();
  expectClean(found);
});

test('propose-review-inbox: the proposal, the review and the inbox in the CJK locale', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const found: Findings = [];
  const proposal = readFileSync(proposalFile(), 'utf8');
  const page = await device(browser, info, `/${locales.cjk}/proposals/new?work=${seed.sagan.id}`);
  await expect(page.locator('html')).toHaveAttribute('lang', locales.cjk);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await checkScreen(page, 'proposal-form-ja', found, info);
  await page.goto(`/${locales.cjk}/proposals/${proposal}`);
  await expect(page.getByText(imeText)).toBeVisible();
  await checkScreen(page, 'proposal-page-ja', found, info);
  await page.goto(`/${locales.cjk}/proposals/${seed.wiki.bundleProposal}`);
  await expect(page.locator('html')).toHaveAttribute('lang', locales.cjk);
  await checkScreen(page, 'review-proposal-ja', found, info, bundleKnown);
  await pressByKeyboard(page, page.locator('[data-action="review"]'), found, 'Review (ja)');
  await expect(page.getByRole('dialog')).toBeVisible();
  await checkScreen(page, 'review-composer-ja', found, info, bundleKnown);
  await page.keyboard.press('Escape');
  await page.goto(`/${locales.cjk}/notifications?view=done`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await checkScreen(page, 'inbox-ja', found, info);
  await page.context().close();
  expectClean(found);
});
