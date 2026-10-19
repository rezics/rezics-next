import { createHash } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import { credentials } from './g-855-library.ts';
import { textFor, type ReportInput, type ReportReceipt } from '../features/safety/report.ts';
import { apiData, catalogueApi, catalogueBrowserFixture, documentMediaUses, documentText, forbidMessages, header, publicSubject,
  short, tabTo, type CatalogueBrowserFixture, type ReportTarget } from './catalogue-browser-fixture.ts';

// C22/C26, pending: visitor selection, isolated member login return and owned report receipts.
// Selection stays Main's existing {component, revision, locator}; no second report API.
// Post/reply roots identify their own object using [data-discussion-object][data-resource].
// These tests never send user messages. Success requests use real Main, never route.fulfill.
let corpus: CatalogueBrowserFixture;
let permitSubmission = false;
let reportWrites: ReportInput[] = [];
let deniedWrites: string[] = [];
let messages: string[] = [];
const t = textFor('en');
test.use({ actionTimeout: 15_000 });
test.beforeAll(async () => { corpus = await catalogueBrowserFixture(); });
test.beforeEach(async ({ context }) => {
  await context.clearCookies();
  permitSubmission = false;
  reportWrites = [];
  deniedWrites = [];
  messages = await forbidMessages(context);
  await context.route(url => url.pathname === '/api/main/v1/public-reports', async route => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    const input = route.request().postDataJSON() as ReportInput;
    reportWrites.push(input);
    const ownedTargets = [corpus.reporting.subject.id, corpus.reporting.post.id, corpus.reporting.reply.id];
    if (!permitSubmission || !ownedTargets.includes(input.target)) {
      deniedWrites.push(input.target);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
});
test.afterEach(() => {
  expect(messages, 'No messages or case correspondence may be sent').toEqual([]);
  expect(deniedWrites, 'Only an explicitly submitted owned fixture report may cross Main').toEqual([]);
});

function owner(page: Page, target: ReportTarget) {
  if (target.owner === 'subject') return header(page);
  const id = target.owner === 'post' ? corpus.reporting.post.id : corpus.reporting.reply.id;
  return page.locator(`main [data-discussion-object][data-resource="${id}"]`);
}

function opener(page: Page, target: ReportTarget) {
  return owner(page, target).getByRole('button', {
    name: target.owner === 'subject' ? `More actions for ${corpus.reporting.subject.title}` : `More actions for ${target.owner}`,
    exact: true,
  });
}

async function chooseMenuByKeyboard(page: Page, item: Locator) {
  await page.keyboard.press('Home');
  for (let index = 0; index < 20; index++) {
    if (await item.evaluate(element => element === document.activeElement)) {
      await page.keyboard.press('Enter');
      return;
    }
    await page.keyboard.press('ArrowDown');
  }
  throw new Error('Report is not reachable in the owning overflow menu');
}

async function selectTarget(page: Page, target: ReportTarget, keyboard = false) {
  const more = opener(page, target);
  if (keyboard) {
    await tabTo(page, more);
    await page.keyboard.press('Enter');
  } else await more.click();
  const menu = page.getByRole('menu');
  await expect(menu).toHaveCount(1);
  const report = menu.getByRole('menuitem', { name: 'Report', exact: true });
  if (keyboard) await chooseMenuByKeyboard(page, report);
  else await report.click();
  const dialog = page.getByRole('dialog', { name: 'Choose what to report', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(target.excerpt);
  const radio = dialog.getByRole('radio', { name: target.label, exact: true });
  if (keyboard) {
    await tabTo(page, radio);
    await page.keyboard.press('Space');
    await expect(radio).toBeChecked();
    const next = dialog.getByRole('button', { name: 'Continue', exact: true });
    await tabTo(page, next);
    await page.keyboard.press('Enter');
  } else {
    // Label clicks work for both native and Ark radio groups.
    await dialog.getByText(target.label, { exact: true }).click();
    await expect(radio).toBeChecked();
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  }
  await expect(page.getByRole('form', { name: t.title, exact: true })).toBeVisible();
  assertAddress(page, target);
  await expect(page.getByLabel(t.targetLabel, { exact: true })).toHaveValue(target.target);
  if (target.selection) {
    const summary = page.getByRole('region', { name: 'Selected content', exact: true });
    await expect(summary).toContainText(target.label);
    await expect(summary).toContainText(target.excerpt);
  }
}

function assertAddress(page: Page, target: ReportTarget) {
  const url = new URL(page.url());
  expect(url.pathname).toBe('/en/report');
  expect(url.searchParams.get('target')).toBe(target.target);
  expect(url.searchParams.get('component')).toBe(target.selection?.component ?? null);
  expect(url.searchParams.get('revision')).toBe(target.selection?.revision ?? null);
  expect(url.searchParams.get('locator')).toBe(target.selection?.locator ?? null);
}

test('C22 C26 / visitor / subject post and each reply have one owning overflow and no resting Report controls', async ({ page }) => {
  await publicSubject(page, corpus.reporting.subject);
  const root = page.locator('main');
  await expect(root.getByRole('button', { name: /^Report(?:\s|$)/ })).toHaveCount(0);
  await expect(root.getByRole('link', { name: /^Report(?:\s|$)/ })).toHaveCount(0);
  await expect(header(page).getByRole('button', { name: `More actions for ${corpus.reporting.subject.title}`, exact: true })).toHaveCount(1);
  for (const [object, kind] of [[corpus.reporting.post, 'post'], [corpus.reporting.reply, 'reply'], [corpus.reporting.secondReply, 'reply']] as const) {
    const row = root.locator(`[data-discussion-object][data-resource="${object.id}"]`);
    await expect(row).toContainText(object.text);
    const more = row.getByRole('button', { name: `More actions for ${kind}`, exact: true });
    await expect(more).toHaveCount(1);
    await more.click();
    await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Report', exact: true })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
  }
  expect(reportWrites).toEqual([]);
});

test('C22 / visitor keyboard / overflow and component picker dismiss and restore focus without submitting', async ({ page }) => {
  const target = corpus.reporting.targets.find(item => item.selection?.component === 'cover')!;
  await publicSubject(page, corpus.reporting.subject);
  const more = opener(page, target);
  await tabTo(page, more);
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(more).toBeFocused();
  await page.keyboard.press('Enter');
  await chooseMenuByKeyboard(page, page.getByRole('menuitem', { name: 'Report', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'Choose what to report', exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(element => element.contains(document.activeElement)), 'Tab stays in the target picker').toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
  await page.keyboard.press('Enter');
  await chooseMenuByKeyboard(page, page.getByRole('menuitem', { name: 'Report', exact: true }));
  await tabTo(page, dialog.getByRole('button', { name: 'Cancel', exact: true }));
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
  expect(reportWrites).toEqual([]);
});

test.describe('C22 / visitor touch at 390', () => {
  // The project's mobile file filter excludes new journeys; explicit context
  // options run this case in the ordinary desktop-chrome prove selection too.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('touch opens the owning menu, outside dismissal and Cancel restore its focus', async ({ page }) => {
    const target = corpus.reporting.targets.find(item => item.owner === 'reply' && !item.selection)!;
    await publicSubject(page, corpus.reporting.subject);
    const more = opener(page, target);
    await more.tap();
    await expect(page.getByRole('menuitem', { name: 'Report', exact: true })).toBeVisible();
    await header(page).getByRole('heading', { level: 1 }).tap();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await more.tap();
    await page.getByRole('menuitem', { name: 'Report', exact: true }).tap();
    const dialog = page.getByRole('dialog', { name: 'Choose what to report', exact: true });
    await expect(dialog).toContainText(corpus.reporting.reply.text);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).tap();
    await expect(dialog).toHaveCount(0);
    await expect(more).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(reportWrites).toEqual([]);
  });
});

const targetCases = [
  { name: 'whole subject', owner: 'subject', component: null },
  { name: 'whole post', owner: 'post', component: null },
  { name: 'whole reply', owner: 'reply', component: null },
  { name: 'cover revision', owner: 'subject', component: 'cover' },
  { name: 'synopsis revision', owner: 'subject', component: 'synopsis' },
  { name: 'body content revision', owner: 'post', component: 'body' },
  { name: 'embedded media exact locator', owner: 'reply', component: 'media_use' },
] as const;

async function assertActualSelection(page: Page, target: ReportTarget) {
  const selection = target.selection;
  if (!selection) return;
  const main = catalogueApi(page);
  const query = { actingSubject: corpus.reporting.actingSubject };
  if (selection.component === 'cover' || selection.component === 'synopsis') {
    const work = await apiData(main.v1.works({ id: short(target.target) }).get({ query }), 'owned selected Work component');
    if (selection.component === 'cover') expect(work.cover).toMatchObject({ kind: 'image', selection: selection.revision });
    else {
      expect(work.metadataRevision).toBe(selection.revision);
      expect(work.description?.value).toContain(target.excerpt);
    }
    expect(selection.locator).toBeNull();
    return;
  }
  const content = await apiData(main.v1['content-revisions']({ revision: short(selection.revision) }).get({ query }), 'owned exact content revision');
  expect(content.reference.revisionId).toBe(selection.revision);
  const bytes = Buffer.from(content.serializedJson);
  expect(content.reference.byteLength).toBe(bytes.length);
  expect(content.reference.byteDigest).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(JSON.parse(content.serializedJson)).toEqual(content.body);
  if (selection.component === 'body') expect(documentText(content.body)).toContain(target.excerpt);
  else expect(documentMediaUses(content.body)).toContain(selection.locator);
}

for (const choice of targetCases) test(`C22 / isolated owner / ${choice.name} selection reaches the real report receipt`, async ({ page }) => {
  const target = corpus.reporting.targets.find(item => item.owner === choice.owner && (item.selection?.component ?? null) === choice.component);
  expect(target, `${choice.name} command-created fixture prerequisite`).toBeDefined();
  await signInAtAccounts(page, corpus.reporting.subject.href, credentials().member);
  const query = { actingSubject: corpus.reporting.actingSubject };
  const projection = await apiData(catalogueApi(page).v1.resources({ resource: short(corpus.reporting.subject.id) }).page.get({ query }), 'owned report subject');
  expect(projection.summary.reference).toBe(corpus.reporting.subject.id);
  const post = await apiData(catalogueApi(page).v1.posts({ id: short(corpus.reporting.post.id) }).get({ query }), 'owned report Post');
  expect(post.publisher).toBe(corpus.reporting.actingSubject);
  await assertActualSelection(page, target!);
  await selectTarget(page, target!, true);
  const form = page.getByRole('form', { name: t.title, exact: true });
  const category = form.getByRole('radio', { name: /^Spam or manipulation/ });
  await tabTo(page, category);
  await page.keyboard.press('Space');
  await expect(category).toBeChecked();
  const statement = `Isolated acceptance fixture: verify the selected ${choice.name}.`;
  await form.getByLabel(t.statementLabel, { exact: true }).fill(statement);
  const send = form.getByRole('button', { name: t.submit, exact: true });
  await expect(send).toBeEnabled();
  const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/main/v1/public-reports'
    && response.request().method() === 'POST');
  permitSubmission = true;
  await tabTo(page, send);
  await page.keyboard.press('Enter');
  const response = await received;
  expect(response.status()).toBe(201);
  const input = response.request().postDataJSON() as ReportInput;
  expect(input).toMatchObject({ profile: 'public-report-v1', target: target!.target,
    category: 'spam_or_manipulation', statement });
  expect(input.selection).toEqual(target!.selection);
  expect(response.request().headers()['idempotency-key']).toBeTruthy();
  const receipt = await response.json() as ReportReceipt;
  expect(receipt.replayed).toBe(false);
  expect(receipt.caseId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page).toHaveURL(url => url.pathname === `/en/report/${receipt.caseId}` && url.hash === `#${receipt.credential}`);
  await expect(page.getByRole('heading', { level: 1, name: t.statusTitle, exact: true })).toBeVisible();
  await page.reload();
  const status = await apiData(catalogueApi(page).v1['public-reports']({ caseId: receipt.caseId }).get({
    headers: { 'x-rezics-case-credential': receipt.credential },
  }), 'real private report case');
  expect(status.caseId).toBe(receipt.caseId);
  expect(status.notice.statement).toBe(statement);
  expect(status.category).toBe('spam_or_manipulation');
  expect(reportWrites).toHaveLength(1);
});

test('C22 / visitor to isolated member / login preserves exact component revision locator and return locale', async ({ page }) => {
  const target = corpus.reporting.targets.find(item => item.selection?.component === 'media_use')!;
  await publicSubject(page, corpus.reporting.subject);
  await selectTarget(page, target, true);
  const returnTo = new URL(page.url()).pathname + new URL(page.url()).search;
  const login = page.getByRole('link', { name: 'Sign in', exact: true });
  await expect(login).toBeVisible();
  const href = await login.getAttribute('href');
  expect(href).toBeTruthy();
  const start = new URL(href!, page.url());
  expect(start.pathname).toBe('/auth/start');
  expect(start.searchParams.get('next')).toBe(returnTo);
  // Reuse the approved Accounts flow with the exact next extracted from the
  // actual login control. Its canonical redirect matcher preserves path tails.
  await signInAtAccounts(page, start.searchParams.get('next')!, credentials().member);
  assertAddress(page, target);
  const selected = page.getByRole('region', { name: 'Selected content', exact: true });
  await expect(selected).toContainText(target.label);
  await expect(selected).toContainText(target.excerpt);
  await page.reload();
  assertAddress(page, target);
  await expect(selected).toContainText(target.excerpt);
  expect(reportWrites).toEqual([]);
});

test('C22 / visitor / editing the target clears the previous exact selection before any report is sent', async ({ page }) => {
  const target = corpus.reporting.targets.find(item => item.selection?.component === 'synopsis')!;
  await publicSubject(page, corpus.reporting.subject);
  await selectTarget(page, target);
  const control = page.getByLabel(t.targetLabel, { exact: true });
  await control.fill(corpus.reporting.reply.id);
  await expect(page.getByRole('region', { name: 'Selected content', exact: true })).toHaveCount(0);
  await expect(control).toHaveValue(corpus.reporting.reply.id);
  expect(reportWrites).toEqual([]);
});
