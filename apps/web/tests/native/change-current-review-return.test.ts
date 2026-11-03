import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { expect as pageExpect } from 'playwright/test';
import { m } from '../../src/paraglide/messages.js';
import { candidateContext } from '../../src/subject/candidates.ts';
import { startCatalogueChangesFixture, type CatalogueChangesFixture } from './catalogue-changes-fixture.ts';

let fixture: CatalogueChangesFixture;
beforeAll(async () => {
  fixture = await startCatalogueChangesFixture({ multipleSelection: true });
}, 300_000);
afterAll(async () => fixture && fixture.close(), 180_000);

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function selectRevision(page: Page, revision: number): Promise<void> {
  const button = page.getByRole('button', { name: new RegExp(`Revision ${revision}(?!\\d)`) });
  await pageExpect(button).toBeVisible();
  await button.click();
  await pageExpect(
    page.getByRole('heading', { name: m.changes_revision({ revision: String(revision) }) }),
  ).toBeVisible();
}

async function openChanges(page: Page): Promise<void> {
  await page.goto(`${fixture.stack.web}${fixture.path}/changes`, { waitUntil: 'domcontentloaded' });
  await hydrate(page);
  await pageExpect(page.locator('[data-slot="subject-changes"]')).toBeVisible();
}

test('an adoption row opens only its exact current candidate and safely returns after a concealed read', async () => {
  const current = fixture;
  const signedIn = await current.auth.signIn('alice');
  const page = signedIn.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  await openChanges(page);
  const changes = page.locator('[data-slot="subject-changes"]');
  await selectRevision(page, current.multiAdoption!);

  const reviewLinks = changes.getByRole('link', { name: m.changes_review_current(), exact: true });
  await pageExpect(reviewLinks).toHaveCount(2);
  const exact = new URL((await reviewLinks.nth(1).getAttribute('href'))!, current.stack.web);
  expect(exact.searchParams.get('reviewProperty')).toBe('schema:inLanguage');
  expect(exact.searchParams.get('candidate')).toBe(current.multiCandidates![1]);
  expect(exact.searchParams.get('context')).toBe(candidateContext);
  expect(exact.searchParams.get('returnTo')).toBe('changes');

  await reviewLinks.nth(1).click();
  await page.waitForURL(/\/edit\?/);
  const review = page.getByRole('region', { name: m.candidate_title(), exact: true });
  await review.locator('[data-candidate-item]').waitFor({ state: 'visible' });
  const exactChoice = review.locator(`#include-${current.multiCandidates![1]}`);
  await exactChoice.waitFor({ state: 'visible' });
  expect(await exactChoice.isChecked()).toBe(true);
  await page.getByRole('link', { name: m.changes_return_to_changes(), exact: true }).click();
  await page.waitForURL(/\/changes/);
  await selectRevision(page, current.multiAdoption!);
  await pageExpect(
    changes.getByRole('button', { name: m.changes_revision({ revision: String(current.multiAdoption!) }) }),
  ).toHaveAttribute('aria-pressed', 'true');

  await current.stack.injectKernelFailureOnce({
    method: 'GET',
    path: `/v1/subjects/${current.id}/candidates`,
    status: 404,
    body: JSON.stringify({
      type: 'https://rezics.com/problems/not_found',
      title: 'Not found',
      status: 404,
      code: 'not_found',
      detail: 'CONCEALED CANDIDATE BODY',
      request_id: crypto.randomUUID(),
    }),
  });
  await changes.getByRole('link', { name: m.changes_review_current(), exact: true }).nth(1).click();
  await page.waitForURL(/\/edit\?/);
  const unavailable = page.getByRole('region', { name: m.candidate_title(), exact: true });
  await unavailable.getByRole('alert').filter({ hasText: m.candidate_unavailable() }).waitFor();
  await page.getByRole('link', { name: m.changes_return_to_changes(), exact: true }).click();
  await page.waitForURL(/\/changes/);
  await selectRevision(page, current.multiAdoption!);
  await pageExpect(page.getByText('CONCEALED CANDIDATE BODY', { exact: false })).toHaveCount(0);
  await pageExpect(changes.getByRole('link', { name: m.changes_review_current(), exact: true })).toHaveCount(2);
  await page.close();
});
