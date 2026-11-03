import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import { expect as ui } from 'playwright/test';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import {
  startCatalogueClassificationFixture,
  type NativeClassificationFixture,
  type NativeClassificationSubject,
} from './catalogue-classification-fixture.ts';

setDefaultTimeout(900_000);

let fixture: NativeClassificationFixture;

beforeAll(async () => {
  fixture = await startCatalogueClassificationFixture();
}, 600_000);

afterAll(async () => fixture?.close(), 180_000);

function genreSection(page: Page) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: 'genre', exact: true, level: 3 }) });
}

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function openEditor(page: Page, path: string, heading: string): Promise<void> {
  const response = await page.goto(new URL(path, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await hydrate(page);
  await page.getByRole('heading', { name: heading, exact: true }).waitFor({ state: 'visible' });
}

async function pickGenre(page: Page): Promise<void> {
  const section = genreSection(page);
  await section.getByRole('button', { name: 'Edit this field', exact: true }).click();
  const box = section.getByRole('combobox', { name: 'genre', exact: true });
  await box.fill(fixture.concept.label);
  await ui(page.getByRole('option', { name: fixture.concept.label })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('option', { name: fixture.concept.label }).click();
}

async function cite(page: Page, section: ReturnType<typeof genreSection>): Promise<void> {
  await section.getByRole('button', { name: 'Add citation', exact: true }).click();
  const citationPart = section.locator('[data-add-part]').filter({
    has: page.getByRole('combobox', { name: 'Add citation part', exact: true }),
  });
  await citationPart.getByRole('combobox', { name: 'Add citation part', exact: true }).selectOption('schema:url');
  await citationPart.getByRole('button', { name: 'Add', exact: true }).click();
  await section.getByRole('textbox', { name: 'URL', exact: true }).fill(fixture.citation);
}

async function propose(page: Page, section: ReturnType<typeof genreSection>): Promise<void> {
  await section.getByRole('button', { name: 'Submit proposal', exact: true }).click();
}

function candidatePosts(id: string) {
  return fixture.stack.kernelRequests().filter((request) => {
    if (request.fixtureRequest || request.method !== 'POST' || !request.body) return false;
    return new URL(request.url, fixture.stack.kernelOrigin).pathname === `/v1/subjects/${id}/candidates`;
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

async function publicGenre(id: string): Promise<unknown[]> {
  const response = await fixture.stack.kernel(`/v1/subjects/${id}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    subject: { statements: Record<string, { value: { content: unknown }; references: unknown[] }[]> };
  };
  return body.subject.statements['schema:genre'] ?? [];
}

async function nativeCandidates(id: string) {
  const query = new URLSearchParams({ property: 'schema:genre', context: GLOBAL_CONTEXT, limit: '20' });
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

async function confirmNamed(page: Page, action: string): Promise<void> {
  await page.getByRole('button', { name: action, exact: true }).last().click();
  const region = page.locator('section[aria-labelledby]').filter({ hasText: `Confirm: ${action}` });
  await region.waitFor({ state: 'visible' });
  await region.getByRole('button', { name: action, exact: true }).click();
}

test('Manga classification correction uses the picker, cited native candidate path, explicit select, and current readback', async () => {
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  await openEditor(page, fixture.manga.path, 'Edit manga series or volume');
  await pickGenre(page);
  const section = genreSection(page);
  await cite(page, section);

  await fixture.stack.flushKernelRequests();
  await fixture.stack.injectKernelFailureOnce({
    method: 'POST',
    path: `/v1/subjects/${fixture.manga.id}/candidates`,
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
  await propose(page, section);
  await ui(section.getByRole('alert')).toContainText('You cannot propose this correction right now.');
  await fixture.stack.syncKernelRequests();
  expect(await publicGenre(fixture.manga.id)).toEqual([]);

  await section.getByRole('button', { name: 'Retry exact proposal', exact: true }).click();
  await ui(section.getByRole('status').filter({ hasText: 'Proposed, awaiting review.' })).toBeVisible();
  await fixture.stack.syncKernelRequests();
  const writes = candidatePosts(fixture.manga.id);
  expect(writes.length).toBeGreaterThanOrEqual(2);
  expect(writes.some((request) => request.failure?.status === 403)).toBe(true);
  const success = writes.find((request) => !request.failure && request.responseStatus === 201);
  expect(success?.body).toBeTruthy();
  expect(proposalProperty(success!.body!)).toBe('schema:genre');
  expect(proposalTarget(success!.body!)).toBe(fixture.concept.id);
  expect(success!.idempotencyKey).toBeTruthy();
  expect(writes.filter((request) => request.idempotencyKey === success!.idempotencyKey).length).toBeGreaterThan(1);

  const listed = await nativeCandidates(fixture.manga.id);
  const candidate = listed.candidates.find((row) => row.statement.value.content === fixture.concept.id);
  expect(candidate).toBeDefined();
  expect(candidate!.decision).toBeNull();

  await section.getByRole('button', { name: 'Review this proposal', exact: true }).click();
  await page.locator('[data-candidate-item]').waitFor({ state: 'visible' });
  await confirmNamed(page, 'Accept suggestion');
  await ui(page.getByText('Suggestion accepted.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Reload current values', exact: true }).click();
  const include = page.locator(`#include-${candidate!.id}`);
  await include.waitFor({ state: 'visible' });
  if (!(await include.isChecked())) await include.click();
  await confirmNamed(page, 'Select for public subject');
  await ui(page.getByText('The public reader confirms this selection', { exact: false })).toBeVisible();
  const selected = await publicGenre(fixture.manga.id);
  expect(selected).toHaveLength(1);
  expect(selected[0]).toMatchObject({ value: { content: fixture.concept.id } });
  await page.close();
});

test('Album and Screen bind the same classification admission path through their production editors', async () => {
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);

  async function proposeOn(subject: NativeClassificationSubject, heading: string) {
    await openEditor(page, subject.path, heading);
    await pickGenre(page);
    const section = genreSection(page);
    await cite(page, section);
    await propose(page, section);
    await ui(section.getByRole('status').filter({ hasText: 'Proposed, awaiting review.' })).toBeVisible();
    await fixture.stack.syncKernelRequests();
    const posts = candidatePosts(subject.id);
    expect(posts.some((request) => !request.failure && request.responseStatus === 201)).toBe(true);
    const body = posts.find((request) => request.responseStatus === 201)?.body;
    expect(proposalProperty(body!)).toBe('schema:genre');
    expect(proposalTarget(body!)).toBe(fixture.concept.id);
    expect(await publicGenre(subject.id)).toEqual([]);
  }

  await proposeOn(fixture.album, 'Edit album profile');
  await proposeOn(fixture.screen, 'Edit film, television or episode');
  await page.close();
});
