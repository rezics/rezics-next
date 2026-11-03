import { expect } from 'bun:test';
import type { Page } from 'playwright';
import { m } from '../../src/paraglide/messages.js';
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
