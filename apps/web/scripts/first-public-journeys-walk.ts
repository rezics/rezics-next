/**
 * Current-dev first-public journey walk for Performance. Runs inside `dev-stack.ts walk`.
 * Anonymous portions of mixed paths use real pages and kernel readback even when the importer
 * seed writes no `result.json`. Content ce33 integrated `ea7dc5fe59`: signed-in paths resume on a
 * stack that contains it. Issuer, JWKS, launcher and importer-seed failures are recorded causes;
 * this walk does not repair startup or seed transport. Evidence stays under
 * `.temp/goal/performance/` and never records secrets. The walk writes the 17-row table in
 * `docs/goals/performance.capabilities.md`.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startSeededFrontends } from '../../../services/auth/scripts/dev-stack.ts';
import { CAPABILITIES_BEGIN, CAPABILITIES_END, capabilitiesTableMarkdown } from './first-public-journeys-table.ts';
import {
  FIRST_PUBLIC_JOURNEY_PATHS,
  type JourneyAuth,
  type JourneyId,
  type JourneyOwner,
  type JourneyStatus,
} from './first-public-journeys-paths.ts';

export {
  FIRST_PUBLIC_JOURNEY_PATHS,
  type JourneyAuth,
  type JourneyId,
  type JourneyOwner,
  type JourneyStatus,
} from './first-public-journeys-paths.ts';
export { CAPABILITIES_BEGIN, CAPABILITIES_END, capabilitiesTableMarkdown } from './first-public-journeys-table.ts';

const root = resolve(import.meta.dir, '../../..');
export const evidenceDir = join(root, '.temp/goal/performance');
const seedResult = join(root, '.temp/cross-media-seed/result.json');
const keysPath = join(root, '.temp/local-stack/keys.json');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 860 };
let hydrateBudgetMs = 180_000;

export const SIGN_IN_STARTUP_CAUSE =
  'issuer JWKS origin differs from native Auth JWKS after ce33 ea7dc5fe59; recorded, not repaired here';
const capabilitiesPath = join(root, 'docs/goals/performance.capabilities.md');

type Json = Record<string, unknown>;
type Stack = { web: string; issuer: string; native: string; kernel: string };
type PathResult = {
  id: JourneyId;
  job: string;
  auth: JourneyAuth;
  owner: JourneyOwner;
  status: JourneyStatus;
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
  workId?: string | undefined;
  collectionId?: string | undefined;
  accountId?: string | undefined;
  handle?: string | undefined;
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
  const workFromCommunity =
    community.state === 'published' && typeof (community.source as Json | undefined)?.subjectId === 'string'
      ? String((community.source as Json).subjectId)
      : undefined;
  return {
    workId: workFromCommunity ?? workIdentity(raw, 'vndb', 'v2002') ?? workIdentity(raw, 'bangumi', '10380'),
    collectionId: published ? String((published.public as Json).id) : undefined,
    accountId: typeof raw.accountId === 'string' ? raw.accountId : undefined,
    handle: typeof raw.handle === 'string' ? raw.handle : 'developer',
  };
}

async function hydrated(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: hydrateBudgetMs });
}

async function probeHydration(page: Page, origin: string): Promise<{ ok: boolean; detail: string; elapsedMs: number }> {
  const started = performance.now();
  try {
    const response = await page.goto(`${origin}/en`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 60_000 });
    return {
      ok: true,
      detail: `GET /en HTTP ${response?.status() ?? 0}`,
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    hydrateBudgetMs = 15_000;
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      elapsedMs: Math.round(performance.now() - started),
    };
  }
}

async function gotoPage(page: Page, url: string): Promise<{ status: number; url: string }> {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await hydrated(page);
  return { status: response?.status() ?? 0, url: page.url() };
}

async function shellOk(page: Page, locale: string): Promise<{ lang: string; main: number }> {
  const lang = (await page.locator('html').getAttribute('lang')) ?? '';
  if (lang !== locale) throw new Error(`html lang was ${JSON.stringify(lang)}, expected ${locale}`);
  const main = await page.getByRole('main').count();
  if (main < 1) throw new Error(`localized shell missing main=${main}`);
  return { lang, main };
}

async function probeSignIn(stack: Stack): Promise<{ ok: boolean; detail: string }> {
  const issuerJwks = await http(`${stack.issuer}/.well-known/jwks.json`);
  const nativeJwks = await http(`${stack.native}/.well-known/jwks.json`);
  const discovery = await http(`${stack.issuer}/.well-known/openid-configuration`);
  const login = await http(`${stack.issuer}/login`);
  const signIn = await http(`${stack.web}/auth/sign-in?return_to=${encodeURIComponent('/en/settings')}`);
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
    detail: `issuer JWKS HTTP ${issuerJwks.status}; native JWKS HTTP ${nativeJwks.status}; login HTTP ${login.status}; web sign-in HTTP ${signIn.status}`,
  };
}

async function probeKernel(stack: Stack): Promise<{ ok: boolean; detail: string }> {
  const active = await http(`${stack.kernel}/v1/definitions/active`);
  const nativeJwks = await http(`${stack.native}/.well-known/jwks.json`);
  const worker = await http(`${stack.kernel}/health`).catch((error: Error) => ({
    status: 0,
    headers: {},
    text: error.message,
  }));
  const ok = active.status < 400 && nativeJwks.status < 500;
  return {
    ok,
    detail: `kernel /v1/definitions/active HTTP ${active.status}; native JWKS HTTP ${nativeJwks.status}; kernel /health HTTP ${worker.status}`,
  };
}

async function gitRevision(args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
  const text = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return text;
}

async function writeCapabilitiesTable(
  source: string,
  devRevision: string,
  base: string,
  results: PathResult[],
  extras: {
    stack?: Stack;
    seed?: Seed;
    kernel?: { ok: boolean; detail: string };
    signIn?: { ok: boolean; detail: string };
    seedCause?: string;
    seedElapsedMs?: number;
    hydration?: { ok: boolean; detail: string; elapsedMs: number };
  } = {},
): Promise<void> {
  const text = await readFile(capabilitiesPath, 'utf8');
  const begin = text.indexOf(CAPABILITIES_BEGIN);
  const end = text.indexOf(CAPABILITIES_END);
  if (begin < 0 || end < 0 || end < begin)
    throw new Error('docs/goals/performance.capabilities.md is missing first-public-journeys markers');
  const section = capabilitiesTableMarkdown(source, base, results, { ...extras, devRevision });
  await writeFile(capabilitiesPath, `${text.slice(0, begin)}${CAPABILITIES_BEGIN}\n\n${section}${text.slice(end)}`);
}

async function developerPassword(): Promise<string> {
  const keys = JSON.parse(await readFile(keysPath, 'utf8')) as { password?: unknown };
  if (typeof keys.password !== 'string') throw new Error('development persona password is missing from local keys');
  return keys.password;
}

type WalkContext = {
  stack: Stack;
  seed: Seed;
  page: Page;
  source: string;
  signIn: { ok: boolean; detail: string };
  signedIn: boolean;
};

function unreached(message: string): Error {
  return Object.assign(new Error(message), { unreached: true });
}

async function requireSession(ctx: WalkContext): Promise<void> {
  if (!ctx.signIn.ok) throw unreached(ctx.signIn.detail);
  if (!ctx.signedIn) await signInDeveloper(ctx);
}

async function signInDeveloper(ctx: WalkContext): Promise<void> {
  const opened = await gotoPage(ctx.page, `${ctx.stack.web}/en/settings`);
  const url = new URL(opened.url);
  if (url.origin === ctx.stack.issuer && url.pathname === '/login') {
    const password = await developerPassword();
    await ctx.page.locator('input[name="email"]').fill('developer@rezics.test');
    await ctx.page.locator('input[name="password"]').fill(password);
    await ctx.page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await ctx.page.waitForURL((next) => new URL(next).origin === ctx.stack.web, { timeout: 180_000 });
    await hydrated(ctx.page);
  }
  if (new URL(ctx.page.url()).pathname.includes('/auth/sign-in') || new URL(ctx.page.url()).pathname === '/login')
    throw unreached(`password sign-in did not return to Web: ${ctx.page.url()}`);
  ctx.signedIn = true;
}

async function openSettings(ctx: WalkContext, hash: string): Promise<{ url: string; heading: number }> {
  await requireSession(ctx);
  const opened = await gotoPage(ctx.page, `${ctx.stack.web}/en/settings#${hash}`);
  if (opened.url.includes('/auth/sign-in') || new URL(opened.url).pathname === '/login')
    throw unreached(`settings redirected to sign-in: ${opened.url}`);
  await shellOk(ctx.page, 'en');
  const heading = await ctx.page.getByRole('heading').count();
  if (heading < 1) throw new Error(`settings#${hash} has no heading`);
  return { url: ctx.page.url(), heading };
}

async function clickNamed(page: Page, names: string[], role: 'button' | 'link' = 'button'): Promise<string> {
  for (const name of names) {
    const control = page.getByRole(role, { name: new RegExp(name, 'i') }).first();
    if ((await control.count()) > 0) {
      await control.click();
      await hydrated(page);
      return name;
    }
  }
  throw new Error(`none of ${names.join(', ')} ${role}s are present on ${page.url()}`);
}

async function fillFirstTextbox(page: Page, value: string): Promise<string> {
  const box = page.getByRole('textbox').first();
  if ((await box.count()) === 0) throw new Error(`no textbox on ${page.url()}`);
  await box.fill(value);
  return value;
}

async function walkP01(ctx: WalkContext): Promise<unknown> {
  const opened = await openSettings(ctx, 'profile');
  const draft = `walk-profile-${Date.now().toString(36)}`;
  const filled = await fillFirstTextbox(ctx.page, draft);
  const saved = await clickNamed(ctx.page, ['Save', 'Saved']);
  const savedStatus = await ctx.page.getByRole('status').count();
  const left = await gotoPage(ctx.page, `${ctx.stack.web}/en/library`);
  await gotoPage(ctx.page, opened.url);
  const recovered = await ctx.page
    .getByRole('textbox')
    .first()
    .inputValue()
    .catch(() => '');
  return publicFields({
    opened: opened.url,
    filled,
    saved,
    savedStatus,
    left: left.url,
    recovered,
    returned: ctx.page.url(),
  });
}

async function walkAnonymousProfile(
  ctx: WalkContext,
): Promise<{ url: string; canonical: string | null; status: number }> {
  const handle = ctx.seed.handle ?? 'developer';
  const opened = await gotoPage(ctx.page, `${ctx.stack.web}/en/@${handle}`);
  if (opened.status >= 400 || opened.url.includes('/auth/sign-in'))
    throw unreached(`anonymous public profile HTTP ${opened.status} at ${opened.url}`);
  await shellOk(ctx.page, 'en');
  const canonical = await ctx.page.locator('link[rel="canonical"]').getAttribute('href');
  return { url: opened.url, canonical, status: opened.status };
}

async function walkP02(ctx: WalkContext): Promise<unknown> {
  const anonymous = await walkAnonymousProfile(ctx);
  if (!ctx.signIn.ok)
    throw unreached(`anonymous public profile reached ${anonymous.url}; save unreached: ${ctx.signIn.detail}`);
  const activity = await openSettings(ctx, 'public-activity');
  const saved = await clickNamed(ctx.page, ['Save', 'Saved']).catch((error: Error) => error.message);
  const owner = await walkAnonymousProfile(ctx);
  return publicFields({ anonymous, activity: activity.url, saved, owner });
}

async function walkP03(ctx: WalkContext): Promise<unknown> {
  const directory = await gotoPage(ctx.page, `${ctx.stack.web}/en/settings?view=accounts#account`);
  await requireSession(ctx);
  await gotoPage(ctx.page, `${ctx.stack.web}/en/settings?view=accounts#account`);
  const frontier = ctx.page.url();
  const row = ctx.page.locator('a[href*="managedAccount="], a[href*="/accounts/"]').first();
  if ((await row.count()) === 0) throw unreached('managed-account directory has no admitted row');
  await row.click();
  await hydrated(ctx.page);
  const detail = ctx.page.url();
  await ctx.page.goBack({ waitUntil: 'domcontentloaded' });
  await hydrated(ctx.page);
  return publicFields({ directory: directory.url, frontier, detail, returned: ctx.page.url() });
}

async function walkP04(ctx: WalkContext): Promise<unknown> {
  await openSettings(ctx, 'account');
  const security = ctx.page.getByRole('link', { name: /security/i }).first();
  if ((await security.count()) === 0) {
    const opened = await gotoPage(ctx.page, `${ctx.stack.issuer}/security`);
    if (opened.status >= 400) throw new Error(`Auth security HTTP ${opened.status}`);
    return publicFields({ via: 'issuer', url: opened.url });
  }
  await security.click();
  await hydrated(ctx.page);
  if (!ctx.page.url().includes('/security')) throw new Error(`security action landed on ${ctx.page.url()}`);
  await ctx.page.goBack({ waitUntil: 'domcontentloaded' });
  await hydrated(ctx.page);
  return publicFields({ security: true, returned: ctx.page.url() });
}

async function walkP05(ctx: WalkContext): Promise<unknown> {
  await openSettings(ctx, 'account');
  const rename = ctx.page.getByRole('link', { name: /rename/i }).first();
  if ((await rename.count()) === 0) {
    const opened = await gotoPage(ctx.page, `${ctx.stack.issuer}/account/rename`);
    if (opened.status >= 400) throw new Error(`Auth rename HTTP ${opened.status}`);
    return publicFields({ via: 'issuer', url: opened.url, completed: false });
  }
  await rename.click();
  await hydrated(ctx.page);
  if (!ctx.page.url().includes('/account/rename')) throw new Error(`rename action landed on ${ctx.page.url()}`);
  return publicFields({ url: ctx.page.url() });
}

async function walkP06(ctx: WalkContext): Promise<unknown> {
  await openSettings(ctx, 'account');
  const deletion = ctx.page.getByRole('link', { name: /delet/i }).first();
  if ((await deletion.count()) === 0) {
    const opened = await gotoPage(ctx.page, `${ctx.stack.issuer}/account/delete`);
    if (opened.status >= 400) throw new Error(`Auth deletion HTTP ${opened.status}`);
    return publicFields({ via: 'issuer', url: opened.url });
  }
  await deletion.click();
  await hydrated(ctx.page);
  if (!ctx.page.url().includes('/account/delete')) throw new Error(`deletion action landed on ${ctx.page.url()}`);
  return publicFields({ url: ctx.page.url() });
}

async function walkP07(ctx: WalkContext): Promise<unknown> {
  await requireSession(ctx);
  await gotoPage(ctx.page, `${ctx.stack.web}/en/library`);
  const menu = ctx.page.getByRole('button', { name: /^You/ }).first();
  if ((await menu.count()) === 0) throw new Error('signed-in account menu is absent');
  await menu.click();
  await clickNamed(ctx.page, ['Sign out'], 'button').catch(async () => clickNamed(ctx.page, ['Sign out'], 'link'));
  ctx.signedIn = false;
  const destination = ctx.page.url();
  const privateRetry = await gotoPage(ctx.page, `${ctx.stack.web}/en/settings`);
  if (!privateRetry.url.includes('/login') && !privateRetry.url.includes('/auth/sign-in'))
    throw new Error(`signed-out settings still admitted: ${privateRetry.url}`);
  return publicFields({ destination, settings: privateRetry.url });
}

async function walkP08(ctx: WalkContext): Promise<unknown> {
  const opened = await openSettings(ctx, 'verification');
  const chooser = ctx.page.getByRole('combobox').first();
  const search = ctx.page.getByRole('searchbox').first();
  const request = ctx.page.getByRole('button', { name: /request|submit/i }).first();
  if ((await chooser.count()) + (await search.count()) + (await request.count()) === 0)
    throw unreached('verification chooser is absent on Safety');
  return publicFields({ opened: opened.url, chooser: await chooser.count(), request: await request.count() });
}

async function walkP09(ctx: WalkContext): Promise<unknown> {
  const opened = await openSettings(ctx, 'notifications');
  const saved = await clickNamed(ctx.page, ['Save', 'Saved']).catch((error: Error) => error.message);
  const reset = await clickNamed(ctx.page, ['Reset']).catch((error: Error) => error.message);
  return publicFields({ opened: opened.url, saved, reset });
}

async function walkP10(ctx: WalkContext): Promise<unknown> {
  const opened = await openSettings(ctx, 'reading');
  const saved = await clickNamed(ctx.page, ['Save', 'Saved']).catch((error: Error) => error.message);
  const reset = await clickNamed(ctx.page, ['Reset']).catch((error: Error) => error.message);
  return publicFields({ opened: opened.url, saved, reset });
}

async function walkP11(ctx: WalkContext): Promise<unknown> {
  const opened = await openSettings(ctx, 'display');
  const load = await clickNamed(ctx.page, ['Load', 'type']).catch((error: Error) => error.message);
  return publicFields({ opened: opened.url, load });
}

async function walkP12(ctx: WalkContext): Promise<unknown> {
  const opened = await openSettings(ctx, 'privacy');
  const row = ctx.page.getByRole('combobox').first();
  if ((await row.count()) === 0) throw unreached('Collection privacy inventory has no admitted row');
  const saved = await clickNamed(ctx.page, ['Save', 'Saved']).catch((error: Error) => error.message);
  return publicFields({ opened: opened.url, saved });
}

async function walkP13(ctx: WalkContext): Promise<unknown> {
  await requireSession(ctx);
  const opened = await gotoPage(ctx.page, `${ctx.stack.web}/en/inbox`);
  if (opened.url.includes('/auth/sign-in')) throw unreached(`Inbox redirected to sign-in: ${opened.url}`);
  await shellOk(ctx.page, 'en');
  const notices = ctx.page.getByRole('listitem');
  const count = await notices.count();
  if (count === 0) throw unreached('Inbox has no reply, mention or moderation notice');
  const before = ctx.page.url();
  await notices.first().locator('a').first().click();
  await hydrated(ctx.page);
  const destination = ctx.page.url();
  await ctx.page.goBack({ waitUntil: 'domcontentloaded' });
  await hydrated(ctx.page);
  return publicFields({
    opened: opened.url,
    count,
    destination,
    returned: ctx.page.url(),
    sameRange: ctx.page.url() === before,
  });
}

async function walkP14(ctx: WalkContext): Promise<unknown> {
  await requireSession(ctx);
  if (!ctx.seed.workId) throw unreached('seed published no follow target');
  const following = await gotoPage(ctx.page, `${ctx.stack.web}/en/library/following`);
  if (following.url.includes('/auth/sign-in')) throw unreached(`Following redirected to sign-in: ${following.url}`);
  const frontier = ctx.page.url();
  await gotoPage(ctx.page, `${ctx.stack.web}/en/subjects/${ctx.seed.workId}`);
  const follow = ctx.page.getByRole('button', { name: /follow/i }).first();
  if ((await follow.count()) > 0) await follow.click();
  await gotoPage(ctx.page, frontier);
  return publicFields({ following: following.url, frontier, target: ctx.seed.workId, returned: ctx.page.url() });
}

async function walkP15(ctx: WalkContext): Promise<unknown> {
  await requireSession(ctx);
  const labels = await gotoPage(ctx.page, `${ctx.stack.web}/en/library/labels`);
  if (labels.url.includes('/auth/sign-in')) throw unreached(`labels redirected to sign-in: ${labels.url}`);
  await shellOk(ctx.page, 'en');
  const create = ctx.page.getByRole('button', { name: /create|add|new/i }).first();
  const name = `walk-label-${Date.now().toString(36)}`;
  if ((await create.count()) > 0) {
    await create.click();
    await fillFirstTextbox(ctx.page, name).catch(() => undefined);
    await clickNamed(ctx.page, ['Save', 'Create', 'Add']).catch(() => undefined);
  }
  const row = ctx.page.getByRole('link').filter({ hasText: /./ }).first();
  if ((await row.count()) === 0 && (await create.count()) === 0)
    throw unreached('label catalogue has neither a row nor a create control');
  return publicFields({ labels: labels.url, name, create: await create.count() });
}

async function walkP16(ctx: WalkContext): Promise<unknown> {
  await requireSession(ctx);
  const shelf = await gotoPage(ctx.page, `${ctx.stack.web}/en/library/continue`);
  if (shelf.url.includes('/auth/sign-in')) throw unreached(`active shelf redirected to sign-in: ${shelf.url}`);
  await shellOk(ctx.page, 'en');
  const session = ctx.page.locator('a[href*="/library/progress"], a[href*="/subjects/"]').first();
  if ((await session.count()) === 0) throw unreached('active shelf has no session or target');
  const frontier = ctx.page.url();
  await session.click();
  await hydrated(ctx.page);
  const target = ctx.page.url();
  await ctx.page.goBack({ waitUntil: 'domcontentloaded' });
  await hydrated(ctx.page);
  return publicFields({ shelf: shelf.url, frontier, target, returned: ctx.page.url() });
}

async function walkAnonymousLog(
  ctx: WalkContext,
): Promise<{ id?: string; url?: string; status: number; empty: boolean }> {
  if (typeof ctx.seed.accountId !== 'string') return { status: 0, empty: true };
  const listed = await kernel(ctx.stack, 'GET', '/v1/publishedLogs', {
    query: { accountId: ctx.seed.accountId, limit: '5' },
  });
  const items = (listed.value.publishedLogs as Json[] | undefined) ?? (listed.value.items as Json[] | undefined) ?? [];
  const id = items.find((row) => typeof row.id === 'string')?.id;
  if (typeof id !== 'string') return { status: listed.status, empty: true };
  const opened = await gotoPage(ctx.page, `${ctx.stack.web}/en/logs/${id}`);
  if (opened.status >= 400) throw new Error(`public Log HTTP ${opened.status}`);
  await shellOk(ctx.page, 'en');
  return { id, url: opened.url, status: opened.status, empty: false };
}

async function walkP17(ctx: WalkContext): Promise<unknown> {
  const anonymous = await walkAnonymousLog(ctx);
  if (!ctx.signIn.ok) {
    throw unreached(
      anonymous.empty
        ? `anonymous published-log list ${
            typeof ctx.seed.accountId === 'string'
              ? `HTTP ${anonymous.status} (empty)`
              : 'skipped (no seeded accountId)'
          }; publish unreached: ${ctx.signIn.detail}`
        : `anonymous public snapshot reached ${anonymous.url}; publish/retract unreached: ${ctx.signIn.detail}`,
    );
  }
  await requireSession(ctx);
  const mine = await gotoPage(ctx.page, `${ctx.stack.web}/en/library/logs`);
  if (mine.url.includes('/auth/sign-in')) throw unreached(`My Logs redirected to sign-in: ${mine.url}`);
  return publicFields({ anonymous, mine: mine.url });
}

const walkers: Record<JourneyId, (ctx: WalkContext) => Promise<unknown>> = {
  P01: walkP01,
  P02: walkP02,
  P03: walkP03,
  P04: walkP04,
  P05: walkP05,
  P06: walkP06,
  P07: walkP07,
  P08: walkP08,
  P09: walkP09,
  P10: walkP10,
  P11: walkP11,
  P12: walkP12,
  P13: walkP13,
  P14: walkP14,
  P15: walkP15,
  P16: walkP16,
  P17: walkP17,
};

function hourly(results: PathResult[]): void {
  const passing = results.filter((row) => row.status === 'PASS').length;
  const failing = results.filter((row) => row.status !== 'PASS');
  const slowest = failing.slice().sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
  console.log(
    `first-public-journeys: ${passing}/17` +
      (slowest ? `; slowest failing ${slowest.id} ${slowest.elapsedMs}ms ${slowest.status}` : ''),
  );
}

export async function run(): Promise<PathResult[]> {
  if (!process.env.GOAL_TASK_ID || !/(native|browser)/.test(process.env.GOAL_ACCEPTANCE_REQUIRES ?? ''))
    throw new Error(
      'The first-public journey walk runs on a walk stack whose brief lists native and browser acceptance',
    );
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await mkdir('/tmp/rw', { recursive: true, mode: 0o700 });
  const source = await sourceRevision();
  const [devRevision, base] = await Promise.all([
    gitRevision(['rev-parse', 'dev']).catch(() => ''),
    gitRevision(['merge-base', 'HEAD', 'dev']).catch(() => ''),
  ]);
  const sourceIsCurrentDev = source !== '' && devRevision !== '' && base !== '' && source === base;
  const results: PathResult[] = [];
  const began = performance.now();
  const failRest = (cause: string, persona = 'setup') => {
    const elapsedMs = Math.round(performance.now() - began);
    for (const path of FIRST_PUBLIC_JOURNEY_PATHS) {
      if (results.some((row) => row.id === path.id)) continue;
      results.push({
        id: path.id,
        job: path.job,
        auth: path.auth,
        owner: path.owner,
        status: 'FAIL-unreached',
        persona,
        elapsedMs,
        source,
        evidence: { cause },
        firstWrong: cause,
      });
    }
  };
  const stackIfAdmitted = (): Stack | undefined => {
    try {
      return stackOrigins();
    } catch {
      return undefined;
    }
  };

  const { retireDevelopmentSeedState, retireStaleSeedJournals, kernelEnvironment } =
    await import('../../../services/auth/scripts/dev-stack.ts');
  await retireDevelopmentSeedState(root);
  const kernelEnv = await kernelEnvironment();
  if (kernelEnv.DATABASE_URL) await retireStaleSeedJournals(root, kernelEnv.DATABASE_URL);

  const personaCode = await child(['bun', 'services/auth/scripts/dev-stack.ts', 'persona'], 'persona');
  if (personaCode !== 0) {
    failRest(`persona exited ${personaCode}; see .temp/goal/performance/persona.log`);
    await writeEvidence(source, devRevision, base, results, stackIfAdmitted());
    hourly(results);
    return results;
  }
  const seedEnv = { ...process.env, ...(await parseEnv(join(root, '.temp/local-stack/seed.env'))) };
  const seedStarted = performance.now();
  const seedCode = await child(['bun', 'scripts/datasets/cross-media-seed.ts', '--dev'], 'seed', seedEnv);
  const seedElapsedMs = Math.round(performance.now() - seedStarted);
  let seed: Seed = { handle: 'developer' };
  let seedCause: string | undefined;
  try {
    seed = await readSeed();
  } catch (error) {
    const seedLog = (await readFile(join(evidenceDir, 'seed.log'), 'utf8').catch(() => '')).trim();
    const first =
      seedLog.split('\n').find((line) => line.trim()) ?? (error instanceof Error ? error.message : String(error));
    seedCause = `seed exited ${seedCode}: ${first}`;
    await writeFile(
      join(evidenceDir, 'seed-failure.json'),
      `${JSON.stringify({ seedCode, seedElapsedMs, first, log: seedLog.slice(0, 4000) }, null, 2)}\n`,
    );
  }

  const stack = stackOrigins();
  let frontends: { stop(): Promise<void> } | undefined;
  let browser: Browser | undefined;
  let signIn: { ok: boolean; detail: string } | undefined;
  let kernelReady: { ok: boolean; detail: string } | undefined;
  let hydration: { ok: boolean; detail: string; elapsedMs: number } | undefined;
  try {
    frontends = await startSeededFrontends();
    const admitted = await probeSignIn(stack);
    const kernel = await probeKernel(stack);
    signIn = admitted;
    kernelReady = kernel;
    await writeFile(
      join(evidenceDir, 'sign-in-probe.json'),
      `${JSON.stringify({ stack, signIn: admitted, kernel, seed: publicFields(seed), seedCause, seedElapsedMs }, null, 2)}\n`,
    );
    browser = await chromium.launch({ headless: true, env: { ...process.env, TMPDIR: '/tmp/rw' } });
    const desktopContext: BrowserContext = await browser.newContext({ locale: 'en-US', viewport: desktop });
    const phoneContext: BrowserContext = await browser.newContext({ locale: 'en-US', viewport: phone });
    const page = await desktopContext.newPage();
    page.setDefaultTimeout(60_000);
    const phonePage = await phoneContext.newPage();
    phonePage.setDefaultTimeout(60_000);
    hydration = await probeHydration(page, stack.web);
    const ctx: WalkContext = { stack, seed, page, source, signIn: admitted, signedIn: false };
    const phoneCtx: WalkContext = { stack, seed, page: phonePage, source, signIn: admitted, signedIn: false };

    for (const path of FIRST_PUBLIC_JOURNEY_PATHS) {
      const started = performance.now();
      const walker = walkers[path.id];
      try {
        if (path.auth === 'signed-in' && !admitted.ok) {
          results.push({
            id: path.id,
            job: path.job,
            auth: path.auth,
            owner: path.owner,
            status: 'FAIL-unreached',
            persona: 'signed-in',
            elapsedMs: Math.round(performance.now() - started),
            source,
            evidence: { cause: admitted.detail },
            firstWrong: admitted.detail,
          });
          hourly(results);
          continue;
        }
        const evidence = await walker(ctx);
        let phoneEvidence: unknown = undefined;
        if (path.auth !== 'signed-in' || admitted.ok) {
          try {
            phoneEvidence = await walker(phoneCtx);
          } catch (error) {
            phoneEvidence = { error: error instanceof Error ? error.message : String(error) };
          }
        }
        results.push({
          id: path.id,
          job: path.job,
          auth: path.auth,
          owner: path.owner,
          status: sourceIsCurrentDev ? 'PASS' : 'FAIL',
          persona: path.auth === 'signed-in' ? 'signed-in' : 'anonymous',
          elapsedMs: Math.round(performance.now() - started),
          source,
          evidence: {
            desktop: evidence,
            phone: phoneEvidence,
            ...(sourceIsCurrentDev ? {} : { currentDevGate: { devRevision, base } }),
          },
          ...(sourceIsCurrentDev
            ? {}
            : {
                firstWrong: `candidate source ${source.slice(0, 10)} cannot pass current-dev rows; integrated dev is ${(devRevision || base).slice(0, 10) || 'unavailable'}`,
              }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reachedUnreached = Boolean((error as { unreached?: boolean }).unreached);
        results.push({
          id: path.id,
          job: path.job,
          auth: path.auth,
          owner: path.owner,
          status: reachedUnreached ? 'FAIL-unreached' : 'FAIL',
          persona: path.auth === 'signed-in' ? 'signed-in' : path.auth === 'mixed' ? 'anonymous' : 'signed-in',
          elapsedMs: Math.round(performance.now() - started),
          source,
          evidence: { error: message, url: ctx.page.url() },
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
  await writeEvidence(source, devRevision, base, results, stack, seed, {
    ...(kernelReady === undefined ? {} : { kernel: kernelReady }),
    ...(signIn === undefined ? {} : { signIn }),
    ...(seedCause === undefined ? {} : { seedCause }),
    seedElapsedMs,
    ...(hydration === undefined ? {} : { hydration }),
  });
  hourly(results);
  return results;
}

async function writeEvidence(
  source: string,
  devRevision: string,
  base: string,
  results: PathResult[],
  stack?: Stack,
  seed?: Seed,
  extras: {
    kernel?: { ok: boolean; detail: string };
    signIn?: { ok: boolean; detail: string };
    seedCause?: string;
    seedElapsedMs?: number;
    hydration?: { ok: boolean; detail: string; elapsedMs: number };
  } = {},
): Promise<void> {
  const passing = results.filter((row) => row.status === 'PASS').length;
  const failing = results.filter((row) => row.status !== 'PASS');
  const slowest = failing.slice().sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
  await writeFile(
    join(evidenceDir, 'evidence.json'),
    `${JSON.stringify(
      {
        source,
        devRevision,
        base,
        observedAt: new Date().toISOString(),
        passing: `${passing}/17`,
        slowestFailing: slowest
          ? { id: slowest.id, elapsedMs: slowest.elapsedMs, status: slowest.status, firstWrong: slowest.firstWrong }
          : null,
        stack,
        seed: publicFields(seed),
        kernel: extras.kernel,
        signIn: extras.signIn,
        seedCause: extras.seedCause,
        seedElapsedMs: extras.seedElapsedMs,
        hydration: extras.hydration,
        results,
      },
      null,
      2,
    )}\n`,
  );
  await writeCapabilitiesTable(source, devRevision, base, results, {
    ...(stack === undefined ? {} : { stack }),
    ...(seed === undefined ? {} : { seed }),
    ...extras,
  });
}

if (import.meta.main) {
  const results = await run();
  const failed = results.some((row) => row.status === 'FAIL');
  process.exit(failed ? 1 : 0);
}
