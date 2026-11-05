import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page, Response as PlaywrightResponse } from 'playwright';
import { expect as ui } from 'playwright/test';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import {
  startCatalogueFactsFixture,
  type CatalogueFactsFixture,
  type CatalogueFactsStatement,
} from './catalogue-facts-fixture.ts';

setDefaultTimeout(900_000);
let fixture: CatalogueFactsFixture;

beforeAll(async () => {
  fixture = await startCatalogueFactsFixture();
}, 600_000);
afterAll(async () => fixture?.close(), 180_000);

type Candidate = { id: string; statement: CatalogueFactsStatement; decision: string | null };

async function json<T>(response: Response, status: number, action: string): Promise<T> {
  const text = await response.text();
  expect(response.status, `${action}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}

function walk(value: unknown, visit: (record: Record<string, unknown>) => void) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  for (const item of Object.values(record)) walk(item, visit);
}

function proposalProperty(response: PlaywrightResponse) {
  if (response.request().method() !== 'POST' || !new URL(response.url()).pathname.startsWith('/_serverFn/')) return;
  let property: string | undefined;
  walk(response.request().postDataJSON(), (record) => {
    const id = (record.statement as { property?: { id?: unknown } } | undefined)?.property?.id;
    if (typeof id === 'string') property = id;
  });
  return property;
}

function waitForProposals(page: Page, count: number) {
  const seen: PlaywrightResponse[] = [];
  return new Promise<PlaywrightResponse[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      page.off('response', onResponse);
      reject(new Error(`Expected ${count} proposals, received ${seen.length}`));
    }, 60_000);
    const onResponse = (response: PlaywrightResponse) => {
      const property = proposalProperty(response);
      if (property !== 'schema:datePublished' && property !== 'schema:inLanguage') return;
      if (seen.includes(response)) return;
      seen.push(response);
      if (seen.length < count) return;
      clearTimeout(timer);
      page.off('response', onResponse);
      resolve(seen);
    };
    page.on('response', onResponse);
  });
}

async function open(page: Page) {
  const response = await page.goto(new URL(fixture.path, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await page.getByRole('heading', { name: 'Edit facts', exact: true }).waitFor({ state: 'visible' });
}

async function stage(page: Page, field: string) {
  const region = page.getByRole('region', { name: field, exact: true });
  await region.getByRole('button', { name: 'Edit this field', exact: true }).click();
  await region.getByText('Private proposal draft').waitFor({ state: 'visible' });
}

test('a contributor reviews exact changed assertions, jump-back invalidates, and native commands recover independently', async () => {
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  await open(page);
  await stage(page, 'publication date');
  await page
    .getByRole('region', { name: 'publication date', exact: true })
    .getByLabel('Day', { exact: true })
    .fill('7');
  await stage(page, 'language');
  await page.getByRole('region', { name: 'language', exact: true }).getByLabel('Value', { exact: true }).fill('ja');

  const review = page.locator('[data-fact-review]');
  await review.waitFor({ state: 'visible' });
  await ui(review.getByRole('heading', { name: 'publication date', exact: true })).toBeVisible();
  await ui(review.getByRole('heading', { name: 'language', exact: true })).toBeVisible();
  await ui(review.getByText('ja', { exact: true })).toBeVisible();
  const submit = page.getByRole('button', { name: 'Submit included changes / retry unresolved', exact: true });
  await ui(submit).toBeEnabled();

  await review
    .getByRole('heading', { name: 'language', exact: true })
    .locator('..')
    .getByRole('button', { name: 'Open this field', exact: true })
    .click();
  await ui(page.getByText('These drafts changed after this review.', { exact: false })).toBeVisible();
  await ui(submit).toBeDisabled();
  await page.getByRole('region', { name: 'language', exact: true }).getByLabel('Value', { exact: true }).fill('de');
  await page.getByRole('button', { name: 'Review included changes', exact: true }).click();
  await ui(submit).toBeEnabled();
  await ui(review.getByText('de', { exact: true })).toBeVisible();

  const candidatesPath = `/v1/subjects/${new URL(fixture.path, fixture.stack.web).pathname.split('/')[3]}/candidates`;
  await fixture.stack.flushKernelRequests();
  await fixture.stack.injectKernelFailureOnce({
    method: 'POST',
    path: candidatesPath,
    status: 403,
    body: JSON.stringify({
      type: 'https://rezics.com/problems/forbidden',
      title: 'Forbidden',
      status: 403,
      code: 'forbidden',
      retryable: false,
      effect_status: 'not_applied',
      request_id: crypto.randomUUID(),
    }),
  });
  const first = waitForProposals(page, 2);
  await submit.click();
  expect(new Set((await first).map(proposalProperty))).toEqual(new Set(['schema:datePublished', 'schema:inLanguage']));
  await page.getByText('Proposed, awaiting review.', { exact: false }).waitFor({ state: 'visible' });
  await page.getByRole('alert').filter({ hasText: 'You cannot propose this correction right now.' }).waitFor({
    state: 'visible',
  });
  const board = page.locator('[data-fact-results]');
  await ui(board.getByRole('heading', { name: 'Proposed, awaiting review', exact: true })).toBeVisible();
  await ui(board.getByRole('heading', { name: 'Refused', exact: true })).toBeVisible();

  const retry = waitForProposals(page, 1);
  await submit.click();
  expect((await retry)[0]!.status()).toBeLessThan(400);
  await ui(page.getByText('Proposed, awaiting review.', { exact: false })).toHaveCount(2);

  const subject = new URL(fixture.path, fixture.stack.web).pathname.split('/')[3]!;
  const language = await json<{ candidates: Candidate[] }>(
    await fixture.stack.kernel(
      `/v1/subjects/${subject}/candidates?${new URLSearchParams({ property: 'schema:inLanguage', context: GLOBAL_CONTEXT, limit: '20' })}`,
      {},
      'alice',
    ),
    200,
    'GET language candidates',
  );
  const proposed = language.candidates.find(
    (candidate) => JSON.stringify(candidate.statement.value) === JSON.stringify({ type: 'value', content: 'de' }),
  );
  expect(proposed?.decision).toBeNull();
  await page
    .getByRole('region', { name: 'language', exact: true })
    .getByRole('link', { name: 'Review this proposal', exact: true })
    .click();
  await page.locator('[data-candidate-item]').waitFor({ state: 'visible' });
  await ui(page.locator('[data-candidate-item]')).toHaveCount(1);
});
