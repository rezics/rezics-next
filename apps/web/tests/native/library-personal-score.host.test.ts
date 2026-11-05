import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { startAuthStack } from './auth-stack.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll } from './lifecycle.ts';
import { createLibraryEntry } from './library-navigation-fixture.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const stacks: NativeWebStack[] = [];
const authStacks: Awaited<ReturnType<typeof startAuthStack>>[] = [];
const browsers: Browser[] = [];
const lifecycle = new NativeTestLifecycle('native personal-score library walk');
const standardQuestion = '00000000-0000-7000-8000-000000000001';
const evidence = resolve(import.meta.dir, '../../../../.temp/library-personal-score');
const label = 'Native library member';

setDefaultTimeout(300_000);

nativeBeforeAll(lifecycle, 600_000, async () => {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  stacks.push(await startNativeWebStack());
});

afterEach(async () => {
  for (const auth of authStacks.splice(0).reverse()) await auth.stop();
}, 180_000);

afterAll(async () => {
  for (const browser of browsers.splice(0).reverse()) await browser.close();
  for (const stack of stacks.splice(0).reverse()) await stack.stop();
}, 180_000);
nativeAfterAll(lifecycle, 180_000);

function key() {
  return `"${crypto.randomUUID()}"`;
}

async function capture(page: Page, name: string) {
  await page.screenshot({ path: resolve(evidence, `${name}.png`), fullPage: true });
}

async function vote(stack: NativeWebStack, subjectId: string, persona: string) {
  return stack.kernel(`/v1/subjects/${subjectId}/ratings/${standardQuestion}/vote`, undefined, persona);
}

async function scorePage(stack: NativeWebStack, persona: string) {
  return stack.kernel('/v1/libraryEntries?view=FULL&limit=20&orderBy=personalScore&direction=desc', undefined, persona);
}

async function prepareScore(stack: NativeWebStack, persona: string) {
  for (let step = 0; step < 8; step++) {
    const response = await stack.kernel(
      '/v1/libraryShelfScorePreparation',
      { method: 'POST', headers: { 'idempotency-key': key() } },
      persona,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const receipt = (await response.json()) as { installation: string };
    if (receipt.installation === 'installed') return;
  }
  throw new Error('Score order preparation did not install');
}

async function waitForRatingIdle(page: Page) {
  await page.waitForFunction(
    () => document.querySelector('[data-slot="rating-control-reserved"]')?.getAttribute('aria-busy') === 'false',
  );
}

async function saveRating(page: Page, unitsFromMin: number) {
  const control = page.getByRole('slider', { name: /rating/i });
  await control.waitFor({ state: 'visible' });
  await control.press('Home');
  for (let step = 0; step < unitsFromMin; step++) await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Save rating', exact: true }).click();
  await waitForRatingIdle(page);
}

async function publicFigure(stack: NativeWebStack, subjectId: string) {
  return stack.kernel(`/v1/subjects/${subjectId}/figure`);
}

async function openScoreOrder(page: Page, stack: NativeWebStack) {
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await page.getByRole('heading', { name: 'Library' }).waitFor({ state: 'visible' });
  const sort = page.locator('select[name="orderBy"]');
  await sort.waitFor({ state: 'visible' });
  await sort.selectOption('personalScore');
  await page.getByRole('button', { name: 'Apply sort', exact: true }).click();
  const prepare = page.getByRole('button', {
    name: /prepare personal score order|continue preparation|retry this step/i,
  });
  for (let attempt = 0; attempt < 8; attempt++) {
    const score = page.locator('[data-library-own-score]');
    const unavailable = page.locator('[data-shelf-score-state="unavailable"]');
    if (await score.isVisible().catch(() => false)) return;
    if (await unavailable.isVisible().catch(() => false)) {
      throw new Error(`Score order is not current: ${await unavailable.innerText()}`);
    }
    if (await prepare.isVisible().catch(() => false)) {
      await prepare.click();
      await page.getByRole('status').waitFor({ state: 'visible' });
      continue;
    }
    await page.getByRole('heading', { name: 'Library' }).waitFor({ state: 'visible' });
  }
  const native = await scorePage(stack, 'alice');
  throw new Error(`Score order page did not settle; native ${native.status} ${await native.text()}`);
}

test('signed-in voters rate a work and read the same current score in Library, Liked and public pages', async () => {
  const stack = stacks[0]!;
  const alice = await stack.authPersona('alice');
  const subject = await createLibraryEntry(stack, 'alice', alice.authorization);
  const { subjectHref } = await import('../../src/subject/subject-href.ts');
  const pageUrl = `${stack.web}${subjectHref({ id: subject.id, label }, 'en').href}`;
  const auth = await startAuthStack(stack);
  authStacks.push(auth);
  const browserReader = await auth.signIn('alice', { returnTo: new URL(pageUrl).pathname });
  const page = browserReader.context.pages().at(-1)!;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: label, exact: true }).waitFor({ state: 'visible' });
  await saveRating(page, 0);
  await page.locator('[data-slot="own-rating"]').waitFor({ state: 'visible' });
  expect(await page.locator('[data-slot="own-rating"]').innerText()).toMatch(/\b0\b/);
  const zeroVote = await vote(stack, subject.id, 'alice');
  expect(zeroVote.status, await zeroVote.clone().text()).toBe(200);
  expect(await zeroVote.json()).toMatchObject({ units: 0 });
  await capture(page, 'alice-subject-zero-1440-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await capture(page, 'alice-subject-zero-1440-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, 'alice-subject-zero-390-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await capture(page, 'alice-subject-zero-390-light');
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: label, exact: true }).waitFor({ state: 'visible' });
  await page.locator('[data-slot="own-rating"]').waitFor({ state: 'visible' });
  expect(await page.locator('[data-slot="own-rating"]').innerText()).toMatch(/\b0\b/);
  const refreshedZero = await vote(stack, subject.id, 'alice');
  expect(refreshedZero.status, await refreshedZero.clone().text()).toBe(200);
  expect(await refreshedZero.json()).toMatchObject({ units: 0 });

  await prepareScore(stack, 'alice');
  await openScoreOrder(page, stack);
  await page.getByText(label).waitFor({ state: 'visible' });
  const shelfScore = page.locator('[data-library-own-score]');
  await shelfScore.waitFor({ state: 'visible' });
  expect(await shelfScore.innerText()).toMatch(/\b0\b/);
  const listed = await scorePage(stack, 'alice');
  expect(listed.status, await listed.clone().text()).toBe(200);
  const listedBody = (await listed.json()) as {
    scoreQuestion?: { id: string };
    libraryEntries: Array<{ subjectId: string; personalScore: number | null }>;
  };
  expect(listedBody.scoreQuestion?.id).toBe(standardQuestion);
  expect(listedBody.libraryEntries.find((entry) => entry.subjectId === subject.id)?.personalScore).toBe(0);
  await capture(page, 'alice-library-score-zero');

  await page.getByRole('link', { name: label }).click();
  await page.getByRole('heading', { name: label, exact: true }).waitFor({ state: 'visible' });
  await stack.injectKernelFailureOnce({
    method: 'PUT',
    path: `/v1/subjects/${subject.id}/ratings/${standardQuestion}/vote`,
    status: 503,
    body: JSON.stringify({
      type: 'https://rezics.com/problems/overloaded',
      title: 'Overloaded',
      status: 503,
      code: 'overloaded',
      detail: 'injected vote write failure',
      request_id: crypto.randomUUID(),
    }),
  });
  await saveRating(page, 15);
  await page.getByRole('status').waitFor({ state: 'visible' });
  expect(await page.getByRole('status').innerText()).toMatch(/uncertain/i);
  const retrySave = page.getByRole('button', { name: 'Save rating', exact: true });
  expect(await retrySave.isEnabled()).toBe(true);
  await capture(page, 'alice-subject-uncertain');
  await retrySave.click();
  await waitForRatingIdle(page);
  await page.locator('[data-slot="own-rating"]').waitFor({ state: 'visible' });
  expect(await page.locator('[data-slot="own-rating"]').innerText()).toContain('7.5');
  const changedVote = await vote(stack, subject.id, 'alice');
  expect(changedVote.status, await changedVote.clone().text()).toBe(200);
  expect(await changedVote.json()).toMatchObject({ units: 15 });

  await openScoreOrder(page, stack);
  await shelfScore.waitFor({ state: 'visible' });
  expect(await shelfScore.innerText()).toContain('7.5');
  const changedList = await scorePage(stack, 'alice');
  expect(changedList.status, await changedList.clone().text()).toBe(200);
  const changedBody = (await changedList.json()) as {
    libraryEntries: Array<{ subjectId: string; personalScore: number | null }>;
  };
  expect(changedBody.libraryEntries.find((entry) => entry.subjectId === subject.id)?.personalScore).toBe(15);

  const likedWrite = await stack.kernel(
    `/v1/subjects/${subject.id}/reaction`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': key() },
      body: JSON.stringify({ kind: 'like' }),
    },
    'alice',
  );
  expect(likedWrite.status, await likedWrite.clone().text()).toBe(200);
  const collections = await stack.kernel(
    `/v1/collections?curatorAccountId=${encodeURIComponent(alice.accountId)}&limit=100`,
    undefined,
    'alice',
  );
  expect(collections.status, await collections.clone().text()).toBe(200);
  const discovered = (await collections.json()) as {
    collections: Array<{ id: string; builtinKind?: string | null }>;
  };
  const liked = discovered.collections.find((collection) => collection.builtinKind === 'liked');
  expect(liked, 'Liked builtin is present for the signed-in voter').toBeDefined();
  await page.goto(`${stack.web}/en/collections/${liked!.id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: label }).waitFor({ state: 'visible' });
  const likedScore = page.locator('[data-liked-own-score]');
  await likedScore.waitFor({ state: 'visible' });
  expect(await likedScore.innerText()).toMatch(/7\.5|15/);
  await capture(page, 'alice-liked-score');

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  const persisted = page.getByRole('slider', { name: /rating/i });
  await persisted.waitFor({ state: 'visible' });
  await persisted.press('Delete');
  await page.locator('[data-slot="own-rating"]').waitFor({ state: 'detached' });
  const cleared = await vote(stack, subject.id, 'alice');
  expect(cleared.status).toBe(404);

  await openScoreOrder(page, stack);
  await page.getByText(label).waitFor({ state: 'visible' });
  await shelfScore.waitFor({ state: 'visible' });
  expect(await shelfScore.innerText().catch(() => '')).not.toContain('7.5');
  const clearedList = await scorePage(stack, 'alice');
  expect(clearedList.status, await clearedList.clone().text()).toBe(200);
  const clearedBody = (await clearedList.json()) as {
    libraryEntries: Array<{ subjectId: string; personalScore: number | null }>;
  };
  expect(clearedBody.libraryEntries.find((entry) => entry.subjectId === subject.id)?.personalScore ?? null).toBeNull();

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await saveRating(page, 0);
  const restored = await vote(stack, subject.id, 'alice');
  expect(restored.status, await restored.clone().text()).toBe(200);
  expect(await restored.json()).toMatchObject({ units: 0 });

  const bobVote = await stack.kernel(
    `/v1/subjects/${subject.id}/ratings/${standardQuestion}/vote`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': key() },
      body: JSON.stringify({ units: 15 }),
    },
    'bob',
  );
  expect(bobVote.status, await bobVote.clone().text()).toBe(200);
  const bobOwn = await vote(stack, subject.id, 'bob');
  expect(await bobOwn.json()).toMatchObject({ units: 15 });
  const aliceOwn = await vote(stack, subject.id, 'alice');
  expect(await aliceOwn.json()).toMatchObject({ units: 0 });

  const bobAuth = await auth.signIn('bob', { returnTo: new URL(pageUrl).pathname });
  const bobPage = bobAuth.context.pages().at(-1)!;
  await bobPage.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await bobPage.locator('[data-slot="own-rating"]').waitFor({ state: 'visible' });
  expect(await bobPage.locator('[data-slot="own-rating"]').innerText()).toContain('7.5');
  expect(await bobPage.locator('[data-slot="own-rating"]').innerText()).not.toMatch(/Your rating:\s*0\b/);
  await capture(bobPage, 'bob-subject-own-score');

  const anonymous = await stack.request(pageUrl);
  expect(anonymous.status).toBe(200);
  const html = await anonymous.text();
  expect(html).not.toContain('Your rating: 0');
  expect(html).not.toContain('data-slot="own-rating"');
  expect(html).toContain('data-slot="rating-summary"');
  const figure = await publicFigure(stack, subject.id);
  expect(figure.status, await figure.clone().text()).toBe(200);
  const figureBody = (await figure.json()) as { figure: { count: number; populationId?: string } };
  expect(figureBody.figure.count).toBeGreaterThanOrEqual(0);
  await writeFile(
    resolve(evidence, 'readback.json'),
    `${JSON.stringify(
      {
        subjectId: subject.id,
        alice: await (await vote(stack, subject.id, 'alice')).json(),
        bob: await (await vote(stack, subject.id, 'bob')).json(),
        figure: figureBody.figure,
        anonymousOwnRatingPresent: html.includes('data-slot="own-rating"'),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  for (const [locale, scoreLabel, shot] of [
    ['zh-Hant', '個人評分', 'alice-library-zh-Hant-390'],
    ['ja', '自分の評価', 'alice-library-ja-1440'],
  ] as const) {
    await page.setViewportSize(locale === 'zh-Hant' ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.goto(`${stack.web}/${locale}/library?orderBy=personalScore&direction=desc`, {
      waitUntil: 'domcontentloaded',
    });
    await page.locator('select[name="orderBy"]').waitFor({ state: 'visible' });
    expect(await page.locator('select[name="orderBy"]').innerText()).toContain(scoreLabel);
    await capture(page, shot);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(`${stack.web}/en/library?orderBy=personalScore&direction=desc`, { waitUntil: 'domcontentloaded' });
  await page.getByText(label).waitFor({ state: 'visible' });
  expect(await page.locator('[data-library-own-score]').innerText()).toMatch(/\b0\b/);
  await capture(page, 'alice-library-reopen');
}, 600_000);
