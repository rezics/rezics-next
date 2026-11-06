/**
 * Seeded Home walk. Runs inside `dev-stack.ts walk`: the developer persona and the supported cross-media seed supply
 * actual public Collections, works and a Global thread; an ordinary reader signs up through the served Auth page; and
 * anonymous, reader and replacement sessions are walked through Web's own pages. Every write is an ordinary native
 * command with a fresh idempotency key. Evidence contains identities, routes and visible facts, never secrets.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const root = resolve(import.meta.dir, '../../..');
const evidenceDir = join(root, '.temp/home-walk');
const standardQuestion = '00000000-0000-7000-8000-000000000001';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const collectionTimeout = 480_000;

type Json = Record<string, unknown>;
type Stack = { web: string; issuer: string; kernel: string };
type Step = { name: string; url?: string; observed?: unknown; status?: number };

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
    kernel: loopback('REZICS_LOCAL_STACK_KERNEL_ORIGIN'),
  };
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error(`${label} is not a native identity`);
  return value;
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
  if (code !== 0) throw new Error(`${name} exited ${code}; see .temp/home-walk/${name}.log`);
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
  options: { bearer?: string; body?: unknown; query?: Record<string, string>; ifMatch?: string } = {},
): Promise<{ status: number; value: Json }> {
  const url = new URL(path, stack.kernel);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(60_000),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' ? {} : { 'idempotency-key': crypto.randomUUID() }),
      ...(options.ifMatch ? { 'if-match': JSON.stringify(options.ifMatch) } : {}),
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
      'accept-language': 'en',
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, value: text ? (JSON.parse(text) as Json) : {} };
}

function requireOk(result: { status: number; value: Json }, label: string, expected = 200): Json {
  if (result.status !== expected)
    throw new Error(`${label} returned HTTP ${result.status}: ${JSON.stringify(result.value).slice(0, 600)}`);
  return result.value;
}

/** Ordinary website sign-in for API tokens, the same path Web's session bridge uses. */
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
  if (!signin.ok) throw new Error(`website sign-in for ${email} failed: HTTP ${signin.status}`);
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
  if (!token.ok) throw new Error(`token for ${email} failed: HTTP ${token.status}`);
  const body = (await token.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`token for ${email} omitted access_token`);
  return body.access_token;
}

type Showcase = {
  workId: string;
  boardId: string;
  threadId: string;
  collections: { id: string; memberIds: string[] }[];
};

/** Reads only the seed's published identities: the Steins;Gate work, its Global thread and public Collections. */
async function readShowcase(): Promise<Showcase> {
  const result = JSON.parse(await readFile(join(root, '.temp/cross-media-seed/result.json'), 'utf8')) as {
    developmentShowcase?: {
      community?: {
        state?: string;
        source?: { subjectId?: unknown };
        board?: { id?: unknown };
        thread?: { threadId?: unknown };
      };
      collections?: {
        status?: string;
        public?: { id?: unknown };
        members?: { subjectId?: unknown }[];
      }[];
    };
  };
  const showcase = result.developmentShowcase;
  const community = showcase?.community;
  if (community?.state !== 'published') throw new Error('the seed did not publish the Global discussion community');
  const collections = (showcase?.collections ?? [])
    .filter((row) => row.status === 'current' && row.public?.id !== undefined)
    .map((row) => ({
      id: requireId(row.public!.id, 'seeded Collection'),
      memberIds: (row.members ?? []).map((member) => requireId(member.subjectId, 'seeded member subject')),
    }));
  if (collections.length === 0) throw new Error('the seed published no public Collection');
  return {
    workId: requireId(community.source?.subjectId, 'seeded work'),
    boardId: requireId(community.board?.id, 'seeded board'),
    threadId: requireId(community.thread?.threadId, 'seeded thread'),
    collections,
  };
}

function observedFeed(page: Json): unknown[] {
  const items = Array.isArray(page.feedItems) ? (page.feedItems as Json[]) : [];
  return items.map((item) => ({
    id: item.id,
    source: item.source,
    destination: item.destination,
  }));
}

/** Waits for discovery to publish the seeded Collection card with its curator and preview facts. */
async function waitForCollectionCard(stack: Stack, collectionId: string): Promise<Json> {
  const deadline = Date.now() + collectionTimeout;
  let last: unknown = undefined;
  while (Date.now() < deadline) {
    const feed = requireOk(
      await kernel(stack, 'GET', '/v1/feedItems', { query: { stream: 'home', limit: '20' } }),
      'public Home feed',
    );
    last = observedFeed(feed);
    const item = (feed.feedItems as Json[] | undefined)?.find(
      (row) => (row.destination as Json | undefined)?.id === collectionId,
    );
    const card = (item?.summary as Json | undefined)?.card as Json | undefined;
    if (
      card &&
      (card.curator as Json | undefined)?.state === 'available' &&
      (card.preview as Json | undefined)?.state === 'available'
    )
      return item!;
    await Bun.sleep(5_000);
  }
  throw new Error(`discovery did not publish the seeded Collection card: ${JSON.stringify(last).slice(0, 800)}`);
}

async function hydrated(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 180_000 });
}

/** Signs an ordinary reader up through the served Auth page; the local widget completes its own challenge. */
async function signUp(page: Page, stack: Stack, account: { handle: string; email: string; password: string }) {
  await page.goto(`${stack.issuer}/signup`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await hydrated(page);
  await page.locator('input[name="handle"]').fill(account.handle);
  await page.locator('input[name="email"]').fill(account.email);
  for (const field of await page.locator('input[type="password"]').all()) await field.fill(account.password);
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL((url) => !url.pathname.startsWith('/signup'), { timeout: 180_000 });
}

/** Completes Web's own sign-in journey, through Auth's login form and back to Web's return path. */
async function signIn(page: Page, stack: Stack, account: { email: string; password: string }) {
  await page.goto(`${stack.web}/en/auth/sign-in?return_to=${encodeURIComponent('/en/')}`, {
    waitUntil: 'domcontentloaded',
    timeout: 180_000,
  });
  for (let attempt = 0; attempt < 4 && new URL(page.url()).origin === stack.issuer; attempt++) {
    await hydrated(page);
    const email = page.locator('input[type="email"]');
    if (await email.count()) {
      await email.fill(account.email);
      await page.locator('input[type="password"]').fill(account.password);
    }
    await page.locator('form button[type="submit"]').first().click();
    await page.waitForLoadState('domcontentloaded');
  }
  await page.waitForURL((url) => url.origin === stack.web && url.pathname.startsWith('/en'), { timeout: 180_000 });
}

/** Submits Web's account-menu sign-out form, which is the control a person uses. */
async function signOut(page: Page, stack: Stack) {
  await page.goto(`${stack.web}/en/`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await hydrated(page);
  await page
    .locator('form[action="/auth/sign-out"]')
    .first()
    .evaluate((form) => (form as HTMLFormElement).requestSubmit());
  await page.waitForLoadState('domcontentloaded');
}

async function main() {
  const stack = stackOrigins();
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const steps: Step[] = [];

  await child(['bun', 'services/auth/scripts/dev-stack.ts', 'persona'], 'persona');
  const seedEnv = { ...process.env, ...(await parseEnv(join(root, '.temp/local-stack/seed.env'))) };
  await child(['bun', 'scripts/datasets/cross-media-seed.ts', '--dev'], 'seed', seedEnv);
  const showcase = await readShowcase();
  steps.push({
    name: 'seed',
    observed: { workId: showcase.workId, boardId: showcase.boardId, collections: showcase.collections.length },
  });

  const keys = JSON.parse(await readFile(join(root, '.temp/local-stack/keys.json'), 'utf8')) as { password: string };
  const developer = await accessToken(stack, 'developer@rezics.test', keys.password);
  const collection = showcase.collections.find((row) => row.memberIds.length > 0);
  if (!collection) throw new Error('the seed published no Collection with members');
  const reader = {
    handle: `walk-${randomBytes(3).toString('hex')}`,
    email: `walk.reader.${randomBytes(4).toString('hex')}@rezics.test`,
    password: randomBytes(18).toString('base64url'),
  };

  // Chromium's Unix socket paths must fit a short root; the inherited temporary root may be too long.
  await mkdir('/tmp/rw', { recursive: true, mode: 0o700 });
  const browser: Browser = await chromium.launch({ headless: true, env: { ...process.env, TMPDIR: '/tmp/rw' } });
  const anonymous: BrowserContext = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
  });
  const member: BrowserContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  try {
    const signupPage = await member.newPage();
    await signUp(signupPage, stack, reader);
    steps.push({ name: 'reader signup', observed: { handle: reader.handle } });

    const readerToken = await accessToken(stack, reader.email, reader.password);
    const written = await kernel(stack, 'PUT', `/v1/libraryEntries/${showcase.workId}`, {
      bearer: readerToken,
      body: { state: 'reading' },
    });
    if (written.status !== 200 && written.status !== 201)
      throw new Error(
        `reader library entry returned HTTP ${written.status}: ${JSON.stringify(written.value).slice(0, 600)}`,
      );
    const entry = written.value;
    const vote = requireOk(
      await kernel(stack, 'POST', `/v1/subjects/${showcase.workId}/ratings/${standardQuestion}/vote`, {
        bearer: readerToken,
        body: { units: 14 },
      }),
      'reader vote',
    );
    const reaction = requireOk(
      await kernel(stack, 'POST', `/v1/threads/${showcase.threadId}/reaction`, {
        bearer: readerToken,
        body: { kind: 'upvote' },
      }),
      'reader reaction',
    );
    steps.push({
      name: 'reader writes',
      observed: { entry: Object.keys(entry), vote: Object.keys(vote), reaction: reaction.kind },
    });

    const feedItem = await waitForCollectionCard(stack, collection.id);
    steps.push({ name: 'discovery card', observed: feedItem.destination });

    // Anonymous visitor: the installed Collection card, its curator and occurrence-bound preview links.
    const visitor = await anonymous.newPage();
    await visitor.goto(`${stack.web}/en/`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await hydrated(visitor);
    const row = visitor.locator(`li[data-feed-id="discovery:commerce:${collection.id}"]`);
    await row.waitFor({ state: 'visible', timeout: 180_000 });
    const card = {
      curator: await row.locator('[data-home-curator-state="available"]').count(),
      preview: await row.locator('[data-home-collection-preview="available"]').count(),
      members: await row.locator('[data-collection-member-id]').count(),
    };
    if (card.curator !== 1 || card.preview !== 1 || card.members < 1)
      throw new Error(`Collection card facts missing: ${JSON.stringify(card)}`);
    const homeUrl = visitor.url();
    await row.locator('[data-collection-member-id] a').first().click();
    await visitor.waitForURL((url) => url.pathname.includes('/subjects/') && url.searchParams.has('via'), {
      timeout: 120_000,
    });
    steps.push({ name: 'member link', url: visitor.url() });
    await visitor.goBack({ waitUntil: 'domcontentloaded' });
    await hydrated(visitor);
    await visitor
      .locator(`li[data-feed-id="discovery:commerce:${collection.id}"]`)
      .waitFor({ state: 'visible', timeout: 120_000 });
    steps.push({ name: 'anonymous return', url: visitor.url(), observed: { homeUrl, card } });

    // Ordinary reader: personal facts for the admitted work, retained through a reload of the same page.
    await signIn(signupPage, stack, reader);
    await signupPage.goto(`${stack.web}/en/`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await hydrated(signupPage);
    const workEntry = signupPage.locator('[data-slot="home-work-library-entry"]').first();
    await workEntry.waitFor({ state: 'visible', timeout: 180_000 });
    const score = await signupPage.locator('[data-slot="home-work-library-score"]').first().textContent();
    if (!score?.includes('7 / 10')) throw new Error(`reader score was ${JSON.stringify(score)}, expected 7 / 10`);
    steps.push({ name: 'reader personal facts', url: signupPage.url(), observed: { score } });

    // Session replacement: sign-out withdraws the reader's facts; the developer sees none of them.
    await signOut(signupPage, stack);
    await signupPage.goto(`${stack.web}/en/`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await hydrated(signupPage);
    if ((await signupPage.locator('[data-slot="home-work-library-score"]').count()) !== 0)
      throw new Error('reader facts remained after sign-out');
    steps.push({ name: 'sign-out retirement' });
    await signIn(signupPage, stack, { email: 'developer@rezics.test', password: keys.password });
    await signupPage.goto(`${stack.web}/en/`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await hydrated(signupPage);
    if ((await signupPage.locator('[data-slot="home-work-library-score"]').count()) !== 0)
      throw new Error('developer session displayed the reader score');
    steps.push({ name: 'replacement session', observed: { developer: Boolean(developer) } });
  } finally {
    await browser.close();
  }

  await writeFile(
    join(evidenceDir, 'evidence.json'),
    JSON.stringify(
      { stack, steps, collection: collection.id, work: showcase.workId, thread: showcase.threadId },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  console.log(`home walk complete: ${steps.length} steps recorded in .temp/home-walk/evidence.json`);
}

await main();
