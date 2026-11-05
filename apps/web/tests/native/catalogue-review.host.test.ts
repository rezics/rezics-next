import { afterAll, expect } from 'bun:test';
import type { Page, Response as PlaywrightResponse } from 'playwright';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import {
  acceptCatalogueReviewCandidate,
  adoptCatalogueReviewSelection,
  createCatalogueReviewSubject,
  grantCatalogueReviewAuthority,
  listCatalogueReviewCandidates,
  publicLanguages,
  readPublicSubject,
  type CatalogueReviewSubject,
} from './catalogue-review-fixture.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';
import { startNativeWebStack, type NativeKernelRequest, type NativeWebStack } from './stack.ts';

let stack: NativeWebStack;
let auth: NativeAuthStack;
const lifecycle = new NativeTestLifecycle('native catalogue review');

nativeBeforeAll(lifecycle, 300_000, async () => {
  stack = await startNativeWebStack();
  auth = await startAuthStack(stack);
  const [alice, bob] = await Promise.all([auth.signIn('alice'), auth.signIn('bob')]);
  if ((await alice.response()).status() !== 200 || (await bob.response()).status() !== 200)
    throw new Error('Native Alice and Bob must sign in through the served Auth forms');
  await grantCatalogueReviewAuthority(stack);
});

afterAll(async () => {
  try {
    await auth?.stop();
  } finally {
    await stack?.stop();
  }
}, 240_000);
nativeAfterAll(lifecycle, 240_000);

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function reviewerPage(): Promise<Page> {
  const page = await (await auth.context('bob')).newPage();
  page.setDefaultTimeout(30_000);
  return page;
}

async function openProposals(page: Page, subject: CatalogueReviewSubject): Promise<void> {
  const response = await page.goto(new URL(`${subject.href}?candidateField=schema:inLanguage`, stack.web).href, {
    waitUntil: 'domcontentloaded',
  });
  expect(response?.status()).toBe(200);
  await hydrate(page);
  await page.getByRole('button', { name: 'Review proposals', exact: true }).click();
  const field = page.locator('#candidate-field');
  await field.waitFor({ state: 'visible' });
  if ((await field.inputValue()) !== 'schema:inLanguage') await field.selectOption('schema:inLanguage');
  await page.locator('[data-candidate-item]').first().waitFor({ state: 'visible' });
}

function suggestion(page: Page, name: string) {
  return page.locator('[data-candidate-item]').filter({ hasText: name });
}

function choice(page: Page, name: string) {
  return page.locator('[data-candidate-choice]').filter({ hasText: name });
}

async function includeLanguage(page: Page, name: string, candidateId: string, rank: 'normal' | 'preferred') {
  await page.locator('[data-candidate-draft]').waitFor({ state: 'visible' });
  const row = choice(page, name);
  const box = row.getByRole('checkbox');
  await box.waitFor({ state: 'visible' });
  if (!(await box.isChecked())) await box.click();
  await row.locator(`#rank-${candidateId}`).selectOption(rank);
}

async function reviewSuggestion(page: Page, name: string): Promise<void> {
  await suggestion(page, name).getByRole('button', { name: 'Review suggestion', exact: true }).click();
  await page.locator('[data-candidate-panel="proposed"]').waitFor({ state: 'visible' });
}

async function confirmAction(page: Page, action: string): Promise<PlaywrightResponse> {
  await page.getByRole('button', { name: action, exact: true }).last().click();
  const region = page.locator('section[aria-labelledby]').filter({ hasText: `Confirm: ${action}` });
  await region.waitFor({ state: 'visible' });
  const receipt = page.waitForResponse(async (response) => {
    if (response.request().method() !== 'POST') return false;
    if (new URL(response.url()).origin !== new URL(stack.web).origin) return false;
    const text = await response.text().catch(() => '');
    try {
      const body = JSON.parse(text) as { kind?: string; reason?: string };
      return (
        body.kind === 'accepted' ||
        body.kind === 'selected' ||
        body.kind === 'pending' ||
        body.kind === 'rejected' ||
        body.reason === 'stale' ||
        body.reason === 'denied' ||
        body.reason === 'unavailable' ||
        body.reason === 'invalid'
      );
    } catch {
      return false;
    }
  });
  await region.getByRole('button', { name: action, exact: true }).click();
  return receipt;
}

async function kernelTraffic(): Promise<readonly NativeKernelRequest[]> {
  await stack.syncKernelRequests();
  return stack.kernelRequests();
}

function subjectGets(requests: readonly NativeKernelRequest[], id: string): NativeKernelRequest[] {
  const path = `/v1/subjects/${id}`;
  return requests.filter((request) => {
    if (request.fixtureRequest || request.method !== 'GET') return false;
    const url = new URL(request.url, stack.kernelOrigin);
    return url.pathname === path;
  });
}

function commandPosts(requests: readonly NativeKernelRequest[], id: string): NativeKernelRequest[] {
  return requests.filter((request) => {
    if (request.fixtureRequest || request.method !== 'POST') return false;
    const url = new URL(request.url, stack.kernelOrigin);
    return url.pathname === `/v1/subjects/${id}:adopt` || url.pathname.startsWith(`/v1/subjects/${id}/candidates/`);
  });
}

nativeTest(
  'an authorized reviewer accepts one of two slot alternatives through the website BFF without changing public reading, then explicitly adopts it',
  900_000,
  async () => {
    const subject = await createCatalogueReviewSubject(stack);
    const before = publicLanguages((await readPublicSubject(stack, subject.id)).subject);
    expect(before).toEqual([]);

    const page = await reviewerPage();
    const started = (await kernelTraffic()).length;
    await openProposals(page, subject);
    expect(await suggestion(page, 'Japanese').count()).toBe(1);
    expect(await suggestion(page, 'Korean').count()).toBe(1);

    await reviewSuggestion(page, 'Japanese');
    expect(await page.locator('[data-candidate-panel="current"]').innerText()).toContain('No current public value.');
    const accepted = await confirmAction(page, 'Accept suggestion');
    const acceptedBody = (await accepted.json()) as { ok: boolean; kind?: string; session?: string };
    expect(accepted.status()).toBe(200);
    expect(acceptedBody).toMatchObject({ ok: true, kind: 'accepted' });
    expect(typeof acceptedBody.session).toBe('string');
    await page.getByRole('status').filter({ hasText: 'Suggestion accepted' }).waitFor({ state: 'visible' });
    expect(await page.getByRole('status').innerText()).toContain(
      'Suggestion accepted. Reload to review its public selection separately.',
    );
    expect(await page.getByRole('link', { name: 'View public subject' }).count()).toBe(0);

    const afterAccept = publicLanguages((await readPublicSubject(stack, subject.id)).subject);
    expect(afterAccept).toEqual([]);
    const listed = await listCatalogueReviewCandidates(stack, subject.id);
    expect(listed.candidates.find((item) => item.id === subject.japanese.id)?.decision).toBe('accepted');
    expect(listed.candidates.find((item) => item.id === subject.korean.id)?.decision ?? null).toBeNull();

    await page.getByRole('button', { name: 'Reload current values', exact: true }).click();
    await suggestion(page, 'Japanese').waitFor({ state: 'visible' });
    await includeLanguage(page, 'Japanese', subject.japanese.id, 'preferred');
    const selected = await confirmAction(page, 'Select for public subject');
    const selectedBody = (await selected.json()) as { ok: boolean; kind?: string; session?: string };
    expect(selected.status()).toBe(200);
    expect(selectedBody).toMatchObject({ ok: true, kind: 'selected' });
    expect(typeof selectedBody.session).toBe('string');
    await page.getByRole('status').filter({ hasText: 'The public reader confirms this selection' }).waitFor({
      state: 'visible',
    });
    expect(await page.getByRole('link', { name: 'View public subject' }).count()).toBe(1);

    const afterAdopt = publicLanguages((await readPublicSubject(stack, subject.id)).subject);
    expect(afterAdopt).toEqual([{ id: subject.japanese.id, rank: 'preferred', content: 'ja' }]);
    const ranked = await listCatalogueReviewCandidates(stack, subject.id);
    expect(ranked.candidates.find((item) => item.id === subject.japanese.id)?.rank).toBe('preferred');
    expect(ranked.candidates.find((item) => item.id === subject.korean.id)?.decision ?? null).toBeNull();
    expect(ranked.candidates.find((item) => item.id === subject.korean.id)?.rank ?? null).toBeNull();

    const traffic = (await kernelTraffic()).slice(started);
    const publicGets = subjectGets(traffic, subject.id);
    expect(publicGets.length).toBeGreaterThan(0);
    expect(publicGets.every((request) => request.authorization === null)).toBe(true);
    expect(
      commandPosts(traffic, subject.id).some((request) =>
        request.url.startsWith(`/v1/subjects/${subject.id}/candidates/${subject.japanese.id}:accept`),
      ),
    ).toBe(true);
    expect(
      commandPosts(traffic, subject.id).some((request) => request.url === `/v1/subjects/${subject.id}:adopt`),
    ).toBe(true);

    const anonymous = await (await auth.context('anonymous')).newPage();
    anonymous.setDefaultTimeout(30_000);
    const publicPage = await anonymous.goto(new URL(subject.href, stack.web).href, { waitUntil: 'domcontentloaded' });
    expect(publicPage?.status()).toBe(200);
    await hydrate(anonymous);
    const visible = await anonymous.locator('body').innerText();
    expect(visible).toContain(subject.label);
    expect(visible).toContain('Japanese');
    expect(visible).not.toContain(subject.korean.id);
    const publicReadHeaders = publicPage?.request().headers() ?? {};
    expect(publicReadHeaders.authorization).toBeUndefined();
  },
  lifecycle,
);

nativeTest(
  'a stale adoption head preserves the selection draft and requires an explicit new confirmation',
  900_000,
  async () => {
    const subject = await createCatalogueReviewSubject(stack);
    await acceptCatalogueReviewCandidate(stack, subject.id, subject.japanese.id, null, 'bob');
    await acceptCatalogueReviewCandidate(stack, subject.id, subject.korean.id, null, 'bob');
    const comparison = await listCatalogueReviewCandidates(stack, subject.id);
    expect(comparison.adoption.head).not.toBeNull();

    const page = await reviewerPage();
    const started = (await kernelTraffic()).length;
    await openProposals(page, subject);
    await includeLanguage(page, 'Japanese', subject.japanese.id, 'preferred');
    await page.getByRole('button', { name: 'Select for public subject', exact: true }).click();
    const region = page.locator('section[aria-labelledby]').filter({ hasText: 'Confirm: Select for public subject' });
    await region.waitFor({ state: 'visible' });

    await adoptCatalogueReviewSelection(
      stack,
      subject.id,
      [{ candidate: subject.korean.id, rank: 'normal' }],
      comparison.adoption.head,
      'bob',
    );
    expect(publicLanguages((await readPublicSubject(stack, subject.id)).subject)).toEqual([
      { id: subject.korean.id, rank: 'normal', content: 'ko' },
    ]);

    const stale = page.waitForResponse(async (response) => {
      if (response.request().method() !== 'POST') return false;
      if (new URL(response.url()).origin !== new URL(stack.web).origin) return false;
      const text = await response.text().catch(() => '');
      try {
        return (JSON.parse(text) as { reason?: string }).reason === 'stale';
      } catch {
        return false;
      }
    });
    await region.getByRole('button', { name: 'Select for public subject', exact: true }).click();
    const staleReceipt = await stale;
    expect(staleReceipt.status()).toBe(200);
    await page
      .getByRole('alert')
      .filter({
        hasText:
          'The comparison changed. Your selection draft is preserved. Reload, compare again, then explicitly confirm a new request.',
      })
      .waitFor({ state: 'visible' });

    const afterStale = (await kernelTraffic()).slice(started);
    const firstAdopt = commandPosts(afterStale, subject.id).filter(
      (request) => request.url === `/v1/subjects/${subject.id}:adopt`,
    );
    expect(firstAdopt).toHaveLength(1);
    expect(firstAdopt[0]?.failure?.status).toBe(409);
    expect(firstAdopt[0]?.idempotencyKey).toBeTruthy();

    await page.getByRole('button', { name: 'Reload current values', exact: true }).click();
    await choice(page, 'Japanese').waitFor({ state: 'visible' });
    expect(await choice(page, 'Japanese').getByRole('checkbox').isChecked()).toBe(true);
    expect(await choice(page, 'Korean').getByRole('checkbox').isChecked()).toBe(true);
    expect(await page.locator('[data-candidate-draft]').innerText()).toContain('Korean');

    const confirmed = await confirmAction(page, 'Select for public subject');
    const confirmedBody = (await confirmed.json()) as { ok: boolean; kind?: string };
    expect(confirmed.status()).toBe(200);
    expect(confirmedBody).toMatchObject({ ok: true, kind: 'selected' });
    await page.getByRole('status').filter({ hasText: 'The public reader confirms this selection' }).waitFor({
      state: 'visible',
    });

    const afterConfirm = (await kernelTraffic()).slice(started);
    const bffAdopts = commandPosts(afterConfirm, subject.id).filter(
      (request) => request.url === `/v1/subjects/${subject.id}:adopt`,
    );
    expect(bffAdopts.length).toBeGreaterThanOrEqual(2);
    expect(bffAdopts[0]?.idempotencyKey).not.toBe(bffAdopts.at(-1)?.idempotencyKey);
    expect(bffAdopts.at(-1)?.failure).toBeUndefined();
    const selected = publicLanguages((await readPublicSubject(stack, subject.id)).subject);
    expect(selected).toHaveLength(2);
    expect(selected).toEqual(
      expect.arrayContaining([
        { id: subject.japanese.id, rank: 'preferred', content: 'ja' },
        { id: subject.korean.id, rank: 'normal', content: 'ko' },
      ]),
    );
  },
  lifecycle,
);
