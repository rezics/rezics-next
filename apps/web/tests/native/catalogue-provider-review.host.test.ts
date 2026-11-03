import { expect } from 'bun:test';
import type { Page } from 'playwright';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';
import {
  createCatalogueProviderReviewFixture,
  providerReviewSource,
  readProviderReviewPage,
  type CatalogueProviderReviewFixture,
} from './catalogue-provider-review-fixture.ts';

let fixture: CatalogueProviderReviewFixture | undefined;
const lifecycle = new NativeTestLifecycle('catalogue provider review');

nativeBeforeAll(lifecycle, 360_000, async () => {
  fixture = await createCatalogueProviderReviewFixture();
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

async function openReview(page: Page): Promise<void> {
  const current = fixture!;
  const response = await page.goto(`${current.stack.web}/en/imports/review`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  expect(response?.headers()['cache-control']).toMatch(/private|no-store/i);
  await hydrate(page);
  await page.getByRole('heading', { name: 'Import review queue' }).waitFor();
}

async function chooseNamedContext(page: Page): Promise<void> {
  const current = fixture!;
  const query = current.context.label.slice(0, 13);
  await page.getByLabel('Search Contexts').fill(query);
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

async function loadScope(page: Page): Promise<void> {
  await page.getByLabel('Provider').fill(providerReviewSource);
  await page.getByRole('button', { name: 'Show suggestions' }).click();
}

async function waitForSuggestions(page: Page): Promise<void> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if ((await page.getByRole('checkbox').count()) > 0) return;
    const empty = page.getByRole('status').filter({ hasText: 'No suggestions match this scope.' });
    if (await empty.count())
      throw new Error('Queue presented a complete empty page before native rows were available');
    for (const name of ['Prepare index', 'Continue', 'Retry'] as const) {
      const button = page.getByRole('button', { name, exact: true });
      if ((await button.count()) && (await button.isEnabled())) {
        await button.click();
        break;
      }
    }
    await Bun.sleep(500);
  }
  throw new Error('Scoped review queue did not present useful native rows');
}

async function confirmDecision(page: Page, operation: 'accept' | 'reject'): Promise<void> {
  await page
    .getByRole('button', { name: operation === 'accept' ? 'Accept suggestion' : 'Reject suggestion' })
    .click();
  const dialog = page.getByRole('alertdialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog
    .getByRole('button', { name: operation === 'accept' ? 'Confirm acceptance' : 'Confirm rejection' })
    .click();
  await page
    .getByText(operation === 'accept' ? 'Accepted. Review public selection separately.' : 'Rejected. The candidate was not deleted.')
    .waitFor();
}

async function bffQueueRequests() {
  const current = fixture!;
  await current.stack.syncKernelRequests();
  return current.stack.kernelRequests().filter((request) => {
    if (request.fixtureRequest) return false;
    const path = request.url.split('?')[0]!;
    return path === '/v1/review-candidates' || path === '/v1/review-candidates:prepare';
  });
}

nativeTest(
  'named Context review prepares real open-library suggestions and keeps accept independent of adoption',
  360_000,
  async () => {
    const current = fixture!;
    const before = await readProviderReviewPage(current.stack, 'alice', current.context.id);
    expect(before.status).toBe(503);
    expect(before.body).not.toHaveProperty('candidates');

    const alice = await current.auth.signIn('alice');
    const page = pageFor(alice);
    page.setDefaultTimeout(30_000);
    await openReview(page);
    await chooseNamedContext(page);
    await loadScope(page);
    await page.getByText('Suggestions are unavailable. Retry, or prepare the provider index explicitly.').waitFor();
    expect(await page.getByText('No suggestions match this scope.').count()).toBe(0);

    await waitForSuggestions(page);
    expect(await page.getByText('Open Library').count()).toBeGreaterThan(0);
    expect(await page.getByText(current.context.label).count()).toBeGreaterThan(0);
    expect(await page.getByText('Choose up to 20 visible suggestions.').count()).toBeGreaterThan(0);
    for (const book of current.books) await page.getByText(book.title).waitFor();

    const ready = await readProviderReviewPage(current.stack, 'alice', current.context.id);
    expect(ready.status).toBe(200);
    const pageBody = ready.body as {
      candidates: { subject: string; candidate: { id: string; source?: { source?: string } }; adoption: unknown }[];
    };
    expect(pageBody.candidates.length).toBeGreaterThan(0);
    expect(pageBody.candidates.length).toBeLessThanOrEqual(20);
    expect(pageBody.candidates.map((row) => row.subject).sort()).toEqual(current.books.map((book) => book.id).sort());
    expect(pageBody.candidates.every((row) => row.candidate.source?.source === providerReviewSource)).toBe(true);
    expect(pageBody.candidates.every((row) => row.adoption === null)).toBe(true);

    const queueTraffic = await bffQueueRequests();
    expect(queueTraffic.some((request) => request.method === 'POST' && request.url === '/v1/review-candidates:prepare')).toBe(
      true,
    );
    const reads = queueTraffic.filter((request) => request.method === 'GET' && request.url.startsWith('/v1/review-candidates?'));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((request) => new URL(request.url, current.stack.kernelOrigin).searchParams.get('limit') === '20')).toBe(
      true,
    );
    expect(reads.every((request) => new URL(request.url, current.stack.kernelOrigin).searchParams.get('source') === providerReviewSource)).toBe(
      true,
    );
    expect(reads.some((request) => request.failure?.status === 503)).toBe(true);
    expect(reads.some((request) => !request.failure)).toBe(true);

    await page.getByRole('checkbox', { name: new RegExp(current.books[0]!.title) }).click();
    await confirmDecision(page, 'accept');
    await page.getByRole('button', { name: 'Finish reviewing results' }).click();
    await page.getByRole('checkbox', { name: new RegExp(current.books[1]!.title) }).click();
    await confirmDecision(page, 'reject');

    const listing = (await (
      await current.stack.kernel(
        `/v1/subjects/${current.books[0]!.id}/candidates?property=schema:inLanguage&context=${encodeURIComponent(current.context.id)}`,
        {},
        'alice',
      )
    ).json()) as {
      candidates: { id: string; decision: string | null }[];
      adoption: { mode: string; head: number } | null;
    };
    expect(listing.adoption).toBeNull();
    expect(listing.candidates.find((row) => row.id === current.books[0]!.candidate)?.decision).toBe('accepted');
    const rejectedListing = (await (
      await current.stack.kernel(
        `/v1/subjects/${current.books[1]!.id}/candidates?property=schema:inLanguage&context=${encodeURIComponent(current.context.id)}`,
        {},
        'alice',
      )
    ).json()) as { candidates: { id: string; decision: string | null }[] };
    expect(rejectedListing.candidates.find((row) => row.id === current.books[1]!.candidate)?.decision).toBe('rejected');
    const currentRead = (await (
      await current.stack.kernel(
        `/v1/subjects/${current.books[0]!.id}?context=${encodeURIComponent(current.context.id)}`,
        {},
        'alice',
      )
    ).json()) as { subject: { statements: Record<string, { rank: string }[]> } };
    expect(currentRead.subject.statements['schema:inLanguage'] ?? []).toEqual([]);

    await current.stack.injectKernelFailureOnce({
      method: 'GET',
      path: '/v1/review-candidates',
      status: 503,
      body: JSON.stringify({
        type: 'https://rezics.com/problems/semantic_not_ready',
        title: 'Unavailable',
        status: 503,
        code: 'semantic_not_ready',
        request_id: crypto.randomUUID(),
        retryable: true,
      }),
    });
    await page.getByRole('button', { name: 'Refresh from start' }).click();
    await page.getByText('Suggestions are unavailable. Retry, or prepare the provider index explicitly.').waitFor();
    expect(await page.getByText('No suggestions match this scope.').count()).toBe(0);
  },
);

nativeTest(
  'unknown decisions keep the original command; scope change retires unsubmitted confirmation',
  360_000,
  async () => {
    const current = fixture!;
    const alice = await current.auth.signIn('alice');
    const page = pageFor(alice);
    page.setDefaultTimeout(30_000);
    await openReview(page);
    await chooseNamedContext(page);
    await loadScope(page);
    await waitForSuggestions(page);

    await page.getByRole('checkbox').nth(0).click();
    await page.getByRole('button', { name: 'Accept suggestion' }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'visible' });
    await page.getByLabel('Provider').fill('bangumi');
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    expect(await page.getByRole('button', { name: 'Confirm acceptance' }).count()).toBe(0);

    await page.getByLabel('Provider').fill(providerReviewSource);
    await chooseNamedContext(page);
    await loadScope(page);
    await waitForSuggestions(page);

    const remaining = current.books.slice(2);
    await page.getByRole('checkbox', { name: new RegExp(remaining[0]!.title) }).click();
    await page.getByRole('checkbox', { name: new RegExp(remaining[1]!.title) }).click();
    await current.stack.injectKernelFailureOnce({
      method: 'POST',
      path: `/v1/subjects/${remaining[0]!.id}/candidates/${remaining[0]!.candidate}:accept`,
      status: 503,
      body: JSON.stringify({
        type: 'https://rezics.com/problems/overloaded',
        title: 'Unavailable',
        status: 503,
        code: 'overloaded',
        request_id: crypto.randomUUID(),
        retryable: true,
      }),
    });
    await page.getByRole('button', { name: 'Accept suggestion' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Confirm acceptance' }).click();
    await page.getByText('Accepted. Review public selection separately.').waitFor();
    await page.getByText('Suggestions are unavailable. Try again.').waitFor();
    expect(await page.getByRole('button', { name: 'Finish reviewing results' }).count()).toBe(0);

    await current.stack.syncKernelRequests();
    const beforeRetry = current.stack
      .kernelRequests()
      .filter((request) => !request.fixtureRequest && request.method === 'POST' && request.url.endsWith(':accept'));
    const failed = beforeRetry.find((request) => request.url.includes(remaining[0]!.candidate));
    const succeeded = beforeRetry.find((request) => request.url.includes(remaining[1]!.candidate));
    expect(failed?.failure?.status).toBe(503);
    expect(succeeded?.failure).toBeUndefined();
    expect(failed?.idempotencyKey).toBeString();
    const originalKey = failed!.idempotencyKey;

    await page.getByRole('button', { name: 'Retry failed decisions' }).click();
    await page.getByText('Accepted. Review public selection separately.').first().waitFor();
    await current.stack.syncKernelRequests();
    const afterRetry = current.stack
      .kernelRequests()
      .filter((request) => !request.fixtureRequest && request.method === 'POST' && request.url.endsWith(':accept'));
    const retried = afterRetry.filter((request) => request.url.includes(remaining[0]!.candidate));
    expect(retried).toHaveLength(2);
    expect(retried[1]!.idempotencyKey).toBe(originalKey);
    expect(afterRetry.filter((request) => request.url.includes(remaining[1]!.candidate))).toHaveLength(1);
  },
);
