/**
 * Current-dev first-public-scope walk for Web. Runs inside `dev-stack.ts walk`. Anonymous paths use real seeded
 * pages and kernel readback. Paths owned by isolated native/browser host suites name their exact separate
 * entrypoints and stay FAIL-unreached here. Evidence stays under `.temp/goal/web/` and never records secrets.
 */
import { walkAcceptanceId, walkStackAdmitted } from '../../../scripts/stack-run.ts';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { developmentKeys, firstPublicWebWalk, startSeededFrontends } from '../../../services/auth/scripts/dev-stack.ts';
import { fillPasswordSignIn, parseEnv, websiteToken } from './accounts-goal-walk.ts';
import { readFirstPublicCatalogueReport, seedFirstPublicWeb, type WebFixture } from './first-public-scope-fixture.ts';
import { readZonePage, type KernelOptions } from './semantic-first-public-native.ts';
import { FIRST_PUBLIC_SCOPE_PATHS, type PathAuth, type PathId, type PathStatus } from './first-public-scope-paths.ts';

export { FIRST_PUBLIC_SCOPE_PATHS, type PathAuth, type PathId, type PathStatus } from './first-public-scope-paths.ts';

const root = resolve(import.meta.dir, '../../..');
export const evidenceDir = join(root, '.temp/goal/web');
const launchLocales = ['en', 'zh-Hant'] as const;
const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 860 };

export const SIGN_IN_STARTUP_CAUSE = 'native sign-in prerequisites unavailable';
const SEPARATE_NATIVE_JOURNEY_CAUSE =
  'This seeded walk has no walker for this required journey; run its isolated native/browser host suite separately';

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
  acceptanceCommand?: string[];
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

function publicFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 24).map(publicFields);
  if (!value || typeof value !== 'object') return value;
  const output: Json = {};
  for (const [key, field] of Object.entries(value as Json)) {
    if (/token|password|cookie|authorization|secret|credential|bearer|^email$/i.test(key)) continue;
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

async function sourceRevision(): Promise<string> {
  const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
  const text = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return text;
}

async function kernel(stack: Stack, method: string, path: string, options: KernelOptions = {}) {
  const url = new URL(path, stack.kernel);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(60_000),
    redirect: 'error',
    headers: {
      'accept-language': 'en',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
      ...(options.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` }),
      ...(options.ifMatch === undefined ? {} : { 'if-match': JSON.stringify(options.ifMatch) }),
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
  return { status: response.status, body: value, value, headers: response.headers };
}

async function http(url: string): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'manual' });
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers.entries()) headers[name] = value;
  return { status: response.status, headers, text: await response.text() };
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
  seed: WebFixture;
  page: Page;
  signIn: { ok: boolean; detail: string };
};

async function walkW01(ctx: WalkContext): Promise<unknown> {
  const visits: unknown[] = [];
  const routes = ['/', '/books', '/collections', '/boards'];
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
  const release = await openSubject(ctx.page, ctx.stack, ctx.seed.releaseId);
  const releaseRead = await pageRead(ctx.stack, ctx.seed.releaseId);
  if (releaseRead.status !== 200) throw new Error(`release pages:read HTTP ${releaseRead.status}`);
  readers.push({ kind: 'release', url: release, native: releaseRead.status });
  readers.push({ kind: 'agent', ...(await walkW10(ctx)) });
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

async function walkW10(ctx: WalkContext) {
  const { accountId, handle, subjectId } = ctx.seed.owner;
  const page = await gotoPage(ctx.page, `${ctx.stack.web}/en/@${handle}`);
  if (page.status !== 200 || new URL(page.url).pathname !== `/en/@${handle}`)
    throw new Error(`public fixture profile HTTP ${page.status} at ${page.url}`);
  const canonical = await ctx.page.locator('link[rel="canonical"]').getAttribute('href');
  if (!canonical || new URL(canonical, page.url).pathname !== new URL(page.url).pathname)
    throw new Error('The exact canonical profile link is absent');
  const accounts = await kernel(ctx.stack, 'GET', '/v1/accounts', { query: { handle } });
  const rows = accounts.value.accounts as Json[] | undefined;
  if (accounts.status !== 200 || rows?.length !== 1 || rows[0]?.id !== accountId)
    throw new Error(`public handle did not read the exact fixture account (HTTP ${accounts.status})`);
  const agent = await kernel(ctx.stack, 'POST', '/v1/pages:read', {
    body: { target: { account: handle }, languages: ['en'] },
  });
  if (agent.status !== 200 || agent.value.account !== accountId || agent.value.subject !== subjectId)
    throw new Error(`agent page did not bind the exact account and Subject (HTTP ${agent.status})`);
  return { url: page.url, canonical, accounts: accounts.status, accountId, subjectId, nativePage: agent.status };
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
  if (native.status !== 200 || (native.value.collection as Json | undefined)?.id !== ctx.seed.collectionId)
    throw new Error(`The exact public Collection readback was missing (HTTP ${native.status})`);
  return { url: url.url, itemList, members: ctx.seed.collectionMembers, native: native.status };
}

async function withOwnerPage<T>(
  ctx: WalkContext,
  returnUrl: string,
  observed: Json,
  witness: (page: Page, enter: (stage: string) => void) => Promise<T>,
): Promise<T> {
  if (!ctx.signIn.ok) throw Object.assign(new Error(ctx.signIn.detail), { unreached: true, observed });
  const { stack, seed } = ctx;
  const context = await ctx.page.context().browser()!.newContext({ locale: 'en-US', viewport: desktop });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const target = new URL(returnUrl);
  const returned = (url: URL) =>
    url.origin === stack.web && url.pathname === target.pathname && url.search === target.search;
  const consent = (url: URL) => url.origin === stack.issuer && url.pathname === '/consent';
  let stage = 'Open the ordinary Auth login';
  let signedIn = false;
  try {
    const signInUrl = new URL('/auth/sign-in', stack.web);
    signInUrl.searchParams.set('return_to', target.pathname + target.search);
    const login = await gotoPage(page, signInUrl.href);
    const loginUrl = new URL(login.url);
    if (login.status !== 200 || loginUrl.origin !== stack.issuer || loginUrl.pathname !== '/login')
      throw new Error('Auth did not open the login form');
    stage = 'Sign in through Auth as the seeded owner';
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).origin === stack.issuer &&
          new URL(response.url()).pathname === '/signin' &&
          response.request().method() === 'POST',
      ),
      fillPasswordSignIn(page, seed.owner.email),
    ]);
    observed.authStatus = response.status();
    if (response.status() !== 200 || (await response.json()).account_id !== seed.owner.accountId)
      throw new Error('Auth did not acknowledge the exact owner');
    stage = 'Return from Auth to the exact signed-in page';
    await page.waitForURL((url) => returned(url) || consent(url), { waitUntil: 'domcontentloaded' });
    if (consent(new URL(page.url()))) {
      stage = 'Approve the website request through Auth';
      await hydrated(page);
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
    }
    stage = 'Return from Auth to the exact signed-in page';
    await page.waitForURL(returned, { waitUntil: 'domcontentloaded' });
    await hydrated(page);
    await page.locator('#account-menu-button').waitFor({ state: 'visible' });
    signedIn = true;
    return await witness(page, (next) => {
      stage = next;
    });
  } catch (error) {
    const path = new URL(page.url()).pathname;
    // Auth redirect URLs can contain transient credentials; preserve only paths and the sign-in status.
    const detail =
      signedIn && error instanceof Error
        ? error.message
        : `stopped at ${path}${observed.authStatus === undefined ? '' : ` after Auth HTTP ${observed.authStatus}`}`;
    throw Object.assign(new Error(`${stage}: ${detail}`), { observed: { ...observed, mountedPath: path } });
  } finally {
    await context.close();
  }
}

async function walkW29(ctx: WalkContext): Promise<unknown> {
  if (!ctx.seed.boardId || !ctx.seed.threadId) throw new Error('seed published no board or thread');
  const board = await gotoPage(ctx.page, `${ctx.stack.web}/en/boards/${ctx.seed.boardId}`);
  if (board.status >= 400) throw new Error(`board HTTP ${board.status}`);
  const thread = ctx.page.locator(`a[href*="/threads/${ctx.seed.threadId}"]`).first();
  await thread.click();
  await hydrated(ctx.page);
  if (!new URL(ctx.page.url()).pathname.split('/').includes(ctx.seed.threadId))
    throw new Error(`the exact thread did not open: ${ctx.page.url()}`);
  const native = await kernel(ctx.stack, 'GET', `/v1/threads/${ctx.seed.threadId}`);
  const current = native.value.thread as Json | undefined;
  const opening = current?.firstPost as Json | undefined;
  if (
    native.status !== 200 ||
    current?.boardId !== ctx.seed.boardId ||
    opening?.id !== ctx.seed.openingPostId ||
    opening.revisionId !== ctx.seed.openingRevisionId ||
    opening.authorId !== ctx.seed.owner.accountId
  )
    throw new Error(`The exact native conversation and opening revision were absent (HTTP ${native.status})`);
  const history = await kernel(
    ctx.stack,
    'GET',
    `/v1/posts/${ctx.seed.openingPostId}/revisions/${ctx.seed.openingRevisionId}`,
  );
  const revision = history.value.post as Json | undefined;
  if (
    history.status !== 200 ||
    revision?.revisionId !== ctx.seed.openingRevisionId ||
    revision.id !== ctx.seed.openingPostId ||
    revision.authorId !== ctx.seed.owner.accountId
  )
    throw new Error(`The exact native opening history was absent (HTTP ${history.status})`);
  const observed = { board: board.url, thread: ctx.page.url(), native: native.status, history: history.status };
  const { boardId, threadId, openingPostId, owner } = ctx.seed;
  return withOwnerPage(ctx, observed.thread, observed, async (page, enter) => {
    enter('Open the reply composer for the exact opening post');
    await page
      .locator(`[id="post-${openingPostId}"]`)
      .getByRole('button', { name: 'Reply to this post', exact: true })
      .click();
    const composer = page.getByRole('region', { name: 'Reply', exact: true });
    const text = `First-public conversation reply ${crypto.randomUUID()}`;
    await composer.getByRole('textbox', { name: 'Reply', exact: true }).fill(text);
    enter('Send the mounted reply and wait for it in the conversation');
    await composer.getByRole('button', { name: 'Send', exact: true }).click();
    const rendered = page.locator('[id^="post-"]').getByText(text, { exact: true });
    const failure = composer.getByRole('alert').first();
    await rendered.or(failure).waitFor({ state: 'visible' });
    if (!(await rendered.isVisible())) throw new Error(await failure.innerText());

    enter('Read the exact current reply from the native conversation');
    const matchesReply = (post: Json) =>
      post.threadId === threadId &&
      post.boardId === boardId &&
      post.parentId === openingPostId &&
      post.authorId === owner.accountId &&
      post.visibility === 'published' &&
      post.availability === 'available' &&
      JSON.stringify(post.body)?.includes(JSON.stringify(text));
    const posts = await kernel(ctx.stack, 'GET', `/v1/threads/${threadId}/posts`);
    const replies = Array.isArray(posts.value.posts) ? (posts.value.posts as Json[]).filter(matchesReply) : [];
    const reply = replies[0];
    if (
      posts.status !== 200 ||
      replies.length !== 1 ||
      typeof reply?.id !== 'string' ||
      reply.id === openingPostId ||
      typeof reply.revisionId !== 'string' ||
      typeof reply.sha256 !== 'string'
    )
      throw new Error(`Expected one new native reply to the opening post (HTTP ${posts.status})`);
    await page.locator(`[id="post-${reply.id}"]`).getByText(text, { exact: true }).waitFor({ state: 'visible' });

    enter('Read the immutable native reply revision');
    const replyHistory = await kernel(ctx.stack, 'GET', `/v1/posts/${reply.id}/revisions/${reply.revisionId}`);
    const stored = replyHistory.value.post as Json | undefined;
    if (
      replyHistory.status !== 200 ||
      stored?.id !== reply.id ||
      stored.revisionId !== reply.revisionId ||
      stored.sha256 !== reply.sha256 ||
      !matchesReply(stored)
    )
      throw new Error(`The exact native reply revision was absent (HTTP ${replyHistory.status})`);
    return {
      ...observed,
      reply: { postId: reply.id, revisionId: reply.revisionId, parentId: openingPostId, authorId: owner.accountId },
      replyRead: posts.status,
      replyHistory: replyHistory.status,
    };
  });
}

async function walkW31(ctx: WalkContext): Promise<unknown> {
  const { realmId, spaceAddress } = ctx.seed;
  const opened = await gotoPage(ctx.page, `${ctx.stack.web}/en/realms/${realmId}`);
  const expected = spaceAddress ? `/en/spaces/${encodeURIComponent(spaceAddress)}` : `/en/realms/${realmId}`;
  if (opened.status !== 200 || new URL(opened.url).pathname !== expected)
    throw new Error(`The exact public Realm home returned HTTP ${opened.status} at ${opened.url}`);
  await ctx.page.getByRole('heading', { name: 'First-public Web Space', exact: true }).waitFor({ state: 'visible' });
  const current = await kernel(ctx.stack, 'GET', `/v1/realms/${ctx.seed.realmId}`);
  const realm = current.value.realm as Json | undefined;
  if (current.status !== 200 || realm?.realmId !== ctx.seed.realmId || realm.spaceId !== ctx.seed.spaceId)
    throw new Error(`The exact public Realm and Space readback was missing (HTTP ${current.status})`);
  const observed: Json = { opened: opened.url, realmId, spaceId: ctx.seed.spaceId, native: current.status };
  return withOwnerPage(ctx, opened.url, observed, async (page, enter) => {
    enter('Open the owner’s Members page from the public Realm home');
    await page.getByRole('button', { name: 'Manage community', exact: true }).click();
    await page.getByRole('link', { name: 'Members', exact: true }).click();
    await page.waitForURL((url) => url.origin === ctx.stack.web && url.pathname === `/en/realms/${realmId}/members`);

    const { outsider } = ctx.seed;
    observed.selectedAccountId = outsider.accountId;
    enter('Inspect the exact seeded nonmember on the owner’s roster');
    await page.getByRole('textbox', { name: 'Exact account ID', exact: true }).fill(outsider.accountId);
    await page.getByRole('button', { name: 'Look up account', exact: true }).click();
    const selected = page.getByRole('region', { name: 'Selected account', exact: true });
    await selected.getByText('Not a current member', { exact: true }).waitFor({ state: 'visible' });
    const addition = selected.getByRole('group', { name: 'Add member', exact: true });
    await addition.getByRole('button', { name: 'Add member', exact: true }).click();
    await addition.getByText(outsider.accountId, { exact: true }).waitFor({ state: 'visible' });
    await addition.getByText(realmId, { exact: true }).waitFor({ state: 'visible' });

    enter('Authenticate the seeded nonmember for independent native reads');
    const [bindings, { website }] = await Promise.all([parseEnv(join(root, 'apps/web/.dev.vars')), developmentKeys()]);
    // Use a fresh ordinary website token so expiry during earlier walks cannot look like a membership failure.
    const auth = await websiteToken(ctx.stack, outsider, bindings, website).catch(() => {
      throw new Error('Ordinary Auth could not issue the nonmember’s website token');
    });
    if (auth.session.accountId !== outsider.accountId) throw new Error('Auth returned a different nonmember');

    enter('Independently read the nonmember and protected roster boundary');
    const rosterPath = `/v1/realms/${realmId}/members`;
    const readMembership = () => kernel(ctx.stack, 'GET', `${rosterPath}/me`, { bearer: auth.bearer });
    const readRoster = () => kernel(ctx.stack, 'GET', rosterPath, { bearer: auth.bearer });
    const [before, anonymousRoster, outsiderRoster] = await Promise.all([
      readMembership(),
      kernel(ctx.stack, 'GET', rosterPath),
      readRoster(),
    ]);
    if (before.status !== 200 || before.value.state !== 'none' || before.value.since !== null)
      throw new Error(
        `Expected no current membership before the add (HTTP ${before.status}, ${before.value.code ?? before.value.state ?? 'no state'})`,
      );
    if (anonymousRoster.status !== 401 || outsiderRoster.status !== 403 || outsiderRoster.value.code !== 'forbidden')
      throw new Error(
        `Roster boundary returned HTTP ${anonymousRoster.status} anonymous, ${outsiderRoster.status} nonmember`,
      );

    enter('Confirm the mounted owner add and wait for its acknowledgement');
    const accepted = addition.getByText(
      'The request to add this member was accepted. Membership is still pending confirmation.',
      { exact: true },
    );
    const unresolved = addition.getByText(
      /^(The request to add this member was rejected\.|The add result is unknown\.)/,
    );
    await addition.getByRole('button', { name: /^Confirm\b/ }).click();
    await accepted.or(unresolved).waitFor({ state: 'visible' });
    if (!(await accepted.isVisible())) throw new Error(await unresolved.innerText());
    observed.addAccepted = true;

    enter('Wait for native membership publication for the exact selected account');
    const deadline = performance.now() + 60_000;
    let membership = await readMembership();
    while (membership.status === 200 && membership.value.state !== 'member' && performance.now() < deadline) {
      await Bun.sleep(250);
      membership = await readMembership();
    }
    const { state, since, code } = membership.value;
    if (
      membership.status !== 200 ||
      state !== 'member' ||
      typeof since !== 'string' ||
      !Number.isFinite(Date.parse(since))
    )
      throw new Error(
        `Owner add was accepted but members/me returned HTTP ${membership.status} (${code ?? state ?? 'no state'})`,
      );
    observed.membership = { state, since };

    enter('Confirm current membership on the owner’s roster');
    await addition.getByRole('button', { name: 'Check member status', exact: true }).click();
    await selected.getByText('Current member', { exact: true }).waitFor({ state: 'visible' });

    enter('Read the protected roster boundary as the newly admitted member');
    const memberRoster = await readRoster();
    if (memberRoster.status !== 403 || memberRoster.value.code !== 'forbidden')
      throw new Error(`Membership disclosed the management roster (HTTP ${memberRoster.status})`);
    return {
      ...observed,
      membersPage: page.url(),
      roster: { anonymous: anonymousRoster.status, nonmember: outsiderRoster.status, member: memberRoster.status },
    };
  });
}

async function walkW34(ctx: WalkContext): Promise<unknown> {
  const { id, route, text } = ctx.seed.zone;
  const home = await gotoPage(ctx.page, `${ctx.stack.web}/zh-Hant/zones/${id}`);
  if (home.status !== 200) throw new Error(`Zone home HTTP ${home.status}`);
  const opened = await gotoPage(ctx.page, `${ctx.stack.web}/zh-Hant/zones/${id}/${route}`);
  if (opened.status !== 200) throw new Error(`Configured Zone page HTTP ${opened.status}`);
  await shellOk(ctx.page, 'zh-Hant');
  await ctx.page.getByText(text, { exact: true }).waitFor({ state: 'visible' });
  const native = await readZonePage((method, path, options) => kernel(ctx.stack, method, path, options), id, route);
  if (native.status !== 200) throw new Error(`Configured Zone native read HTTP ${native.status}`);
  await returnTo(ctx.page, home.url);
  return { id, url: opened.url, native: native.status, return: ctx.page.url() };
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
    `first-public-scope: ${passing}/${FIRST_PUBLIC_SCOPE_PATHS.length}` +
      (slowest ? `; slowest failing ${slowest.id} ${slowest.elapsedMs}ms ${slowest.status}` : ''),
  );
}

export async function run(): Promise<PathResult[]> {
  if (
    !firstPublicWebWalk() ||
    !walkAcceptanceId(process.env, 'native') ||
    !walkAcceptanceId(process.env, 'browser') ||
    !walkStackAdmitted(process.env, root)
  )
    throw new Error('Use dev-stack.ts walk --first-public-web with native and browser acceptance');
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await mkdir('/tmp/rw', { recursive: true, mode: 0o700 });
  const source = await sourceRevision();
  const results: PathResult[] = [];
  const failRest = (cause: string, persona = 'setup') => {
    for (const path of FIRST_PUBLIC_SCOPE_PATHS) {
      if (results.some((row) => row.id === path.id)) continue;
      const pathCause = 'nativeHost' in path ? SEPARATE_NATIVE_JOURNEY_CAUSE : cause;
      results.push({
        id: path.id,
        job: path.job,
        auth: path.auth,
        status: 'FAIL-unreached',
        persona: 'nativeHost' in path ? 'mixed' : persona,
        elapsedMs: 0,
        source,
        evidence: { cause: pathCause, ...(pathCause !== cause ? { setupCause: cause } : {}) },
        ...('nativeHost' in path
          ? { acceptanceCommand: ['bun', 'apps/web/scripts/check.ts', '--host', path.nativeHost] }
          : {}),
        firstWrong: pathCause,
      });
    }
  };

  const stack = stackOrigins();
  let seed: WebFixture | undefined;
  let frontends: Awaited<ReturnType<typeof startSeededFrontends>> | undefined;
  let browser: Browser | undefined;
  try {
    const seedEnv = { ...process.env, ...(await parseEnv(join(root, '.temp/local-stack/seed.env'))) };
    const seedCode = await child(
      [process.execPath, 'scripts/datasets/cross-media-seed.ts', '--dev-catalogue', '--without-person-merge'],
      'seed',
      seedEnv,
    );
    if (seedCode !== 0) throw new Error(`Catalogue seed exited ${seedCode}; see .temp/goal/web/seed.log`);
    seed = await seedFirstPublicWeb(
      root,
      stack,
      (method, path, options) => kernel(stack, method, path, options),
      await readFirstPublicCatalogueReport(root),
    );
    frontends = await startSeededFrontends();
    const signIn = await probeSignIn(stack);
    await writeFile(
      join(evidenceDir, 'sign-in-probe.json'),
      `${JSON.stringify({ stack, signIn, seed: publicFields(seed) }, null, 2)}\n`,
    );
    browser = await chromium.launch({ headless: true, env: { ...process.env, TMPDIR: '/tmp/rw' } });
    const context: BrowserContext = await browser.newContext({ locale: 'en-US', viewport: desktop });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const ctx: WalkContext = { stack, seed, page, signIn };

    for (const path of FIRST_PUBLIC_SCOPE_PATHS) {
      const started = performance.now();
      const persona =
        path.id === 'W29' || path.id === 'W31' ? 'mixed' : path.auth === 'signed-in' ? 'signed-in' : 'anonymous';
      try {
        if ('nativeHost' in path) {
          const acceptanceCommand = ['bun', 'apps/web/scripts/check.ts', '--host', path.nativeHost];
          const cause = SEPARATE_NATIVE_JOURNEY_CAUSE;
          results.push({
            id: path.id,
            job: path.job,
            auth: path.auth,
            status: 'FAIL-unreached',
            persona: 'mixed',
            elapsedMs: Math.round(performance.now() - started),
            source,
            evidence: { cause },
            acceptanceCommand,
            firstWrong: cause,
          });
          hourly(results);
          continue;
        }
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
          persona,
          elapsedMs: Math.round(performance.now() - started),
          source,
          evidence,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const { unreached, observed } = error as { unreached?: boolean; observed?: unknown };
        results.push({
          id: path.id,
          job: path.job,
          auth: path.auth,
          status: unreached ? 'FAIL-unreached' : 'FAIL',
          persona,
          elapsedMs: Math.round(performance.now() - started),
          source,
          evidence: { error: message, url: page.url(), ...(observed && { observed }) },
          firstWrong: message,
        });
      }
      hourly(results);
    }
  } catch (error) {
    failRest(error instanceof Error ? error.message : String(error));
  } finally {
    await browser?.close();
    await frontends?.stop();
  }
  await writeEvidence(source, results, stack, seed);
  hourly(results);
  return results;
}

async function writeEvidence(source: string, results: PathResult[], stack?: Stack, seed?: WebFixture): Promise<void> {
  const passing = results.filter((row) => row.status === 'PASS').length;
  const failing = results.filter((row) => row.status !== 'PASS');
  const slowest = failing.slice().sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
  await writeFile(
    join(evidenceDir, 'evidence.json'),
    `${JSON.stringify(
      {
        source,
        observedAt: new Date().toISOString(),
        passing: `${passing}/${FIRST_PUBLIC_SCOPE_PATHS.length}`,
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
  const failed = results.some((row) => row.status !== 'PASS');
  process.exit(failed ? 1 : 0);
}
