import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrowserContext, Page } from 'playwright';
import { UI_LOCALES } from '@rezics/composition';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import {
  createNativeStaticZonesFixture,
  zoneDisclosureComplaint,
  zoneDisclosureFieldPaths,
} from './native-static-zones-fixture.ts';
import type { NativeWebStack } from './stack.ts';
import { startNativeWebStack } from './stack.ts';

const titles: Record<(typeof UI_LOCALES)[number], string> = {
  en: 'Field Notes',
  'zh-Hant': '田野筆記',
  'zh-Hans': '田野札记',
  ja: 'フィールドノート',
  ko: '현장 노트',
  de: 'Feldnotizen',
  fr: 'Notes de terrain',
  es: 'Notas de campo',
};
const subjectLabels: Record<(typeof UI_LOCALES)[number], string> = {
  en: 'Static link subject',
  'zh-Hant': '靜態連結主題',
  'zh-Hans': '静态链接主题',
  ja: '静的リンク対象',
  ko: '정적 링크 주제',
  de: 'Statisches Linkthema',
  fr: 'Sujet du lien statique',
  es: 'Enlace estático',
};
const copy: Record<(typeof UI_LOCALES)[number], string> = {
  en: 'A public page from the native Zone configuration.',
  'zh-Hant': '原生區域頁面內容。',
  'zh-Hans': '原生区域页面内容。',
  ja: 'ネイティブなゾーンページです。',
  ko: '네이티브 구역 페이지입니다.',
  de: 'Eine native Zone-Seite.',
  fr: 'Une page Zone native.',
  es: 'Una página Zone nativa.',
};

let stack: NativeWebStack;
let auth: NativeAuthStack;
let fixture: Awaited<ReturnType<typeof createNativeStaticZonesFixture>>;
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  stack = await startNativeWebStack();
  auth = await startAuthStack(stack);
  fixture = await createNativeStaticZonesFixture(stack);
}, 360_000);

afterAll(async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => {});
  await auth?.stop();
  await stack?.stop();
}, 180_000);

async function browserPage(context: BrowserContext, path: string, viewport: { width: number; height: number }) {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.setViewportSize(viewport);
  await page.goto(`${stack.web}${path}`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  return page;
}

async function ownContext(persona: 'anonymous' | 'alice' | 'bob') {
  const context = await auth.context(persona);
  if (!contexts.includes(context)) contexts.push(context);
  return context;
}

function canonicalPath(page: Page) {
  const href = page.locator('link[rel="canonical"]').getAttribute('href');
  return href.then((value) => new URL(value!, stack.web).pathname);
}

async function pageProblem(response: Response) {
  return (await response.json()) as { code?: string; request_id?: string };
}

test('anonymous readers use native static Zone pages, actual subject links, and localized canonical paths', async () => {
  const started = stack.kernelRequests().length;
  for (const locale of UI_LOCALES) {
    const response = await stack.request(`${stack.web}/${locale}/zones/${fixture.publicZoneId}`);
    expect(response.status, `${locale} home`).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-zone-shell');
    expect(html).toContain('data-zone-page');
    expect(html).toContain(titles[locale]);
    expect(html).toContain(copy[locale]);
    expect(html).toContain(subjectLabels[locale]);
    expect(html).toContain(`/${locale}/subjects/${fixture.subjectId}/`);
    expect(html).toContain(`/${locale}/zones/${fixture.publicZoneId}/guide`);
    expect(html).not.toContain('zone_sources');
    expect(html).not.toContain('Saved scope');
    expect(html).not.toContain('Mount collection');
  }

  const metadata = await stack.kernel(`/v1/zones/${fixture.publicZoneId}`);
  expect(metadata.status).toBe(200);
  const publicZone = (await metadata.json()) as { zone: Record<string, unknown> };
  expect(publicZone.zone).not.toHaveProperty('ownerId');
  expect(publicZone.zone).not.toHaveProperty('mounts');
  expect(publicZone.zone).not.toHaveProperty('configuration');

  const anonymous = await ownContext('anonymous');
  const phone = await browserPage(anonymous, `/zh-Hans/zones/${fixture.publicZoneId}`, { width: 390, height: 844 });
  await phone.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await phone.getByRole('heading', { level: 1, name: titles['zh-Hans'] }).waitFor();
  await phone.getByRole('navigation', { name: 'Zone navigation' }).waitFor();
  await phone.getByText(copy['zh-Hans']).waitFor();
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  expect(await phone.getByRole('searchbox').count()).toBe(0);
  expect(await phone.getByRole('button', { name: /scope|mount|prepare|edit/i }).count()).toBe(0);
  expect(await phone.getByText(/no subjects|0 subjects|all results|complete results|empty results/i).count()).toBe(0);
  expect(await canonicalPath(phone)).toBe(`/zh-Hans/zones/${fixture.publicZoneId}`);

  const subjectLink = phone.getByRole('link', { name: subjectLabels['zh-Hans'], exact: true });
  await subjectLink.focus();
  expect(await subjectLink.evaluate((node) => node === document.activeElement)).toBe(true);
  await phone.keyboard.press('Enter');
  await phone.waitForURL((url) => url.pathname.startsWith(`/zh-Hans/subjects/${fixture.subjectId}/`));
  expect(await phone.getByRole('heading', { name: subjectLabels['zh-Hans'] }).count()).toBeGreaterThan(0);
  expect(await canonicalPath(phone)).toBe(new URL(`${stack.web}/zh-Hans/subjects/${fixture.subjectId}`).pathname);
  await phone.goBack();
  await phone.waitForURL(new URL(`${stack.web}/zh-Hans/zones/${fixture.publicZoneId}`).href);
  expect(await canonicalPath(phone)).toBe(`/zh-Hans/zones/${fixture.publicZoneId}`);

  const desktop = await browserPage(anonymous, `/en/zones/${fixture.publicZoneId}/guide`, {
    width: 1280,
    height: 860,
  });
  await desktop.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await desktop.getByRole('heading', { level: 1, name: 'Guide' }).waitFor();
  await desktop.getByText('A second declared static page.').waitFor();
  expect(await canonicalPath(desktop)).toBe(`/en/zones/${fixture.publicZoneId}/guide`);

  const nativeReads = stack.kernelRequests().slice(started);
  expect(nativeReads.some(({ url }) => url.includes(`/v1/zones/${fixture.publicZoneId}:readPage`))).toBe(true);
  expect(
    nativeReads.filter(({ url }) =>
      /\/v1\/zones\/[^/?]+\/(?:subjects|collections)|\/v1\/(?:subjects:search|search)|\/v1\/zones\/[^/?]+:prepare/.test(
        url,
      ),
    ),
  ).toEqual([]);
  expect(nativeReads.every(({ failure }) => failure === undefined)).toBe(true);
});

test('private and missing Zones are unknown-equivalent, while their native owner sees only the static page', async () => {
  const privateRead = await stack.kernel(`/v1/zones/${fixture.privateZoneId}:readPage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: { route: '' }, languages: ['en'] }),
  });
  const missingId = '00000000-0000-4000-8000-000000000000';
  const missingRead = await stack.kernel(`/v1/zones/${missingId}:readPage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: { route: '' }, languages: ['en'] }),
  });
  expect(privateRead.status).toBe(404);
  expect(missingRead.status).toBe(404);
  const [privateProblem, missingProblem] = await Promise.all([pageProblem(privateRead), pageProblem(missingRead)]);
  expect(privateProblem.code).toBe('not_found');
  expect(missingProblem.code).toBe('not_found');
  expect(privateProblem.request_id).not.toBe(missingProblem.request_id);

  const anonymous = await ownContext('anonymous');
  const hidden = await browserPage(anonymous, `/en/zones/${fixture.privateZoneId}`, { width: 1280, height: 860 });
  const unknown = await browserPage(anonymous, `/en/zones/${missingId}`, { width: 1280, height: 860 });
  await expect(hidden.locator('main').innerText()).resolves.toBe(await unknown.locator('main').innerText());
  expect(await hidden.locator('main').innerText()).not.toContain(fixture.privateSentinel);
  expect(await canonicalPath(hidden)).toBe(`/en/zones/${fixture.privateZoneId}`);

  const alice = await auth.signIn('alice');
  const ownerPage = alice.context.pages().at(-1)!;
  await ownerPage.goto(`${stack.web}/en/zones/${fixture.privateZoneId}`, { waitUntil: 'domcontentloaded' });
  await ownerPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(ownerPage.getByText(fixture.privateSentinel, { exact: true })).toBeTruthy();
  await ownerPage.getByText(fixture.privateSentinel, { exact: true }).waitFor();
  expect(await ownerPage.getByRole('button', { name: /scope|mount|prepare|edit/i }).count()).toBe(0);
  expect(await ownerPage.getByRole('searchbox').count()).toBe(0);
  expect((await alice.requestHeaders()).every((headers) => !headers.has('authorization'))).toBe(true);
  if (!contexts.includes(alice.context)) contexts.push(alice.context);

  const bob = await auth.signIn('bob');
  const bobPage = bob.context.pages().at(-1)!;
  await bobPage.goto(`${stack.web}/en/zones/${fixture.privateZoneId}`, { waitUntil: 'domcontentloaded' });
  await bobPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await expect(bobPage.locator('main').innerText()).resolves.toBe(await unknown.locator('main').innerText());
  expect(await bobPage.locator('main').innerText()).not.toContain(fixture.privateSentinel);
  if (!contexts.includes(bob.context)) contexts.push(bob.context);
});

test('static Zone pages do not offer closed source operations or invoke source-dependent reads', async () => {
  const before = stack.kernelRequests().length;
  const configuration = await stack.kernel(`/v1/zones/${fixture.publicZoneId}/configuration`, {}, 'alice');
  expect(configuration.status).toBe(200);
  const saved = (await configuration.json()) as { configuration: { scope: string[] }; mounts: string[] };
  expect(saved.configuration.scope).toEqual([]);
  expect(saved.mounts).toEqual([]);

  const anonymous = await ownContext('anonymous');
  const page = await browserPage(anonymous, `/en/zones/${fixture.publicZoneId}`, { width: 1280, height: 860 });
  expect(await page.getByRole('searchbox').count()).toBe(0);
  expect(await page.getByRole('button', { name: /mount|scope|save|prepare|union|direct/i }).count()).toBe(0);
  const visibleText = await page.locator('main').innerText();
  expect(visibleText).not.toMatch(
    /saved scope|mount collection|union|prepar|no subjects|0 subjects|all results|empty/i,
  );

  const reads = stack.kernelRequests().slice(before);
  expect(
    reads.filter(({ url }) =>
      /\/v1\/zones\/[^/?]+\/(?:subjects|collections)|\/v1\/(?:subjects:search|search)|\/v1\/zones\/[^/?]+:prepare/.test(
        url,
      ),
    ),
  ).toEqual([]);
});

test('current Zone takedown removes protected copy from page and metadata for the next persona read', async () => {
  const alice = await auth.signIn('alice');
  const alicePage = alice.context.pages().at(-1)!;
  const previousResponse = await alicePage.goto(`${stack.web}/en/zones/${fixture.publicZoneId}`, {
    waitUntil: 'domcontentloaded',
  });
  await alicePage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(previousResponse?.status()).toBe(200);
  await alicePage.getByText(fixture.protectedSentinel, { exact: true }).waitFor();
  if (!contexts.includes(alice.context)) contexts.push(alice.context);

  const originalPage = await stack.kernel(
    `/v1/zones/${fixture.publicZoneId}:readPage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { route: '' }, languages: ['en'] }),
    },
    'alice',
  );
  expect(originalPage.status).toBe(200);
  expect(JSON.stringify(await originalPage.json())).toContain(fixture.protectedSentinel);

  const takedown = await stack.kernel(
    `/v1/zones/${fixture.publicZoneId}:takedown`,
    {
      method: 'POST',
      headers: commandHeaders(),
      body: JSON.stringify({
        notice: { complaint: zoneDisclosureComplaint, received_at: new Date().toISOString() },
        fields: zoneDisclosureFieldPaths,
      }),
    },
    'governor',
  );
  expect(takedown.status, `POST /v1/zones/${fixture.publicZoneId}:takedown: ${await takedown.clone().text()}`).toBe(
    200,
  );

  const nextPage = await stack.kernel(`/v1/zones/${fixture.publicZoneId}:readPage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: { route: '' }, languages: ['en'] }),
  });
  expect(nextPage.status).toBe(200);
  const pageBody = JSON.stringify(await nextPage.json());
  expect(pageBody).not.toContain(fixture.protectedSentinel);

  const metadata = await stack.kernel(`/v1/zones/${fixture.publicZoneId}`);
  expect(metadata.status).toBe(200);
  const metadataBody = JSON.stringify(await metadata.json());
  expect(metadataBody).not.toContain('Field Notes');
  expect(metadataBody).not.toContain(fixture.protectedSentinel);

  const bob = await auth.signIn('bob');
  const bobPage = bob.context.pages().at(-1)!;
  await bobPage.goto(`${stack.web}/en/zones/${fixture.publicZoneId}`, { waitUntil: 'domcontentloaded' });
  await bobPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(await bobPage.locator('main').innerText()).not.toContain(fixture.protectedSentinel);
  expect(await bobPage.locator('[data-zone-shell]').innerText()).not.toContain('Field Notes');
  if (!contexts.includes(bob.context)) contexts.push(bob.context);
});
