import { expect } from 'bun:test';
import type { Page } from 'playwright';
import { m } from '../../src/paraglide/messages.js';
import { candidateContext } from '../../src/subject/candidates';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';
import {
  createCatalogueProviderReviewFixture,
  providerReviewSource,
  readProviderReviewPage,
  type CatalogueProviderReviewFixture,
} from './catalogue-provider-review-fixture.ts';

let fixture: CatalogueProviderReviewFixture | undefined;
const lifecycle = new NativeTestLifecycle('provider queue return');

nativeBeforeAll(lifecycle, 360_000, async () => {
  fixture = await createCatalogueProviderReviewFixture({ bookCount: 22 });
});
nativeAfterAll(lifecycle, 240_000);

function pageFor(journey: Awaited<ReturnType<CatalogueProviderReviewFixture['auth']['signIn']>>): Page {
  const page = journey.context.pages().at(-1);
  if (!page) throw new Error('Auth did not keep the served browser page open');
  return page;
}

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function chooseContext(page: Page): Promise<void> {
  const current = fixture!;
  await page.getByLabel('Search Contexts').fill(current.context.label.slice(0, 13));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const choose = page.getByRole('button', { name: 'Choose', exact: true }).first();
    try {
      await choose.waitFor({ state: 'visible', timeout: 2_000 });
      await choose.click();
      await page.getByText(`Selected Context: ${current.context.label}`).waitFor({ timeout: 5_000 });
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error('Named Context choice did not resolve through the served directory');
}

async function chooseGlobal(page: Page): Promise<void> {
  await page.getByRole('button', { name: m.prq_global(), exact: true }).click();
  await page.getByText(m.provider_scope_selected({ label: m.prq_global() }), { exact: true }).waitFor();
}

async function waitForRows(page: Page): Promise<void> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if ((await page.getByRole('checkbox').count()) > 0) return;
    for (const label of [m.prq_prepare(), m.prq_continue(), m.prq_retry()]) {
      const button = page.getByRole('button', { name: label, exact: true });
      if ((await button.count()) && (await button.isEnabled())) {
        await button.click();
        break;
      }
    }
    await Bun.sleep(500);
  }
  throw new Error('The native provider queue did not present a candidate page');
}

async function exactPage(stack: CatalogueProviderReviewFixture['stack'], cursor: string) {
  const query = new URLSearchParams({
    source: providerReviewSource,
    context: fixture!.context.id,
    status: 'pending',
    limit: '20',
    cursor,
  });
  const response = await stack.kernel(`/v1/review-candidates?${query}`, {}, 'alice');
  expect(response.status).toBe(200);
  return (await response.json()) as {
    candidates: {
      subject: string;
      candidate: { id: string; statement: { property: { id: string }; value: { content: string } } };
    }[];
  };
}

nativeTest(
  'a second-page exact review accepts and selects independently, then rereads the scoped queue',
  900_000,
  async () => {
    const current = fixture!;
    const alice = await current.auth.signIn('alice');
    const page = pageFor(alice);
    page.setDefaultTimeout(30_000);
    const opened = await page.goto(`${current.stack.web}/en/imports/review`, { waitUntil: 'domcontentloaded' });
    expect(opened?.status()).toBe(200);
    await hydrate(page);
    await chooseContext(page);
    await page.getByLabel(m.prq_source()).fill(providerReviewSource);
    await page.getByRole('button', { name: m.prq_load(), exact: true }).click();
    await waitForRows(page);

    const first = await readProviderReviewPage(current.stack, 'alice', current.context.id);
    expect(first.status).toBe(200);
    expect(typeof first.body.next).toBe('string');
    const next = first.body.next as string;
    const second = await exactPage(current.stack, next);
    expect(second.candidates.length).toBeGreaterThan(0);
    const target = second.candidates[0]!;
    const book = current.books.find((entry) => entry.id === target.subject)!;
    expect(book).toBeDefined();

    await page.getByRole('button', { name: m.prq_next(), exact: true }).click();
    await page.getByText(book.title, { exact: true }).waitFor();
    await page.getByRole('link', { name: m.prq_open_candidate(), exact: true }).first().click();
    await page.waitForURL(/\/edit\?/);
    const reviewUrl = new URL(page.url());
    expect(reviewUrl.searchParams.get('reviewProperty')).toBe(target.candidate.statement.property.id);
    expect(reviewUrl.searchParams.get('candidate')).toBe(target.candidate.id);
    expect(reviewUrl.searchParams.get('context')).toBe(current.context.id);
    expect(reviewUrl.searchParams.get('returnTo')).toBe('queue');

    const review = page.getByRole('region', { name: m.candidate_title(), exact: true });
    const item = review.locator('[data-candidate-item]');
    await item.waitFor({ state: 'visible' });
    await review.getByRole('button', { name: m.candidate_accept(), exact: true }).click();
    await review.getByRole('button', { name: m.candidate_accept(), exact: true }).last().click();
    await page.getByRole('button', { name: m.candidate_reload(), exact: true }).waitFor();

    const candidateRead = await current.stack.kernel(
      `/v1/subjects/${target.subject}/candidates?${new URLSearchParams({
        property: target.candidate.statement.property.id,
        context: current.context.id,
        limit: '20',
      })}`,
      {},
      'alice',
    );
    expect(candidateRead.status).toBe(200);
    const candidates = (await candidateRead.json()) as { candidates: { id: string; decision: string | null }[] };
    expect(candidates.candidates.find((entry) => entry.id === target.candidate.id)?.decision).toBe('accepted');

    await page.getByRole('button', { name: m.candidate_reload(), exact: true }).click();
    await item.waitFor({ state: 'visible' });
    const choice = review.locator(`#include-${target.candidate.id}`);
    await choice.waitFor({ state: 'visible' });
    if (!(await choice.isChecked())) await choice.click();
    await review.getByRole('button', { name: m.context_adopt(), exact: true }).click();
    await review.getByRole('button', { name: m.context_adopt(), exact: true }).last().click();
    await page.getByText(m.context_saved(), { exact: true }).waitFor();

    const readingResponse = await current.stack.kernel(
      `/v1/subjects/${target.subject}?context=${encodeURIComponent(current.context.id)}`,
      {},
      'alice',
    );
    expect(readingResponse.status).toBe(200);
    const reading = (await readingResponse.json()) as {
      subject: { statements: Record<string, { id: string; value: { content: string } }[]> };
    };
    expect(
      reading.subject.statements[target.candidate.statement.property.id]?.some((row) => row.id === target.candidate.id),
    ).toBe(true);

    await page.getByRole('link', { name: m.prq_return_to_queue(), exact: true }).click();
    await page.waitForURL(/\/imports\/review/);
    await page.getByText(m.prq_return_moved(), { exact: true }).waitFor();
    await page.getByText(book.title, { exact: true }).waitFor({ state: 'detached' });

    await current.stack.syncKernelRequests();
    await page.getByLabel(m.prq_status()).selectOption('accepted_unselected');
    await page.getByRole('button', { name: m.prq_load(), exact: true }).click();
    await page.getByText(m.prq_empty(), { exact: true }).waitFor();
    await current.stack.syncKernelRequests();
    const queueReads = current.stack.kernelRequests().filter((request) => {
      if (request.fixtureRequest || request.method !== 'GET') return false;
      const url = new URL(request.url, current.stack.kernelOrigin);
      return url.pathname === '/v1/review-candidates' && url.searchParams.get('status') === 'accepted_unselected';
    });
    expect(queueReads.length).toBeGreaterThan(0);
    expect(new URL(queueReads.at(-1)!.url, current.stack.kernelOrigin).searchParams.has('cursor')).toBe(false);
    await page.close();
  },
);

nativeTest(
  'Global accepted candidate is deliberately selected by a separate editor and returns to its bounded frontier',
  900_000,
  async () => {
    const current = fixture!;
    const book = current.books[0]!;
    const alice = await current.auth.signIn('alice');
    const reviewerPage = pageFor(alice);
    reviewerPage.setDefaultTimeout(30_000);
    await reviewerPage.goto(`${current.stack.web}/en/imports/review`, { waitUntil: 'domcontentloaded' });
    await hydrate(reviewerPage);
    await chooseGlobal(reviewerPage);
    await reviewerPage.getByLabel(m.prq_source()).fill(providerReviewSource);
    await reviewerPage.getByRole('button', { name: m.prq_load(), exact: true }).click();
    await waitForRows(reviewerPage);
    await reviewerPage.getByRole('checkbox', { name: new RegExp(book.title) }).click();
    await reviewerPage.getByRole('button', { name: m.candidate_accept(), exact: true }).click();
    await reviewerPage.getByRole('button', { name: m.candidate_accept(), exact: true }).last().click();
    await reviewerPage.getByText('Accepted. Review public selection separately.').waitFor();

    const accepted = await readProviderReviewPage(current.stack, 'editor', candidateContext, 'accepted_unselected');
    expect(accepted.status).toBe(200);
    const acceptedRows = accepted.body.candidates as {
      subject: string;
      candidate: { id: string; statement: { property: { id: string } } };
    }[];
    expect(acceptedRows.length).toBeGreaterThan(0);
    expect(acceptedRows.length).toBeLessThanOrEqual(20);
    const exact = acceptedRows.find((row) => row.subject === book.id && row.candidate.id === book.candidate);
    expect(exact).toBeDefined();

    const editor = await current.auth.signIn('editor');
    const page = pageFor(editor);
    page.setDefaultTimeout(30_000);
    const concurrentEditor = await current.auth.signIn('editor');
    const concurrentPage = pageFor(concurrentEditor);
    concurrentPage.setDefaultTimeout(30_000);
    for (const targetPage of [page, concurrentPage]) {
      await targetPage.goto(`${current.stack.web}/en/imports/review`, { waitUntil: 'domcontentloaded' });
      await hydrate(targetPage);
      await chooseGlobal(targetPage);
      await targetPage.getByLabel(m.prq_source()).fill(providerReviewSource);
      await targetPage.getByLabel(m.prq_status()).selectOption('accepted_unselected');
      await targetPage.getByRole('button', { name: m.prq_load(), exact: true }).click();
      const exactLink = targetPage.getByRole('link', { name: m.prq_open_candidate(), exact: true }).first();
      await exactLink.waitFor({ state: 'visible' });
      await exactLink.click();
      await targetPage.waitForURL(/\/edit\?/);
    }

    const address = new URL(page.url());
    expect(address.searchParams.get('reviewProperty')).toBe('schema:inLanguage');
    expect(address.searchParams.get('candidate')).toBe(book.candidate);
    expect(address.searchParams.get('context')).toBe(candidateContext);
    expect(address.searchParams.get('returnTo')).toBe('queue');
    const review = page.getByRole('region', { name: m.candidate_title(), exact: true });
    expect(await review.getByRole('button', { name: m.candidate_reject(), exact: true }).isDisabled()).toBe(true);
    expect(await review.getByRole('button', { name: m.candidate_adopt(), exact: true }).isDisabled()).toBe(false);
    expect(await review.locator('#context-mode').count()).toBe(0);
    const sourceReference = `https://openlibrary.org/works/${book.externalId}`;
    await review.locator(`a[href="${sourceReference}"]`).waitFor({ state: 'visible' });
    const include = review.locator(`#include-${book.candidate}`);
    await include.click();
    const concurrentReview = concurrentPage.getByRole('region', { name: m.candidate_title(), exact: true });
    await concurrentReview.locator(`#include-${book.candidate}`).click();
    await concurrentReview.getByRole('button', { name: m.candidate_adopt(), exact: true }).click();
    await concurrentReview.getByText(m.candidate_confirm_head({ head: '—' }), { exact: true }).waitFor();
    await review.getByRole('button', { name: m.candidate_adopt(), exact: true }).click();
    await review.getByRole('button', { name: m.candidate_adopt(), exact: true }).last().click();
    await review.getByText(m.candidate_selection_confirmed(), { exact: true }).waitFor();
    await review.getByRole('link', { name: m.candidate_view_public(), exact: true }).waitFor();
    const currentSelection = review.locator('[data-candidate-panel="current"]');
    await currentSelection
      .getByText(m.candidate_statement_identity({ id: book.candidate }), { exact: true })
      .waitFor();
    await currentSelection.locator(`a[href="${sourceReference}"]`).waitFor({ state: 'visible' });

    await concurrentReview.getByRole('button', { name: m.candidate_adopt(), exact: true }).last().click();
    await concurrentReview.getByRole('alert').getByText(m.candidate_draft_stale(), { exact: true }).waitFor();
    await concurrentReview.getByRole('alert').getByRole('button', { name: m.candidate_reload(), exact: true }).click();
    await concurrentReview
      .locator('[data-candidate-panel="current"]')
      .getByText(m.candidate_statement_identity({ id: book.candidate }), { exact: true })
      .waitFor();
    await concurrentReview.getByRole('button', { name: m.candidate_adopt(), exact: true }).click();
    await concurrentReview.getByText(m.candidate_confirm_head({ head: '1' }), { exact: true }).waitFor();
    await concurrentReview.getByRole('button', { name: m.candidate_adopt(), exact: true }).last().click();
    await concurrentReview.getByText(m.candidate_selection_confirmed(), { exact: true }).waitFor();

    const publicRead = await current.stack.kernel(`/v1/subjects/${book.id}`, {}, 'anonymous');
    expect(publicRead.status).toBe(200);
    const publicSubject = (await publicRead.json()) as {
      subject: { statements: Record<string, { id: string; rank: string; value: { content: string } }[]> };
    };
    const selected = publicSubject.subject.statements['schema:inLanguage'] ?? [];
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ id: book.candidate, rank: 'normal', value: { content: book.language } });

    await concurrentPage.getByRole('link', { name: m.prq_return_to_queue(), exact: true }).click();
    await concurrentPage.waitForURL(/\/imports\/review/);
    await concurrentPage.getByText(m.prq_return_moved(), { exact: true }).waitFor();
    expect(await concurrentPage.getByLabel(m.prq_source()).inputValue()).toBe(providerReviewSource);
    expect(await concurrentPage.getByLabel(m.prq_status()).inputValue()).toBe('accepted_unselected');
    await concurrentPage.getByText(m.provider_scope_selected({ label: m.prq_global() }), { exact: true }).waitFor();
    expect(await concurrentPage.getByRole('link', { name: m.prq_open_candidate(), exact: true }).count()).toBe(0);
    await page.close();
    await concurrentPage.close();
    await reviewerPage.close();
  },
);
