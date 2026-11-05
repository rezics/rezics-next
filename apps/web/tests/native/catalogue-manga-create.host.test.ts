import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { documentText, type DocumentSnapshot } from '@rezics/document';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { m } from '../../src/paraglide/messages.js';
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

async function signedInPage(path = '/en/catalogue/manga') {
  const journey = await auth.signIn('alice', { returnTo: path });
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(30_000);
  await page.locator('form').waitFor({ state: 'visible' });
  return { page, journey };
}

async function identity(page: Page, label: string) {
  await page.getByRole('textbox', { name: m.catalogue_create_label() }).fill(label);
  await page.getByRole('button', { name: m.identity_intake_search() }).click();
  await page.getByRole('button', { name: m.identity_intake_continue() }).click();
}

async function review(page: Page) {
  await page.getByRole('button', { name: m.manga_create_review() }).click();
  await page.locator('[data-manga-create-review]').waitFor({ state: 'visible' });
}

async function subjectPosts(label: string) {
  await stack.syncKernelRequests();
  return stack.kernelRequests().filter((request) => {
    if (request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body) return false;
    const body = JSON.parse(request.body) as { labels?: { en?: string } };
    return body.labels?.en === label;
  });
}

async function readCreated(id: string) {
  const response = await stack.kernel(`/v1/subjects/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    subject: {
      id: string;
      type: string;
      labels: Record<string, string>;
      statements: Record<
        string,
        {
          value: { type: string; content: unknown };
          qualifiers: { property: { id: string }; value: unknown }[];
          references: { parts: { value: { content: unknown } }[] }[];
        }[]
      >;
    };
  };
}

async function revokeCreate(accountId: string) {
  const response = await stack.kernel(
    '/v1/grants:revoke',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: accountId },
        actions: ['subject:create'],
        valid: '(,)',
      }),
    },
    'governor',
  );
  expect([200, 201, 204, 409]).toContain(response.status);
}

async function grantCreate(accountId: string) {
  const response = await stack.kernel(
    '/v1/grants',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: accountId },
        actions: ['subject:create'],
        valid: '(,)',
      }),
    },
    'governor',
  );
  expect([200, 201, 204, 409]).toContain(response.status);
}

test('Manga creation uses current parent authority, exact identity review and native acknowledgement recovery', async () => {
  const guest = await (await auth.context('anonymous')).newPage();
  guest.setDefaultTimeout(30_000);
  await guest.goto(`${stack.web}/en/catalogue/manga`, { waitUntil: 'domcontentloaded' });
  await guest.getByText(/sign in to create a catalogue identity/i).waitFor({ state: 'visible' });
  const type = guest.getByRole('combobox', { name: m.manga_grain() });
  await type.waitFor({ state: 'visible' });
  expect(await type.locator('option').count()).toBe(2);
  expect(await subjectPosts('Guest manga')).toHaveLength(0);
  await guest.getByRole('textbox', { name: m.catalogue_create_label() }).fill('Guest manga');
  await guest.getByRole('button', { name: m.identity_intake_search() }).click();
  await guest.getByRole('button', { name: m.identity_intake_unverified() }).click();
  await review(guest);
  expect(await guest.locator('#create-subject-submit').isDisabled()).toBe(true);
  await guest.close();

  const { page, journey } = await signedInPage();
  await stack.injectKernelFailureOnce({
    method: 'POST',
    path: '/v1/viewerActions',
    status: 503,
    body: '{"title":"Temporarily unavailable","status":503,"code":"dependency_unavailable"}',
  });
  await page.goto(`${stack.web}/en/catalogue/manga`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/required service is unavailable/i).waitFor({ state: 'visible' });
  expect(await page.getByRole('combobox', { name: m.manga_grain() }).locator('option').count()).toBe(2);
  await page.getByRole('button', { name: m.identity_intake_authority_retry() }).click();
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });

  const alice = await stack.authPersona('alice');
  await revokeCreate(alice.accountId);
  await page.goto(`${stack.web}/en/catalogue/manga`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/does not allow creating a catalogue identity/i).waitFor({ state: 'visible' });
  const refusedLabel = `Refused manga ${crypto.randomUUID()}`;
  await identity(page, refusedLabel);
  await review(page);
  expect(await page.locator('#create-subject-submit').isDisabled()).toBe(true);
  expect(await subjectPosts(refusedLabel)).toHaveLength(0);
  await grantCreate(alice.accountId);

  // Revoke after the page's current observation and after fresh eligibility, immediately before the native create.
  await page.goto(`${stack.web}/en/catalogue/manga`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
  const staleLabel = `Revoked after review ${crypto.randomUUID()}`;
  await identity(page, staleLabel);
  await review(page);
  let serverCalls = 0;
  let revokedDuringSubmit = false;
  await page.route('**/_serverFn/**', async (route) => {
    if (route.request().method() === 'POST') {
      serverCalls++;
      if (serverCalls === 2 && !revokedDuringSubmit) {
        revokedDuringSubmit = true;
        await revokeCreate(alice.accountId);
      }
    }
    await route.continue();
  });
  await page.locator('#create-subject-submit').click();
  await page.getByRole('alert').waitFor({ state: 'visible' });
  await page.getByText(/does not allow creating a catalogue identity/i).waitFor({ state: 'visible' });
  expect(revokedDuringSubmit).toBe(true);
  const stalePosts = await subjectPosts(staleLabel);
  expect(stalePosts).toHaveLength(1);
  expect(stalePosts[0]?.responseStatus).toBe(403);
  expect(stalePosts[0]?.access?.authorized).toBe(false);
  expect(await page.locator('#create-subject-submit').isDisabled()).toBe(true);
  await page.unroute('**/_serverFn/**');
  await grantCreate(alice.accountId);

  await page.goto(`${stack.web}/en/catalogue/manga`, { waitUntil: 'domcontentloaded' });
  const seriesLabel = `Native Manga series ${crypto.randomUUID()}`;
  const seriesText = `An independently authored account for ${seriesLabel}.`;
  await page.getByRole('combobox', { name: m.authored_title() }).selectOption('schema:abstract');
  await page.getByRole('button', { name: m.correction_add() }).last().click();
  await page.getByRole('textbox', { name: m.authored_language() }).fill('en');
  await page.getByRole('textbox', { name: m.authored_licence() }).fill('CC-BY-4.0');
  await page.locator('[contenteditable="true"]').last().fill(seriesText);
  await page.getByRole('checkbox', { name: m.authored_original() }).check();
  await page
    .getByRole('textbox', { name: m.relation_citation() })
    .fill('https://example.org/native-original-manga-text');
  await identity(page, seriesLabel);
  await review(page);
  const seriesReview = page.locator('[data-manga-create-review]');
  await seriesReview.getByText(seriesLabel, { exact: true }).waitFor({ state: 'visible' });
  await seriesReview.getByText(seriesText, { exact: false }).waitFor({ state: 'visible' });

  let dropped: { status: number; body: string } | undefined;
  const dropFirstCreateResponse = async (route: import('playwright').Route) => {
    if (!dropped && route.request().method() === 'POST' && route.request().postData()?.includes(seriesLabel)) {
      const response = await route.fetch();
      dropped = { status: response.status(), body: await response.text() };
      await route.abort('failed');
      return;
    }
    await route.continue();
  };
  await page.route('**/_serverFn/**', dropFirstCreateResponse);
  await page.locator('#create-subject-submit').click();
  await page.getByRole('alert').waitFor({ state: 'visible' });
  await page.locator('#create-subject-submit').click();
  await page.getByText(m.manga_created(), { exact: true }).waitFor({ state: 'visible' });
  const seriesId = (await page.locator('p.font-mono').last().innerText()).trim();
  expect(seriesId).toMatch(/^[0-9a-f-]{36}$/i);
  await page.unroute('**/_serverFn/**', dropFirstCreateResponse);
  const seriesAttempts = await subjectPosts(seriesLabel);
  expect(dropped?.status).toBe(200);
  expect(seriesAttempts).toHaveLength(2);
  expect(seriesAttempts[1]?.idempotencyKey).toBe(seriesAttempts[0]?.idempotencyKey);
  expect(seriesAttempts[1]?.body).toBe(seriesAttempts[0]?.body);
  const series = await readCreated(seriesId);
  expect(series.subject.id).toBe(seriesId);
  expect(series.subject.type).toBe('schema:ComicSeries');
  expect(series.subject.labels.en).toBe(seriesLabel);
  const authored = series.subject.statements['schema:abstract']?.[0]?.value.content as {
    document: DocumentSnapshot;
    language: string;
    licence: string;
  };
  expect(authored.language).toBe('en');
  expect(authored.licence).toBe('CC-BY-4.0');
  expect(documentText(authored.document)).toContain(seriesText);

  await page.goto(`${stack.web}/en/catalogue/manga`, { waitUntil: 'domcontentloaded' });
  const volumeLabel = `Native independent volume ${crypto.randomUUID()}`;
  await page.getByRole('combobox', { name: m.manga_grain() }).selectOption('schema:PublicationVolume');
  await page.getByRole('checkbox', { name: m.manga_independent() }).check();
  await page.getByRole('combobox', { name: m.manga_membership() }).selectOption('wdt:P179');
  await page.getByRole('button', { name: m.correction_add() }).last().click();
  const picker = page.locator('[data-manga-picker] input[role="combobox"]').first();
  await picker.fill(seriesLabel);
  await page.getByRole('option', { name: new RegExp(seriesLabel) }).click();
  await page.getByRole('combobox', { name: m.correction_add_qualifier() }).selectOption('schema:position');
  await page.getByRole('button', { name: m.relation_add_qualifier() }).click();
  await page.getByRole('textbox', { name: m.correction_value() }).fill('2');
  await page.getByRole('textbox', { name: m.relation_citation() }).fill('https://example.org/native-volume-membership');
  await identity(page, volumeLabel);
  await review(page);
  const volumeReview = page.locator('[data-manga-create-review]');
  await volumeReview.getByText(m.manga_independent(), { exact: false }).waitFor({ state: 'visible' });
  await stack.injectCreatedSubjectReadFailureOnce({
    status: 503,
    body: '{"title":"Reader temporarily unavailable"}',
  });
  await page.locator('#create-subject-submit').click();
  await page.getByText(m.manga_created(), { exact: true }).waitFor({ state: 'visible' });
  const volumeId = (await page.locator('p.font-mono').last().innerText()).trim();
  expect(await page.getByRole('button', { name: m.correction_retry() }).isVisible()).toBe(true);
  await page.getByRole('button', { name: m.correction_retry() }).click();
  await page.getByRole('link', { name: m.candidate_view_public() }).waitFor({ state: 'visible' });
  expect(await subjectPosts(volumeLabel)).toHaveLength(1);
  const volume = await readCreated(volumeId);
  expect(volume.subject.type).toBe('schema:PublicationVolume');
  expect(volume.subject.labels.en).toBe(volumeLabel);
  expect(volume.subject.statements['wdt:P179']?.[0]).toMatchObject({
    value: { content: seriesId },
    qualifiers: [{ property: { id: 'schema:position' }, value: { content: '2' } }],
    references: [{ parts: [{ value: { content: 'https://example.org/native-volume-membership' } }] }],
  });

  // A completed native ACK cannot repaint a route after its original creator has deliberately left.
  await page.goto(`${stack.web}/en/catalogue/manga`, { waitUntil: 'domcontentloaded' });
  const retiredLabel = `Retired Manga creator ${crypto.randomUUID()}`;
  await identity(page, retiredLabel);
  await review(page);
  let releaseResponse!: () => void;
  let responseCaptured!: () => void;
  const captured = new Promise<void>((resolve) => (responseCaptured = resolve));
  const gate = new Promise<void>((resolve) => (releaseResponse = resolve));
  const holdCreateResponse = async (route: import('playwright').Route) => {
    if (route.request().method() === 'POST' && route.request().postData()?.includes(retiredLabel)) {
      const response = await route.fetch();
      const body = await response.body();
      responseCaptured();
      await gate;
      await route.fulfill({ response, body });
      return;
    }
    await route.continue();
  };
  await page.route('**/_serverFn/**', holdCreateResponse);
  await page.locator('#create-subject-submit').click();
  await captured;
  await page.getByRole('link', { name: m.catalogue_create_search() }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: m.thread_authoring_leave() }).click();
  await page.waitForURL((url) => url.pathname.startsWith('/en/search'));
  releaseResponse();
  await page.unroute('**/_serverFn/**', holdCreateResponse);
  expect(await subjectPosts(retiredLabel)).toHaveLength(1);
  expect(await page.getByText(m.manga_created(), { exact: true }).count()).toBe(0);
  await journey.context.close();
}, 900_000);
