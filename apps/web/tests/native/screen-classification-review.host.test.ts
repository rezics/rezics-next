import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import { expect as ui } from 'playwright/test';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import {
  startCatalogueClassificationFixture,
  type NativeClassificationFixture,
} from './catalogue-classification-fixture.ts';

setDefaultTimeout(900_000);

let fixture: NativeClassificationFixture;

beforeAll(async () => {
  fixture = await startCatalogueClassificationFixture();
}, 600_000);

afterAll(async () => fixture?.close(), 180_000);

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

function propertyOf(body: string): string | undefined {
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

function referenceParts(body: string, property: string): [string, unknown][][] {
  let groups: [string, unknown][][] = [];
  walk(JSON.parse(body), (record) => {
    const statement = record.statement;
    if (!statement || typeof statement !== 'object' || Array.isArray(statement)) return;
    const row = statement as {
      property?: { id?: unknown };
      references?: { parts: { property: { id: string }; value: { content: unknown } }[] }[];
    };
    if (row.property?.id === property)
      groups = (row.references ?? []).map((group) =>
        group.parts.map((part): [string, unknown] => [part.property.id, part.value.content]),
      );
  });
  return groups;
}

function field(page: Page, property: string) {
  return page.locator(`[data-classification-property="${property}"]`);
}

async function addPart(region: ReturnType<typeof field>, property: string, label: RegExp, value: string) {
  const add = region.locator('[data-add-part]').filter({
    has: region.getByRole('combobox', { name: 'Add citation part', exact: true }),
  });
  await add.getByRole('combobox', { name: 'Add citation part', exact: true }).selectOption(property);
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await region
    .locator('div[data-statement-addition]')
    .filter({ hasText: label })
    .last()
    .getByRole('textbox')
    .fill(value);
}

async function edit(page: Page, property: string, name: string, citation?: string) {
  const region = field(page, property);
  await region.getByRole('button', { name: 'Edit this field', exact: true }).click();
  const picker = region.getByRole('combobox', { name, exact: true });
  await picker.fill(fixture.concept.label);
  await ui(page.getByRole('option', { name: fixture.concept.label })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('option', { name: fixture.concept.label }).click();
  if (citation) {
    await region.getByRole('button', { name: 'Add citation', exact: true }).click();
    await addPart(region, 'schema:url', /URL/i, citation);
    await addPart(region, 'schema:inLanguage', /language/i, 'en');
  }
  return region;
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
    candidates: { id: string; statement: { value: { content: unknown } }; decision: string | null }[];
  };
}

test('Screen corrections review admitted holders, copy evidence independently, and reread only explicit selection', async () => {
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  const response = await page.goto(new URL(fixture.screen.path, fixture.stack.web).href, {
    waitUntil: 'domcontentloaded',
  });
  expect(response?.status()).toBe(200);
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });

  const genre = await edit(page, 'schema:genre', 'genre', `${fixture.citation}/genre`);
  const keywords = await edit(page, 'schema:keywords', 'keywords');
  await genre.getByRole('button', { name: 'Reuse this reference', exact: true }).click();
  const reuse = page.locator('[data-fact-reuse]');
  await reuse.getByRole('checkbox', { name: 'keywords', exact: true }).click();
  await reuse.getByRole('button', { name: 'Copy onto selected drafts', exact: true }).click();
  await ui(page.getByText('Copied onto 1 drafts.', { exact: false })).toBeVisible();
  await keywords.getByRole('textbox', { name: 'URL', exact: true }).fill(`${fixture.citation}/keywords`);

  await page.getByRole('button', { name: 'Review included changes', exact: true }).click();
  const review = page.locator('[data-classification-review]');
  await ui(review.getByRole('heading', { name: 'genre', exact: true })).toBeVisible();
  await ui(review.getByRole('heading', { name: 'keywords', exact: true })).toBeVisible();
  await fixture.stack.flushKernelRequests();
  await page.getByRole('button', { name: 'Submit included changes / retry unresolved', exact: true }).click();
  await ui(page.getByText('Proposed, awaiting review.', { exact: false }).first()).toBeVisible();
  await fixture.stack.syncKernelRequests();

  const writes = candidatePosts(fixture.screen.id).filter((request) => request.responseStatus === 201);
  expect(writes.map((request) => propertyOf(request.body!)).sort()).toEqual(['schema:genre', 'schema:keywords']);
  expect(new Set(writes.map((request) => request.idempotencyKey)).size).toBe(2);
  expect(
    referenceParts(writes.find((request) => propertyOf(request.body!) === 'schema:genre')!.body!, 'schema:genre'),
  ).toEqual([
    [
      ['schema:url', `${fixture.citation}/genre`],
      ['schema:inLanguage', 'en'],
    ],
  ]);
  expect(
    referenceParts(writes.find((request) => propertyOf(request.body!) === 'schema:keywords')!.body!, 'schema:keywords'),
  ).toEqual([
    [
      ['schema:url', `${fixture.citation}/keywords`],
      ['schema:inLanguage', 'en'],
    ],
  ]);

  await genre.getByRole('button', { name: 'Review this proposal', exact: true }).click();
  await page.locator('[data-candidate-item]').waitFor({ state: 'visible' });
  await confirmNamed(page, 'Accept suggestion');
  await page.getByRole('button', { name: 'Reload current values', exact: true }).click();
  const listed = await nativeCandidates(fixture.screen.id, 'schema:genre');
  const candidate = listed.candidates.find((row) => row.statement.value.content === fixture.concept.id);
  expect(candidate).toBeDefined();
  const include = page.locator(`#include-${candidate!.id}`);
  await include.waitFor({ state: 'visible' });
  if (!(await include.isChecked())) await include.click();
  await confirmNamed(page, 'Select for public subject');
  await page.getByRole('button', { name: 'Read current selection', exact: true }).first().click();

  await ui(page.getByRole('region', { name: 'Current public values' })).toContainText(fixture.concept.label);
  const selected = await fixture.stack.kernel(`/v1/subjects/${fixture.screen.id}`);
  expect(selected.status).toBe(200);
  const body = (await selected.json()) as {
    subject: { statements: Record<string, { value: { content: unknown } }[]> };
  };
  expect(body.subject.statements['schema:genre']).toMatchObject([{ value: { content: fixture.concept.id } }]);
  expect(body.subject.statements['schema:keywords'] ?? []).toEqual([]);
  expect(candidatePosts(fixture.screen.id).filter((request) => request.responseStatus === 201)).toHaveLength(2);
  await page.close();
});
