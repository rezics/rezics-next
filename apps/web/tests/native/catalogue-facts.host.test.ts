import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page, Response as PlaywrightResponse } from 'playwright';
import { expect as ui } from 'playwright/test';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import {
  startCatalogueFactsFixture,
  type CatalogueFactsFixture,
  type CatalogueFactsStatement,
} from './catalogue-facts-fixture.ts';
import type { NativeKernelRequest } from './stack.ts';

setDefaultTimeout(900_000);

let fixture: CatalogueFactsFixture;

beforeAll(async () => {
  fixture = await startCatalogueFactsFixture();
}, 600_000);

afterAll(async () => fixture?.close(), 180_000);

type Candidate = {
  id: string;
  statement: CatalogueFactsStatement;
  release: string;
  decision: string | null;
  rank: string | null;
};

async function json<T>(response: Response, status: number, action: string): Promise<T> {
  const text = await response.text();
  expect(response.status, `${action}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}

function candidatePosts(path: string): NativeKernelRequest[] {
  return fixture.stack.kernelRequests().filter((request) => {
    if (request.fixtureRequest || request.method !== 'POST') return false;
    return new URL(request.url, fixture.stack.kernelOrigin).pathname === path;
  });
}

function walk(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  for (const item of Object.values(record)) walk(item, visit);
}

function proposalProperty(response: PlaywrightResponse): string | undefined {
  if (response.request().method() !== 'POST') return;
  if (!new URL(response.url()).pathname.startsWith('/_serverFn/')) return;
  let property: string | undefined;
  walk(response.request().postDataJSON(), (record) => {
    const statement = record.statement;
    if (!statement || typeof statement !== 'object' || Array.isArray(statement)) return;
    const id = (statement as { property?: { id?: unknown } }).property?.id;
    if (typeof id === 'string') property = id;
  });
  return property;
}

function proposalReader(response: PlaywrightResponse): string | undefined {
  let reader: string | undefined;
  walk(response.request().postDataJSON(), (record) => {
    if (typeof record.expectedReader === 'string') reader = record.expectedReader;
  });
  return reader;
}

function waitForProposals(page: Page, count: number): Promise<PlaywrightResponse[]> {
  const seen: PlaywrightResponse[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      page.off('response', onResponse);
      reject(new Error(`Expected ${count} fact-proposal BFF responses, received ${seen.length}`));
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

async function openEditor(page: Page): Promise<void> {
  const response = await page.goto(new URL(fixture.path, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await page.getByRole('heading', { name: 'Edit facts', exact: true }).waitFor({ state: 'visible' });
}

async function stage(page: Page, field: string): Promise<void> {
  const region = page.getByRole('region', { name: field, exact: true });
  await region.getByRole('button', { name: 'Edit this field', exact: true }).click();
  await region.getByText('Private proposal draft').waitFor({ state: 'visible' });
}

function subjectId(): string {
  return new URL(fixture.path, fixture.stack.web).pathname.split('/')[3]!;
}

async function nativeCandidates(property: string): Promise<Candidate[]> {
  const query = new URLSearchParams({ property, context: GLOBAL_CONTEXT, limit: '20' });
  const body = await json<{ candidates: Candidate[] }>(
    await fixture.stack.kernel(`/v1/subjects/${subjectId()}/candidates?${query}`, {}, 'alice'),
    200,
    `GET candidates ${property}`,
  );
  return body.candidates.filter((candidate) => !('deleted' in candidate && candidate.deleted));
}

function citationOf(statement: CatalogueFactsStatement): unknown {
  return statement.references.map((reference) =>
    reference.parts.map((part) => ({ property: part.property.id, value: part.value })),
  );
}

test('a multi-field Edit facts submit uses the production BFF, keeps public values, and reviews each exact candidate', async () => {
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  const browserAuthorization: string[] = [];
  page.on('request', (request) => {
    const authorization = request.headers().authorization;
    if (authorization) browserAuthorization.push(authorization);
  });
  await openEditor(page);
  await stage(page, 'publication date');
  await page
    .getByRole('region', { name: 'publication date', exact: true })
    .getByLabel('Day', { exact: true })
    .fill('7');
  await stage(page, 'language');
  await page.getByRole('region', { name: 'language', exact: true }).getByLabel('Value', { exact: true }).fill('ja');

  const candidatesPath = `/v1/subjects/${subjectId()}/candidates`;
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
  const firstBatch = waitForProposals(page, 2);
  await page.getByRole('button', { name: 'Submit included changes / retry unresolved', exact: true }).click();
  const firstResponses = await firstBatch;
  expect(firstResponses.every((response) => response.status() < 400)).toBe(true);
  expect(new Set(firstResponses.map(proposalProperty))).toEqual(new Set(['schema:datePublished', 'schema:inLanguage']));
  expect(firstResponses.map(proposalReader)).toEqual([fixture.aliceAccountId, fixture.aliceAccountId]);
  await page.getByText('Proposed, awaiting review.', { exact: false }).waitFor({ state: 'visible' });
  await page.getByRole('alert').filter({ hasText: 'You cannot propose this correction right now.' }).waitFor({
    state: 'visible',
  });

  await fixture.stack.flushKernelRequests();
  const firstWrites = candidatePosts(candidatesPath);
  expect(firstWrites).toHaveLength(2);
  expect(firstWrites.filter((request) => request.failure?.status === 403)).toHaveLength(1);
  expect(firstWrites.filter((request) => !request.failure)).toHaveLength(1);
  expect(firstWrites.every((request) => request.authorization)).toBe(true);
  const keys = firstWrites.map((request) => request.idempotencyKey);
  expect(keys.every((key) => key)).toBe(true);
  expect(new Set(keys).size).toBe(2);

  const publicAfterPartial = await fixture.current();
  expect(publicAfterPartial.statements['schema:datePublished']![0]!.value).toEqual({
    type: 'value',
    content: fixture.published,
  });
  expect(publicAfterPartial.statements['schema:inLanguage']![0]!.value).toEqual({
    type: 'value',
    content: fixture.language,
  });
  expect(publicAfterPartial.statements['schema:url']![0]!.value).toEqual({ type: 'value', content: fixture.url });

  const retryBatch = waitForProposals(page, 1);
  await page.getByRole('button', { name: 'Submit included changes / retry unresolved', exact: true }).click();
  const retryResponses = await retryBatch;
  expect(retryResponses).toHaveLength(1);
  expect(retryResponses[0]!.status()).toBeLessThan(400);
  expect(proposalReader(retryResponses[0]!)).toBe(fixture.aliceAccountId);
  await ui(page.getByText('Proposed, awaiting review.', { exact: false })).toHaveCount(2);
  await ui(page.getByRole('alert').filter({ hasText: 'You cannot propose this correction right now.' })).toHaveCount(0);

  await fixture.stack.flushKernelRequests();
  const retryWrites = candidatePosts(candidatesPath);
  expect(retryWrites).toHaveLength(1);
  expect(retryWrites[0]!.failure).toBeUndefined();
  expect(keys).toContain(retryWrites[0]!.idempotencyKey);

  const publicAfter = await fixture.current();
  expect(publicAfter.statements).toEqual(publicAfterPartial.statements);
  expect(publicAfter.release).toBe(fixture.digest);

  const [dateCandidates, languageCandidates, urlCandidates] = await Promise.all([
    nativeCandidates('schema:datePublished'),
    nativeCandidates('schema:inLanguage'),
    nativeCandidates('schema:url'),
  ]);
  const dateCandidate = dateCandidates.find(
    (candidate) =>
      JSON.stringify(candidate.statement.value) ===
      JSON.stringify({ type: 'value', content: { ...fixture.published, time: '+1946-04-07T00:00:00Z' } }),
  );
  const languageCandidate = languageCandidates.find(
    (candidate) => JSON.stringify(candidate.statement.value) === JSON.stringify({ type: 'value', content: 'ja' }),
  );
  expect(dateCandidate).toBeDefined();
  expect(languageCandidate).toBeDefined();
  expect(urlCandidates.filter((candidate) => candidate.decision === null)).toHaveLength(0);
  for (const candidate of [dateCandidate!, languageCandidate!]) {
    expect(candidate.decision).toBeNull();
    expect(candidate.rank).toBeNull();
    expect(candidate.release).toBe(fixture.digest);
    expect(candidate.statement.qualifiers).toEqual([]);
    expect(candidate.statement.rezics.release).toBe(fixture.digest);
  }
  expect(citationOf(dateCandidate!.statement)).toEqual([
    [{ property: 'schema:url', value: { type: 'value', content: fixture.citations.date } }],
  ]);
  expect(citationOf(languageCandidate!.statement)).toEqual([
    [{ property: 'schema:url', value: { type: 'value', content: fixture.citations.language } }],
  ]);

  for (const [property, candidate] of [
    ['publication date', dateCandidate!],
    ['language', languageCandidate!],
  ] as const) {
    await page
      .getByRole('region', { name: property, exact: true })
      .getByRole('link', { name: 'Review this proposal', exact: true })
      .click();
    const item = page.locator('[data-candidate-item]');
    await item.waitFor({ state: 'visible' });
    await ui(item).toHaveCount(1);
    await ui(page.getByText('This proposal is not on this page.', { exact: false })).toHaveCount(0);
    expect(candidate.id).toMatch(/^[0-9a-f-]{36}$/i);
  }

  expect(browserAuthorization).toEqual([]);
});
