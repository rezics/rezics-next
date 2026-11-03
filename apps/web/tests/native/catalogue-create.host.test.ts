import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { startAuthStack } from './auth-stack.ts';
import { startNativeWebStack } from './stack.ts';

let stack: Awaited<ReturnType<typeof startNativeWebStack>>;
let auth: Awaited<ReturnType<typeof startAuthStack>>;

beforeAll(async () => {
  stack = await startNativeWebStack();
  auth = await startAuthStack(stack);
}, 300_000);

afterAll(async () => {
  await auth?.stop();
  await stack?.stop();
}, 180_000);

async function chooseBook(page: Page) {
  await page.locator('#create-type-search-mode').selectOption('id');
  const query = page.locator('#create-type-query');
  await query.fill('schema:Book');
  await query.press('Enter');
  const select = page.getByRole('button', { name: /^Select / });
  await select.waitFor({ state: 'visible' });
  await select.click();
}

async function fillTerms(page: Page, token: string) {
  const en = {
    label: `Native catalogue book ${token}`,
    description: `English description ${token}`,
    alias: `English alias ${token}`,
  };
  const zh = {
    label: `原生目录条目 ${token}`,
    description: `中文说明 ${token}`,
    alias: `中文别名 ${token}`,
  };
  await page.locator('#create-label-0').fill(en.label);
  await page.locator('#create-description-0').fill(en.description);
  await page.locator('#create-aliases-0').fill(en.alias);
  await page.getByRole('button', { name: /add language/i }).click();
  await page.locator('#create-language-1').fill('zh-Hans');
  await page.locator('#create-label-1').fill(zh.label);
  await page.locator('#create-description-1').fill(zh.description);
  await page.locator('#create-aliases-1').fill(zh.alias);
  return { en, zh };
}

async function subjectPosts(label: string) {
  await stack.syncKernelRequests();
  return stack.kernelRequests().filter((request) => {
    if (request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body) return false;
    return (JSON.parse(request.body) as { labels?: { en?: string } }).labels?.en === label;
  });
}

async function publicSubjectIds(label: string) {
  const response = await stack.kernel('/v1/subject-pages?limit=1000');
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    subjectPages: { id: string; labels: { language: string; value: string }[] }[];
  };
  return body.subjectPages
    .filter((subject) => subject.labels.some((term) => term.value === label))
    .map((subject) => subject.id);
}

test(
  'signed-in generic creation uses the native subject POST, exact uncertain retry, and retained-ID read retry',
  async () => {
    const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/new' });
    expect(journey.url).toBe(`${stack.web}/en/catalogue/new`);
    expect((await journey.response()).status()).toBe(200);
    expect((await journey.requestHeaders()).every((headers) => !headers.has('authorization'))).toBe(true);

    const page = journey.context.pages().at(-1)!;
    page.setDefaultTimeout(30_000);
    const browserHeaders: Promise<Headers>[] = [];
    const browserFunctionBodies: string[] = [];
    const browserFunctionResponses: Promise<string>[] = [];
    page.on('request', (request) => {
      browserHeaders.push(request.allHeaders().then((headers) => new Headers(headers)));
      if (new URL(request.url()).pathname.startsWith('/_serverFn/'))
        browserFunctionBodies.push(request.postData() ?? '');
    });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/_serverFn/'))
        browserFunctionResponses.push(response.text().catch(() => ''));
    });

    await page.locator('form').waitFor({ state: 'visible' });
    expect(await page.locator('html').getAttribute('lang')).toBe('en');
    await chooseBook(page);
    const first = await fillTerms(page, crypto.randomUUID());

    let droppedResponse: { status: number; body: string } | undefined;
    const dropFirstCreateResponse = async (route: import('playwright').Route) => {
      if (!droppedResponse && route.request().method() === 'POST') {
        const response = await route.fetch();
        droppedResponse = { status: response.status(), body: await response.text() };
        await route.abort('failed');
        return;
      }
      await route.continue();
    };
    await page.route('**/_serverFn/**', dropFirstCreateResponse);
    const submit = page.locator('form button[type="submit"]');
    await submit.click();
    await page.getByRole('alert').waitFor({ state: 'visible' });
    expect(await submit.innerText()).toMatch(/retry/i);
    await submit.click();
    await page.waitForURL((url) => url.pathname.includes('/subjects/'));
    await page.unroute('**/_serverFn/**', dropFirstCreateResponse);

    expect(droppedResponse?.status).toBe(200);
    expect(droppedResponse?.body).not.toContain('Bearer ');
    const firstPosts = await subjectPosts(first.en.label);
    expect(firstPosts).toHaveLength(2);
    expect(firstPosts.map((request) => request.responseStatus)).toEqual([201, 201]);
    expect(firstPosts[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(firstPosts[1]?.idempotencyKey).toBe(firstPosts[0]?.idempotencyKey);
    expect(firstPosts[1]?.body).toBe(firstPosts[0]?.body);
    expect(firstPosts[0]?.authorization?.startsWith('Bearer ')).toBe(true);
    expect(JSON.parse(firstPosts[0]!.body!)).toEqual({
      type: 'schema:Book',
      labels: { en: first.en.label, 'zh-Hans': first.zh.label },
      descriptions: { en: first.en.description, 'zh-Hans': first.zh.description },
      aliases: { en: [first.en.alias], 'zh-Hans': [first.zh.alias] },
    });
    const firstPath = new URL(page.url()).pathname;
    const firstId = firstPath.match(/^\/en\/subjects\/([^/]+)/)?.[1];
    expect(firstId).toBeTruthy();
    expect(await publicSubjectIds(first.en.label)).toEqual([firstId]);

    await page.goto(`${stack.web}/en/catalogue/new`, { waitUntil: 'domcontentloaded' });
    await page.locator('form').waitFor({ state: 'visible' });
    await chooseBook(page);
    const second = await fillTerms(page, crypto.randomUUID());
    await stack.injectKernelFailureOnce({
      method: 'GET',
      path: '/v1/subjects/*',
      status: 503,
      body: '{"title":"Reader temporarily unavailable","status":503}',
    });
    await page.locator('form button[type="submit"]').click();

    const outcome = page.locator('section[role="status"]');
    await outcome.waitFor({ state: 'visible' });
    expect(await outcome.innerText()).toMatch(/created/i);
    const secondPosts = await subjectPosts(second.en.label);
    expect(secondPosts).toHaveLength(1);
    expect(secondPosts[0]?.responseStatus).toBe(201);
    const failedRead = stack
      .kernelRequests()
      .findLast(
        (request) => request.method === 'GET' && request.failure?.status === 503 && request.url.startsWith('/v1/subjects/'),
      );
    expect(failedRead).toBeDefined();
    const secondId = failedRead!.url.slice('/v1/subjects/'.length);

    await outcome.getByRole('button', { name: /retry/i }).click();
    await page.waitForURL((url) => url.pathname.includes(`/subjects/${secondId}`));
    expect((await subjectPosts(second.en.label))).toHaveLength(1);
    expect(await publicSubjectIds(second.en.label)).toEqual([secondId]);

    const allBrowserHeaders = await Promise.all(browserHeaders);
    const allFunctionResponses = await Promise.all(browserFunctionResponses);
    expect(allBrowserHeaders.every((headers) => !headers.has('authorization'))).toBe(true);
    expect(browserFunctionBodies.every((body) => !body.includes('Bearer '))).toBe(true);
    expect(allFunctionResponses.every((body) => !body.includes('Bearer '))).toBe(true);
  },
  900_000,
);
