/**
 * Current-dev first-public-scope walk for Web. Runs inside `dev-stack.ts walk`. Anonymous paths use real seeded
 * pages and kernel readback. Signed-in paths stay FAIL-unreached while issuer/JWKS origins differ; ce33aabc owns
 * that sign-in startup repair. Evidence stays under `.temp/goal/web/` and never records secrets.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startSeededFrontends } from '../../../services/auth/scripts/dev-stack.ts';
import { FIRST_PUBLIC_SCOPE_PATHS, type PathAuth, type PathId, type PathStatus } from './first-public-scope-paths.ts';

export { FIRST_PUBLIC_SCOPE_PATHS, type PathAuth, type PathId, type PathStatus } from './first-public-scope-paths.ts';

const root = resolve(import.meta.dir, '../../..');
export const evidenceDir = join(root, '.temp/goal/web');
const seedResult = join(root, '.temp/cross-media-seed/result.json');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const launchLocales = ['en', 'zh-Hant'] as const;
const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 860 };

export const SIGN_IN_STARTUP_CAUSE =
  'issuer JWKS origin differs from native Auth JWKS; urgent ce33aabc owns sign-in startup';

type Json = Record<string, unknown>;
type Stack = { web: string; issuer: string; native: string; kernel: string };
type PathResult = {
  id: PathId;
  job: string;
  auth: PathAuth;
  status: PathStatus;
  persona: string;
  elapsedMs: number;
  source: string;
  evidence: unknown;
  firstWrong?: string;
};

function loopback(variable: string): string {
  const value = process.env[variable];
  if (value === undefined) throw new Error(`${variable} is required inside dev-stack walk`);
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error(`${variable} must be loopback HTTP`);
  return url.origin;
}

function stackOrigins(): Stack {
  return {
    web: loopback('REZICS_LOCAL_STACK_WEB_ORIGIN'),
    issuer: loopback('REZICS_LOCAL_STACK_ISSUER_ORIGIN'),
    native: loopback('REZICS_LOCAL_STACK_NATIVE_ORIGIN'),
    kernel: loopback('REZICS_LOCAL_STACK_KERNEL_ORIGIN'),
  };
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error(`${label} is not a native identity`);
  return value;
}

function publicFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 24).map(publicFields);
  if (!value || typeof value !== 'object') return value;
  const output: Json = {};
  for (const [key, field] of Object.entries(value as Json)) {
    if (/token|password|cookie|authorization|secret|credential|bearer/i.test(key)) continue;
    output[key] = publicFields(field);
  }
  return output;
}

async function child(command: string[], name: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const log = Bun.file(join(evidenceDir, `${name}.log`));
  const handle = await log.writer();
  const proc = spawn(command[0]!, command.slice(1), { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (chunk: Buffer) => handle.write(chunk));
  proc.stderr.on('data', (chunk: Buffer) => handle.write(chunk));
  const code = await new Promise<number | null>((done) => proc.on('close', done));
  await handle.end();
  return code ?? 1;
}

async function parseEnv(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const match = /^(?<name>[A-Z0-9_]+)=(?<value>.*)$/.exec(line);
    if (match?.groups) values[match.groups.name!] = match.groups.value!.replace(/^'(.*)'$/, '$1');
  }
  return values;
}

async function sourceRevision(): Promise<string> {
  const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
  const text = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return text;
}

async function kernel(
  stack: Stack,
  method: string,
  path: string,
  options: { body?: unknown; query?: Record<string, string> } = {},
): Promise<{ status: number; value: Json; text: string }> {
  const url = new URL(path, stack.kernel);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(60_000),
    headers: {
      'accept-language': 'en',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' ? {} : { 'idempotency-key': crypto.randomUUID() }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let value: Json = {};
  if (text) {
    try {
      value = JSON.parse(text) as Json;
    } catch {
      value = { text: text.slice(0, 400) };
    }
  }
  return { status: response.status, value, text };
}

async function http(url: string): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'manual' });
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers.entries()) headers[name] = value;
  return { status: response.status, headers, text: await response.text() };
}

type Seed = {
  workId?: string;
  boardId?: string;
  threadId?: string;
  collectionId?: string;
  collectionMembers: string[];
  editionSubjectId?: string;
  readings: { provider: string; externalId: string; subjectId: string }[];
};

function workIdentity(seed: Json, provider: string, externalId: string): string | undefined {
  for (const entry of (seed.readings as Json[] | undefined) ?? []) {
    if (entry?.source !== provider || entry.externalId !== externalId) continue;
    const id = (entry.subject as Json | undefined)?.subject
      ? ((entry.subject as Json).subject as Json).id
      : (entry.subject as Json | undefined)?.id;
    if (typeof id === 'string' && uuid.test(id)) return id;
  }
  for (const entry of (seed.workLinks as Json[] | undefined) ?? []) {
    const source = entry?.source as Json | undefined;
    if (source?.provider !== provider || source.externalId !== externalId) continue;
    const id = (source.subject as Json | undefined)?.subjectId;
    if (typeof id === 'string' && uuid.test(id)) return id;
  }
  return undefined;
}

async function readSeed(): Promise<Seed> {
  if (!(await Bun.file(seedResult).exists())) throw new Error(`seed result missing: ${seedResult}`);
  const raw = JSON.parse(await readFile(seedResult, 'utf8')) as Json;
  const showcase = (raw.developmentShowcase as Json | undefined) ?? {};
  const community = (showcase.community as Json | undefined) ?? {};
  const collections = ((showcase.collections as Json[] | undefined) ?? []).filter(
    (row) => row.status === 'current' && (row.public as Json | undefined)?.id,
  );
  const published = collections[0];
  const members = ((published?.members as Json[] | undefined) ?? [])
    .map((member) => member.subjectId)
    .filter((id): id is string => typeof id === 'string' && uuid.test(id));
  const edition = showcase.edition as Json | undefined;
  const editionSubject =
    typeof edition?.targetSubjectId === 'string' && uuid.test(edition.targetSubjectId)
      ? edition.targetSubjectId
      : undefined;
  const workFromCommunity =
    community.state === 'published' && typeof (community.source as Json | undefined)?.subjectId === 'string'
      ? String((community.source as Json).subjectId)
      : undefined;
  return {
    workId: workFromCommunity ?? workIdentity(raw, 'vndb', 'v2002') ?? workIdentity(raw, 'bangumi', '10380'),
    boardId:
      typeof (community.board as Json | undefined)?.id === 'string' ? String((community.board as Json).id) : undefined,
    threadId:
      typeof (community.thread as Json | undefined)?.threadId === 'string'
        ? String((community.thread as Json).threadId)
        : undefined,
    collectionId: published ? requireId((published.public as Json).id, 'seeded Collection') : undefined,
    collectionMembers: members,
    editionSubjectId: editionSubject,
    readings: [
      ...['vndb:v2002', 'vndb:v4', 'bangumi:10380'].flatMap((pair) => {
        const [provider, externalId] = pair.split(':') as [string, string];
        const subjectId = workIdentity(raw, provider, externalId);
        return subjectId ? [{ provider, externalId, subjectId }] : [];
      }),
    ],
  };
}

async function hydrated(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 180_000 });
}

async function gotoPage(page: Page, url: string): Promise<{ status: number; url: string }> {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await hydrated(page);
  return { status: response?.status() ?? 0, url: page.url() };
}

async function shellOk(
  page: Page,
  locale: string,
): Promise<{ lang: string; main: number; banner: number; nav: number }> {
  const lang = (await page.locator('html').getAttribute('lang')) ?? '';
  if (lang !== locale) throw new Error(`html lang was ${JSON.stringify(lang)}, expected ${locale}`);
  const main = await page.getByRole('main').count();
  const banner = await page.getByRole('banner').count();
  const nav = await page.getByRole('navigation').count();
  if (main < 1 || banner < 1 || nav < 1)
    throw new Error(`localized shell missing main=${main} banner=${banner} nav=${nav}`);
  return { lang, main, banner, nav };
}

async function subjectHrefs(page: Page): Promise<string[]> {
  return page
    .locator('a[href*="/subjects/"]')
    .evaluateAll((nodes) => [
      ...new Set(nodes.map((node) => (node as HTMLAnchorElement).getAttribute('href') ?? '').filter(Boolean)),
    ]);
}

async function clickFirstSubject(page: Page, current: string): Promise<string> {
  const hrefs = await subjectHrefs(page);
  const next = hrefs.find((href) => !current.includes(href.split('?')[0] ?? href));
  if (!next) throw new Error(`no distinct subject link on ${current}`);
  await page.locator(`a[href="${next}"]`).first().click();
  await hydrated(page);
  return page.url();
}

async function openSubject(page: Page, stack: Stack, id: string, locale = 'en'): Promise<string> {
  const opened = await gotoPage(page, `${stack.web}/${locale}/subjects/${id}`);
  if (opened.status >= 400) throw new Error(`subject ${id} returned HTTP ${opened.status}`);
  if (new URL(opened.url).pathname.includes('/auth/sign-in')) throw new Error(`subject ${id} redirected to sign-in`);
  if (!opened.url.includes('/subjects/') && !opened.url.includes('/@'))
    throw new Error(`subject ${id} landed on ${opened.url}`);
  return opened.url;
}

async function openView(page: Page, name: string): Promise<string> {
  const tab = page.getByRole('link', { name, exact: true }).first();
  if ((await tab.count()) === 0) throw new Error(`view tab ${JSON.stringify(name)} is absent`);
  await tab.click();
  await hydrated(page);
  return page.url();
}

async function continueNative(page: Page): Promise<string | undefined> {
  const more = page.getByRole('link', { name: /more|continue|next/i }).first();
  const cursor = page.locator('a[href*="cursor="]').first();
  if ((await more.count()) > 0) {
    await more.click();
    await hydrated(page);
    return page.url();
  }
  if ((await cursor.count()) > 0) {
    await cursor.click();
    await hydrated(page);
    return page.url();
  }
  return undefined;
}

async function returnTo(page: Page, expected: string): Promise<void> {
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 120_000 });
  await hydrated(page);
  const now = page.url();
  const want = new URL(expected);
  const got = new URL(now);
  if (got.pathname !== want.pathname) throw new Error(`return landed on ${now}, expected pathname ${want.pathname}`);
}

async function pageRead(stack: Stack, subject: string, view?: string): Promise<{ status: number; value: Json }> {
  const body = { target: view ? { subject, view } : { subject }, languages: ['en'] };
  const result = await kernel(stack, 'POST', '/v1/pages:read', { body });
  return { status: result.status, value: result.value };
}

async function probeSignIn(stack: Stack): Promise<{ ok: boolean; detail: string }> {
  const issuerJwks = await http(`${stack.issuer}/.well-known/jwks.json`);
  const nativeJwks = await http(`${stack.native}/.well-known/jwks.json`);
  const discovery = await http(`${stack.issuer}/.well-known/openid-configuration`);
  const login = await http(`${stack.issuer}/login`);
  const signIn = await http(`${stack.web}/en/auth/sign-in?return_to=${encodeURIComponent('/en/library')}`);
  const sameOrigin = new URL(stack.issuer).origin === new URL(stack.native).origin;
  const nativeKeys = nativeJwks.status < 500;
  const issuerKeys = issuerJwks.status < 500 && /"keys"\s*:/.test(issuerJwks.text);
  if (!sameOrigin && nativeKeys && !issuerKeys) {
    return {
      ok: false,
      detail: `${SIGN_IN_STARTUP_CAUSE}; issuer=${stack.issuer} HTTP ${issuerJwks.status}; native=${stack.native} HTTP ${nativeJwks.status}; discovery HTTP ${discovery.status}; login HTTP ${login.status}; web sign-in HTTP ${signIn.status}`,
    };
  }
  if (login.status >= 400 || signIn.status >= 400) {
    return {
      ok: false,
      detail: `sign-in surfaces unavailable: login HTTP ${login.status}; web sign-in HTTP ${signIn.status}; issuer JWKS HTTP ${issuerJwks.status}; native JWKS HTTP ${nativeJwks.status}`,
    };
  }
  return {
    ok: true,
    detail: `issuer JWKS HTTP ${issuerJwks.status}; native JWKS HTTP ${nativeJwks.status}; login HTTP ${login.status}`,
  };
}

type WalkContext = {
  stack: Stack;
  seed: Seed;
  page: Page;
  source: string;
  signIn: { ok: boolean; detail: string };
};

async function walkW01(ctx: WalkContext): Promise<unknown> {
  const visits: unknown[] = [];
  const routes = ['/', '/search', '/collections', '/boards'];
  for (const viewport of [desktop, phone]) {
    await ctx.page.setViewportSize(viewport);
    for (const locale of launchLocales) {
      for (const route of routes) {
        const url = `${ctx.stack.web}/${locale}${route === '/' ? '' : route}`;
        const opened = await gotoPage(ctx.page, url);
        const shell = await shellOk(ctx.page, locale);
        visits.push({ viewport: viewport.width, locale, route, status: opened.status, url: opened.url, shell });
      }
    }
  }
  if (ctx.seed.workId) {
    await ctx.page.setViewportSize(phone);
    const url = await openSubject(ctx.page, ctx.stack, ctx.seed.workId, 'en');
    visits.push({ viewport: phone.width, locale: 'en', route: 'subject', url, shell: await shellOk(ctx.page, 'en') });
    await ctx.page.setViewportSize(desktop);
    const zh = await openSubject(ctx.page, ctx.stack, ctx.seed.workId, 'zh-Hant');
    visits.push({
      viewport: desktop.width,
      locale: 'zh-Hant',
      route: 'subject',
      url: zh,
      shell: await shellOk(ctx.page, 'zh-Hant'),
    });
  }
  return { visits };
}

async function walkW02(ctx: WalkContext): Promise<unknown> {
  if (!ctx.seed.workId) throw new Error('seed published no work Subject');
  const work = await openSubject(ctx.page, ctx.stack, ctx.seed.workId);
  const workRead = await pageRead(ctx.stack, ctx.seed.workId);
  if (workRead.status !== 200) throw new Error(`work pages:read HTTP ${workRead.status}`);
  const readers: unknown[] = [{ kind: 'work', url: work, native: workRead.status }];
  const releaseId = ctx.seed.editionSubjectId ?? ctx.seed.readings.find((row) => row.externalId !== 'v2002')?.subjectId;
  if (releaseId && releaseId !== ctx.seed.workId) {
    const release = await openSubject(ctx.page, ctx.stack, releaseId);
    const releaseRead = await pageRead(ctx.stack, releaseId);
    if (releaseRead.status !== 200) throw new Error(`release pages:read HTTP ${releaseRead.status}`);
    readers.push({ kind: 'release', url: release, native: releaseRead.status });
  } else {
    const editionsUrl = await openView(ctx.page, 'Editions').catch(() => undefined);
    if (!editionsUrl) throw new Error('no distinct release Subject and Editions tab is absent');
    const href = (await subjectHrefs(ctx.page))[0];
    if (!href) throw new Error('Editions page has no release link');
    await ctx.page.locator(`a[href="${href}"]`).first().click();
    await hydrated(ctx.page);
    readers.push({ kind: 'release', url: ctx.page.url(), via: 'editions' });
  }
  const handlePage = await gotoPage(ctx.page, `${ctx.stack.web}/en/@developer`);
  if (handlePage.status === 200 && !handlePage.url.includes('/auth/sign-in')) {
    readers.push({ kind: 'agent', url: handlePage.url, status: handlePage.status });
  } else {
    const credits = await openSubject(ctx.page, ctx.stack, ctx.seed.workId);
    await openView(ctx.page, 'Credits').catch(async () => openView(ctx.page, 'Cast'));
    const person = (await subjectHrefs(ctx.page)).find((href) => !credits.includes(href.split('?')[0] ?? href));
    if (!person) throw new Error('no agent or credited Person reader from the seeded work');
    await ctx.page.locator(`a[href="${person}"]`).first().click();
    await hydrated(ctx.page);
    readers.push({ kind: 'agent', url: ctx.page.url(), via: 'credits' });
  }
  return { readers };
}

async function walkViewToChild(
  ctx: WalkContext,
  tab: string,
  options: { next?: boolean; returnPathIncludes: string } = { returnPathIncludes: tab.toLowerCase() },
): Promise<unknown> {
  if (!ctx.seed.workId) throw new Error('seed published no work Subject');
  const origin = await openSubject(ctx.page, ctx.stack, ctx.seed.workId);
  const viewUrl = await openView(ctx.page, tab);
  const native = await pageRead(ctx.stack, ctx.seed.workId, tab.toLowerCase());
  const continued = options.next ? await continueNative(ctx.page) : undefined;
  const before = ctx.page.url();
  const child = await clickFirstSubject(ctx.page, before);
  await returnTo(ctx.page, before);
  if (
    !ctx.page.url().includes(options.returnPathIncludes) &&
    !new URL(ctx.page.url()).pathname.endsWith(new URL(viewUrl).pathname)
  )
    throw new Error(`return was ${ctx.page.url()}, not the ${tab} page`);
  return publicFields({ origin, viewUrl, continued, child, nativeStatus: native.status, return: ctx.page.url() });
}

async function walkW07(ctx: WalkContext): Promise<unknown> {
  if (!ctx.seed.workId) throw new Error('seed published no work Subject');
  await openSubject(ctx.page, ctx.stack, ctx.seed.workId);
  await openView(ctx.page, 'Credits').catch(async () => openView(ctx.page, 'Cast'));
  const personUrl = await clickFirstSubject(ctx.page, ctx.page.url());
  const worksTab = await openView(ctx.page, 'Works').catch(async () => openView(ctx.page, 'Appearances'));
  const before = ctx.page.url();
  const workUrl = await clickFirstSubject(ctx.page, before);
  await returnTo(ctx.page, before);
  const ja = await gotoPage(ctx.page, before.replace('/en/', '/ja/'));
  await shellOk(ctx.page, 'ja');
  return { personUrl, worksTab, workUrl, return: ctx.page.url(), ja: ja.url };
}

async function walkW08(ctx: WalkContext): Promise<unknown> {
  if (!ctx.seed.workId) throw new Error('seed published no work Subject');
  await openSubject(ctx.page, ctx.stack, ctx.seed.workId);
  const relations = await openView(ctx.page, 'Relations').catch(async () => {
    const graph = ctx.page.locator('a[href*="/graph"]').first();
    if ((await graph.count()) === 0) throw new Error('Relations tab and graph companion are absent');
    await graph.click();
    await hydrated(ctx.page);
    return ctx.page.url();
  });
  const before = ctx.page.url();
  const related = await clickFirstSubject(ctx.page, before);
  await returnTo(ctx.page, before);
  return { relations, related, return: ctx.page.url() };
}

async function walkW09(ctx: WalkContext): Promise<unknown> {
  if (!ctx.seed.workId) throw new Error('seed published no work Subject');
  await openSubject(ctx.page, ctx.stack, ctx.seed.workId);
  const details = await openView(ctx.page, 'Details');
  const sources = await ctx.page.locator('text=/source|history|statement/i').count();
  const history = ctx.page.locator('a[href*="changes"], a[href*="history"]').first();
  const historyUrl = (await history.count()) > 0 ? await history.getAttribute('href') : null;
  const native = await pageRead(ctx.stack, ctx.seed.workId, 'details');
  if (native.status !== 200) throw new Error(`details pages:read HTTP ${native.status}`);
  if (sources < 1 && !historyUrl) throw new Error('Details page has neither sourced facts nor history');
  return { details, sources, historyUrl, native: native.status };
}

async function walkW10(ctx: WalkContext): Promise<unknown> {
  const handle = await gotoPage(ctx.page, `${ctx.stack.web}/en/@developer`);
  if (handle.status >= 400 || handle.url.includes('/auth/sign-in')) {
    if (!ctx.seed.workId) throw new Error('no public handle and no seeded work for a credited agent');
    await openSubject(ctx.page, ctx.stack, ctx.seed.workId);
    await openView(ctx.page, 'Credits').catch(async () => openView(ctx.page, 'Cast'));
    await clickFirstSubject(ctx.page, ctx.page.url());
  }
  const canonical = await ctx.page.locator('link[rel="canonical"]').getAttribute('href');
  const url = ctx.page.url();
  if (!canonical) throw new Error('canonical profile link is absent');
  const accounts = await kernel(ctx.stack, 'GET', '/v1/accounts', {
    query: url.includes('/@') ? { handle: new URL(url).pathname.split('/@')[1]?.split('/')[0] ?? 'developer' } : {},
  });
  return { url, canonical, accounts: accounts.status };
}

async function walkW11(ctx: WalkContext): Promise<unknown> {
  const home = await gotoPage(ctx.page, `${ctx.stack.web}/en`);
  await shellOk(ctx.page, 'en');
  const feed = await kernel(ctx.stack, 'GET', '/v1/feedItems', { query: { stream: 'home', limit: '20' } });
  const items = (feed.value.feedItems as Json[] | undefined) ?? [];
  if (feed.status !== 200) throw new Error(`home feed HTTP ${feed.status}`);
  const card = ctx.page.locator('[data-feed-id], [data-collection-member-id] a, a[href*="/subjects/"]').first();
  if ((await card.count()) === 0 && items.length === 0) throw new Error('signed-out Home has no discovery item');
  if ((await card.count()) > 0) await card.click();
  else {
    const destination = (items[0]?.destination as Json | undefined)?.id;
    if (typeof destination !== 'string') throw new Error('home feed item has no destination');
    await openSubject(ctx.page, ctx.stack, destination);
  }
  await hydrated(ctx.page);
  if (!ctx.page.url().includes('/subjects/') && !ctx.page.url().includes('/collections/'))
    throw new Error(`discovery did not open a Subject or Collection: ${ctx.page.url()}`);
  return { home: home.url, feed: feed.status, items: items.length, opened: ctx.page.url() };
}

async function walkW18(ctx: WalkContext): Promise<unknown> {
  if (!ctx.seed.collectionId) throw new Error('seed published no public Collection');
  const url = await gotoPage(ctx.page, `${ctx.stack.web}/en/collections/${ctx.seed.collectionId}`);
  if (url.status >= 400) throw new Error(`public Collection HTTP ${url.status}`);
  await hydrated(ctx.page);
  const jsonLd = await ctx.page.locator('script[type="application/ld+json"]').allTextContents();
  const itemList = jsonLd.some((text) => text.includes('ItemList'));
  const native = await kernel(ctx.stack, 'GET', `/v1/collections/${ctx.seed.collectionId}`);
  if (!itemList) throw new Error('public Collection has no ItemList JSON-LD');
  return { url: url.url, itemList, members: ctx.seed.collectionMembers.length, native: native.status };
}

async function walkW29(ctx: WalkContext): Promise<unknown> {
  if (!ctx.seed.boardId || !ctx.seed.threadId) throw new Error('seed published no board or thread');
  const board = await gotoPage(ctx.page, `${ctx.stack.web}/en/boards/${ctx.seed.boardId}`);
  if (board.status >= 400) throw new Error(`board HTTP ${board.status}`);
  const thread = ctx.page.locator(`a[href*="${ctx.seed.threadId}"], a[href*="/threads/"]`).first();
  if ((await thread.count()) === 0) {
    await gotoPage(ctx.page, `${ctx.stack.web}/en/threads/${ctx.seed.threadId}`);
  } else {
    await thread.click();
    await hydrated(ctx.page);
  }
  if (!ctx.page.url().includes('/threads/')) throw new Error(`thread did not open: ${ctx.page.url()}`);
  const native = await kernel(ctx.stack, 'GET', `/v1/threads/${ctx.seed.threadId}`);
  if (!ctx.signIn.ok)
    throw Object.assign(new Error(`anonymous board/thread reached; write unreached: ${ctx.signIn.detail}`), {
      unreached: true,
    });
  return { board: board.url, thread: ctx.page.url(), native: native.status };
}

async function walkW31(ctx: WalkContext): Promise<unknown> {
  const realms = await gotoPage(ctx.page, `${ctx.stack.web}/en/realms`);
  const spaces = await kernel(ctx.stack, 'GET', '/v1/spaces', { query: { limit: '5' } });
  const realmLink = ctx.page.locator('a[href*="/realms/"], a[href*="/spaces/"]').first();
  if ((await realmLink.count()) === 0) {
    throw Object.assign(new Error('no public Realm or Space home on the seeded stack'), { unreached: true });
  }
  await realmLink.click();
  await hydrated(ctx.page);
  if (!ctx.signIn.ok)
    throw Object.assign(
      new Error(`public home reached ${ctx.page.url()}; membership unreached: ${ctx.signIn.detail}`),
      {
        unreached: true,
      },
    );
  return { directory: realms.url, opened: ctx.page.url(), spaces: spaces.status };
}

async function walkW34(ctx: WalkContext): Promise<unknown> {
  const zones = await kernel(ctx.stack, 'GET', '/v1/zones', { query: { limit: '5' } });
  const items = (zones.value.zones as Json[] | undefined) ?? (zones.value.items as Json[] | undefined) ?? [];
  const id = items.find((row) => typeof row.id === 'string')?.id;
  if (typeof id !== 'string')
    throw Object.assign(new Error(`seed published no static Zone (zones HTTP ${zones.status})`), { unreached: true });
  const page = await gotoPage(ctx.page, `${ctx.stack.web}/en/zones/${id}`);
  if (page.status >= 400) throw new Error(`Zone HTTP ${page.status}`);
  await shellOk(ctx.page, 'en');
  await ctx.page.goBack({ waitUntil: 'domcontentloaded' });
  await hydrated(ctx.page);
  return { id, url: page.url(), native: zones.status };
}

async function walkW35(ctx: WalkContext): Promise<unknown> {
  if (!ctx.seed.workId) throw new Error('seed published no work Subject');
  const subject = await openSubject(ctx.page, ctx.stack, ctx.seed.workId);
  const canonical = await ctx.page.locator('link[rel="canonical"]').getAttribute('href');
  const og = await ctx.page.locator('meta[property="og:url"]').getAttribute('content');
  const jsonLd = await ctx.page.locator('script[type="application/ld+json"]').allTextContents();
  if (!canonical) throw new Error('canonical link is absent');
  if (!og) throw new Error('og:url is absent');
  if (!jsonLd.some((text) => text.includes('@type') || text.includes('schema.org')))
    throw new Error('JSON-LD is absent');
  const robots = await http(`${ctx.stack.web}/robots.txt`);
  if (robots.status !== 200) throw new Error(`robots.txt HTTP ${robots.status}`);
  if (!/Sitemap:\s+\S+\/sitemap\.xml/i.test(robots.text)) throw new Error('robots.txt has no Sitemap line');
  const index = await http(`${ctx.stack.web}/sitemap.xml`);
  if (index.status !== 200 && index.status !== 503) throw new Error(`sitemap.xml HTTP ${index.status}`);
  const shards = [...index.text.matchAll(/<loc>([^<]*sitemap-[^<]+)<\/loc>/g)].map((match) => match[1]!);
  const shardResults: { url: string; status: number }[] = [];
  for (const loc of shards) {
    const shard = await http(loc);
    shardResults.push({ url: loc, status: shard.status });
    if (shard.status >= 400 && shard.status !== 503) throw new Error(`sitemap shard ${loc} HTTP ${shard.status}`);
  }
  if (index.status === 200 && shards.length === 0) throw new Error('sitemap index has no eligible shards');
  return {
    subject,
    canonical,
    og,
    jsonLd: jsonLd.length,
    robots: robots.status,
    sitemap: index.status,
    shards: shardResults,
  };
}

const walkers: Partial<Record<PathId, (ctx: WalkContext) => Promise<unknown>>> = {
  W01: walkW01,
  W02: walkW02,
  W03: (ctx) => walkViewToChild(ctx, 'Editions', { next: true, returnPathIncludes: '/editions' }),
  W04: (ctx) => walkViewToChild(ctx, 'Contents', { next: true, returnPathIncludes: '/contents' }),
  W05: (ctx) =>
    walkViewToChild(ctx, 'Cast', { returnPathIncludes: 'cast' }).catch(() =>
      walkViewToChild(ctx, 'Credits', { returnPathIncludes: '/credits' }),
    ),
  W06: (ctx) =>
    walkViewToChild(ctx, 'Crew', { returnPathIncludes: 'crew' }).catch(() =>
      walkViewToChild(ctx, 'Credits', { returnPathIncludes: '/credits' }),
    ),
  W07: walkW07,
  W08: walkW08,
  W09: walkW09,
  W10: walkW10,
  W11: walkW11,
  W18: walkW18,
  W29: walkW29,
  W31: walkW31,
  W34: walkW34,
  W35: walkW35,
};

function hourly(results: PathResult[]): void {
  const passing = results.filter((row) => row.status === 'PASS').length;
  const failing = results.filter((row) => row.status !== 'PASS');
  const slowest = failing.slice().sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
  console.log(
    `first-public-scope: ${passing}/35` +
      (slowest ? `; slowest failing ${slowest.id} ${slowest.elapsedMs}ms ${slowest.status}` : ''),
  );
}

export async function run(): Promise<PathResult[]> {
  if (!process.env.GOAL_TASK_ID || !/(native|browser)/.test(process.env.GOAL_ACCEPTANCE_REQUIRES ?? ''))
    throw new Error('The first-public-scope walk runs on a walk stack whose brief lists native and browser acceptance');
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await mkdir('/tmp/rw', { recursive: true, mode: 0o700 });
  const source = await sourceRevision();
  const results: PathResult[] = [];
  const failRest = (cause: string, persona = 'setup') => {
    for (const path of FIRST_PUBLIC_SCOPE_PATHS) {
      if (results.some((row) => row.id === path.id)) continue;
      results.push({
        id: path.id,
        job: path.job,
        auth: path.auth,
        status: 'FAIL-unreached',
        persona,
        elapsedMs: 0,
        source,
        evidence: { cause },
        firstWrong: cause,
      });
    }
  };

  const { retireDevelopmentSeedState, retireStaleSeedJournals, kernelEnvironment } =
    await import('../../../services/auth/scripts/dev-stack.ts');
  await retireDevelopmentSeedState(root);
  const kernelEnv = await kernelEnvironment();
  if (kernelEnv.DATABASE_URL) await retireStaleSeedJournals(root, kernelEnv.DATABASE_URL);

  const personaCode = await child(['bun', 'services/auth/scripts/dev-stack.ts', 'persona'], 'persona');
  if (personaCode !== 0) {
    failRest(`persona exited ${personaCode}; see .temp/goal/web/persona.log`);
    await writeEvidence(source, results, undefined, undefined);
    hourly(results);
    return results;
  }
  const seedEnv = { ...process.env, ...(await parseEnv(join(root, '.temp/local-stack/seed.env'))) };
  const seedCode = await child(['bun', 'scripts/datasets/cross-media-seed.ts', '--dev'], 'seed', seedEnv);
  let seed: Seed;
  try {
    seed = await readSeed();
  } catch (error) {
    failRest(`seed exited ${seedCode}: ${error instanceof Error ? error.message : String(error)}`);
    await writeEvidence(source, results, undefined, undefined);
    hourly(results);
    return results;
  }

  const stack = stackOrigins();
  const frontends = await startSeededFrontends();
  let browser: Browser | undefined;
  try {
    const signIn = await probeSignIn(stack);
    await writeFile(
      join(evidenceDir, 'sign-in-probe.json'),
      `${JSON.stringify({ stack, signIn, seed: publicFields(seed) }, null, 2)}\n`,
    );
    browser = await chromium.launch({ headless: true, env: { ...process.env, TMPDIR: '/tmp/rw' } });
    const context: BrowserContext = await browser.newContext({ locale: 'en-US', viewport: desktop });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const ctx: WalkContext = { stack, seed, page, source, signIn };

    for (const path of FIRST_PUBLIC_SCOPE_PATHS) {
      const started = performance.now();
      try {
        if (path.auth === 'signed-in' && !signIn.ok) {
          results.push({
            id: path.id,
            job: path.job,
            auth: path.auth,
            status: 'FAIL-unreached',
            persona: 'signed-in',
            elapsedMs: Math.round(performance.now() - started),
            source,
            evidence: { cause: signIn.detail },
            firstWrong: signIn.detail,
          });
          hourly(results);
          continue;
        }
        const walker = walkers[path.id];
        if (!walker) {
          results.push({
            id: path.id,
            job: path.job,
            auth: path.auth,
            status: 'FAIL-unreached',
            persona: path.auth === 'anonymous' ? 'anonymous' : 'signed-in',
            elapsedMs: Math.round(performance.now() - started),
            source,
            evidence: { cause: signIn.ok ? 'no walker' : signIn.detail },
            firstWrong: signIn.ok ? 'no walker' : signIn.detail,
          });
          hourly(results);
          continue;
        }
        const evidence = await walker(ctx);
        results.push({
          id: path.id,
          job: path.job,
          auth: path.auth,
          status: 'PASS',
          persona: path.auth === 'signed-in' ? 'signed-in' : 'anonymous',
          elapsedMs: Math.round(performance.now() - started),
          source,
          evidence,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unreached = Boolean((error as { unreached?: boolean }).unreached);
        results.push({
          id: path.id,
          job: path.job,
          auth: path.auth,
          status: unreached ? 'FAIL-unreached' : 'FAIL',
          persona: path.auth === 'signed-in' ? 'signed-in' : 'anonymous',
          elapsedMs: Math.round(performance.now() - started),
          source,
          evidence: { error: message, url: page.url() },
          firstWrong: message,
        });
      }
      hourly(results);
    }
  } catch (error) {
    failRest(error instanceof Error ? error.message : String(error));
  } finally {
    await browser?.close();
    await frontends.stop();
  }
  await writeEvidence(source, results, stack, seed);
  hourly(results);
  return results;
}

async function writeEvidence(source: string, results: PathResult[], stack?: Stack, seed?: Seed): Promise<void> {
  const passing = results.filter((row) => row.status === 'PASS').length;
  const failing = results.filter((row) => row.status !== 'PASS');
  const slowest = failing.slice().sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
  await writeFile(
    join(evidenceDir, 'evidence.json'),
    `${JSON.stringify(
      {
        source,
        observedAt: new Date().toISOString(),
        passing: `${passing}/35`,
        slowestFailing: slowest ? { id: slowest.id, elapsedMs: slowest.elapsedMs, status: slowest.status } : null,
        stack,
        seed: publicFields(seed),
        results,
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) {
  const results = await run();
  const failed = results.some((row) => row.status === 'FAIL');
  process.exit(failed ? 1 : 0);
}
