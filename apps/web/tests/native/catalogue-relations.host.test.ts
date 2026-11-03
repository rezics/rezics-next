import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import { expect as playExpect } from 'playwright/test';
import {
  createNativeCatalogueRelationsFixture,
  hydrate,
  readPublicStatements,
  readSlotCandidates,
  type NativeCatalogueRelationsFixture,
} from './catalogue-relations-fixture.ts';

setDefaultTimeout(900_000);
let fixture: NativeCatalogueRelationsFixture;

beforeAll(async () => {
  fixture = await createNativeCatalogueRelationsFixture();
}, 300_000);

afterAll(async () => fixture?.close(), 180_000);

const voiceCredit = 'wdt:P725';
const citation = 'https://example.org/native-credits';

async function openEditor(page: Page): Promise<void> {
  const navigation = await page.goto(`${fixture.stack.web}${fixture.editorPath}`, { waitUntil: 'domcontentloaded' });
  expect(navigation?.status()).toBe(200);
  await hydrate(page);
  await page.getByRole('button', { name: 'Open relation editor', exact: true }).click();
  await playExpect(page.getByLabel('Relation', { exact: true })).toBeVisible();
}

async function pickSubject(page: Page, label: string, title: string): Promise<void> {
  const box = page.getByRole('combobox', { name: label, exact: true });
  await box.fill(title);
  await playExpect(page.getByRole('option', { name: title })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('option', { name: title }).click();
}

async function draftCredit(page: Page, roleLabel: string): Promise<void> {
  await page.getByLabel('Relation', { exact: true }).selectOption({ label: 'voice actor' });
  await pickSubject(page, 'Target subject', fixture.person.label);
  await page.getByLabel('Qualifier', { exact: true }).selectOption({ label: 'character role' });
  await page.getByRole('button', { name: 'Add a qualifier', exact: true }).click();
  await pickSubject(page, 'character role', roleLabel);
  await page.getByLabel('Citation URL', { exact: true }).fill(citation);
  await page.getByRole('button', { name: 'Add citation', exact: true }).click();
}

async function confirmPropose(page: Page): Promise<void> {
  const group = page.getByRole('group', { name: 'Confirm: Propose relation' });
  if (!(await group.isVisible())) {
    await page.getByRole('button', { name: 'Propose relation', exact: true }).click();
    await playExpect(group).toBeVisible();
  }
  await group.getByRole('button', { name: 'Propose relation', exact: true }).click();
}

function candidatePosts() {
  return fixture.stack.kernelRequests().filter((request) => {
    const path = request.url.split('?')[0];
    return request.method === 'POST' && path === `/v1/subjects/${fixture.movie.id}/candidates`;
  });
}

describe('native catalogue relation contribution', () => {
  test('the relation editor proposes a cited credit through the session BFF and recovers the exact slot', async () => {
    const page = await fixture.alice.context.newPage();
    page.setDefaultTimeout(60_000);
    await openEditor(page);
    await draftCredit(page, fixture.firstRole.label);

    await fixture.stack.injectKernelFailureOnce({
      method: 'POST',
      path: `/v1/subjects/${fixture.movie.id}/candidates`,
      status: 403,
      body: JSON.stringify({
        type: 'https://rezics.com/problems/forbidden',
        title: 'Forbidden',
        status: 403,
        code: 'forbidden',
      }),
    });
    await confirmPropose(page);
    await fixture.stack.syncKernelRequests();
    await playExpect(page.getByRole('alert')).toContainText('You do not have permission for this operation.');
    await playExpect(page.getByLabel('Relation', { exact: true })).toHaveValue(voiceCredit);
    await playExpect(page.getByRole('combobox', { name: 'Target subject', exact: true })).toHaveValue(
      fixture.person.label,
    );
    await playExpect(page.getByRole('combobox', { name: 'character role', exact: true })).toHaveValue(
      fixture.firstRole.label,
    );
    expect(await readPublicStatements(fixture.stack, fixture.movie.id, voiceCredit)).toEqual([]);

    await fixture.stack.injectKernelFailureOnce({
      method: 'POST',
      path: `/v1/subjects/${fixture.movie.id}/candidates`,
      status: 503,
      body: JSON.stringify({
        type: 'https://rezics.com/problems/overloaded',
        title: 'Overloaded',
        status: 503,
        code: 'overloaded',
      }),
    });
    await confirmPropose(page);
    await fixture.stack.syncKernelRequests();
    await playExpect(page.getByRole('alert')).toContainText('The result could not be confirmed.');
    const beforeRetry = candidatePosts();
    const uncertain = beforeRetry.at(-1);
    expect(uncertain?.failure?.status).toBe(503);
    expect(uncertain?.idempotencyKey).toBeTruthy();

    await confirmPropose(page);
    await playExpect(page.getByRole('status').filter({ hasText: 'Relation proposed.' })).toBeVisible();
    await fixture.stack.syncKernelRequests();
    const retried = candidatePosts().at(-1);
    expect(retried?.idempotencyKey).toBe(uncertain?.idempotencyKey);
    expect(retried?.failure).toBeUndefined();

    const firstSlot = { property: voiceCredit, target: fixture.person.id, key: fixture.firstRole.id };
    const first = await readSlotCandidates(fixture.stack, fixture.movie.id, firstSlot);
    expect(first).toHaveLength(1);
    await playExpect(page.getByRole('heading', { name: 'Review this slot', exact: true })).toBeVisible();
    await playExpect(page.getByText(fixture.firstRole.label, { exact: true }).first()).toBeVisible();
    expect(await readPublicStatements(fixture.stack, fixture.movie.id, voiceCredit)).toEqual([]);

    await pickSubject(page, 'character role', fixture.secondRole.label);
    await confirmPropose(page);
    await playExpect(page.getByRole('status').filter({ hasText: 'Relation proposed.' })).toBeVisible();
    const second = await readSlotCandidates(fixture.stack, fixture.movie.id, {
      property: voiceCredit,
      target: fixture.person.id,
      key: fixture.secondRole.id,
    });
    expect(second).toHaveLength(1);
    expect(second[0]?.id).not.toBe(first[0]?.id);
    expect(await readSlotCandidates(fixture.stack, fixture.movie.id, firstSlot)).toEqual(first);
    expect(await readPublicStatements(fixture.stack, fixture.movie.id, voiceCredit)).toEqual([]);
    expect(fixture.movie.type).toBe('schema:Movie');
    expect(fixture.person.type).toBe('schema:Person');
    expect(fixture.firstRole.type).toBe('wd:Q95074');
    await page.close();
  });
});
