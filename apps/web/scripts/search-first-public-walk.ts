/**
 * Search first-public journey walk. Runs inside `dev-stack.ts walk`.
 * Records secret-free native and page observations for the six inventory rows.
 * Authenticated Search/publication is attempted only when a real bearer is issued.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startSeededFrontends } from '../../../services/auth/scripts/dev-stack.ts';

const root = resolve(import.meta.dir, '../../..');
const evidenceDir = join(root, '.temp/search-walk');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mixedQuery = 'Steins;Gate';
const bookQuery = 'The';
const originalName = 'シュタインズ・ゲート';
const aliasName = 'CLANNAD';
const invalidQuery = '"unclosed';
const visualNovelType = 'wd:Q689445';
const bookType = 'schema:Book';

type Json = Record<string, unknown>;
type Stack = { web: string; issuer: string; native: string; kernel: string };
type NativeCall = {
  method: string;
  path: string;
  status?: number;
  code?: string;
  retryAfter?: string | null;
  keys?: string[];
  hitCount?: number;
  next?: boolean;
  subjectId?: string;
  digest?: string;
  error?: string;
};
type PageCall = {
  url: string;
  viewport: { width: number; height: number };
  locale: string;
  status?: number;
  title?: string | null;
  hydrated?: boolean;
  resultLinks?: number;
  visible?: string;
  error?: string;
};
type JourneyRecord = {
  name: string;
  startedAt: string;
  elapsedSeconds: number;
  persona: string;
  operands: Json;
  native: NativeCall[];
  pages: PageCall[];
  result: 'PASS' | 'FAIL' | 'blocked';
  firstFailure?: string;
  blockedOn?: string;
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
  if (Array.isArray(value)) return value.slice(0, 12).map(publicFields);
  if (!value || typeof value !== 'object') return value;
  const output: Json = {};
  for (const [key, field] of Object.entries(value as Json)) {
    if (/token|password|cookie|authorization|secret|credential|bearer/i.test(key)) continue;
    output[key] = publicFields(field);
  }
  return output;
}

function problemCode(value: Json | undefined): string | undefined {
  return typeof value?.code === 'string' ? value.code : undefined;
}

async function child(command: string[], name: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const log = Bun.file(join(evidenceDir, `${name}.log`));
  const handle = await log.writer();
  const proc = spawn(command[0]!, command.slice(1), { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (chunk: Buffer) => handle.write(chunk));
  proc.stderr.on('data', (chunk: Buffer) => handle.write(chunk));
  const code = await new Promise<number | null>((done) => proc.on('close', done));
  await handle.end();
  if (code !== 0) throw new Error(`${name} exited ${code}; see .temp/search-walk/${name}.log`);
}

async function parseEnv(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const match = /^(?<name>[A-Z0-9_]+)=(?<value>.*)$/.exec(line);
    if (match?.groups) values[match.groups.name!] = match.groups.value!.replace(/^'(.*)'$/, '$1');
  }
  return values;
}

async function kernel(
  stack: Stack,
  method: string,
  path: string,
  options: { bearer?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<{ status: number; headers: Headers; value: Json; raw: string }> {
  const url = new URL(path, stack.kernel);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(60_000),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' ? {} : { 'idempotency-key': crypto.randomUUID() }),
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
      'accept-language': 'en',
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const raw = await response.text();
  let value: Json = {};
  if (raw) {
    try {
      value = JSON.parse(raw) as Json;
    } catch {
      value = { unparsed: raw.slice(0, 240) };
    }
  }
  return { status: response.status, headers: response.headers, value, raw };
}

function recordNative(
  method: string,
  path: string,
  result: { status: number; headers: Headers; value: Json },
): NativeCall {
  const subjects = Array.isArray(result.value.subjects) ? (result.value.subjects as Json[]) : undefined;
  const first = subjects?.[0] as { id?: unknown } | undefined;
  return {
    method,
    path,
    status: result.status,
    code: problemCode(result.value),
    retryAfter: result.headers.get('retry-after'),
    keys: Object.keys(result.value).slice(0, 16),
    hitCount: subjects?.length,
    next: typeof result.value.next === 'string',
    subjectId: typeof first?.id === 'string' && uuid.test(first.id) ? first.id : undefined,
    digest: typeof result.value.digest === 'string' ? result.value.digest : undefined,
  };
}

async function untilSearchUseful(
  stack: Stack,
  body: Json,
  timeoutMs = 180_000,
  bearer?: string,
): Promise<{ status: number; headers: Headers; value: Json; raw: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { status: number; headers: Headers; value: Json; raw: string } | undefined;
  while (Date.now() < deadline) {
    last = await kernel(stack, 'POST', '/v1/subjects:search', { body, bearer });
    if (last.status === 200 && Array.isArray(last.value.subjects)) return last;
    if (last.status !== 503 && last.status !== 409) return last;
    const retryAfter = Number(last.headers.get('retry-after') ?? '2');
    await Bun.sleep(Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 15) * 1000 : 2000);
  }
  return last!;
}

async function hydrated(page: Page): Promise<boolean> {
  try {
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 180_000 });
    return true;
  } catch {
    return false;
  }
}

async function openPage(
  context: BrowserContext,
  url: string,
  viewport: { width: number; height: number },
  locale: string,
): Promise<PageCall & { page: Page }> {
  const page = await context.newPage();
  let status: number | undefined;
  page.on('response', (response) => {
    if (response.url() === url || new URL(response.url()).pathname === new URL(url).pathname) status = response.status();
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    const ready = await hydrated(page);
    const results = page.locator('[data-search-results] a[href*="/subjects/"]');
    const resultLinks = await results.count().catch(() => 0);
    const recovery = page.locator('[data-search-recovery], [data-search-input-recovery]');
    const visible =
      (await recovery.first().getAttribute('data-search-recovery').catch(() => null)) ??
      (await recovery.first().getAttribute('data-search-input-recovery').catch(() => null)) ??
      (resultLinks > 0 ? 'results' : 'mounted');
    return {
      page,
      url: page.url(),
      viewport,
      locale,
      status,
      title: await page.title().catch(() => null),
      hydrated: ready,
      resultLinks,
      visible,
    };
  } catch (error) {
    return {
      page,
      url,
      viewport,
      locale,
      status,
      error: error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400),
    };
  }
}

type Showcase = { workId?: string; collections: { id: string }[]; digest?: string };

async function readShowcase(): Promise<Showcase> {
  const result = JSON.parse(await readFile(join(root, '.temp/cross-media-seed/result.json'), 'utf8')) as {
    developmentShowcase?: {
      community?: { state?: string; source?: { subjectId?: unknown } };
      collections?: { status?: string; public?: { id?: unknown } }[];
    };
  };
  const showcase = result.developmentShowcase;
  const workId =
    typeof showcase?.community?.source?.subjectId === 'string' && uuid.test(showcase.community.source.subjectId)
      ? showcase.community.source.subjectId
      : undefined;
  const collections = (showcase?.collections ?? [])
    .filter((row) => row.status === 'current' && typeof row.public?.id === 'string' && uuid.test(row.public.id))
    .map((row) => ({ id: row.public!.id as string }));
  return { workId, collections };
}

async function accessToken(stack: Stack, email: string, password: string): Promise<string> {
  const bindings = await parseEnv(join(root, 'apps/web/.dev.vars'));
  const signin = await fetch(`${stack.issuer}/signin`, {
    method: 'POST',
    headers: { origin: stack.issuer, 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      client_id: bindings.WEBSITE_CLIENT_ID ?? 'rezics-website',
      scope: bindings.WEBSITE_SCOPES,
    }),
  });
  if (!signin.ok) throw new Error(`website sign-in failed: HTTP ${signin.status}`);
  const token = await fetch(`${stack.issuer}/token`, {
    method: 'POST',
    headers: {
      origin: stack.issuer,
      'content-type': 'application/json',
      cookie: signin.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; '),
    },
    body: '{}',
  });
  if (!token.ok) throw new Error(`token failed: HTTP ${token.status}`);
  const body = (await token.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('token omitted access_token');
  return body.access_token;
}

async function writeEvidence(body: Json): Promise<void> {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

async function journey(
  name: string,
  persona: string,
  operands: Json,
  run: (record: JourneyRecord) => Promise<void>,
): Promise<JourneyRecord> {
  const started = Date.now();
  const record: JourneyRecord = {
    name,
    startedAt: new Date(started).toISOString(),
    elapsedSeconds: 0,
    persona,
    operands,
    native: [],
    pages: [],
    result: 'FAIL',
  };
  try {
    await run(record);
    if (record.result === 'FAIL' && !record.firstFailure) record.result = 'PASS';
  } catch (error) {
    record.result = 'FAIL';
    record.firstFailure = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }
  record.elapsedSeconds = Number(((Date.now() - started) / 1000).toFixed(3));
  return record;
}

function fail(record: JourneyRecord, step: string): never {
  record.result = 'FAIL';
  record.firstFailure = step;
  throw new Error(step);
}

function block(record: JourneyRecord, reason: string, owner: string): void {
  record.result = 'blocked';
  record.firstFailure = reason;
  record.blockedOn = owner;
}

const sourceRevision = (await Bun.$`git rev-parse HEAD`.cwd(root).text()).trim();
const observedAt = new Date().toISOString();

await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const stack = stackOrigins();
const setup: Json[] = [];
const journeys: JourneyRecord[] = [];
let showcase: Showcase = { collections: [] };
let bearerIssued = false;
let bearer: string | undefined;
let frontends: { stop(): Promise<void> } | undefined;
let browser: Browser | undefined;

const evidenceBase = () => ({
  sourceRevision,
  observedAt,
  stack,
  issuer: process.env.AUTH_ISSUER ?? stack.issuer,
  jwksUrl: process.env.AUTH_JWKS_URL ?? `${stack.issuer}/.well-known/jwks.json`,
  slot: process.env.REZICS_WALK_STACK_SLOT,
  setup,
  journeys,
  showcase: { workId: showcase.workId, collections: showcase.collections.length },
  bearerIssued,
});

try {
  const started = Date.now();
  await child(['bun', 'services/auth/scripts/dev-stack.ts', 'persona'], 'persona');
  setup.push({ step: 'persona', elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(3)) });
  const seedEnv = { ...process.env, ...(await parseEnv(join(root, '.temp/local-stack/seed.env'))) };
  const seedStarted = Date.now();
  await child(['bun', 'scripts/datasets/cross-media-seed.ts', '--dev'], 'seed', seedEnv);
  showcase = await readShowcase();
  setup.push({
    step: 'seed',
    elapsedSeconds: Number(((Date.now() - seedStarted) / 1000).toFixed(3)),
    workId: showcase.workId,
    collections: showcase.collections.length,
  });
  const frontendStarted = Date.now();
  frontends = await startSeededFrontends();
  setup.push({
    step: 'frontends',
    elapsedSeconds: Number(((Date.now() - frontendStarted) / 1000).toFixed(3)),
  });
} catch (error) {
  setup.push({
    step: 'setup-failure',
    error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  });
}

try {
  const keysPath = join(root, '.temp/local-stack/keys.json');
  const keys = JSON.parse(await readFile(keysPath, 'utf8')) as { password?: string };
  if (keys.password) {
    bearer = await accessToken(stack, 'developer@rezics.test', keys.password);
    bearerIssued = bearer.length > 0;
    setup.push({ step: 'developer-bearer', issued: bearerIssued });
  }
} catch (error) {
  setup.push({
    step: 'developer-bearer',
    issued: false,
    error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
  });
}

await mkdir('/tmp/rw', { recursive: true, mode: 0o700 });
try {
  browser = await chromium.launch({ headless: true, env: { ...process.env, TMPDIR: '/tmp/rw' } });
} catch (error) {
  setup.push({
    step: 'browser',
    error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
  });
}

const desktop = { width: 1280, height: 900 };
const phone = { width: 390, height: 844 };

async function contextFor(locale: string, viewport: { width: number; height: number }): Promise<BrowserContext> {
  if (!browser) throw new Error('browser did not start');
  return browser.newContext({ locale, viewport });
}

journeys.push(
  await journey('Mixed Search', 'anonymous', { text: mixedQuery, viewports: [desktop, phone] }, async (record) => {
    const searched = await untilSearchUseful(stack, { text: mixedQuery, languages: ['en'], limit: 20 });
    record.native.push(recordNative('POST', '/v1/subjects:search', searched));
    if (searched.status !== 200) fail(record, `native mixed search HTTP ${searched.status} ${problemCode(searched.value) ?? ''}`);
    const subjects = searched.value.subjects as Json[] | undefined;
    if (!subjects?.length) fail(record, 'native mixed search returned no permitted hits');
    const subjectId = (subjects[0] as { id: string }).id;
    const context = await contextFor('en-US', desktop);
    try {
      const opened = await openPage(context, `${stack.web}/en/search?q=${encodeURIComponent(mixedQuery)}`, desktop, 'en');
      record.pages.push(opened);
      if (opened.error) fail(record, `search page: ${opened.error}`);
      if ((opened.resultLinks ?? 0) < 1) fail(record, 'search page showed no permitted result links');
      const first = opened.page.locator('[data-search-results] a[href*="/subjects/"]').first();
      await first.click();
      await opened.page.waitForURL((url) => url.pathname.includes('/subjects/'), { timeout: 60_000 });
      record.pages.push({
        url: opened.page.url(),
        viewport: desktop,
        locale: 'en',
        visible: 'subject',
      });
      await opened.page.goBack({ waitUntil: 'domcontentloaded' });
      await hydrated(opened.page);
      if (!opened.page.url().includes(`q=${encodeURIComponent(mixedQuery)}`) && !opened.page.url().includes('q=Steins'))
        fail(record, `return lost executed query: ${opened.page.url()}`);
      record.pages.push({
        url: opened.page.url(),
        viewport: desktop,
        locale: 'en',
        visible: 'returned-query',
      });
    } finally {
      await context.close();
    }
    const phoneContext = await contextFor('en-US', phone);
    try {
      const phonePage = await openPage(
        phoneContext,
        `${stack.web}/en/search?q=${encodeURIComponent(mixedQuery)}`,
        phone,
        'en',
      );
      record.pages.push(phonePage);
    } finally {
      await phoneContext.close();
    }
    if (!bearer) fail(record, 'developer bearer was not issued after issuer-origin JWKS receiving');
    const granted = await untilSearchUseful(stack, { text: mixedQuery, languages: ['en'], limit: 20 }, 180_000, bearer);
    record.native.push(recordNative('POST', '/v1/subjects:search', granted));
    if (granted.status !== 200) fail(record, `granted mixed search HTTP ${granted.status}`);
    const cursor = typeof granted.value.next === 'string' ? granted.value.next : undefined;
    if (cursor) {
      const continued = await kernel(stack, 'POST', '/v1/subjects:search', {
        body: { text: mixedQuery, languages: ['en'], limit: 20, cursor },
        bearer,
      });
      record.native.push(recordNative('POST', '/v1/subjects:search', continued));
      if (continued.status !== 200 && continued.status !== 409 && continued.status !== 503)
        fail(record, `granted continuation HTTP ${continued.status}`);
    }
    const collectionId = showcase.collections[0]?.id;
    if (collectionId) {
      const current = await kernel(stack, 'GET', `/v1/collections/${collectionId}`, { bearer });
      record.native.push(recordNative('GET', `/v1/collections/${collectionId}`, current));
      const collection = current.value.collection as { revision?: number; visibility?: string } | undefined;
      if (current.status === 200 && typeof collection?.revision === 'number') {
        const nextVisibility = collection.visibility === 'public' ? 'unlisted' : 'public';
        const changed = await kernel(stack, 'PATCH', `/v1/collections/${collectionId}`, {
          bearer,
          body: { revision: collection.revision, visibility: nextVisibility },
        });
        record.native.push(recordNative('PATCH', `/v1/collections/${collectionId}`, changed));
        const after = await untilSearchUseful(
          stack,
          { text: mixedQuery, languages: ['en'], limit: 20 },
          180_000,
          bearer,
        );
        record.native.push(recordNative('POST', '/v1/subjects:search', after));
        if (after.status !== 200) fail(record, `mixed search after visibility change HTTP ${after.status}`);
      } else {
        fail(record, `seeded collection ${collectionId} was not readable for a visibility change`);
      }
    } else {
      fail(record, 'seeded collection was missing so visibility change could not run');
    }
    void subjectId;
  }),
);

journeys.push(
  await journey(
    'Refine and continue',
    'anonymous',
    { text: bookQuery, type: bookType, also: visualNovelType },
    async (record) => {
      const body = {
        text: bookQuery,
        filter: { type: { in: [bookType] } },
        languages: ['en'],
        limit: 20,
      };
      const searched = await untilSearchUseful(stack, body);
      record.native.push(recordNative('POST', '/v1/subjects:search', searched));
      if (searched.status !== 200)
        fail(record, `native typed search HTTP ${searched.status} ${problemCode(searched.value) ?? ''}`);
      const facets = await kernel(stack, 'POST', '/v1/subjects:facets', {
        body: {
          text: bookQuery,
          filter: { type: { in: [bookType] } },
          facets: [{ property: 'type', size: 8 }],
        },
      });
      record.native.push(recordNative('POST', '/v1/subjects:facets', facets));
      const cursor = typeof searched.value.next === 'string' ? searched.value.next : undefined;
      if (cursor) {
        const continued = await kernel(stack, 'POST', '/v1/subjects:search', { body: { ...body, cursor } });
        record.native.push(recordNative('POST', '/v1/subjects:search', continued));
        const restarted = await kernel(stack, 'POST', '/v1/subjects:search', { body });
        record.native.push(recordNative('POST', '/v1/subjects:search', restarted));
      }
      const context = await contextFor('en-US', desktop);
      try {
        const opened = await openPage(
          context,
          `${stack.web}/en/search?q=${encodeURIComponent(bookQuery)}&type=${encodeURIComponent(bookType)}`,
          desktop,
          'en',
        );
        record.pages.push(opened);
        const constraints = await opened.page.locator('[data-search-constraints]').count().catch(() => 0);
        record.pages.push({
          url: opened.page.url(),
          viewport: desktop,
          locale: 'en',
          visible: constraints > 0 ? 'facet-choices' : opened.visible,
        });
      } finally {
        await context.close();
      }
      if (!bearer) fail(record, 'developer bearer was not issued after issuer-origin JWKS receiving');
      const granted = await untilSearchUseful(stack, body, 180_000, bearer);
      record.native.push(recordNative('POST', '/v1/subjects:search', granted));
      const grantedCursor = typeof granted.value.next === 'string' ? granted.value.next : undefined;
      if (grantedCursor) {
        const crossReader = await kernel(stack, 'POST', '/v1/subjects:search', {
          body: { ...body, cursor: grantedCursor },
        });
        record.native.push(recordNative('POST', '/v1/subjects:search', crossReader));
        if (crossReader.status === 200)
          fail(record, 'anonymous continuation reused a granted-reader cursor');
        const restarted = await kernel(stack, 'POST', '/v1/subjects:search', { body, bearer });
        record.native.push(recordNative('POST', '/v1/subjects:search', restarted));
        if (restarted.status !== 200 && restarted.status !== 503)
          fail(record, `granted restart HTTP ${restarted.status}`);
      }
    },
  ),
);

journeys.push(
  await journey(
    'Multilingual names',
    'anonymous',
    { original: originalName, alias: aliasName, locales: ['en', 'zh-Hant', 'ja'] },
    async (record) => {
      const suggested = await kernel(stack, 'GET', '/v1/subjects:suggest', {
        query: { q: originalName, limit: '5' },
      });
      record.native.push(recordNative('GET', '/v1/subjects:suggest', suggested));
      if (suggested.status !== 200)
        fail(record, `suggest HTTP ${suggested.status} ${problemCode(suggested.value) ?? ''}`);
      const searched = await untilSearchUseful(stack, { text: originalName, languages: ['ja', 'en'], limit: 10 });
      record.native.push(recordNative('POST', '/v1/subjects:search', searched));
      const alias = await untilSearchUseful(stack, { text: aliasName, languages: ['en', 'ja'], limit: 10 });
      record.native.push(recordNative('POST', '/v1/subjects:search', alias));
      const context = await contextFor('ja-JP', desktop);
      try {
        const opened = await openPage(
          context,
          `${stack.web}/ja/search?q=${encodeURIComponent(originalName)}`,
          desktop,
          'ja',
        );
        record.pages.push(opened);
        const option = opened.page.locator('[role="option"]').first();
        const hit = opened.page.locator('[data-search-results] a[href*="/subjects/"]').first();
        if ((await option.count()) > 0) {
          await option.click();
          record.pages.push({ url: opened.page.url(), viewport: desktop, locale: 'ja', visible: 'suggestion' });
        } else if ((await hit.count()) === 0) {
          fail(record, 'no suggestion or permitted Subject for the original-language name');
        }
        if ((await hit.count()) > 0) {
          await hit.click();
          await opened.page.waitForURL((url) => url.pathname.includes('/subjects/'), { timeout: 60_000 });
          const subjectUrl = opened.page.url();
          record.pages.push({ url: subjectUrl, viewport: desktop, locale: 'ja', visible: 'subject' });
          const zh = subjectUrl.replace('/ja/', '/zh-Hant/');
          await opened.page.goto(zh, { waitUntil: 'domcontentloaded', timeout: 180_000 });
          await hydrated(opened.page);
          if (!opened.page.url().includes('/zh-Hant/')) fail(record, `locale change lost: ${opened.page.url()}`);
          record.pages.push({ url: opened.page.url(), viewport: desktop, locale: 'zh-Hant', visible: 'locale-change' });
        } else {
          fail(record, 'suggestion did not open a Subject');
        }
      } finally {
        await context.close();
      }
    },
  ),
);

journeys.push(
  await journey('Search recovery', 'anonymous', { invalid: invalidQuery }, async (record) => {
    const invalid = await kernel(stack, 'POST', '/v1/subjects:search', { body: { text: invalidQuery } });
    record.native.push(recordNative('POST', '/v1/subjects:search', invalid));
    if (invalid.status === 200) fail(record, 'invalid operand was accepted as a successful search');
    const corrected = await untilSearchUseful(stack, { text: mixedQuery, languages: ['en'], limit: 5 });
    record.native.push(recordNative('POST', '/v1/subjects:search', corrected));
    const stale = await kernel(stack, 'POST', '/v1/subjects:search', {
      body: { text: mixedQuery, cursor: 'not-a-cursor' },
    });
    record.native.push(recordNative('POST', '/v1/subjects:search', stale));
    const context = await contextFor('en-US', desktop);
    try {
      const opened = await openPage(
        context,
        `${stack.web}/en/search?q=${encodeURIComponent(invalidQuery)}`,
        desktop,
        'en',
      );
      record.pages.push(opened);
      const box = opened.page.locator('input[role="combobox"][name="q"]').first();
      if ((await box.count()) > 0) {
        await box.fill(mixedQuery);
        await box.press('Enter');
        await opened.page.waitForLoadState('domcontentloaded');
        record.pages.push({ url: opened.page.url(), viewport: desktop, locale: 'en', visible: 'corrected' });
      }
    } finally {
      await context.close();
    }
    if (corrected.status !== 200)
      fail(record, `corrected search HTTP ${corrected.status} ${problemCode(corrected.value) ?? ''}`);
  }),
);

journeys.push(
  await journey(
    'Configured reading',
    'anonymous',
    { home: '/en/', subject: showcase.workId, locales: ['en', 'zh-Hant'] },
    async (record) => {
      const active = await kernel(stack, 'GET', '/v1/presentation/active');
      record.native.push(recordNative('GET', '/v1/presentation/active', active));
      if (active.status !== 200) fail(record, `active profile HTTP ${active.status} ${problemCode(active.value) ?? ''}`);
      if (showcase.workId) {
        const pageRead = await kernel(stack, 'POST', '/v1/pages:read', {
          body: { target: { subject: showcase.workId }, languages: ['en'] },
        });
        record.native.push(recordNative('POST', '/v1/pages:read', pageRead));
        if (pageRead.status !== 200 && pageRead.status !== 202 && pageRead.status !== 503)
          fail(record, `subject page read HTTP ${pageRead.status} ${problemCode(pageRead.value) ?? ''}`);
      }
      const context = await contextFor('en-US', desktop);
      try {
        const home = await openPage(context, `${stack.web}/en/`, desktop, 'en');
        record.pages.push(home);
        const lists = await home.page.locator('[data-slot="type-list"], section, ol, ul').count().catch(() => 0);
        if (!home.hydrated && home.error) fail(record, `home page: ${home.error}`);
        if (lists < 1) fail(record, 'configured home lists were not visible');
        if (showcase.workId) {
          const subject = await openPage(context, `${stack.web}/en/subjects/${showcase.workId}/work`, desktop, 'en');
          record.pages.push(subject);
        }
        const zhHome = await openPage(context, `${stack.web}/zh-Hant/`, desktop, 'zh-Hant');
        record.pages.push(zhHome);
      } finally {
        await context.close();
      }
    },
  ),
);

journeys.push(
  await journey('Published composition', 'anonymous', { selectedPublic: true, workingDraft: 'blocked' }, async (record) => {
    const active = await kernel(stack, 'GET', '/v1/presentation/active');
    record.native.push(recordNative('GET', '/v1/presentation/active', active));
    if (active.status !== 200) fail(record, `selected public profile HTTP ${active.status}`);
    const digest = typeof active.value.digest === 'string' ? active.value.digest : undefined;
    if (!digest) fail(record, 'active profile omitted digest');
    const profile = await kernel(stack, 'GET', `/v1/presentation/profiles/${digest}`);
    record.native.push(recordNative('GET', `/v1/presentation/profiles/${digest}`, profile));
    if (profile.status !== 200) fail(record, `immutable public profile HTTP ${profile.status}`);
    const lost = await kernel(stack, 'GET', `/v1/presentation/profiles/${digest}not`);
    record.native.push(recordNative('GET', `/v1/presentation/profiles/${digest}not`, lost));
    const recovered = await kernel(stack, 'GET', `/v1/presentation/profiles/${digest}`);
    record.native.push(recordNative('GET', `/v1/presentation/profiles/${digest}`, recovered));
    if (recovered.status !== 200) fail(record, `recovered publication HTTP ${recovered.status}`);
    const refusedPublish = await kernel(stack, 'POST', '/v1/presentation/profiles', { body: { profile: {} } });
    record.native.push(recordNative('POST', '/v1/presentation/profiles', refusedPublish));
    const context = await contextFor('en-US', desktop);
    try {
      const home = await openPage(context, `${stack.web}/en/`, desktop, 'en');
      record.pages.push(home);
    } finally {
      await context.close();
    }
    if (!bearer) fail(record, 'developer bearer was not issued after issuer-origin JWKS receiving');
    const working = await kernel(stack, 'POST', '/v1/presentation/profiles', {
      bearer,
      body: { profile: profile.value.profile ?? {} },
    });
    record.native.push(recordNative('POST', '/v1/presentation/profiles', working));
    if (working.status !== 200 && working.status !== 201 && working.status !== 400 && working.status !== 403)
      fail(record, `editor publish HTTP ${working.status}`);
    const publicAgain = await kernel(stack, 'GET', `/v1/presentation/profiles/${digest}`);
    record.native.push(recordNative('GET', `/v1/presentation/profiles/${digest}`, publicAgain));
    if (publicAgain.status !== 200) fail(record, `selected public A after working draft HTTP ${publicAgain.status}`);
  }),
);

if (browser) await browser.close();
if (frontends) await frontends.stop();
await writeEvidence({ ...evidenceBase(), publicSetup: publicFields(setup) });
const passing = journeys.filter((row) => row.result === 'PASS').length;
const slowest = [...journeys].sort((a, b) => b.elapsedSeconds - a.elapsedSeconds)[0];
console.log(
  `search walk complete: ${passing}/6 passing; slowest ${slowest?.name ?? 'none'} ${slowest?.elapsedSeconds ?? 0}s; evidence .temp/search-walk/evidence.json`,
);
