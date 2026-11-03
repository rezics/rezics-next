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
    statements?: Record<string, unknown>;
  };
};
type TermsPatch = {
  labels?: Record<string, string | null>;
  descriptions?: Record<string, string | null>;
  aliases?: Record<string, string[] | null>;
};
type TermsCommand = { id: string; etag: string; key: string; patch: TermsPatch; session?: string };

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function readSubject(id: string): Promise<SubjectRead> {
  const response = await fixture.stack.kernel(`/v1/subjects/${encodeURIComponent(id)}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as SubjectRead;
}

async function patchTerms(id: string, revision: number, patch: TermsCommand['patch']): Promise<void> {
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

function extractCommand(value: unknown): TermsCommand | undefined {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.id === 'string' && typeof record.etag === 'string' && typeof record.key === 'string' && record.patch)
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
  await page.getByRole('button', { name: 'Save terms', exact: true }).waitFor({ state: 'visible' });
}

async function submitTerms(page: Page, name: string): Promise<{ request: PlaywrightRequest; commands: TermsCommand[] }> {
  const commands: TermsCommand[] = [];
  const pending = page.waitForRequest((request) => {
    if (request.method() !== 'POST' || !new URL(request.url()).pathname.startsWith('/_serverFn/')) return false;
    const command = commandFrom(request);
    if (!command?.patch) return false;
    commands.push(command);
    return true;
  });
  await page.getByRole('button', { name, exact: true }).click();
  return { request: await pending, commands };
}

function bff(requests: readonly NativeKernelRequest[], after: number, id: string) {
  const path = `/v1/subjects/${id}`;
  return requests.slice(after).filter((request) => !request.fixtureRequest && request.url.split('?')[0]!.startsWith(path));
}

describe('native catalogue terms', () => {
  test('the Terms route patches names through the session BFF and recovers stale or uncertain writes', async () => {
    const { stack, auth } = fixture;
    const corrected = await fixture.createSubject(`Native terms book ${crypto.randomUUID()}`);
    const stale = await fixture.createSubject(`Native terms stale ${crypto.randomUUID()}`);
    const uncertain = await fixture.createSubject(`Native terms retry ${crypto.randomUUID()}`);
    const concealed = await fixture.createSubject(`Native terms withheld ${crypto.randomUUID()}`);
    const name = 'Corrected native title';
    const description = 'Corrected native description.';
    const aliases = 'Corrected alias\nSecond alias';
    const journey = await auth.signIn('alice', { returnTo: corrected.termsPath });
    const page = journey.context.pages().at(-1)!;
    page.setDefaultTimeout(30_000);
    await hydrate(page);
    await page.getByRole('heading', { name: 'Edit names and descriptions', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Save terms', exact: true }).waitFor({ state: 'visible' });

    const beforeCorrection = stack.kernelRequests().length;
    const original = await readSubject(corrected.id);
    await replaceField(page, 'Name', name);
    await replaceField(page, 'Short description (optional)', description);
    await replaceField(page, 'Aliases (optional)', aliases);
    const saved = await submitTerms(page, 'Save terms');
    await page.getByText('Terms saved.').waitFor({ state: 'visible' });
    await stack.refreshKernelRequests();
    const correctionTraffic = bff(stack.kernelRequests(), beforeCorrection, corrected.id);
    const patch = correctionTraffic.find(
      (request) => request.method === 'PATCH' && request.url === `/v1/subjects/${corrected.id}/terms`,
    );
    const patchIndex = patch ? correctionTraffic.indexOf(patch) : -1;
    const reread = correctionTraffic.find(
      (request, index) =>
        index > patchIndex && request.method === 'GET' && request.url.split('?')[0] === `/v1/subjects/${corrected.id}`,
    );
    expect(saved.commands).toHaveLength(1);
    expect(saved.commands[0]).toMatchObject({
      id: corrected.id,
      etag: `"${original.subject.revision}"`,
      patch: {
        labels: { en: name },
        descriptions: { en: description },
        aliases: { en: ['Corrected alias', 'Second alias'] },
      },
    });
    expect(patch).toBeDefined();
    expect(patch?.ifMatch).toBe(`"${original.subject.revision}"`);
    expect(patch?.idempotencyKey).toBe(saved.commands[0]!.key);
    expect(JSON.parse(patch?.body ?? 'null')).toEqual(saved.commands[0]!.patch);
    expect(reread).toBeDefined();
    expect(reread?.session).toBeTruthy();
    expect(correctionTraffic.some((request) => request.method === 'POST' && request.url.includes('/candidates'))).toBe(
      false,
    );
    const current = await readSubject(corrected.id);
    expect(current.subject.revision).toBeGreaterThan(original.subject.revision);
    expect(current.subject.labels).toEqual({ ...corrected.labels, en: name });
    expect(current.subject.descriptions).toEqual({ ...corrected.descriptions, en: description });
    expect(current.subject.aliases).toEqual({ ...corrected.aliases, en: ['Corrected alias', 'Second alias'] });
    await page.getByText(name, { exact: true }).waitFor({ state: 'visible' });
    await page.getByText(corrected.labels.ja, { exact: true }).waitFor({ state: 'visible' });
    await page.getByText(corrected.descriptions.ja, { exact: true }).waitFor({ state: 'visible' });
    await page.getByText(corrected.aliases.ja[0]!, { exact: true }).waitFor({ state: 'visible' });
    const detail = await stack.kernel(`/v1/subjects/${corrected.id}/revisions/${current.subject.revision}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { change?: { kind?: string } }).change?.kind).toBe('terms');

    await openTerms(page, corrected);
    const unchanged = await readSubject(corrected.id);
    const beforeNoEffect = stack.kernelRequests().length;
    await replaceField(page, 'Name', name);
    await submitTerms(page, 'Save terms');
    await page.getByText('Terms saved.').waitFor({ state: 'visible' });
    expect((await readSubject(corrected.id)).subject.revision).toBe(unchanged.subject.revision);
    await stack.refreshKernelRequests();
    const noEffectPatch = bff(stack.kernelRequests(), beforeNoEffect, corrected.id).find(
      (request) => request.method === 'PATCH',
    );
    expect(JSON.parse(noEffectPatch?.body ?? 'null')).toEqual({ labels: { en: name } });
    expect(noEffectPatch?.ifMatch).toBe(`"${unchanged.subject.revision}"`);

    await openTerms(page, stale);
    const staleBefore = await readSubject(stale.id);
    await replaceField(page, 'Name', 'Alice stale draft');
    await patchTerms(stale.id, staleBefore.subject.revision, { labels: { en: 'Concurrent native title' } });
    const beforeStale = stack.kernelRequests().length;
    await submitTerms(page, 'Save terms');
    await page.getByText('These terms changed. Reload and compare before confirming again. Your draft is kept.').waitFor({
      state: 'visible',
    });
    await page.getByRole('button', { name: 'Reload and compare', exact: true }).click();
    await page.getByText('Concurrent native title', { exact: true }).waitFor({ state: 'visible' });
    await page.getByText('Alice stale draft', { exact: true }).waitFor({ state: 'visible' });
    await submitTerms(page, 'Confirm changes to latest terms');
    await page.getByText('Terms saved.').waitFor({ state: 'visible' });
    await stack.refreshKernelRequests();
    const staleTraffic = bff(stack.kernelRequests(), beforeStale, stale.id).filter((request) => request.method === 'PATCH');
    expect(staleTraffic[0]?.failure?.status).toBe(412);
    expect(JSON.parse(staleTraffic.at(-1)?.body ?? 'null')).toEqual({ labels: { en: 'Alice stale draft' } });
    const recovered = await readSubject(stale.id);
    expect(recovered.subject.labels.en).toBe('Alice stale draft');
    expect(recovered.subject.labels.ja).toBe(stale.labels.ja);
    expect(recovered.subject.descriptions).toEqual(stale.descriptions);

    await openTerms(page, uncertain);
    await replaceField(page, 'Name', 'Uncertain native title');
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
    const beforeUncertain = stack.kernelRequests().length;
    const first = await submitTerms(page, 'Save terms');
    await page.getByText('The result is uncertain. Retry the same request; your draft and request key are kept.').waitFor({
      state: 'visible',
    });
    const retry = await submitTerms(page, 'Retry');
    await page.getByText('Terms saved.').waitFor({ state: 'visible' });
    expect(retry.commands[0]).toEqual(first.commands[0]);
    await stack.refreshKernelRequests();
    const uncertainPatches = bff(stack.kernelRequests(), beforeUncertain, uncertain.id).filter(
      (request) => request.method === 'PATCH',
    );
    expect(uncertainPatches).toHaveLength(2);
    expect(uncertainPatches[0]?.failure?.status).toBe(503);
    expect(uncertainPatches[0]?.idempotencyKey).toBe(uncertainPatches[1]?.idempotencyKey);
    expect(uncertainPatches[0]?.body).toBe(uncertainPatches[1]?.body);
    expect(uncertainPatches[0]?.ifMatch).toBe(uncertainPatches[1]?.ifMatch);
    expect((await readSubject(uncertain.id)).subject.labels.en).toBe('Uncertain native title');
    expect((await readSubject(uncertain.id)).subject.labels.ja).toBe(uncertain.labels.ja);

    await openTerms(page, concealed);
    await replaceField(page, 'Name', 'Withheld imported text');
    await stack.injectKernelFailureOnce({
      method: 'PATCH',
      path: `/v1/subjects/${concealed.id}/terms`,
      status: 404,
      body: JSON.stringify({
        type: 'https://rezics.com/problems/not_found',
        title: 'Not Found',
        status: 404,
        code: 'not_found',
        request_id: crypto.randomUUID(),
        retryable: false,
        effect_status: 'not_applied',
      }),
    });
    await submitTerms(page, 'Save terms');
    await page.getByText('This subject is not available.', { exact: true }).waitFor({ state: 'visible' });
    expect(await page.getByText('Terms saved.').count()).toBe(0);
    const withheld = await readSubject(concealed.id);
    expect(withheld.subject.labels.en).toBe(concealed.labels.en);
    expect(withheld.subject.labels).not.toHaveProperty('en', 'Withheld imported text');
    expect(withheld.subject.statements?.['schema:name']).toBeUndefined();
  }, 900_000);
});
