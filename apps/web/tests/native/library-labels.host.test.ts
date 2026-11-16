import { expect } from 'bun:test';
import { chromium, type Locator, type Page } from 'playwright';
import { startAuthStack, type NativeAuthStack } from './auth-stack';
import { createLibraryLabelsSubject } from './library-labels-fixture';
import { currentNativeLifecycle, NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle';
import { startNativeWebStack, type NativeWebStack } from './stack';

const lifecycle = new NativeTestLifecycle('native Library label journeys');
let stack: NativeWebStack;
let auth: NativeAuthStack;
let subject: Awaited<ReturnType<typeof createLibraryLabelsSubject>>;

nativeBeforeAll(lifecycle, 300_000, async () => {
  stack = await startNativeWebStack();
  expect(await stack.kernel('/v1/definitions/active')).toBeInstanceOf(Response);
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
        `Native Library label response: GET ${path} returned ${response.status} ${await response.text()}`,
      );
  }
  auth = await startAuthStack(stack);
});
nativeAfterAll(lifecycle, 180_000);

async function openSubject(page: Page): Promise<void> {
  const response = await page.goto(`${stack.web}/en/subjects/${subject.id}`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  expect(response?.headers()['cache-control']).toMatch(/private|no-store/i);
  await page.locator('#account-menu-button').waitFor({ state: 'visible' });
}

async function labelRequestOffset(): Promise<number> {
  await stack.refreshKernelRequests();
  return stack.kernelRequests().length;
}

async function checkLabelProducer(since: number) {
  await stack.refreshKernelRequests();
  const request = stack
    .kernelRequests()
    .slice(since)
    .find(
      ({ url, failure }) =>
        Boolean(failure) && (url.startsWith('/v1/libraryLabelAssignments') || url.startsWith('/v1/libraryLabels')),
    );
  if (request?.failure) {
    throw new Error(
      `Native Library label response: ${request.method} ${request.url} returned ${request.failure.status} ${request.failure.body}`,
    );
  }
}

async function openLabelPicker(page: Page, since: number): Promise<void> {
  try {
    await page.getByRole('button', { name: 'Add a label', exact: true }).click();
  } catch (cause) {
    await stack.refreshKernelRequests();
    const reads = stack
      .kernelRequests()
      .slice(since)
      .filter(
        ({ fixtureRequest, url }) =>
          !fixtureRequest &&
          /^\/v1\/(?:platform\/exposure|libraryLabelAssignments|libraryLabels|libraryEntries)(?:[/?]|$)/.test(url),
      )
      .slice(-8)
      .map(({ url, method, responseStatus, authorization, access }) => ({
        method,
        path: new URL(url, stack.kernelOrigin).pathname,
        status: responseStatus,
        credentialPresent: Boolean(authorization),
        authenticated: access?.authenticated,
        authorized: access?.authorized,
      }));
    const pageState = await page.evaluate(() => ({
      hydrated: document.documentElement.hasAttribute('data-hydrated'),
      library: document.querySelector('[data-slot="subject-library-actions"]') !== null,
      labels: document.querySelector('[data-subject-labels]') !== null,
      picker: document.querySelector('[data-subject-label-picker-details]') !== null,
      alerts: document.querySelectorAll('[data-slot="subject-library-actions"] [role="alert"]').length,
    }));
    throw new Error(
      `Subject label picker did not open at ${new URL(page.url()).pathname}: ${JSON.stringify({ pageState, reads })}`,
      { cause },
    );
  }
}

async function waitForLabelOutcome(page: Page, target: Locator, since: number): Promise<void> {
  try {
    await Promise.race([
      target.waitFor({ state: 'visible' }),
      page.getByRole('alert').first().waitFor({ state: 'visible' }),
    ]);
    await target.waitFor({ state: 'visible' });
  } finally {
    await checkLabelProducer(since);
  }
}

nativeTest(
  'the native served subject page keeps labels private between two Auth-signed-in owners',
  300_000,
  async () => {
    const alice = (await auth.signIn('alice')).continueOnPage();
    const beforeAlice = await labelRequestOffset();
    let labelId: string;
    try {
      await openSubject(alice);
      await checkLabelProducer(beforeAlice);
      await openLabelPicker(alice, beforeAlice);
      const picker = alice.locator('[data-subject-label-picker]');
      await picker.getByRole('textbox').fill('Alice private label');
      await picker.getByRole('button', { name: 'Create “Alice private label”', exact: true }).click();
      await alice.getByRole('heading', { name: 'Review label assignment', exact: true }).waitFor({ state: 'visible' });
      const beforeApply = await labelRequestOffset();
      await alice.getByRole('button', { name: 'Apply assignment', exact: true }).click();
      const labelLink = alice.locator('[data-subject-label-chip]').getByRole('link', {
        name: 'Alice private label',
        exact: true,
      });
      await waitForLabelOutcome(alice, labelLink, beforeApply);
      const shelfHref = await labelLink.getAttribute('href');
      expect(shelfHref).toMatch(/^\/en\/library\?label=[0-9a-f-]+$/i);
      const selectedId = new URL(shelfHref!, stack.web).searchParams.get('label');
      if (!selectedId) throw new Error('The exact private label shelf has no label identity');
      labelId = selectedId;
      const beforeShelf = await labelRequestOffset();
      await labelLink.click();
      await alice.getByRole('heading', { level: 1, name: 'Alice private label', exact: true }).waitFor();
      expect(await alice.locator('meta[name="robots"]').getAttribute('content')).toMatch(/noindex/);
      await checkLabelProducer(beforeShelf);
      const shelfReads = stack
        .kernelRequests()
        .slice(beforeShelf)
        .filter(({ url }) => url.startsWith('/v1/libraryLabelAssignments'));
      expect(shelfReads).toHaveLength(1);
      const shelfQuery = new URL(shelfReads[0]!.url, stack.kernelOrigin).searchParams;
      expect(shelfQuery.get('view')).toBe('FULL');
      expect(shelfQuery.get('labelId')).toBe(labelId);
    } finally {
      await alice.close();
    }
    const anonymous = await (await auth.context('anonymous')).newPage();
    try {
      const beforeAnonymous = await labelRequestOffset();
      const response = await anonymous.goto(`${stack.web}/en/subjects/${subject.id}`, {
        waitUntil: 'domcontentloaded',
      });
      expect(response?.status()).toBe(200);
      await anonymous.locator('html[data-hydrated]').waitFor({ state: 'attached' });
      expect(await anonymous.locator('[data-subject-label-chip]').count()).toBe(0);
      expect(await anonymous.locator('body').innerText()).not.toContain('Alice private label');
      await stack.refreshKernelRequests();
      expect(
        stack
          .kernelRequests()
          .slice(beforeAnonymous)
          .some(({ url }) => url.startsWith('/v1/libraryLabelAssignments')),
      ).toBe(false);
    } finally {
      await anonymous.close();
    }
    const bob = (await auth.signIn('bob')).continueOnPage();
    try {
      const beforeBob = await labelRequestOffset();
      await openSubject(bob);
      expect(await bob.locator('[data-subject-label-chip]').count()).toBe(0);
      expect(await bob.locator('body').innerText()).not.toContain('Alice private label');
      await checkLabelProducer(beforeBob);
      const aliceRead = stack
        .kernelRequests()
        .slice(beforeAlice, beforeBob)
        .find(({ url }) => url.startsWith('/v1/libraryLabelAssignments'));
      const bobRead = stack
        .kernelRequests()
        .slice(beforeBob)
        .find(({ url }) => url.startsWith('/v1/libraryLabelAssignments'));
      expect(aliceRead?.authorization?.startsWith('Bearer ')).toBe(true);
      expect(bobRead?.authorization?.startsWith('Bearer ')).toBe(true);
      expect(bobRead?.authorization !== aliceRead?.authorization).toBe(true);
      const foreignShelf = await bob.goto(`${stack.web}/en/library?label=${encodeURIComponent(labelId)}`);
      expect(foreignShelf?.status()).toBe(404);
      await bob.getByRole('heading', { level: 1, name: /not found/i }).waitFor({ state: 'visible' });
      expect(await bob.locator('meta[name="robots"]').getAttribute('content')).toMatch(/noindex/);
    } finally {
      await bob.close();
    }
  },
  lifecycle,
);

nativeTest(
  'the native served subject slot adds, removes and restores a label with JavaScript disabled',
  300_000,
  async () => {
    const signedIn = await auth.signIn('alice');
    const storageState = await signedIn.context.storageState();
    await signedIn.continueOnPage().close();
    const owner = currentNativeLifecycle();
    if (!owner) throw new Error('The script-free browser requires an active native test lifecycle');
    const browser = await chromium.launch();
    const closeBrowser = () => browser.close();
    const releaseBrowser = owner.register({
      label: 'script-free Library label browser',
      close: closeBrowser,
      force: closeBrowser,
    });
    try {
      const context = await browser.newContext({
        storageState,
        viewport: { width: 1280, height: 860 },
        reducedMotion: 'reduce',
        locale: 'en',
        javaScriptEnabled: false,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      const response = await page.goto(`${stack.web}/en/subjects/${subject.id}`, {
        waitUntil: 'domcontentloaded',
      });
      expect(response?.status()).toBe(200);
      await page.locator('[data-subject-label-picker-details] > summary').click();
      const picker = page.locator('[data-subject-label-picker]');
      await picker.getByRole('textbox').fill('No JavaScript label');
      const beforeAdd = await labelRequestOffset();
      await picker.getByRole('button', { name: 'Add a label', exact: true }).click();
      await page.getByText('The label is ready to create. Assignment is a separate step.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByText('Label created. It has not yet been assigned to this subject.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      const chip = page.locator('[data-subject-label-chip]').filter({ hasText: 'No JavaScript label' });
      await waitForLabelOutcome(page, chip, beforeAdd);

      const beforeRemove = await labelRequestOffset();
      await chip.getByRole('button', { name: 'Remove label No JavaScript label', exact: true }).click();
      const undo = page.locator('[data-label-undo]');
      await waitForLabelOutcome(page, undo, beforeRemove);
      expect(await chip.count()).toBe(0);

      const beforeRestore = await labelRequestOffset();
      await undo.getByRole('button', { name: /undo/i }).click();
      await waitForLabelOutcome(page, chip, beforeRestore);
    } finally {
      await closeBrowser();
      releaseBrowser();
    }
  },
  lifecycle,
);
