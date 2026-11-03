import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page, Request as PlaywrightRequest, Response as PlaywrightResponse } from 'playwright';
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
  decision: string | null;
};

type CapturedFunction = { url: string; method: string; headers: Record<string, string>; body: string };

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

function postData(request: PlaywrightRequest): unknown {
  try {
    return request.postDataJSON();
  } catch {
    return undefined;
  }
}

function expectedReader(value: unknown): string | undefined {
  let reader: string | undefined;
  walk(value, (record) => {
    if (typeof record.expectedReader === 'string') reader = record.expectedReader;
  });
  return reader;
}

function statementProperty(value: unknown): string | undefined {
  let property: string | undefined;
  walk(value, (record) => {
    const statement = record.statement;
    if (!statement || typeof statement !== 'object' || Array.isArray(statement)) return;
    const id = (statement as { property?: { id?: unknown } }).property?.id;
    if (typeof id === 'string') property = id;
  });
  return property;
}

function continuation(value: unknown): string[] {
  const tokens: string[] = [];
  walk(value, (record) => {
    if (typeof record.session === 'string' && record.session) tokens.push(record.session);
    if (typeof record.cursor === 'string' && record.cursor) tokens.push(record.cursor);
  });
  return tokens;
}

function serverFunction(response: PlaywrightResponse): boolean {
  return response.request().method() === 'POST' && new URL(response.url()).pathname.startsWith('/_serverFn/');
}

function capture(request: PlaywrightRequest): CapturedFunction {
  const headers = { ...request.headers() };
  for (const name of ['cookie', 'authorization', 'host', 'content-length']) delete headers[name];
  return { url: request.url(), method: request.method(), headers, body: request.postData() ?? '' };
}

function denied(body: unknown): boolean {
  let matched = false;
  walk(body, (record) => {
    if (record.ok === false && record.reason === 'denied') matched = true;
  });
  return matched;
}

function subjectId(): string {
  return new URL(fixture.path, fixture.stack.web).pathname.split('/')[3]!;
}

async function json<T>(response: Response, status: number, action: string): Promise<T> {
  const text = await response.text();
  expect(response.status, `${action}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}

async function nativeCandidates(property: string, persona: string): Promise<Candidate[]> {
  const query = new URLSearchParams({ property, context: GLOBAL_CONTEXT, limit: '20' });
  const body = await json<{ candidates: Candidate[] }>(
    await fixture.stack.kernel(`/v1/subjects/${subjectId()}/candidates?${query}`, {}, persona),
    200,
    `GET candidates ${property} as ${persona}`,
  );
  return body.candidates.filter((candidate) => !('deleted' in candidate && candidate.deleted));
}

function candidatePosts(): NativeKernelRequest[] {
  const path = `/v1/subjects/${subjectId()}/candidates`;
  return fixture.stack.kernelRequests().filter((request) => {
    if (request.fixtureRequest || request.method !== 'POST') return false;
    return new URL(request.url, fixture.stack.kernelOrigin).pathname === path;
  });
}

async function grantBob(): Promise<string> {
  const identity = await fixture.stack.authPersona('bob');
  const grant = await fixture.stack.kernel(
    '/v1/grants',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
      body: JSON.stringify({
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: identity.accountId },
        actions: ['statement:propose'],
        valid: '(,)',
      }),
    },
    'governor',
  );
  expect([201, 409]).toContain(grant.status);
  return identity.accountId;
}

async function openEditor(page: Page): Promise<PlaywrightResponse> {
  const response = await page.goto(new URL(fixture.path, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await page.getByRole('heading', { name: 'Edit facts', exact: true }).waitFor({ state: 'visible' });
  return response!;
}

async function stageLanguage(page: Page): Promise<void> {
  const region = page.getByRole('region', { name: 'language', exact: true });
  await region.getByRole('button', { name: 'Edit this field', exact: true }).click();
  await region.getByText('Private proposal draft').waitFor({ state: 'visible' });
  await region.getByLabel('Value', { exact: true }).fill('ja');
}

async function stageDate(page: Page): Promise<void> {
  const region = page.getByRole('region', { name: 'publication date', exact: true });
  await region.getByRole('button', { name: 'Edit this field', exact: true }).click();
  await region.getByText('Private proposal draft').waitFor({ state: 'visible' });
  await region.getByLabel('Day', { exact: true }).fill('8');
}

async function signOut(page: Page): Promise<void> {
  await page.locator('#account-menu-button').click();
  const signedOut = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/auth/sign-out' && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect((await signedOut).status()).toBeGreaterThanOrEqual(300);
}

async function replay(page: Page, captured: CapturedFunction, csrf: string): Promise<{ status: number; cache: string | null; body: unknown; text: string }> {
  return page.evaluate(async ({ captured, csrf }) => {
    const headers = { ...captured.headers, 'X-CSRF-Token': csrf };
    const response = await fetch(captured.url, {
      method: captured.method,
      headers,
      credentials: 'same-origin',
      body: captured.body,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: response.status, cache: response.headers.get('cache-control'), body, text };
  }, { captured, csrf });
}

test('replacing the editor reader retires protected catalogue work without cancelling an accepted native write', async () => {
  const bobAccountId = await grantBob();
  const bobAuthorization = (await fixture.stack.credentials('bob')).authorization;
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);

  const editorLoads: PlaywrightResponse[] = [];
  const functionCalls: PlaywrightResponse[] = [];
  page.on('response', (response) => {
    if (!serverFunction(response)) return;
    functionCalls.push(response);
    if (expectedReader(postData(response.request())) === fixture.aliceAccountId) editorLoads.push(response);
  });

  const readCall = page.waitForResponse((response) => {
    if (!serverFunction(response) || expectedReader(postData(response.request())) !== fixture.aliceAccountId)
      return false;
    return !statementProperty(postData(response.request()));
  });
  const document = await openEditor(page);
  expect(document.headers()['cache-control']).toContain('private');
  expect(document.headers()['cache-control']).toContain('no-store');
  await ui(page.getByText('Private proposal draft')).toHaveCount(0);
  const loaded = await readCall;
  expect(loaded.headers()['cache-control']).toContain('private');
  expect(loaded.headers()['cache-control']).toContain('no-store');
  const capturedRead = capture(loaded.request());
  expect(continuation(postData(loaded.request()))).toEqual([]);
  expect(page.url()).not.toMatch(/session=|cursor=/i);

  await stageLanguage(page);
  const proposed = page.waitForResponse((response) => {
    return serverFunction(response) && statementProperty(postData(response.request())) === 'schema:inLanguage';
  });
  await page.getByRole('button', { name: 'Submit included changes / retry unresolved', exact: true }).click();
  const proposedResponse = await proposed;
  expect(proposedResponse.status()).toBeLessThan(400);
  expect(expectedReader(postData(proposedResponse.request()))).toBe(fixture.aliceAccountId);
  await page.getByText('Proposed, awaiting review.', { exact: false }).waitFor({ state: 'visible' });
  const capturedSubmit = capture(proposedResponse.request());

  await fixture.stack.flushKernelRequests();
  const acceptedWrites = candidatePosts();
  expect(acceptedWrites.length).toBeGreaterThan(0);
  expect(acceptedWrites.every((request) => request.body && !request.body.includes('expectedReader'))).toBe(true);
  const languageCandidates = await nativeCandidates('schema:inLanguage', 'alice');
  const accepted = languageCandidates.find(
    (candidate) => JSON.stringify(candidate.statement.value) === JSON.stringify({ type: 'value', content: 'ja' }),
  );
  expect(accepted).toBeDefined();
  expect(accepted!.decision).toBeNull();

  const reviewCall = page.waitForResponse((response) => {
    if (!serverFunction(response) || expectedReader(postData(response.request())) !== fixture.aliceAccountId)
      return false;
    const data = postData(response.request());
    let property: string | undefined;
    walk(data, (record) => {
      if (record.property === 'schema:inLanguage') property = 'schema:inLanguage';
    });
    return property === 'schema:inLanguage' && !statementProperty(data);
  });
  await page.getByRole('link', { name: 'Review this proposal', exact: true }).click();
  const reviewed = await reviewCall;
  expect(reviewed.status()).toBeLessThan(400);
  expect(reviewed.headers()['cache-control']).toContain('private');
  expect(reviewed.headers()['cache-control']).toContain('no-store');
  const capturedReview = capture(reviewed.request());
  const protectedTokens = continuation(postData(reviewed.request()));
  await page.locator('[data-candidate-item]').waitFor({ state: 'visible' });
  expect(page.url()).not.toMatch(/session=/i);
  for (const token of protectedTokens) expect(page.url()).not.toContain(token);

  await stageDate(page);
  await fixture.stack.flushKernelRequests();
  await fixture.stack.injectKernelFailureOnce({
    method: 'POST',
    path: `/v1/subjects/${subjectId()}/candidates`,
    status: 503,
    body: JSON.stringify({
      type: 'https://rezics.com/problems/unavailable',
      title: 'Unavailable',
      status: 503,
      code: 'unavailable',
      retryable: true,
      effect_status: 'unknown',
      request_id: crypto.randomUUID(),
    }),
  });
  const uncertain = page.waitForResponse((response) => {
    return serverFunction(response) && statementProperty(postData(response.request())) === 'schema:datePublished';
  });
  await page.getByRole('button', { name: 'Submit included changes / retry unresolved', exact: true }).click();
  const uncertainResponse = await uncertain;
  expect(expectedReader(postData(uncertainResponse.request()))).toBe(fixture.aliceAccountId);
  await page.getByRole('button', { name: 'Submit included changes / retry unresolved', exact: true }).waitFor({
    state: 'visible',
  });
  const capturedUncertain = capture(uncertainResponse.request());

  await fixture.stack.flushKernelRequests();
  const writesBeforeReplacement = candidatePosts().length;
  const aliceSessions = fixture.stack
    .kernelRequests()
    .map((request) => request.session)
    .filter((token): token is string => !!token);

  await signOut(page);
  const bob = await fixture.auth.signIn('bob', { context: page.context(), returnTo: fixture.path });
  expect((await bob.response()).status()).toBe(200);
  const bobPage = bob.context.pages().at(-1)!;
  bobPage.setDefaultTimeout(60_000);
  await bobPage.goto(new URL(fixture.path, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
  await bobPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await bobPage.getByRole('heading', { name: 'Edit facts', exact: true }).waitFor({ state: 'visible' });
  await ui(bobPage.getByText('Private proposal draft')).toHaveCount(0);
  await ui(bobPage.getByText('Proposed, awaiting review.', { exact: false })).toHaveCount(0);
  await ui(bobPage.getByRole('button', { name: 'Submit included changes / retry unresolved', exact: true })).toHaveCount(
    0,
  );
  await ui(bobPage.locator('[data-candidate-item]')).toHaveCount(0);
  expect(new URL(bobPage.url()).search).toBe('');
  for (const token of [...protectedTokens, ...aliceSessions]) expect(bobPage.url()).not.toContain(token);

  await bobPage.locator('#account-menu-button').click();
  const csrf = await bobPage.locator('input[name="csrf_token"]').inputValue();
  expect(csrf.length).toBeGreaterThan(0);
  for (const captured of [capturedRead, capturedReview, capturedSubmit, capturedUncertain]) {
    const result = await replay(bobPage, captured, csrf);
    expect(result.status).toBeLessThan(400);
    expect(result.cache).toContain('private');
    expect(result.cache).toContain('no-store');
    expect(denied(result.body)).toBe(true);
    expect(result.text).not.toContain(accepted!.id);
    expect(result.text).not.toContain('"ja"');
    for (const token of protectedTokens) expect(result.text).not.toContain(token);
    expect(expectedReader(JSON.parse(captured.body) as unknown)).toBe(fixture.aliceAccountId);
  }

  await fixture.stack.syncKernelRequests();
  await fixture.stack.refreshKernelRequests();
  const writesAfterReplay = candidatePosts();
  expect(writesAfterReplay).toHaveLength(writesBeforeReplacement);
  expect(writesAfterReplay.some((request) => request.authorization === bobAuthorization)).toBe(false);
  expect(
    writesAfterReplay.some((request) => request.body?.includes(bobAccountId) || request.body?.includes('expectedReader')),
  ).toBe(false);

  const stillAccepted = (await nativeCandidates('schema:inLanguage', 'alice')).find(
    (candidate) => candidate.id === accepted!.id,
  );
  expect(stillAccepted).toBeDefined();
  expect(JSON.stringify(stillAccepted!.statement.value)).toBe(JSON.stringify({ type: 'value', content: 'ja' }));
  const publicAfter = await fixture.current();
  expect(publicAfter.statements['schema:inLanguage']![0]!.value).toEqual({ type: 'value', content: fixture.language });

  const logs = `${await fixture.stack.workerLogs()}\n${fixture.stack.webOutput()}`;
  for (const token of [...protectedTokens, ...aliceSessions]) {
    if (token.length < 8) continue;
    expect(logs).not.toContain(token);
  }
  expect(editorLoads.every((response) => response.headers()['cache-control']?.includes('no-store'))).toBe(true);
  expect(functionCalls.some((response) => expectedReader(postData(response.request())) === fixture.aliceAccountId)).toBe(
    true,
  );
});
