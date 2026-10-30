import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { startAuthStack, type NativeAuthStack } from './auth-stack';
import { createLibraryLabelsSubject } from './library-labels-fixture';
import { startNativeWebStack, type NativeWebStack } from './stack';

setDefaultTimeout(300_000);
let stack: NativeWebStack;
let auth: NativeAuthStack;
let subject: Awaited<ReturnType<typeof createLibraryLabelsSubject>>;

beforeAll(async () => {
  stack = await startNativeWebStack();
  await expect(await stack.kernel('/v1/definitions/active')).toBeInstanceOf(Response);
  const opened = await stack.kernel(
    '/v1/platform/exposure/personal_library:open',
    { method: 'POST', headers: { 'idempotency-key': `"${crypto.randomUUID()}"` } },
    'governor',
  );
  expect(opened.status).toBe(200);
  const progressOpened = await stack.kernel(
    '/v1/platform/exposure/reading_progress:open',
    { method: 'POST', headers: { 'idempotency-key': `"${crypto.randomUUID()}"` } },
    'governor',
  );
  expect(progressOpened.status).toBe(200);
  subject = await createLibraryLabelsSubject(stack);
  for (const path of [
    '/v1/libraryLabels?limit=20',
    `/v1/libraryLabelAssignments?subjectId=${encodeURIComponent(subject.id)}&view=FULL&limit=32`,
  ]) {
    const response = await stack.kernel(path, {}, 'alice');
    if (!response.ok)
      throw new Error(
        `Commerce label producer response: GET ${path} returned ${response.status} ${await response.text()}`,
      );
  }
  auth = await startAuthStack(stack);
}, 300_000);

afterAll(async () => {
  await auth?.stop();
  await stack?.stop();
}, 180_000);

async function subjectPage(context: BrowserContext): Promise<Page> {
  const page = context.pages().at(-1) ?? (await context.newPage());
  const response = await page.goto(`${stack.web}/en/subjects/${subject.id}`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  expect(response?.headers()['cache-control']).toMatch(/private|no-store/i);
  await page.locator('#account-menu-button').waitFor({ state: 'visible' });
  return page;
}

function missingLabelProducer(): never | void {
  const request = stack
    .kernelRequests()
    .find(
      ({ url, failure }) =>
        Boolean(failure) && (url.startsWith('/v1/libraryLabelAssignments') || url.startsWith('/v1/libraryLabels')),
    );
  if (request?.failure) {
    throw new Error(
      `Commerce label producer response: ${request.method} ${request.url} returned ${request.failure.status} ${request.failure.body}`,
    );
  }
}

async function waitForLabelOutcome(page: Page, expected: string): Promise<void> {
  const target = page.locator(expected).first();
  await Promise.race([
    target.waitFor({ state: 'visible' }),
    page.getByRole('alert').first().waitFor({ state: 'visible' }),
  ]);
  missingLabelProducer();
  await target.waitFor({ state: 'visible' });
}

test('the native served subject page keeps labels private between two Auth-signed-in owners', async () => {
  const alice = await auth.signIn('alice');
  const beforeAlice = stack.kernelRequests().length;
  const alicePage = await subjectPage(alice.context);
  missingLabelProducer();
  await alicePage.getByRole('button', { name: /add.*label/i }).click();
  const picker = alicePage.locator('[data-subject-label-picker]');
  await picker.getByRole('textbox').fill('Alice private label');
  await alicePage.getByRole('button', { name: /create.*Alice private label/i }).click();
  await waitForLabelOutcome(alicePage, '[data-subject-label-chip]:has-text("Alice private label")');
  const labelLink = alicePage.locator('[data-subject-label-chip] a').filter({ hasText: 'Alice private label' });
  const shelfHref = await labelLink.getAttribute('href');
  expect(shelfHref).toMatch(/^\/en\/library\?label=[0-9a-f-]+$/i);
  const foreignLabelId = new URL(shelfHref!, 'https://rezics.example.test').searchParams.get('label');
  const beforeShelf = stack.kernelRequests().length;
  await labelLink.click();
  await alicePage.getByRole('heading', { level: 1, name: 'Alice private label' }).waitFor();
  await expect(alicePage.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  const shelfReads = stack
    .kernelRequests()
    .slice(beforeShelf)
    .filter(({ url }) => url.startsWith('/v1/libraryLabelAssignments'));
  expect(shelfReads).toHaveLength(1);
  const shelfQuery = new URL(shelfReads[0]!.url, stack.kernelOrigin).searchParams;
  expect(shelfQuery.get('view')).toBe('FULL');
  expect(shelfQuery.get('labelId')).toBe(foreignLabelId);
  await subjectPage(alice.context);

  const anonymousContext = await chromium.launch();
  try {
    const anonymousPage = await anonymousContext.newPage();
    const beforeAnonymous = stack.kernelRequests().length;
    const response = await anonymousPage.goto(`${stack.web}/en/subjects/${subject.id}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(response?.status()).toBe(200);
    expect(await anonymousPage.locator('[data-subject-label-chip]').count()).toBe(0);
    expect(await anonymousPage.locator('body').innerText()).not.toContain('Alice private label');
    expect(
      stack
        .kernelRequests()
        .slice(beforeAnonymous)
        .some(({ url }) => url.startsWith('/v1/libraryLabelAssignments')),
    ).toBe(false);
  } finally {
    await anonymousContext.close();
  }

  const bob = await auth.signIn('bob');
  const beforeBob = stack.kernelRequests().length;
  const bobPage = await subjectPage(bob.context);
  expect(await bobPage.locator('[data-subject-label-chip]').count()).toBe(0);
  expect(await bobPage.locator('body').innerText()).not.toContain('Alice private label');
  const foreignShelf = await bobPage.goto(`${stack.web}/en/library?label=${encodeURIComponent(foreignLabelId ?? '')}`);
  expect(foreignShelf?.status()).toBe(404);
  await expect(bobPage.getByRole('heading', { name: /not found/i })).toBeVisible();
  await expect(bobPage.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  const aliceRead = stack
    .kernelRequests()
    .slice(beforeAlice)
    .find(({ url }) => url.startsWith('/v1/libraryLabelAssignments'));
  const bobRead = stack
    .kernelRequests()
    .slice(beforeBob)
    .find(({ url }) => url.startsWith('/v1/libraryLabelAssignments'));
  expect(aliceRead?.authorization).toMatch(/^Bearer /);
  expect(bobRead?.authorization).toMatch(/^Bearer /);
  expect(bobRead?.authorization).not.toBe(aliceRead?.authorization);
  expect(alicePage.locator('[data-subject-label-chip]').first()).toBeDefined();
});

test('the native served subject slot adds, removes and restores a label with JavaScript disabled', async () => {
  const signedIn = await auth.signIn('alice');
  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: await signedIn.context.storageState(),
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    locale: 'en',
    javaScriptEnabled: false,
  });
  try {
    const noScriptPage = await context.newPage();
    noScriptPage.setDefaultTimeout(30_000);
    const response = await noScriptPage.goto(`${stack.web}/en/subjects/${subject.id}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(response?.status()).toBe(200);
    await noScriptPage.locator('[data-subject-label-picker-details] > summary').click();
    await noScriptPage.locator('[data-subject-label-picker]').getByRole('textbox').fill('No JavaScript label');
    await noScriptPage
      .locator('[data-subject-label-picker]')
      .getByRole('button', { name: /add.*label/i })
      .click();
    await waitForLabelOutcome(noScriptPage, '[data-subject-label-chip]:has-text("No JavaScript label")');
    const chip = noScriptPage.locator('[data-subject-label-chip]').filter({ hasText: 'No JavaScript label' });
    await chip.getByRole('button', { name: /remove label/i }).click();
    await waitForLabelOutcome(noScriptPage, '[data-label-undo]');
    const undo = noScriptPage.locator('[data-label-undo]');
    await undo.getByRole('button', { name: /undo/i }).click();
    await waitForLabelOutcome(noScriptPage, '[data-subject-label-chip]:has-text("No JavaScript label")');
  } finally {
    await context.close();
    await browser.close();
  }
});
