import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Page, Request as PlaywrightRequest } from 'playwright';
import {
  startCatalogueTermsFixture,
  type CatalogueTermsFixture,
  type CatalogueTermsSubject,
} from './catalogue-terms-fixture.ts';
import type { NativeKernelRequest } from './stack.ts';

let fixture: CatalogueTermsFixture;
beforeAll(async () => {
  fixture = await startCatalogueTermsFixture();
}, 300_000);
afterAll(async () => fixture && fixture.close(), 180_000);

type SubjectRead = {
  subject: {
    id: string;
    revision: number;
    labels: Record<string, string>;
    descriptions: Record<string, string>;
    aliases: Record<string, string[]>;
  };
};
type TermsPatch = {
  labels?: Record<string, string | null>;
  descriptions?: Record<string, string | null>;
  aliases?: Record<string, string[] | null>;
};
type TermsCommand = { id: string; etag: string; key: string; patch: TermsPatch };

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function readSubject(id: string): Promise<SubjectRead> {
  const response = await fixture.stack.kernel(`/v1/subjects/${encodeURIComponent(id)}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as SubjectRead;
}

async function patchTerms(id: string, revision: number, patch: TermsPatch): Promise<void> {
  const response = await fixture.stack.kernel(
    `/v1/subjects/${encodeURIComponent(id)}/terms`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'if-match': `"${revision}"`,
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify(patch),
    },
    'editor',
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

function fieldset(page: Page, legend: string) {
  return page.locator('fieldset').filter({ has: page.locator('legend', { hasText: legend }) });
}

async function replaceField(page: Page, legend: string, value: string): Promise<void> {
  const group = fieldset(page, legend);
  await group.locator('select').selectOption('set');
  const control = group.getByLabel(legend, { exact: true });
  await control.waitFor({ state: 'visible' });
  await control.fill(value);
}

async function removeField(page: Page, legend: string): Promise<void> {
  await fieldset(page, legend).locator('select').selectOption('remove');
}

function extractCommand(value: unknown): TermsCommand | undefined {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id === 'string' &&
    typeof record.etag === 'string' &&
    typeof record.key === 'string' &&
    record.patch
  )
    return record as TermsCommand;
  for (const nested of Object.values(record)) {
    const found = extractCommand(nested);
    if (found) return found;
  }
}

function commandFrom(request: PlaywrightRequest): TermsCommand | undefined {
  try {
    return extractCommand(request.postDataJSON());
  } catch {
    const text = request.postData();
    if (!text) return;
    try {
      return extractCommand(JSON.parse(text));
    } catch {
      return;
    }
  }
}

async function openTerms(page: Page, subject: CatalogueTermsSubject): Promise<void> {
  const response = await page.goto(`${fixture.stack.web}${subject.termsPath}`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await hydrate(page);
  await page.getByRole('heading', { name: 'Edit names and descriptions', exact: true }).waitFor({ state: 'visible' });
}

async function submitTerms(page: Page, name: string): Promise<TermsCommand[]> {
  const commands: TermsCommand[] = [];
  const pending = page.waitForRequest((request) => {
    if (request.method() !== 'POST' || !new URL(request.url()).pathname.startsWith('/_serverFn/')) return false;
    const command = commandFrom(request);
    if (!command?.patch) return false;
    commands.push(command);
    return true;
  });
  await page.getByRole('button', { name, exact: true }).click();
  await pending;
  return commands;
}

async function resolveReviewedDraft(page: Page, field: string): Promise<void> {
  const group = fieldset(page, `en: ${field}`);
  await group.getByLabel('Resolution', { exact: true }).selectOption('draft');
  await page.getByRole('button', { name: 'Review resolved patch', exact: true }).click();
  await page.getByRole('heading', { name: 'Resolved patch to submit', exact: true }).waitFor({ state: 'visible' });
}

function bff(requests: readonly NativeKernelRequest[], after: number, id: string) {
  const path = `/v1/subjects/${id}`;
  return requests
    .slice(after)
    .filter((request) => !request.fixtureRequest && request.url.split('?')[0]!.startsWith(path));
}

describe('native terms conflict resolution', () => {
  test('a contributor resolves one overlapping field, keeps another current language, removes an admitted field and rereads the native result', async () => {
    const { stack, auth } = fixture;
    const subject = await fixture.createSubject(`Native terms resolve ${crypto.randomUUID()}`);
    const second = await fixture.createSubject(`Native terms second ${crypto.randomUUID()}`);
    const uncertain = await fixture.createSubject(`Native terms custody ${crypto.randomUUID()}`);
    const journey = await auth.signIn('alice', { returnTo: subject.termsPath });
    const page = journey.context.pages().at(-1)!;
    page.setDefaultTimeout(30_000);
    await hydrate(page);
    await page.getByRole('heading', { name: 'Edit names and descriptions', exact: true }).waitFor({ state: 'visible' });

    const original = await readSubject(subject.id);
    await replaceField(page, 'Name', 'Resolved native title');
    await removeField(page, 'Short description (optional)');
    await patchTerms(subject.id, original.subject.revision, {
      labels: { en: 'Concurrent native title', ja: '同時の題名' },
    });
    const beforeFirst = stack.kernelRequests().length;
    await submitTerms(page, 'Save terms');
    await page
      .getByText('These terms changed. Reload and compare before confirming again. Your draft is kept.')
      .waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Reload and compare', exact: true }).click();
    await page.getByText('Concurrent native title', { exact: true }).waitFor({ state: 'visible' });
    await page.getByText('同時の題名', { exact: true }).waitFor({ state: 'visible' });
    await resolveReviewedDraft(page, 'Name');
    await page.getByText('Unchanged languages omitted from this patch').waitFor({ state: 'visible' });
    await page.getByText('ja', { exact: true }).first().waitFor({ state: 'visible' });
    const replacement = fieldset(page, 'en: Name').getByLabel('Resolution', { exact: true });
    await replacement.selectOption('replacement');
    await fieldset(page, 'en: Name').getByLabel('Replacement', { exact: true }).fill('Reviewed replacement title');
    await expect(page.getByRole('heading', { name: 'Resolved patch to submit', exact: true })).toHaveCount(0);
    await replacement.selectOption('draft');
    await page.getByRole('button', { name: 'Review resolved patch', exact: true }).click();
    const first = await submitTerms(page, 'Confirm changes to latest terms');
    await page.getByText('Terms saved.').waitFor({ state: 'visible' });
    await stack.refreshKernelRequests();
    const firstPatches = bff(stack.kernelRequests(), beforeFirst, subject.id).filter(
      (request) => request.method === 'PATCH',
    );
    expect(firstPatches[0]?.failure?.status).toBe(412);
    expect(first[0]?.etag).toBe(`"${original.subject.revision + 1}"`);
    expect(first[0]?.key).not.toBe(firstPatches[0]?.idempotencyKey);
    expect(first[0]?.patch).toEqual({
      labels: { en: 'Resolved native title' },
      descriptions: { en: null },
    });
    const saved = await readSubject(subject.id);
    expect(saved.subject.labels).toEqual({
      ...subject.labels,
      en: 'Resolved native title',
      ja: '同時の題名',
    });
    expect(saved.subject.descriptions).toEqual({ ja: subject.descriptions.ja! });
    expect(saved.subject.aliases).toEqual(subject.aliases);

    await openTerms(page, second);
    const secondOriginal = await readSubject(second.id);
    await replaceField(page, 'Name', 'Second draft title');
    await patchTerms(second.id, secondOriginal.subject.revision, { labels: { en: 'Second concurrent title' } });
    await submitTerms(page, 'Save terms');
    await page.getByRole('button', { name: 'Reload and compare', exact: true }).click();
    await page.getByText('Second concurrent title', { exact: true }).waitFor({ state: 'visible' });
    await resolveReviewedDraft(page, 'Name');
    const current = await readSubject(second.id);
    await patchTerms(second.id, current.subject.revision, { labels: { en: 'Third concurrent title' } });
    await submitTerms(page, 'Confirm changes to latest terms');
    await page
      .getByText('These terms changed. Reload and compare before confirming again. Your draft is kept.')
      .waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Reload and compare', exact: true }).click();
    await page.getByText('Third concurrent title', { exact: true }).waitFor({ state: 'visible' });
    await resolveReviewedDraft(page, 'Name');
    const retry = await submitTerms(page, 'Confirm changes to latest terms');
    await page.getByText('Terms saved.').waitFor({ state: 'visible' });
    expect(retry[0]?.patch).toEqual({ labels: { en: 'Second draft title' } });
    expect((await readSubject(second.id)).subject.labels.en).toBe('Second draft title');
    expect((await readSubject(second.id)).subject.labels.ja).toBe(second.labels.ja);

    await openTerms(page, uncertain);
    await replaceField(page, 'Name', 'Uncertain resolved title');
    await stack.injectKernelFailureOnce({
      method: 'PATCH',
      path: `/v1/subjects/${uncertain.id}/terms`,
      status: 503,
      body: JSON.stringify({
        type: 'https://rezics.com/problems/overloaded',
        title: 'Overloaded',
        status: 503,
        code: 'overloaded',
        request_id: crypto.randomUUID(),
        retryable: true,
        effect_status: 'unknown',
      }),
    });
    const lost = await submitTerms(page, 'Save terms');
    await page
      .getByText('The result is uncertain. Retry the same request; your draft and request key are kept.')
      .waitFor({ state: 'visible' });
    const replayed = await submitTerms(page, 'Retry');
    await page.getByText('Terms saved.').waitFor({ state: 'visible' });
    expect(replayed[0]).toEqual(lost[0]);
    expect((await readSubject(uncertain.id)).subject.labels.en).toBe('Uncertain resolved title');
  }, 900_000);
});
