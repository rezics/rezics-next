import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import { expect as playExpect } from 'playwright/test';
import { subjectHref } from '../../src/subject/subject-href.ts';
import {
  createNativeCatalogueRelationsFixture,
  createSubject,
  hydrate,
  readPublicStatements,
  readSlotCandidates,
  waitForSuggestion,
  type NativeCatalogueRelationsFixture,
  type NativeCatalogueSubject,
} from './catalogue-relations-fixture.ts';

setDefaultTimeout(900_000);
let fixture: NativeCatalogueRelationsFixture;

beforeAll(async () => {
  fixture = await createNativeCatalogueRelationsFixture();
}, 300_000);

afterAll(async () => fixture?.close(), 180_000);

const baseProperty = 'wdt:P8646';
const citation = 'https://example.org/addon-base-work';

async function chooseSubject(page: Page, label: string, subject: NativeCatalogueSubject): Promise<void> {
  const picker = page.getByRole('combobox', { name: label, exact: true });
  await picker.fill(subject.label);
  await playExpect(page.getByRole('option', { name: subject.label })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('option', { name: subject.label }).click();
}

async function confirmPropose(page: Page): Promise<void> {
  const group = page.getByRole('group', { name: 'Confirm: Propose relation' });
  if (!(await group.isVisible())) {
    await page.getByRole('button', { name: 'Propose relation', exact: true }).click();
    await playExpect(group).toBeVisible();
  }
  await group.getByRole('button', { name: 'Propose relation', exact: true }).click();
}

async function confirmAction(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
  const group = page.getByRole('group', { name: `Confirm: ${label}` });
  await playExpect(group).toBeVisible();
  await group.getByRole('button', { name: label, exact: true }).click();
}

describe('native add-on base-work workspace', () => {
  test('keeps route context separate, stages an explicit choice, and rereads accepted membership', async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const base = await createSubject(fixture.stack, 'schema:VideoGame', `Native add-on base ${marker}`);
    await waitForSuggestion(fixture.stack, base);

    const page = await fixture.alice.context.newPage();
    page.setDefaultTimeout(60_000);
    const creation = await page.goto(`${fixture.stack.web}/en/catalogue/addon?work=${encodeURIComponent(base.id)}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(creation?.status()).toBe(200);
    await hydrate(page);
    await playExpect(page.getByRole('heading', { name: 'Work query suggestion', exact: true })).toBeVisible();
    await playExpect(
      page.getByText('This exact readable work came from page context.', { exact: false }),
    ).toBeVisible();
    const creationPicker = page.getByRole('combobox', { name: 'Base work', exact: true });
    await playExpect(creationPicker).toHaveValue('');
    await chooseSubject(page, 'Base work', base);
    await playExpect(page.getByText('Staged for initial creation.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
    const discard = page.getByRole('group', { name: 'Confirm: Remove field' });
    await playExpect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await playExpect(creationPicker).toHaveValue('');
    const addonLabel = `Native add-on ${marker}`;
    const createStart = fixture.stack.kernelRequests().length;
    await page.getByLabel('Name', { exact: true }).fill(addonLabel);
    await page.getByRole('button', { name: 'Create subject', exact: true }).click();
    await playExpect(page.getByRole('link', { name: 'Open subject', exact: true })).toBeVisible();
    await fixture.stack.syncKernelRequests();
    const createPost = fixture.stack
      .kernelRequests()
      .slice(createStart)
      .find((request) => request.method === 'POST' && request.url === '/v1/subjects' && request.body);
    expect(createPost?.responseStatus).toBe(201);
    const createBody = JSON.parse(createPost!.body!);
    expect(createBody).toMatchObject({ type: 'wd:Q209163', labels: { en: addonLabel } });
    expect(createBody).not.toHaveProperty('statements');
    const createdRead = fixture.stack
      .kernelRequests()
      .slice(createStart)
      .findLast((request) => request.method === 'GET' && /^\/v1\/subjects\/[0-9a-f-]{36}$/i.test(request.url));
    expect(createdRead?.responseStatus).toBe(200);
    const addonId = createdRead!.url.slice('/v1/subjects/'.length);
    expect(await readPublicStatements(fixture.stack, addonId, baseProperty)).toEqual([]);
    await page.close();

    const addon = { id: addonId, type: 'wd:Q209163', label: addonLabel };
    const route = `${subjectHref(addon, 'en').href}/addon?work=${encodeURIComponent(base.id)}`;
    const correction = await fixture.alice.context.newPage();
    correction.setDefaultTimeout(60_000);
    const navigation = await correction.goto(`${fixture.stack.web}${route}`, { waitUntil: 'domcontentloaded' });
    expect(navigation?.status()).toBe(200);
    await hydrate(correction);

    await playExpect(correction.getByRole('heading', { name: 'Work query suggestion', exact: true })).toBeVisible();
    await playExpect(
      correction.getByRole('heading', { name: 'Current base-work membership', exact: true }),
    ).toBeVisible();
    await playExpect(
      correction.getByText('The current public read has no selected base-work statement.'),
    ).toBeVisible();
    expect(await readPublicStatements(fixture.stack, addon.id, baseProperty)).toEqual([]);

    const workspace = correction
      .getByRole('heading', { name: 'Choose a base work explicitly', exact: true })
      .locator('xpath=..');
    await workspace.getByRole('button', { name: 'Open relation editor', exact: true }).click();
    await playExpect(correction.getByLabel('Relation', { exact: true })).toHaveValue(baseProperty);
    await chooseSubject(correction, 'Target subject', base);
    await correction.getByLabel('Citation URL', { exact: true }).fill(citation);
    await correction.getByRole('button', { name: 'Add citation', exact: true }).click();
    await confirmPropose(correction);
    await playExpect(correction.getByRole('status').filter({ hasText: 'Relation proposed.' })).toBeVisible();
    await playExpect(correction.getByRole('heading', { name: 'Current public values', exact: true })).toBeVisible();
    await playExpect(correction.getByRole('heading', { name: 'Proposed value', exact: true })).toBeVisible();
    await playExpect(correction.getByText(citation, { exact: true })).toBeVisible();
    const candidates = await readSlotCandidates(fixture.stack, addon.id, { property: baseProperty, target: base.id });
    expect(candidates).toHaveLength(1);
    expect(await readPublicStatements(fixture.stack, addon.id, baseProperty)).toEqual([]);

    await confirmAction(correction, 'Accept suggestion');
    await playExpect(correction.getByRole('status').filter({ hasText: 'Suggestion accepted.' })).toBeVisible();
    expect(await readPublicStatements(fixture.stack, addon.id, baseProperty)).toEqual([]);

    await correction.getByRole('button', { name: 'Review suggestion', exact: true }).click();
    await confirmAction(correction, 'Select for public subject');
    await playExpect(correction.getByRole('status').filter({ hasText: 'This suggestion is selected' })).toBeVisible();
    const reread = await readPublicStatements(fixture.stack, addon.id, baseProperty);
    expect(reread).toHaveLength(1);
    expect(JSON.stringify(reread[0])).toContain(base.id);
    expect(JSON.stringify(reread[0])).toContain(citation);
    expect(addon.type).toBe('wd:Q209163');
    await correction.close();
  });
});
