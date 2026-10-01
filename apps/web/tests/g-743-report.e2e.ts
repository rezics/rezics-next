import { expect, type Page, test } from '@playwright/test';
import { keyed, textFor } from '../features/safety/report.ts';
import { checkScreen, chooseRadio, composeCjk, expectClean, type Findings, keyboardReach, locales, motionRunning, pressByKeyboard } from './g-743-matrix.ts';
import { hubRecords, visitor } from './g-743-stack.ts';
import type { Hub } from './g-850-seed.ts';

// Launch journey `report-without-account`: a visitor with no account reports a Work from the report page and
// reads their private case (G-820's page; the target is a Work of G-850's records). The matrix of `g-743-matrix.ts`
// on the form, its problems, and the case page; the whole report filed by keyboard alone under reduced motion; the
// statement written with a CJK input method; the same journey in Japanese.
let hub: Hub;
test.use({ actionTimeout: 15_000 });
test.beforeAll(async () => {
  test.setTimeout(420_000);
  hub = await hubRecords();
});

async function fileReport(page: Page, locale: 'en' | 'ja', statement: string, found: Findings, info: Parameters<typeof checkScreen>[3]) {
  const t = textFor(locale);
  await page.goto(`/${locale}/report?target=${encodeURIComponent(hub.sao.series.work)}`);
  const form = page.getByRole('form', { name: t.title });
  await expect(form).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  const send = form.getByRole('button', { name: t.submit });
  await expect(send).toBeEnabled({ timeout: 30_000 });
  await checkScreen(page, `report-form-${locale}`, found, info);

  // Sending an empty form says what is missing, on each field, and moves focus to the first problem.
  await pressByKeyboard(page, send, found, 'Send report (empty)');
  await expect(form.getByText(t.categoryRequired)).toBeVisible();
  await expect(form.getByText(t.statementRequired)).toBeVisible();
  await checkScreen(page, `report-form-problems-${locale}`, found, info);

  // A kind of problem, chosen with the keyboard; its own form follows.
  const category = form.getByRole('radio', { name: new RegExp(keyed(t, 'cat', 'spam_or_manipulation')) });
  await chooseRadio(page, category, found, 'Kind of problem');
  await expect(category).toBeChecked();
  const written = form.getByLabel(t.statementLabel);
  await keyboardReach(page, written, found, 'Statement');
  if (locale === 'ja') {
    const composed = await composeCjk(page, written, statement);
    expect(composed.value).toBe(statement);
    expect(composed.submitted, 'an Enter that belongs to the composition does not send the report').toBe(false);
  } else await page.keyboard.type(statement);
  await expect(written).toHaveValue(statement);
  await checkScreen(page, `report-form-filled-${locale}`, found, info);
  await pressByKeyboard(page, send, found, 'Send report');
  await expect(page).toHaveURL(new RegExp(`/${locale}/report/[0-9a-f-]{36}#[\\w-]{43}$`), { timeout: 60_000 });
  await expect(page.getByRole('heading', { level: 1, name: t.statusTitle })).toBeVisible();
  await expect(page.getByText(statement)).toBeVisible({ timeout: 60_000 });
}

/** The private case page: its private-link control is reached by keyboard, and the page passes the matrix. */
async function readCase(page: Page, locale: 'en' | 'ja', found: Findings, info: Parameters<typeof checkScreen>[3]) {
  await keyboardReach(page, page.getByRole('button').filter({ hasText: /./ }).first(), found, `case page control (${locale})`);
  await checkScreen(page, `report-case-${locale}`, found, info);
}

test('report-without-account: a visitor files a report by keyboard alone under reduced motion, in the Latin locale', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const found: Findings = [];
  const page = await visitor(browser, info, { reducedMotion: true });
  await fileReport(page, locales.latin, 'This listing is repeated advertising for an unrelated shop.', found, info);
  await readCase(page, locales.latin, found, info);
  expect(await motionRunning(page), 'running animations under reduced motion').toEqual([]);
  await page.context().close();
  expectClean(found);
});

test('report-without-account: the same report in the CJK locale, the statement composed with an input method', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const found: Findings = [];
  const page = await visitor(browser, info);
  await fileReport(page, locales.cjk, 'この作品の説明は無関係な店の広告の繰り返しです。', found, info);
  await readCase(page, locales.cjk, found, info);
  await page.context().close();
  expectClean(found);
});
