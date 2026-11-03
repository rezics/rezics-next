import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import { expect as ui } from 'playwright/test';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { subjectHref } from '../../src/subject/subject-href.ts';
import {
  startCatalogueClassificationFixture,
  type NativeClassificationFixture,
} from './catalogue-classification-fixture.ts';

setDefaultTimeout(900_000);

let fixture: NativeClassificationFixture;
let addon: { id: string; path: string; label: string };

beforeAll(async () => {
  fixture = await startCatalogueClassificationFixture();
  const created = await json<{ subject: { id: string } }>(
    await fixture.stack.kernel(
      '/v1/subjects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
        body: JSON.stringify({
          type: 'wd:Q209163',
          labels: { en: `Native add-on classification ${crypto.randomUUID().slice(0, 8)}` },
        }),
      },
      'editor',
    ),
    201,
    'POST /v1/subjects add-on',
  );
  const read = await json<{ subject: { id: string; labels: Record<string, string> } }>(
    await fixture.stack.kernel(`/v1/subjects/${created.subject.id}`),
    200,
    'GET add-on',
  );
  const label = read.subject.labels.en ?? created.subject.id;
  addon = {
    id: created.subject.id,
    label,
    path: `${subjectHref({ id: created.subject.id, label }, 'en').href}/addon`,
  };
}, 600_000);

afterAll(async () => fixture?.close(), 180_000);

async function json<T>(response: Response, status: number, action: string): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${action}: HTTP ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
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

function proposalTarget(body: string): string | undefined {
  let target: string | undefined;
  walk(JSON.parse(body), (record) => {
    const statement = record.statement;
    if (!statement || typeof statement !== 'object' || Array.isArray(statement)) return;
    const content = (statement as { value?: { content?: unknown } }).value?.content;
    if (typeof content === 'string') target = content;
  });
  return target;
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

test('Add-on classification correction reviews two changed fields, copies evidence, and selects one native candidate', async () => {
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  const response = await page.goto(new URL(addon.path, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await hydrate(page);
  await page.getByRole('heading', { name: 'Add-on and expansion editor', exact: true }).waitFor({ state: 'visible' });
  await ui(page.getByRole('heading', { name: 'Add-on classifications', exact: true })).toBeVisible();

  async function edit(field: string, url: string) {
    const section = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: field, exact: true, level: 3 }) });
    await section.getByRole('button', { name: 'Edit this field', exact: true }).click();
    const box = section.getByRole('combobox', { name: field, exact: true });
    await box.fill(fixture.concept.label);
    await ui(page.getByRole('option', { name: fixture.concept.label })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('option', { name: fixture.concept.label }).click();
    await section.getByRole('button', { name: 'Add citation', exact: true }).click();
    const citationPart = section.locator('[data-add-part]').filter({
      has: page.getByRole('combobox', { name: 'Add citation part', exact: true }),
    });
    await citationPart.getByRole('combobox', { name: 'Add citation part', exact: true }).selectOption('schema:url');
    await citationPart.getByRole('button', { name: 'Add', exact: true }).click();
    await section.getByRole('textbox', { name: 'URL', exact: true }).fill(url);
    return section;
  }

  const platforms = await edit('game platform', `${fixture.citation}/platform`);
  await edit('genre', `${fixture.citation}/genre`);
  await platforms.getByRole('button', { name: 'Reuse this reference', exact: true }).click();
  await page.getByRole('checkbox', { name: 'genre', exact: true }).click();
  await page.getByRole('button', { name: 'Copy onto selected drafts', exact: true }).click();
  await ui(page.getByText('Copied onto 1 drafts.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Review included changes', exact: true }).click();
  const review = page.locator('[data-classification-review], [data-fact-review]');
  await ui(review.getByRole('heading', { name: 'game platform', exact: true })).toBeVisible();
  await ui(review.getByRole('heading', { name: 'genre', exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Open this field', exact: true }).first().click();
  await platforms.getByRole('textbox', { name: 'URL', exact: true }).fill(`${fixture.citation}/repaired`);
  await page.getByRole('button', { name: 'Review included changes', exact: true }).click();
  await fixture.stack.flushKernelRequests();
  await page.getByRole('button', { name: 'Submit included changes / retry unresolved', exact: true }).click();
  await ui(page.getByText('Proposed, awaiting review.', { exact: false })).toBeVisible();
  await fixture.stack.syncKernelRequests();
  const writes = candidatePosts(addon.id);
  expect(writes.some((request) => !request.failure && request.responseStatus === 201)).toBe(true);
  const bodies = writes.filter((request) => request.responseStatus === 201).map((request) => request.body!);
  expect(new Set(bodies.map((body) => proposalProperty(body!)))).toEqual(new Set(['schema:gamePlatform', 'schema:genre']));
  expect(bodies.every((body) => proposalTarget(body!) === fixture.concept.id)).toBe(true);
  expect(await publicField(addon.id, 'schema:gamePlatform')).toEqual([]);

  await platforms.getByRole('button', { name: 'Review this proposal', exact: true }).click();
  await page.locator('[data-candidate-item]').waitFor({ state: 'visible' });
  await confirmNamed(page, 'Accept suggestion');
  await ui(page.getByText('Suggestion accepted.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Reload current values', exact: true }).click();
  const listed = await nativeCandidates(addon.id, 'schema:gamePlatform');
  const candidate = listed.candidates.find((row) => row.statement.value.content === fixture.concept.id);
  expect(candidate).toBeDefined();
  const include = page.locator(`#include-${candidate!.id}`);
  await include.waitFor({ state: 'visible' });
  if (!(await include.isChecked())) await include.click();
  await confirmNamed(page, 'Select for public subject');
  await ui(page.getByText('The public reader confirms this selection', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Read current selection', exact: true }).first().click();
  const selected = await publicField(addon.id, 'schema:gamePlatform');
  expect(selected).toHaveLength(1);
  expect(selected[0]).toMatchObject({ value: { content: fixture.concept.id } });
  expect(await publicField(addon.id, 'schema:genre')).toEqual([]);
  await page.close();
});

async function publicField(id: string, property: string): Promise<unknown[]> {
  const response = await fixture.stack.kernel(`/v1/subjects/${id}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    subject: { statements: Record<string, { value: { content: unknown } }[]> };
  };
  return body.subject.statements[property] ?? [];
}

async function nativeCandidates(id: string, property: string) {
  const query = new URLSearchParams({ property, context: GLOBAL_CONTEXT, limit: '20' });
  const response = await fixture.stack.kernel(`/v1/subjects/${id}/candidates?${query}`, {}, 'alice');
  expect(response.status).toBe(200);
  return (await response.json()) as {
    candidates: {
      id: string;
      statement: { value: { content: unknown } };
      decision: string | null;
    }[];
  };
}
