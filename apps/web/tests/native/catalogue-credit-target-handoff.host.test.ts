import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import { expect as playExpect } from 'playwright/test';
import { candidateContext } from '../../src/subject/candidates.ts';
import {
  createNativeCatalogueRelationsFixture,
  hydrate,
  readPublicStatements,
  readSlotCandidates,
  type NativeCatalogueRelationsFixture,
} from './catalogue-relations-fixture.ts';

setDefaultTimeout(900_000);
let fixture: NativeCatalogueRelationsFixture;

beforeAll(async () => {
  fixture = await createNativeCatalogueRelationsFixture();
  const alice = await fixture.stack.authPersona('alice');
  const grant = await fixture.stack.kernel(
    '/v1/grants',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
      body: JSON.stringify({
        resource: { route: 0, id: candidateContext },
        subject: { kind: 'account', id: alice.accountId },
        actions: ['statement:propose', 'context:accept', 'context:adopt'],
        valid: '(,)',
      }),
    },
    'governor',
  );
  if (grant.status !== 201 && grant.status !== 409)
    throw new Error(`Granting relation selection authority to Alice: HTTP ${grant.status} ${await grant.text()}`);
}, 300_000);

afterAll(async () => fixture?.close(), 180_000);

const voiceCredit = 'wdt:P725';
const citation = 'https://example.org/created-credit-identity';

async function confirmNamed(page: Page, label: string): Promise<void> {
  const group = page.getByRole('group', { name: `Confirm: ${label}` });
  if (!(await group.isVisible())) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await playExpect(group).toBeVisible();
  }
  await group.getByRole('button', { name: label, exact: true }).click();
}

async function pickRole(page: Page, label: string): Promise<void> {
  const box = page.getByRole('combobox', { name: 'character role', exact: true });
  await box.fill(label);
  await playExpect(page.getByRole('option', { name: label, exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('option', { name: label, exact: true }).click();
}

function browserPosts(path: string) {
  return fixture.stack.kernelRequests().filter((request) => {
    const requestPath = request.url.split('?')[0];
    return !request.fixtureRequest && request.method === 'POST' && requestPath === path;
  });
}

test('a created person returns to the exact work credit draft and is selected explicitly after native read retry', async () => {
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  const opened = await page.goto(`${fixture.stack.web}${fixture.editorPath}`, { waitUntil: 'domcontentloaded' });
  expect(opened?.status()).toBe(200);
  await hydrate(page);

  await page.getByRole('button', { name: 'Open relation editor', exact: true }).click();
  await playExpect(page.getByLabel('Relation', { exact: true })).toBeVisible();
  await page.getByLabel('Relation', { exact: true }).selectOption({ label: 'voice actor' });
  await page.getByLabel('Qualifier', { exact: true }).selectOption({ label: 'character role' });
  await page.getByRole('button', { name: 'Add a qualifier', exact: true }).click();
  await pickRole(page, fixture.firstRole.label);
  await page.getByLabel('Citation URL', { exact: true }).fill(citation);
  await page.getByRole('button', { name: 'Add citation', exact: true }).click();

  const beforeCreate = fixture.stack.kernelRequests().length;
  await page.getByRole('button', { name: 'Create a missing person or organization', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/en/catalogue/people');
  await hydrate(page);
  expect(new URL(page.url()).searchParams.get('work')).toBe(fixture.movie.id);

  const label = `Native created credit identity ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel('Type', { exact: true }).selectOption('schema:Person');
  await page.getByLabel('Name', { exact: true }).fill(label);
  await fixture.stack.injectCreatedSubjectReadFailureOnce({
    status: 503,
    body: '{"title":"Created identity reader unavailable","status":503}',
  });
  await page.getByRole('button', { name: 'Create subject', exact: true }).click();
  await page.locator('[data-people-create-review]').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Create subject', exact: true }).click();
  const createdOutcome = page.locator('section[role="status"]');
  await createdOutcome.getByRole('button', { name: 'Retry', exact: true }).waitFor({ state: 'visible' });
  await fixture.stack.syncKernelRequests();

  const createPosts = browserPosts('/v1/subjects').filter((request) => request.url === '/v1/subjects');
  expect(createPosts).toHaveLength(1);
  expect(createPosts[0]?.responseStatus).toBe(201);
  expect(JSON.parse(createPosts[0]!.body!)).toEqual({ type: 'schema:Person', labels: { en: label } });
  const failedRead = fixture.stack
    .kernelRequests()
    .slice(beforeCreate)
    .findLast((request) => request.method === 'GET' && request.failure?.status === 503);
  expect(failedRead?.responseStatus).toBe(503);
  expect(failedRead?.url).toMatch(/^\/v1\/subjects\/[0-9a-f-]{36}$/i);
  const createdId = failedRead!.url.slice('/v1/subjects/'.length);

  await createdOutcome.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Return to work credit draft', exact: true }).waitFor({ state: 'visible' });
  await fixture.stack.syncKernelRequests();
  expect(browserPosts('/v1/subjects').filter((request) => request.url === '/v1/subjects')).toHaveLength(1);
  expect(
    fixture.stack
      .kernelRequests()
      .filter((request) => request.method === 'GET' && request.url === `/v1/subjects/${createdId}`)
      .map((request) => request.responseStatus),
  ).toContain(200);
  expect(await readPublicStatements(fixture.stack, fixture.movie.id, voiceCredit)).toEqual([]);

  await page.getByRole('button', { name: 'Return to work credit draft', exact: true }).click();
  await page.waitForURL((url) => url.pathname.endsWith('/relation-edit'));
  await hydrate(page);
  const chooseCreated = `Use ${label} as the credit target`;
  await playExpect(page.getByRole('button', { name: chooseCreated, exact: true })).toBeVisible();
  expect(await page.getByRole('combobox', { name: 'Target subject', exact: true }).inputValue()).toBe('');
  expect(browserPosts(`/v1/subjects/${fixture.movie.id}/candidates`)).toHaveLength(0);
  await page.getByRole('button', { name: chooseCreated, exact: true }).click();
  await playExpect(page.getByRole('combobox', { name: 'Target subject', exact: true })).toHaveValue(label);
  expect(await readPublicStatements(fixture.stack, fixture.movie.id, voiceCredit)).toEqual([]);
  expect(browserPosts(`/v1/subjects/${fixture.movie.id}/candidates`)).toHaveLength(0);

  await confirmNamed(page, 'Propose relation');
  await playExpect(page.getByRole('status').filter({ hasText: 'Relation proposed.' })).toBeVisible();
  await fixture.stack.syncKernelRequests();
  const proposalRequest = browserPosts(`/v1/subjects/${fixture.movie.id}/candidates`).at(-1);
  expect(proposalRequest?.responseStatus).toBe(201);
  const proposal = JSON.parse(proposalRequest!.body!) as {
    slot?: { property?: string; target?: string; key?: string };
    statement?: {
      value?: { content?: string };
      qualifiers?: { property?: { id?: string }; value?: { content?: unknown } }[];
      references?: { parts?: { property?: { id?: string }; value?: { content?: unknown } }[] }[];
    };
  };
  expect(proposal.slot).toMatchObject({ property: voiceCredit, target: createdId, key: fixture.firstRole.id });
  expect(proposal.statement?.value?.content).toBe(createdId);
  expect(proposal.statement?.qualifiers).toContainEqual(
    expect.objectContaining({ property: { id: 'wdt:P453' }, value: { content: fixture.firstRole.id } }),
  );
  expect(proposal.statement?.references?.[0]?.parts).toContainEqual(
    expect.objectContaining({ property: { id: 'schema:url' }, value: { content: citation } }),
  );
  expect(await readPublicStatements(fixture.stack, fixture.movie.id, voiceCredit)).toEqual([]);

  const slot = { property: voiceCredit, target: createdId, key: fixture.firstRole.id };
  expect(await readSlotCandidates(fixture.stack, fixture.movie.id, slot)).toHaveLength(1);
  await confirmNamed(page, 'Accept suggestion');
  await playExpect(page.getByRole('status').filter({ hasText: 'Suggestion accepted' })).toBeVisible();
  expect(await readPublicStatements(fixture.stack, fixture.movie.id, voiceCredit)).toEqual([]);
  await confirmNamed(page, 'Select for public subject');
  await playExpect(page.getByRole('status').filter({ hasText: 'selected' })).toBeVisible();

  const publicCredits = await readPublicStatements(fixture.stack, fixture.movie.id, voiceCredit);
  expect(publicCredits).toHaveLength(1);
  expect(publicCredits[0]?.value?.content).toBe(createdId);
  expect(publicCredits[0]?.qualifiers).toContainEqual(
    expect.objectContaining({ property: { id: 'wdt:P453' }, value: { content: fixture.firstRole.id } }),
  );
  expect(publicCredits[0]?.references?.[0]?.parts).toContainEqual(
    expect.objectContaining({ property: { id: 'schema:url' }, value: { content: citation } }),
  );
  await page.close();
});
