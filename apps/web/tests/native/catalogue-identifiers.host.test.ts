import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page, Response as PlaywrightResponse } from 'playwright';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { identifierProperties } from '../../src/features/catalogue/identifiers-profile.ts';
import { startCatalogueFactsFixture, type CatalogueFactsFixture } from './catalogue-facts-fixture.ts';
import type { NativeKernelRequest } from './stack.ts';

setDefaultTimeout(900_000);

let fixture: CatalogueFactsFixture;

beforeAll(async () => {
  fixture = await startCatalogueFactsFixture('bf:Instance');
}, 600_000);

afterAll(async () => fixture?.close(), 180_000);

const isbn = '9780306406157';
const citation = 'https://example.org/identifier-evidence/isbn-9780306406157';

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
  if (response.request().method() !== 'POST' || !new URL(response.url()).pathname.startsWith('/_serverFn/')) return;
  let property: string | undefined;
  try {
    walk(response.request().postDataJSON(), (record) => {
      const statement = record.statement;
      if (!statement || typeof statement !== 'object' || Array.isArray(statement)) return;
      const id = (statement as { property?: { id?: unknown } }).property?.id;
      if (typeof id === 'string') property = id;
    });
  } catch {
    return;
  }
  return property;
}

function proposalReader(response: PlaywrightResponse): string | undefined {
  let reader: string | undefined;
  walk(response.request().postDataJSON(), (record) => {
    if (typeof record.expectedReader === 'string') reader = record.expectedReader;
  });
  return reader;
}

function expectedIdentifierProperties(type: string): string[] {
  return (bundledRelease.types[type]?.properties ?? []).filter((id) => {
    const property = bundledRelease.properties[id]!;
    return (
      property.datatype === 'external-id' ||
      property.datatype === 'url' ||
      (property.datatype === 'string' &&
        'pattern' in property.value &&
        typeof property.value.pattern === 'string' &&
        property.value.pattern.length > 0)
    );
  });
}

async function grantReviewer(): Promise<void> {
  const bob = await fixture.auth.signIn('bob');
  expect((await bob.response()).status()).toBe(200);
  const identity = await fixture.stack.authPersona('bob');
  const response = await fixture.stack.kernel(
    '/v1/grants',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
      body: JSON.stringify({
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: identity.accountId },
        actions: ['context:accept', 'context:adopt'],
        valid: '(,)',
      }),
    },
    'governor',
  );
  expect(response.status).toBe(201);
}

async function confirm(page: Page, action: string): Promise<PlaywrightResponse> {
  await page.getByRole('button', { name: action, exact: true }).last().click();
  const region = page.locator('section[aria-labelledby]').filter({ hasText: `Confirm: ${action}` });
  await region.waitFor({ state: 'visible' });
  const response = page.waitForResponse(async (item) => {
    if (item.request().method() !== 'POST' || new URL(item.url()).origin !== new URL(fixture.stack.web).origin)
      return false;
    try {
      const body = (await item.json()) as { kind?: string };
      return body.kind === 'accepted' || body.kind === 'selected';
    } catch {
      return false;
    }
  });
  await region.getByRole('button', { name: action, exact: true }).click();
  return response;
}

test('the identifier editor filters the released edition fields and reviews its exact cited candidate on that edition', async () => {
  const edition = bundledRelease.types['bf:Instance']!;
  expect(bundledDigest).toBe(fixture.digest);
  expect(edition.properties).toContain('schema:isbn');
  const expectedFields = expectedIdentifierProperties('bf:Instance');
  expect(expectedFields).toEqual(expect.arrayContaining(['schema:isbn', 'schema:sameAs', 'schema:url']));
  expect(expectedFields).not.toContain('schema:name');
  const patternedString = Object.entries(bundledRelease.types)
    .flatMap(([type, definition]) => definition.properties.map((property) => ({ type, property })))
    .find(({ property }) => {
      const definition = bundledRelease.properties[property]!;
      return (
        definition.datatype === 'string' &&
        'pattern' in definition.value &&
        typeof definition.value.pattern === 'string' &&
        definition.value.pattern.length > 0
      );
    });
  expect(patternedString).toBeDefined();
  expect(identifierProperties(bundledRelease, patternedString!.type)).toContain(patternedString!.property);
  await grantReviewer();

  const anonymous = await (await fixture.auth.context('anonymous')).newPage();
  anonymous.setDefaultTimeout(60_000);
  const privateResponse = await anonymous.goto(new URL(fixture.identifiersPath, fixture.stack.web).href, {
    waitUntil: 'domcontentloaded',
  });
  expect(privateResponse?.status()).toBe(200);
  expect(privateResponse?.headers()['cache-control']).toContain('private');
  expect(privateResponse?.headers()['cache-control']).toContain('no-store');
  await anonymous.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await anonymous.getByRole('status').filter({ hasText: /sign in/i }).waitFor({ state: 'visible' });
  expect(await anonymous.getByRole('region', { name: 'ISBN-13', exact: true }).count()).toBe(0);
  expect(await anonymous.locator('meta[name="robots"]').getAttribute('content')).toBe('noindex, nofollow');
  await anonymous.close();

  const browserAuthorization: string[] = [];
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  page.on('request', (request) => {
    const authorization = request.headers().authorization;
    if (authorization) browserAuthorization.push(authorization);
  });
  const response = await page.goto(new URL(fixture.identifiersPath, fixture.stack.web).href, {
    waitUntil: 'domcontentloaded',
  });
  expect(response?.status()).toBe(200);
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  const profile = page.locator('[data-slot="identifiers-profile"]');
  const fields = await profile.locator('section[aria-label] h3').allTextContents();
  expect(fields).toEqual(expectedFields.map((id) => bundledRelease.properties[id]!.labels.en));

  const isbnField = page.getByRole('region', { name: 'ISBN-13', exact: true });
  await isbnField.getByRole('button', { name: 'Edit this field', exact: true }).click();
  await isbnField.getByRole('textbox', { name: 'Value', exact: true }).fill(isbn);
  await isbnField.getByRole('button', { name: 'Add citation', exact: true }).click();
  await isbnField.getByRole('combobox', { name: 'Add citation part', exact: true }).selectOption('schema:url');
  await isbnField.getByRole('button', { name: 'Add', exact: true }).click();
  await isbnField.getByRole('textbox', { name: 'Citation URL', exact: true }).fill(citation);

  const proposal = page.waitForResponse((item) => proposalProperty(item) === 'schema:isbn', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Submit included changes / retry unresolved', exact: true }).click();
  const proposalResponse = await proposal;
  expect(proposalResponse.status()).toBeLessThan(400);
  expect(proposalReader(proposalResponse)).toBe(fixture.aliceAccountId);
  let candidate: string | undefined;
  walk(await proposalResponse.json(), (record) => {
    if (record.kind === 'proposed-awaiting-review' && typeof record.candidate === 'string') candidate = record.candidate;
  });
  expect(candidate).toMatch(/^[0-9a-f-]{36}$/i);

  await fixture.stack.flushKernelRequests();
  const subjectId = new URL(fixture.identifiersPath, fixture.stack.web).pathname.split('/')[3]!;
  const proposals = fixture.stack.kernelRequests().filter((request) => {
    if (request.fixtureRequest || request.method !== 'POST') return false;
    return new URL(request.url, fixture.stack.kernelOrigin).pathname === `/v1/subjects/${subjectId}/candidates`;
  });
  expect(proposals).toHaveLength(1);
  expect(proposals[0]!.responseStatus).toBe(201);
  expect(proposals[0]!.authorization).toStartWith('Bearer ');
  const body = JSON.parse(proposals[0]!.body!) as {
    statement: {
      property: { id: string };
      value: { type: string; content: unknown };
      references: { parts: { property: { id: string }; value: { type: string; content: unknown } }[] }[];
    };
  };
  expect(body.statement.property.id).toBe('schema:isbn');
  expect(body.statement.value).toEqual({ type: 'value', content: isbn });
  expect(body.statement.references).toEqual([
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] },
  ]);
  expect(browserAuthorization).toEqual([]);

  const reviewLink = await isbnField.getByRole('link', { name: 'Review this proposal', exact: true }).getAttribute('href');
  expect(reviewLink).toBeTruthy();
  const reviewAddress = new URL(reviewLink!, fixture.stack.web);
  expect(reviewAddress.searchParams.get('reviewProperty')).toBe('schema:isbn');
  expect(reviewAddress.searchParams.get('candidate')).toBe(candidate);

  const reviewerPage = await (await fixture.auth.context('bob')).newPage();
  reviewerPage.setDefaultTimeout(60_000);
  reviewerPage.on('request', (request) => {
    const authorization = request.headers().authorization;
    if (authorization) browserAuthorization.push(authorization);
  });
  const reviewResponse = await reviewerPage.goto(reviewAddress.href, { waitUntil: 'domcontentloaded' });
  expect(reviewResponse?.status()).toBe(200);
  await reviewerPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  const candidateItem = reviewerPage.locator('[data-candidate-item]');
  await candidateItem.waitFor({ state: 'visible' });
  expect(await candidateItem.innerText()).toContain(isbn);

  const accepted = await confirm(reviewerPage, 'Accept suggestion');
  expect(accepted.status()).toBe(200);
  expect(await accepted.json()).toMatchObject({ ok: true, kind: 'accepted' });
  await reviewerPage.getByRole('button', { name: 'Reload current values', exact: true }).click();
  const choice = reviewerPage.locator('[data-candidate-choice]').filter({ hasText: isbn });
  await choice.waitFor({ state: 'visible' });
  await choice.getByRole('checkbox').check();
  await choice.locator(`#rank-${candidate}`).selectOption('normal');
  const selected = await confirm(reviewerPage, 'Select for public subject');
  expect(selected.status()).toBe(200);
  expect(await selected.json()).toMatchObject({ ok: true, kind: 'selected' });
  await reviewerPage.getByRole('status').filter({ hasText: 'The public reader confirms this selection' }).waitFor({
    state: 'visible',
  });
  expect(browserAuthorization).toEqual([]);

  const current = await fixture.current();
  expect(current.id).toBe(subjectId);
  expect(current.type).toBe('bf:Instance');
  expect(current.statements['schema:isbn']?.map((statement) => statement.value.content)).toEqual([isbn]);
  expect(current.statements['schema:isbn']![0]!.references).toEqual([
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] },
  ]);
});
