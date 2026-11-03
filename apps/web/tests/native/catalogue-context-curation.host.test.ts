import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import {
  createCatalogueContextCurationFixture,
  type CatalogueContextCurationFixture,
  type CatalogueContextSubject,
} from './catalogue-context-curation-fixture.ts';
import type { NativeKernelRequest } from './stack.ts';

setDefaultTimeout(600_000);

let fixture: CatalogueContextCurationFixture | undefined;

beforeAll(async () => {
  fixture = await createCatalogueContextCurationFixture();
}, 600_000);

afterAll(async () => {
  await fixture?.close();
}, 180_000);

type SubjectRead = {
  subject: {
    context: string;
    statements: Record<string, { id: string; value: { content?: unknown } }[]>;
    resolution: Record<string, string>;
  };
};

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  const main = page.locator('#main-content');
  if (await main.count()) await main.waitFor({ state: 'visible' });
}

async function kernelJson<T>(path: string, persona?: string): Promise<T> {
  const response = await fixture!.stack.kernel(path, undefined, persona);
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function liveRequests(after: number): Promise<NativeKernelRequest[]> {
  await fixture!.stack.refreshKernelRequests();
  return fixture!.stack
    .kernelRequests()
    .slice(after)
    .filter((request) => !request.fixtureRequest);
}

async function openReview(page: Page, subject: CatalogueContextSubject, search: string): Promise<void> {
  const url = `${fixture!.stack.web}${subject.href}/context-review?${search}`;
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  await hydrate(page);
  expect(response?.status(), await page.locator('body').innerText()).toBe(200);
  await page.getByRole('heading', { name: 'Review Context', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Review proposals', exact: true }).click();
  await page.locator('[data-context-comparison]').waitFor({ state: 'visible', timeout: 60_000 });
}

async function confirmNamed(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).first().click();
  const region = page.locator('section').filter({ has: page.getByRole('heading', { name: `Confirm: ${name}` }) });
  await region.waitFor({ state: 'visible' });
  await region.getByRole('button', { name, exact: true }).click();
}

async function applyMode(page: Page, mode: 'replace' | 'inherit' | 'suppress'): Promise<void> {
  await page.getByLabel('Selection mode').selectOption(mode);
  await confirmNamed(page, 'Apply to this Context');
  await page
    .getByText(
      'Context selection saved. Reload to review the current reading. This does not publish the whole Context.',
      {
        exact: true,
      },
    )
    .waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Reload current values', exact: true }).click();
  await page.locator('[data-context-comparison]').waitFor({ state: 'visible', timeout: 60_000 });
}

function values(read: SubjectRead, property: string): unknown[] {
  return (read.subject.statements[property] ?? []).map((statement) => statement.value.content);
}

test('community Context review compares Global independently and replace inherit suppress keep Global unchanged', async () => {
  const { stack, auth, journey } = fixture!;
  const alice = await auth.signIn('alice');
  const page = await alice.context.newPage();
  const before = stack.kernelRequests().length;
  await openReview(page, journey, `context=${journey.contextId}&property=schema:inLanguage`);
  await page
    .getByText('This slot inherits Global values, subject to this Context’s decisions.', { exact: true })
    .waitFor();
  await page.getByText('Current public Global values', { exact: true }).waitFor();
  await page.getByText('Community Context', { exact: true }).waitFor();
  await page.locator('[data-context-comparison]').getByText('ja', { exact: true }).first().waitFor();

  await page.getByRole('button', { name: 'Review suggestion', exact: true }).click();
  await confirmNamed(page, 'Accept suggestion');
  await page
    .getByText('Suggestion accepted in this Context. Selection remains a separate decision.', { exact: true })
    .waitFor();
  const accepted = (await liveRequests(before)).filter(
    (request) => request.method === 'POST' && request.url.includes(':accept'),
  );
  expect(accepted).toHaveLength(1);
  expect(accepted[0]!.url).toContain(journey.languageCandidate);

  await page.getByRole('button', { name: 'Reload current values', exact: true }).click();
  await page.locator('[data-candidate-draft]').waitFor({ state: 'visible' });
  await page.locator('#include-' + journey.languageCandidate).waitFor({ state: 'visible' });
  await page.locator(`#include-${journey.languageCandidate}`).click();
  await applyMode(page, 'replace');
  await page.getByText('This slot uses its own replacement selection.', { exact: true }).waitFor();

  await applyMode(page, 'inherit');
  await page
    .getByText('This slot inherits Global values, subject to this Context’s decisions.', { exact: true })
    .waitFor();
  await applyMode(page, 'suppress');
  await page.getByText('This slot suppresses inherited values.', { exact: true }).waitFor();

  const global = await kernelJson<SubjectRead>(`/v1/subjects/${journey.id}`);
  expect(global.subject.context).toBe('00000000-0000-8000-8000-000000000000');
  expect(values(global, 'schema:inLanguage')).toEqual(['ja']);
  expect(values(global, 'schema:author')).toEqual([journey.authorId]);

  const community = await kernelJson<SubjectRead>(`/v1/subjects/${journey.id}?context=${journey.contextId}`, 'alice');
  expect(community.subject.context).toBe(journey.contextId);
  expect(community.subject.resolution['schema:inLanguage']).toBe('suppressed');
  expect(values(community, 'schema:inLanguage')).toEqual([]);

  const slotStart = stack.kernelRequests().length;
  await openReview(page, journey, `context=${journey.contextId}&property=schema:author&target=${journey.authorId}`);
  await page
    .getByText(
      'Relation resolution describes the whole field. These values show only the addressed slot’s disclosed preview.',
      {
        exact: true,
      },
    )
    .waitFor();
  const candidateReads = (await liveRequests(slotStart)).filter(
    (request) => request.method === 'GET' && request.url.includes('/candidates'),
  );
  expect(candidateReads.some((request) => request.url.includes(`target=${journey.authorId}`))).toBe(true);
  expect(candidateReads.every((request) => request.url.includes(`context=${journey.contextId}`))).toBe(true);
  await applyMode(page, 'inherit');
  const slotAdopts = (await liveRequests(slotStart)).filter(
    (request) => request.method === 'POST' && request.url.endsWith(':adopt'),
  );
  expect(slotAdopts.length).toBeGreaterThan(0);

  const stillGlobal = await kernelJson<SubjectRead>(`/v1/subjects/${journey.id}`);
  expect(values(stillGlobal, 'schema:inLanguage')).toEqual(['ja']);
  expect(values(stillGlobal, 'schema:author')).toEqual([journey.authorId]);
  expect(
    (await liveRequests(before)).some((request) => request.method !== 'GET' && request.url.startsWith('/v1/realms')),
  ).toBe(false);
  await page.close();
});

test('stale comparison keeps draft and mode; uncertain confirmation preserves the sealed key; reading grants no write', async () => {
  const { stack, auth, seams } = fixture!;
  const adoptPath = `/v1/subjects/${seams.id}:adopt`;
  const alice = await auth.signIn('alice');
  const page = await alice.context.newPage();
  await openReview(page, seams, `context=${seams.contextId}&property=schema:inLanguage`);
  await page.getByLabel('Selection mode').selectOption('suppress');
  await stack.injectKernelFailureOnce({
    method: 'POST',
    path: adoptPath,
    status: 409,
    body: JSON.stringify({
      type: 'https://rezics.com/problems/conflict',
      title: 'Conflict',
      status: 409,
      code: 'stale_editorial_head',
      request_id: crypto.randomUUID(),
      retryable: false,
      effect_status: 'not_applied',
    }),
  });
  await confirmNamed(page, 'Apply to this Context');
  await page
    .getByText(
      'The comparison changed. Your selection draft is preserved. Reload, compare again, then explicitly confirm a new request.',
      {
        exact: true,
      },
    )
    .waitFor();
  expect(await page.getByLabel('Selection mode').inputValue()).toBe('suppress');
  await page.getByRole('button', { name: 'Reload current values', exact: true }).click();
  await page.locator('[data-candidate-draft]').waitFor({ state: 'visible' });
  expect(await page.getByLabel('Selection mode').inputValue()).toBe('suppress');

  const uncertainStart = stack.kernelRequests().length;
  await stack.injectKernelFailureOnce({
    method: 'POST',
    path: adoptPath,
    status: 503,
    body: JSON.stringify({
      type: 'https://rezics.com/problems/overloaded',
      title: 'Overloaded',
      status: 503,
      code: 'overloaded',
      request_id: crypto.randomUUID(),
      retryable: true,
      effect_status: 'not_applied',
    }),
  });
  await confirmNamed(page, 'Apply to this Context');
  await page.getByRole('button', { name: 'Retry confirmation', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Retry confirmation', exact: true }).click();
  await page
    .getByText(
      'Context selection saved. Reload to review the current reading. This does not publish the whole Context.',
      {
        exact: true,
      },
    )
    .waitFor();
  const retries = (await liveRequests(uncertainStart)).filter(
    (request) => request.method === 'POST' && request.url === adoptPath,
  );
  expect(retries.length).toBeGreaterThanOrEqual(2);
  expect(retries[0]!.idempotencyKey).toBe(retries[1]!.idempotencyKey);
  expect(retries[0]!.idempotencyKey).toBeTruthy();

  const bob = await auth.signIn('bob');
  const bobPage = await bob.context.newPage();
  await openReview(bobPage, seams, `context=${seams.contextId}&property=schema:inLanguage`);
  const deniedStart = stack.kernelRequests().length;
  await confirmNamed(bobPage, 'Apply to this Context');
  await bobPage.getByText('You do not have permission for this operation.', { exact: true }).waitFor();
  const denied = (await liveRequests(deniedStart)).filter(
    (request) => request.method === 'POST' && request.url === adoptPath,
  );
  expect(denied.some((request) => request.failure?.status === 403)).toBe(true);
  const global = await kernelJson<SubjectRead>(`/v1/subjects/${seams.id}`);
  expect(values(global, 'schema:inLanguage')).toEqual(['ja']);
  await page.close();
  await bobPage.close();
});
