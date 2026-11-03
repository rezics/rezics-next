import { afterAll, expect } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Page } from 'playwright';
import {
  startCatalogueContributionFixture,
  type CatalogueContributionRecord,
  type NativeCatalogueContributionFixture,
} from './catalogue-contribution-fixture.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';

const lifecycle = new NativeTestLifecycle('native catalogue contribution suite');
let fixture: NativeCatalogueContributionFixture;

nativeBeforeAll(lifecycle, 360_000, async () => {
  fixture = await startCatalogueContributionFixture();
});
afterAll(async () => {
  await fixture?.close();
}, 180_000);
nativeAfterAll(lifecycle, 180_000);

async function pageReady(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
}

async function openReviewedContribution(page: Page, record: CatalogueContributionRecord): Promise<void> {
  await page.goto(new URL(record.href, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
  await pageReady(page);
  const review = page.getByRole('region', { name: 'Proposals' });
  await review.scrollIntoViewIfNeeded();
  const open = review.getByRole('button', { name: 'Review proposals', exact: true });
  if (await open.isVisible()) await open.click();
  await review.locator('#candidate-field').selectOption('schema:url');
  await browserExpect(review.getByRole('button', { name: 'Review suggestion', exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Review suggestion', exact: true }).click();
  await browserExpect(review.getByRole('button', { name: 'Withdraw contribution', exact: true })).toBeVisible();
}

async function confirmContribution(
  page: Page,
  action: 'Withdraw contribution' | 'Restore contribution',
): Promise<void> {
  const review = page.getByRole('region', { name: 'Proposals' });
  const response = page.waitForResponse(
    (result) => result.request().method() === 'POST' && result.url().includes('_serverFn'),
  );
  await review.getByRole('button', { name: action, exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  expect((await response).status()).toBeLessThan(400);
  await fixture.stack.syncKernelRequests();
  await fixture.stack.refreshKernelRequests();
}

function userLifecycleRequests(from: number) {
  return fixture.stack
    .kernelRequests()
    .slice(from)
    .filter(
      (request) => !request.fixtureRequest && (request.method === 'DELETE' || request.url.includes('restoreDeleted')),
    );
}

nativeTest(
  'the original author deletes and restores from the candidate reader through the session BFF; subject creation, citations and adoption do not confer that authority',
  300_000,
  async () => {
    const record = await fixture.provision();
    expect(JSON.stringify(await fixture.current(record.subject, 'alice'))).toContain(record.payload);

    const bobPage = await fixture.bob.context.newPage();
    bobPage.setDefaultTimeout(30_000);
    await openReviewedContribution(bobPage, record);
    await confirmContribution(bobPage, 'Withdraw contribution');
    await browserExpect(bobPage.getByRole('alert').filter({ hasText: 'cannot perform this action' })).toBeVisible();
    expect(JSON.stringify(await fixture.current(record.subject, 'alice'))).toContain(record.payload);
    await bobPage.close();

    const alicePage = await fixture.alice.context.newPage();
    alicePage.setDefaultTimeout(30_000);
    await openReviewedContribution(alicePage, record);
    const beforeDelete = fixture.stack.kernelRequests().length;
    await confirmContribution(alicePage, 'Withdraw contribution');
    await browserExpect(alicePage.getByRole('status').filter({ hasText: 'Contribution withdrawn' })).toBeVisible();
    await browserExpect(alicePage.getByText('confirms a deleted contribution')).toBeVisible();
    expect(JSON.stringify(await fixture.current(record.subject, 'alice'))).not.toContain(record.payload);
    expect(await fixture.candidates(record.subject, 'alice')).toContainEqual(
      expect.objectContaining({ id: record.candidate, deleted: true }),
    );
    expect(
      userLifecycleRequests(beforeDelete).some(
        (request) =>
          request.method === 'DELETE' &&
          request.url.includes(`/v1/subjects/${record.subject}/candidates/${record.candidate}`),
      ),
    ).toBe(true);

    const beforeRestore = fixture.stack.kernelRequests().length;
    await confirmContribution(alicePage, 'Restore contribution');
    await browserExpect(alicePage.getByRole('status').filter({ hasText: 'Restoration confirmed' })).toBeVisible();
    await browserExpect(alicePage.getByText('available in the current candidate read')).toBeVisible();
    await browserExpect(alicePage.getByText('not currently selected')).toBeVisible();
    expect(JSON.stringify(await fixture.current(record.subject, 'alice'))).not.toContain(record.payload);
    expect(await fixture.candidates(record.subject, 'alice')).toContainEqual(
      expect.objectContaining({ id: record.candidate }),
    );
    expect(
      (await fixture.candidates(record.subject, 'alice')).find((item) => item.id === record.candidate)?.deleted,
    ).toBeUndefined();
    expect(
      userLifecycleRequests(beforeRestore).some(
        (request) =>
          request.method === 'POST' &&
          request.url.includes(`${record.candidate}`) &&
          request.url.includes('restoreDeleted'),
      ),
    ).toBe(true);
    await alicePage.close();
  },
  lifecycle,
);
