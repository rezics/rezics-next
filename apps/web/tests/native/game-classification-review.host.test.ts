import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import { expect as ui } from 'playwright/test';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { subjectHref } from '../../src/subject/subject-href.ts';
import {
  startCatalogueClassificationFixture,
  type NativeClassificationFixture,
  type NativeClassificationSubject,
} from './catalogue-classification-fixture.ts';

setDefaultTimeout(900_000);

let fixture: NativeClassificationFixture;
let game: NativeClassificationSubject;
let platform: NativeClassificationSubject;

beforeAll(async () => {
  fixture = await startCatalogueClassificationFixture();
  const marker = crypto.randomUUID().slice(0, 8);
  platform = await createConcept(`Native game platform ${marker}`);
  game = await createGame(`Native game classification ${marker}`);
  await waitForSuggestion(platform);
}, 600_000);

afterAll(async () => fixture?.close(), 180_000);

async function json<T>(response: Response, status: number, action: string): Promise<T> {
  const text = await response.text();
  expect(response.status, `${action}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}

async function createConcept(label: string): Promise<NativeClassificationSubject> {
  const created = await json<{ subject: { id: string; type: string } }>(
    await fixture.stack.kernel(
      '/v1/subjects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
        body: JSON.stringify({ type: 'skos:Concept', labels: { en: label } }),
      },
      'editor',
    ),
    201,
    `POST /v1/subjects skos:Concept ${label}`,
  );
  return { id: created.subject.id, type: created.subject.type, label, path: '' };
}

async function createGame(label: string): Promise<NativeClassificationSubject> {
  const created = await json<{ subject: { id: string; type: string } }>(
    await fixture.stack.kernel(
      '/v1/subjects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
        body: JSON.stringify({ type: 'schema:VideoGame', labels: { en: label } }),
      },
      'editor',
    ),
    201,
    `POST /v1/subjects schema:VideoGame ${label}`,
  );
  return {
    id: created.subject.id,
    type: created.subject.type,
    label,
    path: `${subjectHref({ id: created.subject.id, label }, 'en').href}/game`,
  };
}

async function waitForSuggestion(subject: NativeClassificationSubject): Promise<void> {
  const until = Date.now() + 60_000;
  const query = `/v1/subjects:suggest?q=${encodeURIComponent(subject.label)}&limit=10&languages=en`;
  while (Date.now() < until) {
    const response = await fixture.stack.kernel(query);
    if (response.status === 200) {
      const body = (await response.json()) as { subjects?: { id: string }[] };
      if (body.subjects?.some((item) => item.id === subject.id)) return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Native suggestions did not include ${subject.type} ${subject.id}`);
}

function field(page: Page, name: string) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name, exact: true, level: 3 }) });
}

async function pick(page: Page, name: string, concept: NativeClassificationSubject): Promise<void> {
  const section = field(page, name);
  const opener = section.getByRole('button', { name: 'Propose another value', exact: true });
  if (await opener.count()) await opener.click();
  else await section.getByRole('button', { name: 'Edit this field', exact: true }).click();
  const box = section.getByRole('combobox', { name, exact: true });
  await box.fill(concept.label);
  await ui(page.getByRole('option', { name: concept.label })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('option', { name: concept.label }).click();
}

async function cite(page: Page, name: string, url: string): Promise<void> {
  const section = field(page, name);
  await section.getByRole('button', { name: 'Add citation', exact: true }).click();
  const citationPart = section.locator('[data-add-part]').filter({
    has: page.getByRole('combobox', { name: 'Add citation part', exact: true }),
  });
  await citationPart.getByRole('combobox', { name: 'Add citation part', exact: true }).selectOption('schema:url');
  await citationPart.getByRole('button', { name: 'Add', exact: true }).click();
  await section.getByRole('textbox', { name: 'URL', exact: true }).fill(url);
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

function proposalProperty(body: string): string | undefined {
  let property: string | undefined;
  walk(JSON.parse(body), (record) => {
    const statement = record.statement;
    if (!statement || typeof statement !== 'object' || Array.isArray(statement)) return;
    const id = (statement as { property?: { id?: unknown } }).property?.id;
    if (typeof id === 'string') property = id;
  });
  return property;
}

function candidatePosts(id: string) {
  return fixture.stack.kernelRequests().filter((request) => {
    if (request.fixtureRequest || request.method !== 'POST' || !request.body) return false;
    return new URL(request.url, fixture.stack.kernelOrigin).pathname === `/v1/subjects/${id}/candidates`;
  });
}

async function confirmNamed(page: Page, action: string): Promise<void> {
  await page.getByRole('button', { name: action, exact: true }).last().click();
  const region = page.locator('section[aria-labelledby]').filter({ hasText: `Confirm: ${action}` });
  await region.waitFor({ state: 'visible' });
  await region.getByRole('button', { name: action, exact: true }).click();
}

async function nativeCandidates(id: string, property: string) {
  const query = new URLSearchParams({ property, context: GLOBAL_CONTEXT, limit: '20' });
  const response = await fixture.stack.kernel(`/v1/subjects/${id}/candidates?${query}`, {}, 'alice');
  expect(response.status).toBe(200);
  return (await response.json()) as {
    candidates: {
      id: string;
      statement: { value: { content: unknown }; references: unknown[] };
      decision: string | null;
    }[];
  };
}

test('Game classification reuses evidence, reviews independent native candidates, then selects and rereads current assertions', async () => {
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  const response = await page.goto(new URL(game.path, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  await page.getByRole('heading', { name: 'Game and visual-novel work editor', exact: true }).waitFor({
    state: 'visible',
  });
  const summary = page.getByText('Platforms and classifications', { exact: true });
  if (!(await summary.locator('xpath=ancestor::details').evaluate((node) => (node as HTMLDetailsElement).open)))
    await summary.click();

  await pick(page, 'game platform', platform);
  await cite(page, 'game platform', `${fixture.citation}/platform`);
  await pick(page, 'genre', fixture.concept);
  await field(page, 'game platform').getByRole('button', { name: /Reuse this reference/ }).click();
  const reuse = page.locator('[data-fact-reuse]');
  await reuse.waitFor({ state: 'visible' });
  await reuse.getByRole('checkbox', { name: 'genre', exact: true }).click();
  await reuse.getByRole('button', { name: 'Copy onto selected drafts', exact: true }).click();
  await ui(page.getByText('Evidence group 1 on genre was copied from game platform.', { exact: false })).toBeVisible();

  const review = page.locator('[data-fact-review]');
  await ui(review.getByRole('heading', { name: 'game platform', exact: true })).toBeVisible();
  await ui(review.getByRole('heading', { name: 'genre', exact: true })).toBeVisible();
  await review
    .getByRole('heading', { name: 'genre', exact: true })
    .locator('..')
    .getByRole('button', { name: 'Open this field', exact: true })
    .click();
  await ui(page.getByText('These drafts changed after this review.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Review included changes', exact: true }).click();
  await fixture.stack.flushKernelRequests();
  await page.getByRole('button', { name: 'Submit included changes / retry unresolved', exact: true }).click();
  await ui(page.getByText('Proposed, awaiting review.', { exact: false })).toHaveCount(2);
  await fixture.stack.syncKernelRequests();

  const writes = candidatePosts(game.id);
  const properties = new Set(writes.filter((request) => request.responseStatus === 201).map((request) => proposalProperty(request.body!)));
  expect(properties).toEqual(new Set(['schema:gamePlatform', 'schema:genre']));
  expect(new Set(writes.filter((request) => request.responseStatus === 201).map((request) => request.idempotencyKey)).size).toBe(2);

  const listed = await nativeCandidates(game.id, 'schema:genre');
  const candidate = listed.candidates.find((row) => row.statement.value.content === fixture.concept.id);
  expect(candidate).toBeDefined();
  expect(candidate!.decision).toBeNull();
  expect(candidate!.statement.references.length).toBeGreaterThan(0);

  await field(page, 'genre').getByRole('button', { name: 'Review this proposal', exact: true }).click();
  await page.locator('[data-candidate-item]').waitFor({ state: 'visible' });
  await confirmNamed(page, 'Accept suggestion');
  await ui(page.getByText('Suggestion accepted.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Reload current values', exact: true }).click();
  const include = page.locator(`#include-${candidate!.id}`);
  await include.waitFor({ state: 'visible' });
  if (!(await include.isChecked())) await include.click();
  await confirmNamed(page, 'Select for public subject');
  await ui(page.getByText('The public reader confirms this selection', { exact: false })).toBeVisible();

  const current = await json<{
    subject: { id: string; statements: Record<string, { value: { content: unknown } }[]> };
  }>(await fixture.stack.kernel(`/v1/subjects/${game.id}`), 200, 'GET current Game');
  expect(current.subject.id).toBe(game.id);
  expect(current.subject.statements['schema:genre']?.[0]).toMatchObject({ value: { content: fixture.concept.id } });
  await page.close();
});
