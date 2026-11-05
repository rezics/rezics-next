import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import { bundledDigest } from '@rezics/definitions/bundled';
import { startAuthStack, type AuthJourney, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

setDefaultTimeout(900_000);

const VN = 'wd:Q689445';
const ANIME = 'schema:TVSeries';
const BOOK = 'schema:Book';
const evidenceDir = join(import.meta.dir, '../../../.temp/subject-progress');
const rateOverrides = JSON.stringify({
  'new-account': { write: { maximum: 1000, seconds: 60 } },
  member: { write: { maximum: 1000, seconds: 60 } },
  trusted: { write: { maximum: 1000, seconds: 60 } },
  service: { write: { maximum: 1000, seconds: 60 } },
});

type LibrarySubject = { id: string; type: string; label: string; unit: string; first: string; next: string };
type NativeSession = {
  id: string;
  state: string;
  amount: string | null;
  unit: string;
  mode: string;
  revision: number;
};
type Viewer = { persona?: string; authorization?: string };
type WalkRecord = {
  persona: string;
  subject: string;
  type: string;
  entryState: string;
  sessionId: string | null;
  amounts: string[];
  cleared: boolean;
};

let stack: NativeWebStack;
let auth: NativeAuthStack;
let alice: AuthJourney;
let bob: AuthJourney;
let newcomer: AuthJourney;
let vn: LibrarySubject;
let anime: LibrarySubject;
let book: LibrarySubject;
const walks: WalkRecord[] = [];

async function json<T>(response: Response, expectedStatus: number): Promise<T> {
  const body = await response.text();
  if (response.status !== expectedStatus)
    throw new Error(`Expected native API status ${expectedStatus}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

async function openFeature(feature: 'personal_library' | 'reading_progress') {
  const response = await stack.kernel(
    `/v1/platform/exposure/${feature}:open`,
    { method: 'POST', headers: { 'idempotency-key': `"${crypto.randomUUID()}"` } },
    'governor',
  );
  await json(response, 200);
}

async function createSubject(type: string, label: string): Promise<{ id: string; type: string; label: string }> {
  const response = await stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
      body: JSON.stringify({ type, labels: { en: label } }),
    },
    'editor',
  );
  const result = await json<{ subject: { id: string; type: string } }>(response, 201);
  return { id: result.subject.id, type: result.subject.type, label };
}

async function subjectHref(subject: { id: string; label: string }, locale: string): Promise<string> {
  const { subjectHref: href } = await import('../../src/subject/subject-href.ts');
  return href(subject, locale).href;
}

async function hydrated(page: Page) {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

function signedInPage(journey: AuthJourney): Page {
  const page = journey.context.pages().at(-1);
  if (!page) throw new Error('The served Auth form did not retain a signed-in browser page.');
  return page;
}

async function visitSubject(page: Page, subject: { id: string; label: string }, locale = 'en') {
  const path = await subjectHref(subject, locale);
  const response = await page.goto(new URL(path, stack.web).href, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await hydrated(page);
  await page.getByRole('heading', { name: locale === 'ja' ? '進捗' : locale === 'zh-Hant' ? '進度' : 'Progress' }).waitFor({
    state: 'visible',
    timeout: 30_000,
  });
  return path;
}

function progressSection(page: Page, locale = 'en') {
  const heading = locale === 'ja' ? '進捗' : locale === 'zh-Hant' ? '進度' : 'Progress';
  return page.locator('section').filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
}

async function kernelGet(path: string, viewer: Viewer) {
  return stack.kernel(
    path,
    viewer.authorization ? { headers: { authorization: viewer.authorization } } : {},
    viewer.persona,
  );
}

async function nativeEntry(subjectId: string, viewer: Viewer) {
  const response = await kernelGet(`/v1/libraryEntries/${encodeURIComponent(subjectId)}?view=FULL`, viewer);
  if (response.status === 404) return null;
  const body = await json<{ libraryEntry: { state: string; revision: number; subjectId: string } }>(response, 200);
  return body.libraryEntry;
}

async function nativeSessions(subjectId: string, viewer: Viewer): Promise<NativeSession[]> {
  const response = await kernelGet(
    `/v1/progressSessions?subjectId=${encodeURIComponent(subjectId)}&limit=100`,
    viewer,
  );
  const body = await json<{ progressSessions: NativeSession[] }>(response, 200);
  return body.progressSessions;
}

async function nativeSession(sessionId: string, viewer: Viewer) {
  const response = await kernelGet(`/v1/progressSessions/${encodeURIComponent(sessionId)}?view=FULL`, viewer);
  if (response.status === 404) return { status: 404 as const };
  const body = await json<{ progressSession: NativeSession }>(response, 200);
  return { status: 200 as const, session: body.progressSession };
}

async function captureViewer(since: number): Promise<string | undefined> {
  await stack.syncKernelRequests();
  return stack
    .kernelRequests()
    .slice(since)
    .find(
      (request) =>
        Boolean(request.authorization) &&
        (request.url.startsWith('/v1/libraryEntries') || request.url.startsWith('/v1/progressSessions')),
    )?.authorization;
}

async function setLibraryState(page: Page) {
  const state = page.getByRole('combobox', { name: 'Library state' });
  await state.click();
  await page.getByRole('option', { name: 'In progress', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Library state saved.' }).waitFor({ state: 'visible' });
}

async function waitSaved(page: Page) {
  await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor({ state: 'visible', timeout: 30_000 });
}

async function fillProgress(page: Page, amount: string) {
  const input = progressSection(page).getByRole('textbox');
  await input.waitFor({ state: 'visible' });
  await input.fill(amount);
}

async function agreePageWithNative(
  page: Page,
  subject: LibrarySubject,
  viewer: Viewer,
  expected: { state: string; amount: string | null },
) {
  await stack.syncKernelRequests();
  const entry = await nativeEntry(subject.id, viewer);
  expect(entry?.state).toBe(expected.state);
  const sessions = await nativeSessions(subject.id, viewer);
  const active = sessions.find((session) => session.state === 'active' && session.unit === subject.unit);
  expect(active, `native session for ${subject.label}`).toBeDefined();
  expect(active!.amount).toBe(expected.amount);
  const body = await page.locator('body').innerText();
  expect(body).toContain('In progress');
  if (expected.amount === null) expect(body).toContain('No progress amount is recorded yet.');
  else expect(body).toContain(expected.amount);
  const open = progressSection(page).locator('[data-configured-progress-session]');
  await open.waitFor({ state: 'visible' });
  const href = await open.getAttribute('href');
  expect(href).toBe(`/en/library/progress/${encodeURIComponent(active!.id)}`);
  return active!;
}

async function returnThroughLibrary(page: Page, subject: LibrarySubject) {
  const library = page.locator('a[href="/en/library"]').first();
  await library.click();
  await page.waitForURL((url) => url.pathname === '/en/library');
  await hydrated(page);
  const card = page.getByRole('link').filter({ hasText: subject.label }).first();
  await card.waitFor({ state: 'visible', timeout: 60_000 });
  await card.click();
  await hydrated(page);
  await page.getByRole('heading', { name: 'Progress' }).waitFor({ state: 'visible', timeout: 30_000 });
}

async function captureViewports(page: Page, name: string) {
  await mkdir(evidenceDir, { recursive: true });
  for (const width of [390, 1440] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({
        path: join(evidenceDir, `${name}-${width}-${theme}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.emulateMedia({ colorScheme: 'light' });
}

async function walkSubject(
  page: Page,
  persona: 'alice' | 'newcomer',
  subject: LibrarySubject,
  options: { replayStart?: boolean } = {},
) {
  const since = stack.kernelRequests().length;
  await visitSubject(page, subject);
  const viewer: Viewer =
    persona === 'alice'
      ? { persona: 'alice' }
      : { authorization: await captureViewer(since) };
  expect(viewer.persona || viewer.authorization, `${persona} native credential`).toBeTruthy();
  await setLibraryState(page);
  await fillProgress(page, subject.first);
  if (options.replayStart) {
    await stack.injectKernelFailureOnce({
      method: 'POST',
      path: '/v1/progressSessions',
      status: 503,
      body: JSON.stringify({
        type: 'https://rezics.com/problems/overloaded',
        title: 'Overloaded',
        status: 503,
        code: 'overloaded',
      }),
    });
  }
  const startKernel = stack.kernelRequests().length;
  await progressSection(page).getByRole('button', { name: 'Start tracking', exact: true }).click();
  if (options.replayStart) {
    await page.getByRole('button', { name: 'Retry the same request', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Retry the same request', exact: true }).click();
  }
  await waitSaved(page);
  if (options.replayStart) {
    await stack.syncKernelRequests();
    const starts = stack
      .kernelRequests()
      .slice(startKernel)
      .filter(({ method, url }) => method === 'POST' && url === '/v1/progressSessions');
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts[0]!.idempotencyKey).toBe(starts[1]!.idempotencyKey);
    expect(starts[0]!.idempotencyKey).toBeTruthy();
  }
  await agreePageWithNative(page, subject, viewer, { state: 'in_progress', amount: subject.first });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await hydrated(page);
  await page.getByRole('heading', { name: 'Progress' }).waitFor({ state: 'visible' });
  const afterRefresh = await agreePageWithNative(page, subject, viewer, {
    state: 'in_progress',
    amount: subject.first,
  });

  await fillProgress(page, subject.next);
  await progressSection(page).getByRole('button', { name: 'Save amount', exact: true }).click();
  await waitSaved(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await hydrated(page);
  await page.getByRole('heading', { name: 'Progress' }).waitFor({ state: 'visible' });
  const afterAdvance = await agreePageWithNative(page, subject, viewer, {
    state: 'in_progress',
    amount: subject.next,
  });

  await returnThroughLibrary(page, subject);
  await agreePageWithNative(page, subject, viewer, { state: 'in_progress', amount: subject.next });

  const path = await subjectHref(subject, 'en');
  await page.goto(new URL(path, stack.web).href, { waitUntil: 'domcontentloaded' });
  await hydrated(page);
  await page.getByRole('heading', { name: 'Progress' }).waitFor({ state: 'visible' });
  await progressSection(page).getByRole('button', { name: 'Clear this amount', exact: true }).click();
  await waitSaved(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await hydrated(page);
  const cleared = await agreePageWithNative(page, subject, viewer, { state: 'in_progress', amount: null });
  const entry = await nativeEntry(subject.id, viewer);
  expect(entry?.state).toBe('in_progress');

  walks.push({
    persona,
    subject: subject.label,
    type: subject.type,
    entryState: 'in_progress',
    sessionId: (cleared ?? afterAdvance ?? afterRefresh)?.id ?? null,
    amounts: [subject.first, subject.next],
    cleared: true,
  });
}

beforeAll(async () => {
  stack = await startNativeWebStack({ writeRateOverrides: rateOverrides });
  const active = await json<{ digest: string }>(await stack.kernel('/v1/definitions/active'), 200);
  expect(active.digest).toBe(bundledDigest);
  await openFeature('personal_library');
  await openFeature('reading_progress');
  const suffix = crypto.randomUUID().slice(0, 8);
  const createdVn = await createSubject(VN, `Native VN progress ${suffix}`);
  const createdAnime = await createSubject(ANIME, `Native anime progress ${suffix}`);
  const createdBook = await createSubject(BOOK, `Native book progress ${suffix}`);
  vn = { ...createdVn, unit: 'percent', first: '12', next: '34' };
  anime = { ...createdAnime, unit: 'episode', first: '3', next: '5' };
  book = { ...createdBook, unit: 'page', first: '40', next: '88' };
  auth = await startAuthStack(stack);
  alice = await auth.signIn('alice');
  bob = await auth.signIn('bob');
  newcomer = await auth.signUp('newcomer');
  expect((await alice.response()).status()).toBe(200);
  expect((await bob.response()).status()).toBe(200);
  expect((await newcomer.response()).status()).toBe(200);
}, 600_000);

afterAll(async () => {
  try {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      join(evidenceDir, 'walk.json'),
      `${JSON.stringify(
        {
          digest: bundledDigest,
          subjects: [vn, anime, book].map(({ id, type, label, unit }) => ({ id, type, label, unit })),
          walks,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await auth?.stop();
    await stack?.stop();
  }
}, 180_000);

describe('subject Library progress for released profiles', () => {
  test('established and new readers record VN, anime and book progress through served controls', async () => {
    const alicePage = signedInPage(alice);
    alicePage.setDefaultTimeout(30_000);
    await walkSubject(alicePage, 'alice', vn, { replayStart: true });
    await captureViewports(alicePage, 'alice-vn');
    await walkSubject(alicePage, 'alice', anime);
    await walkSubject(alicePage, 'alice', book);

    for (const locale of ['zh-Hant', 'ja'] as const) {
      await visitSubject(alicePage, vn, locale);
      const heading = locale === 'ja' ? '進捗' : '進度';
      const state = locale === 'ja' ? 'ライブラリの状態' : '書架狀態';
      await progressSection(alicePage, locale).getByRole('heading', { name: heading, exact: true }).waitFor({
        state: 'visible',
      });
      await alicePage.getByRole('combobox', { name: state }).waitFor({ state: 'visible' });
    }

    const newcomerPage = signedInPage(newcomer);
    newcomerPage.setDefaultTimeout(30_000);
    await walkSubject(newcomerPage, 'newcomer', vn);
    await walkSubject(newcomerPage, 'newcomer', anime);
    await walkSubject(newcomerPage, 'newcomer', book);

    const bobPage = signedInPage(bob);
    bobPage.setDefaultTimeout(30_000);
    await visitSubject(bobPage, vn);
    const bobBody = await bobPage.locator('body').innerText();
    expect(bobBody).not.toContain('12');
    expect(bobBody).not.toContain('34');
    expect(await nativeEntry(vn.id, { persona: 'bob' })).toBeNull();
    expect(await nativeSessions(vn.id, { persona: 'bob' })).toEqual([]);
    const aliceSessions = await nativeSessions(vn.id, { persona: 'alice' });
    expect(aliceSessions.some((session) => session.unit === 'percent')).toBe(true);
    for (const session of aliceSessions) {
      expect((await nativeSession(session.id, { persona: 'bob' })).status).toBe(404);
    }
  });
});
