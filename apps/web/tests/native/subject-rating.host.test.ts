import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { startAuthStack } from './auth-stack.ts';
import { startNativeWebStack } from './stack.ts';

const stacks: Awaited<ReturnType<typeof startNativeWebStack>>[] = [];
const authStacks: Awaited<ReturnType<typeof startAuthStack>>[] = [];
const browsers: Browser[] = [];
const standardQuestion = '00000000-0000-7000-8000-000000000001';
const globalPopulation = '00000000-0000-8000-8000-000000000000';

beforeAll(async () => {
  stacks.push(await startNativeWebStack());
}, 300_000);

afterEach(async () => {
  for (const auth of authStacks.splice(0).reverse()) await auth.stop();
}, 180_000);

afterAll(async () => {
  for (const browser of browsers.splice(0).reverse()) await browser.close();
  for (const stack of stacks.splice(0).reverse()) await stack.stop();
}, 180_000);

type Figure = {
  questionId: string;
  populationId: string;
  count: number;
  state: string;
  mean: number | null;
};

async function readFigure(stack: Awaited<ReturnType<typeof startNativeWebStack>>, subjectId: string) {
  const response = await stack.kernel(`/v1/subjects/${subjectId}/figure`);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { figure: Figure }).figure;
}

async function waitForFigure(
  stack: Awaited<ReturnType<typeof startNativeWebStack>>,
  subjectId: string,
  expected: (figure: Figure) => boolean,
) {
  const deadline = Date.now() + 60_000;
  let figure = await readFigure(stack, subjectId);
  while (!expected(figure) && Date.now() < deadline) {
    await Bun.sleep(1000);
    figure = await readFigure(stack, subjectId);
  }
  if (!expected(figure))
    throw new Error(`Timed out waiting for public figure; last state=${figure.state}, count=${figure.count}`);
  return figure;
}

function idempotencyKey() {
  return `"${crypto.randomUUID()}"`;
}

test('the native browser rates a subject, publishes the Global figure at five votes and clears below threshold', async () => {
  const stack = stacks[0]!;
  const auth = await startAuthStack(stack);
  authStacks.push(auth);

  const openedLibrary = await stack.kernel(
    '/v1/platform/exposure/personal_library:open',
    { method: 'POST', headers: { 'idempotency-key': idempotencyKey() } },
    'governor',
  );
  expect(openedLibrary.status).toBe(200);

  const label = 'Native rating journey subject';
  const created = await stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
      body: JSON.stringify({ type: 'schema:Book', labels: { en: label } }),
    },
    'editor',
  );
  expect(created.status, await created.clone().text()).toBe(201);
  const { subject } = (await created.json()) as { subject: { id: string } };
  const { subjectHref } = await import('../../src/subject/subject-href.ts');
  const pageUrl = `${stack.web}${subjectHref({ id: subject.id, label }, 'en').href}`;
  const votePath = `/v1/subjects/${subject.id}/ratings/${standardQuestion}/vote`;

  const browserReader = await auth.signIn('alice');
  const noScriptBrowser = await chromium.launch();
  browsers.push(noScriptBrowser);
  const noScriptContext = await noScriptBrowser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled: false,
  });
  await noScriptContext.addCookies(await browserReader.context.cookies(pageUrl));
  const noScriptPage = await noScriptContext.newPage();
  const noScriptResponse = await noScriptPage.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  expect(noScriptResponse?.status()).toBe(200);
  await noScriptPage.getByRole('heading', { name: label, exact: true }).waitFor({ state: 'visible' });
  await noScriptPage.getByText('This subject has only a title so far.', { exact: false }).waitFor({ state: 'visible' });
  expect(
    stack.kernelRequests().some(({ method, url }) => method === 'GET' && url === `/v1/subjects/${subject.id}`),
  ).toBe(true);
  const noScriptSlider = noScriptPage.getByRole('slider', { name: 'Your rating' });
  await noScriptSlider.waitFor({ state: 'visible' });
  await noScriptSlider.focus();
  await noScriptSlider.press('ArrowRight');
  await noScriptSlider.press('ArrowRight');
  const noScriptNavigation = noScriptPage.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await noScriptPage.getByRole('button', { name: 'Save rating', exact: true }).click();
  const noScriptReturn = await noScriptNavigation;
  expect(noScriptReturn?.status()).toBe(200);
  const noScriptVote = await stack.kernel(votePath, undefined, 'alice');
  expect(noScriptVote.status, await noScriptVote.clone().text()).toBe(200);
  expect(await noScriptVote.json()).toMatchObject({ units: 12 });

  const page = browserReader.context.pages().at(-1)!;
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: label, exact: true }).waitFor({ state: 'visible' });
  const control = page.getByRole('slider', { name: 'Your rating' });
  await control.waitFor({ state: 'visible' });
  await control.press('Home');
  for (let step = 0; step < 15; step++) await page.keyboard.press('ArrowRight');
  await page.locator('[data-slot="rating-control-value"]').waitFor({ state: 'visible' });
  expect(await page.locator('[data-slot="rating-control-value"]').innerText()).toContain('7.5');
  await page.getByRole('button', { name: 'Save rating', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-slot="rating-control-reserved"]')?.getAttribute('aria-busy') === 'false',
  );
  await page.locator('[data-slot="own-rating"]').waitFor({ state: 'visible' });
  expect(await page.locator('[data-slot="own-rating"]').innerText()).toContain('7.5');

  const ownVote = await stack.kernel(votePath, undefined, 'alice');
  expect(ownVote.status, await ownVote.clone().text()).toBe(200);
  expect(await ownVote.json()).toMatchObject({ units: 15 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-slot="own-rating"]').waitFor({ state: 'visible' });
  expect(await page.locator('[data-slot="own-rating"]').innerText()).toContain('7.5');

  for (let voter = 1; voter <= 4; voter++) {
    const response = await stack.kernel(
      votePath,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
        body: JSON.stringify({ units: 15 }),
      },
      `rating-voter-${voter}`,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }

  const published = await waitForFigure(stack, subject.id, (figure) => figure.state === 'ready' && figure.count === 5);
  expect(published).toMatchObject({
    questionId: standardQuestion,
    populationId: globalPopulation,
    count: 5,
    state: 'ready',
    mean: 7.5,
  });
  const anonymousPage = await stack.request(pageUrl);
  expect(anonymousPage.status).toBe(200);
  const publishedHtml = await anonymousPage.text();
  const publishedRatings = publishedHtml.match(/<section[^>]*data-slot="rating-summary"[\s\S]*?<\/section>/)?.[0];
  expect(publishedRatings).toBeDefined();
  expect(publishedRatings).toContain('7.5');
  expect(publishedRatings).toContain('5');
  expect(publishedRatings).toContain('REZICS');

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  const persistedControl = page.getByRole('slider', { name: 'Your rating' });
  await persistedControl.waitFor({ state: 'visible' });
  await persistedControl.press('Delete');
  await page.locator('[data-slot="own-rating"]').waitFor({ state: 'detached' });
  await page.waitForFunction(
    () => document.querySelector('[data-slot="rating-control-reserved"]')?.getAttribute('aria-busy') === 'false',
  );
  expect(await page.locator('[data-slot="own-rating"]').count()).toBe(0);
  const cleared = await stack.kernel(votePath, undefined, 'alice');
  expect(cleared.status).toBe(404);

  const insufficient = await waitForFigure(
    stack,
    subject.id,
    (figure) => figure.state === 'insufficient_data' && figure.count === 4,
  );
  expect(insufficient).toMatchObject({ count: 4, state: 'insufficient_data', mean: null });
  const anonymousAfterClear = await stack.request(pageUrl);
  expect(anonymousAfterClear.status).toBe(200);
  const clearedHtml = await anonymousAfterClear.text();
  const clearedRatings = clearedHtml.match(/<section[^>]*data-slot="rating-summary"[\s\S]*?<\/section>/)?.[0];
  expect(clearedRatings).toBeDefined();
  expect(clearedRatings).toContain('4');
  expect(clearedRatings).toContain('1 more');
  expect(clearedRatings).not.toContain('7.5');

  const pageVoteReads = stack.kernelRequests().filter(({ method, url }) => method === 'GET' && url === votePath);
  expect(pageVoteReads.length).toBeGreaterThan(0);
  expect(pageVoteReads.some(({ authorization }) => authorization !== null)).toBe(true);
  const voteWrites = stack
    .kernelRequests()
    .filter(({ method, url }) => ['PUT', 'DELETE'].includes(method) && url === votePath);
  expect(voteWrites.some(({ method }) => method === 'PUT')).toBe(true);
  expect(voteWrites.some(({ method }) => method === 'DELETE')).toBe(true);
  expect(voteWrites.every(({ idempotencyKey }) => idempotencyKey !== null && idempotencyKey.length > 0)).toBe(true);
  expect(new Set(voteWrites.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(voteWrites.length);
}, 600_000);
