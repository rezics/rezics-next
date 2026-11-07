#!/usr/bin/env bun
/**
 * Seeded first-public Commerce and Library walk. Run under `dev-stack.ts walk`.
 * Native commands and served pages are recorded per finishing-register row.
 * Evidence stays under `.temp/commerce-walk/`.
 *
 * Kernel /v1/definitions must answer before seed. A 404 or sign-in mismatch is a
 * page failure except anonymous private pages, which must leave the member shell.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startSeededFrontends } from '../../../../services/auth/scripts/dev-stack.ts';
import {
  applyWalkResults,
  createWalkKernel,
  FIRST_PUBLIC_JOURNEYS,
  publicFields,
  requireId,
  runJourney,
  summarizeWalk,
  type JourneyWalkRow,
  type WalkAccount,
  type WalkIdentities,
} from '../../../../services/kernel/test/commerce/support/goal-journey-walk.ts';

const root = resolve(import.meta.dir, '../../../..');
const evidenceDir = join(root, '.temp/commerce-walk');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMERCE_JOURNEYS = new Set([
  'offer-management',
  'purchase',
  'owned-use',
  'payment-repair',
  'creator-money',
  'financial-lifecycle',
]);

type Stack = { web: string; issuer: string; kernel: string };
type Json = Record<string, unknown>;
type Viewer = 'owner' | 'other' | 'anonymous';

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

async function child(command: string[], name: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const log = Bun.file(join(evidenceDir, `${name}.log`));
  const handle = await log.writer();
  const proc = spawn(command[0]!, command.slice(1), { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (chunk: Buffer) => handle.write(chunk));
  proc.stderr.on('data', (chunk: Buffer) => handle.write(chunk));
  const code = await new Promise<number | null>((done) => proc.on('close', done));
  await handle.end();
  if (code !== 0) throw new Error(`${name} exited ${code}: ${await logTail(name)}`);
}

async function logTail(name: string): Promise<string> {
  try {
    const lines = (await readFile(join(evidenceDir, `${name}.log`), 'utf8')).trim().split('\n').filter(Boolean);
    return lines.slice(-8).join(' | ').slice(0, 400) || '(empty log)';
  } catch {
    return '(missing log)';
  }
}

async function waitUntilOk(url: string, label: string, ms = 1_200_000): Promise<void> {
  const deadline = Date.now() + ms;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`${label} not ready: ${last}`);
}

async function parseEnv(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const match = /^(?<name>[A-Z0-9_]+)=(?<value>.*)$/.exec(line);
    if (match?.groups) values[match.groups.name!] = match.groups.value!.replace(/^'(.*)'$/, '$1');
  }
  return values;
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

function sourceRevision(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

async function readShowcase(): Promise<{ workId: string; collectionId?: string; offerId?: string }> {
  const result = JSON.parse(await readFile(join(root, '.temp/cross-media-seed/result.json'), 'utf8')) as {
    developmentShowcase?: {
      community?: { state?: string; source?: { subjectId?: unknown } };
      collections?: { status?: string; public?: { id?: unknown } }[];
      offer?: { state?: string; offerId?: unknown };
    };
  };
  const community = result.developmentShowcase?.community;
  if (community?.state !== 'published') throw new Error('the seed did not publish the Global discussion community');
  const collection = (result.developmentShowcase?.collections ?? []).find(
    (row) => row.status === 'current' && row.public?.id !== undefined,
  );
  const offer = result.developmentShowcase?.offer;
  return {
    workId: requireId(community.source?.subjectId, 'seeded work'),
    ...(collection?.public?.id ? { collectionId: requireId(collection.public.id, 'seeded Collection') } : {}),
    ...(offer?.state === 'created' && offer.offerId ? { offerId: requireId(offer.offerId, 'seeded offer') } : {}),
  };
}

function accountFromBearer(bearer: string): string | undefined {
  const payload = bearer.split('.')[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Json;
    const id = json.sub ?? json.accountId;
    return typeof id === 'string' && uuid.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

async function hydrated(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 180_000 });
}

async function signUp(page: Page, stack: Stack, account: { handle: string; email: string; password: string }) {
  await page.goto(`${stack.issuer}/signup`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await hydrated(page);
  await page.locator('input[name="handle"]').fill(account.handle);
  await page.locator('input[name="email"]').fill(account.email);
  for (const field of await page.locator('input[type="password"]').all()) await field.fill(account.password);
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL((url) => !url.pathname.startsWith('/signup'), { timeout: 180_000 });
}

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

function localize(path: string): string {
  return path.startsWith('/en/') ? path : `/en${path.startsWith('/') ? path : `/${path}`}`;
}

function privatePath(path: string): boolean {
  return (
    path.startsWith('/library') ||
    path.startsWith('/creator') ||
    path.startsWith('/orders') ||
    path.startsWith('/entitlements') ||
    path.startsWith('/settings')
  );
}

function expandPath(path: string, identities: WalkIdentities): string | undefined {
  if (path.includes(':id')) {
    const id =
      path.startsWith('/offers/')
        ? identities.offerId
        : path.startsWith('/orders/')
          ? identities.orderId
          : path.startsWith('/collections/')
            ? (identities.ownedCollectionId ?? identities.collectionId)
            : path.startsWith('/library/progress/')
              ? identities.sessionId
              : path.startsWith('/logs/')
                ? identities.publishedLogId
                : path.startsWith('/creator/statements/')
                  ? undefined
                  : identities.workId;
    if (!id) return undefined;
    return path.replace(':id', id);
  }
  return path;
}

async function openPage(
  page: Page,
  stack: Stack,
  path: string,
): Promise<{ url: string; status: number | null; main: boolean; title: string; heading: string }> {
  const href = `${stack.web}${localize(path)}`;
  const response = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.locator('main').waitFor({ state: 'visible', timeout: 120_000 }).catch(() => undefined);
  const heading = ((await page.locator('main h1, main h2').first().textContent().catch(() => '')) ?? '').trim();
  return {
    url: page.url(),
    status: response?.status() ?? null,
    main: (await page.locator('main').count()) > 0,
    title: await page.title(),
    heading,
  };
}

function pageMismatch(
  opened: { url: string; status: number | null; main: boolean; title: string; heading: string },
  path: string,
  viewer: Viewer,
  stack: Stack,
): string | undefined {
  const url = new URL(opened.url);
  const expected = localize(path).split('?')[0]!;
  const missing = /not found|404/i.test(`${opened.title} ${opened.heading}`);
  if (viewer === 'anonymous' && privatePath(path)) {
    const signedOut =
      url.origin === stack.issuer ||
      url.pathname.includes('/auth/sign-in') ||
      opened.status === 401 ||
      opened.status === 403;
    if (signedOut) return undefined;
    return `anonymous reached ${opened.status} ${opened.url}`;
  }
  if (opened.status === 404 || (opened.status !== null && opened.status >= 400))
    return `HTTP ${opened.status} ${opened.url}`;
  if (url.origin !== stack.web) return `left web origin: ${opened.url}`;
  if (url.origin === stack.issuer || url.pathname.includes('/auth/sign-in')) return `sign-in redirect ${opened.url}`;
  if (!url.pathname.startsWith(expected)) return `path ${url.pathname} not ${expected}`;
  if (!opened.main) return 'main landmark missing';
  if (missing) return `missing page ${opened.title || opened.heading}`;
  return undefined;
}

function failSetup(revision: string, utc: string, elapsedSeconds: number, stage: string, error: unknown): JourneyWalkRow[] {
  const observed = error instanceof Error ? error.message : String(error);
  return FIRST_PUBLIC_JOURNEYS.map((journey) => ({
    journey: journey.id,
    title: journey.title,
    result: 'FAIL' as const,
    revision,
    utc,
    elapsedSeconds: Math.max(1, elapsedSeconds),
    persona: 'setup',
    firstDiffering: { command: stage, expected: 'admitted seeded walk setup', observed },
    evidence: `.temp/commerce-walk/results.json`,
    steps: [],
    pages: [...journey.pages],
  }));
}

async function seedCatalog(): Promise<void> {
  const command = ['bun', '--env-file=.temp/local-stack/seed.env', 'scripts/datasets/cross-media-seed.ts', '--dev'];
  try {
    await child(command, 'seed');
  } catch (first) {
    const observed = first instanceof Error ? first.message : String(first);
    if (!/Import transport request failed/i.test(observed)) throw first;
    await child(command, 'seed-retry');
  }
}

async function reviewJourneyPages(
  spec: (typeof FIRST_PUBLIC_JOURNEYS)[number],
  native: Pick<JourneyWalkRow, 'pages'>,
  identities: WalkIdentities,
  stack: Stack,
  viewers: Record<Viewer, BrowserContext>,
  phone: BrowserContext,
): Promise<{ pages: { path: string; viewer: Viewer; observed: unknown }[]; failure?: JourneyWalkRow['firstDiffering'] }> {
  const pages: { path: string; viewer: Viewer; observed: unknown }[] = [];
  const templates = native.pages.length ? native.pages : spec.pages;
  const roles: Viewer[] = spec.personas.includes('anonymous')
    ? ['owner', 'anonymous']
    : spec.personas.includes('other')
      ? ['owner', 'other']
      : ['owner'];
  for (const viewer of roles) {
    const page = await viewers[viewer].newPage();
    try {
      for (const template of templates) {
        const path = expandPath(template, identities);
        if (!path) continue;
        const opened = await openPage(page, stack, path);
        pages.push({ path, viewer, observed: opened });
        const mismatch = pageMismatch(opened, path, viewer, stack);
        if (mismatch) {
          return {
            pages,
            failure: { command: `GET ${localize(path)} as ${viewer}`, expected: 'intended served page', observed: mismatch },
          };
        }
      }
    } catch (error) {
      return {
        pages,
        failure: {
          command: `served page as ${viewer}`,
          expected: 'page opens',
          observed: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      await page.close();
    }
  }
  if (spec.id === 'everything-and-filters' || spec.id === 'offer-management') {
    const phonePage = await phone.newPage();
    try {
      const path = expandPath(templates[0] ?? spec.pages[0]!, identities);
      if (path) {
        const opened = await openPage(phonePage, stack, path);
        pages.push({ path: `${path}#phone-390`, viewer: 'owner', observed: opened });
        const mismatch = pageMismatch(opened, path, 'owner', stack);
        if (mismatch) {
          return {
            pages,
            failure: { command: `GET ${localize(path)} phone-390`, expected: 'intended served page', observed: mismatch },
          };
        }
      }
    } finally {
      await phonePage.close();
    }
  }
  return { pages };
}

async function main() {
  const stack = stackOrigins();
  const revision = sourceRevision();
  const started = Date.now();
  const utc = new Date().toISOString();
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await mkdir('/tmp/rw', { recursive: true, mode: 0o700 });

  let rows: JourneyWalkRow[] = [];
  let frontends: Awaited<ReturnType<typeof startSeededFrontends>> | undefined;
  let browser: Browser | undefined;
  try {
    await waitUntilOk(`${stack.kernel}/v1/definitions`, 'Kernel /v1/definitions');
    await child(['bun', 'services/auth/scripts/dev-stack.ts', 'persona'], 'persona');
    await seedCatalog();
    frontends = await startSeededFrontends();
    const showcase = await readShowcase();
    const keys = JSON.parse(await readFile(join(root, '.temp/local-stack/keys.json'), 'utf8')) as { password: string };
    browser = await chromium.launch({ headless: true, env: { ...process.env, TMPDIR: '/tmp/rw' } });
    const anonymousContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
    const identities: WalkIdentities = {
      workId: showcase.workId,
      collectionId: showcase.collectionId,
      offerId: showcase.offerId,
    };

    // Public/anonymous pages run before any website sign-in.
    const anonymousPage = await anonymousContext.newPage();
    try {
      const publicPaths = [
        `/subjects/${showcase.workId}`,
        ...(showcase.collectionId ? [`/collections/${showcase.collectionId}`] : []),
        ...(showcase.offerId ? [`/offers/${showcase.offerId}`] : []),
      ];
      for (const path of publicPaths) {
        const opened = await openPage(anonymousPage, stack, path);
        const mismatch = pageMismatch(opened, path, 'anonymous', stack);
        if (mismatch) throw new Error(`anonymous ${path}: ${mismatch}`);
      }
    } finally {
      await anonymousPage.close();
    }

    const ownerToken = await accessToken(stack, 'developer@rezics.test', keys.password);
    const kernel = createWalkKernel(stack.kernel);
    const owner: WalkAccount = {
      bearer: ownerToken,
      accountId: accountFromBearer(ownerToken),
      handle: 'developer',
    };
    const member = {
      handle: `walk-${randomBytes(3).toString('hex')}`,
      email: `walk.member.${randomBytes(4).toString('hex')}@rezics.test`,
      password: randomBytes(18).toString('base64url'),
    };
    const otherAccount = {
      handle: `walk-${randomBytes(3).toString('hex')}`,
      email: `walk.other.${randomBytes(4).toString('hex')}@rezics.test`,
      password: randomBytes(18).toString('base64url'),
    };
    const developerContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
    const memberContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
    const otherContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
    const phoneContext = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 } });
    const developerPage = await developerContext.newPage();
    const memberPage = await memberContext.newPage();
    const otherPage = await otherContext.newPage();
    await signIn(developerPage, stack, { email: 'developer@rezics.test', password: keys.password });
    await signUp(memberPage, stack, member);
    await signUp(otherPage, stack, otherAccount);
    await signIn(memberPage, stack, member);
    await signIn(otherPage, stack, otherAccount);
    await developerPage.close();
    const memberToken = await accessToken(stack, member.email, member.password);
    const otherToken = await accessToken(stack, otherAccount.email, otherAccount.password);
    const ctx = {
      kernel,
      revision,
      owner,
      other: { bearer: otherToken, accountId: accountFromBearer(otherToken), handle: otherAccount.handle },
      identities,
    };
    const memberCtx = {
      ...ctx,
      owner: { bearer: memberToken, accountId: accountFromBearer(memberToken), handle: member.handle },
      other: { bearer: otherToken, accountId: accountFromBearer(otherToken), handle: otherAccount.handle },
    };
    const viewers: Record<Viewer, BrowserContext> = {
      owner: memberContext,
      other: otherContext,
      anonymous: anonymousContext,
    };

    for (const spec of FIRST_PUBLIC_JOURNEYS) {
      const native = await runJourney(COMMERCE_JOURNEYS.has(spec.id) ? ctx : memberCtx, spec.id);
      const pageViewers: Record<Viewer, BrowserContext> = {
        ...viewers,
        owner: COMMERCE_JOURNEYS.has(spec.id) ? developerContext : memberContext,
      };
      const reviewed = await reviewJourneyPages(spec, native, identities, stack, pageViewers, phoneContext);
      const row: JourneyWalkRow = {
        ...native,
        evidence: `.temp/commerce-walk/${spec.id}.json`,
        firstDiffering: native.firstDiffering ?? reviewed.failure,
        result: native.result === 'PASS' && !reviewed.failure ? 'PASS' : 'FAIL',
      };
      rows.push(row);
      await writeFile(
        join(evidenceDir, `${spec.id}.json`),
        `${JSON.stringify({ row: { ...row, steps: publicFields(row.steps) }, pages: reviewed.pages }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  } catch (error) {
    if (rows.length === 0)
      rows = failSetup(revision, utc, Math.round((Date.now() - started) / 1000), 'seeded walk setup', error);
  } finally {
    await browser?.close();
    await frontends?.stop();
  }

  const report = summarizeWalk(revision, rows);
  await writeFile(join(evidenceDir, 'results.json'), `${JSON.stringify({ stack, report: publicFields(report) }, null, 2)}\n`, {
    mode: 0o600,
  });
  const capabilities = await readFile(join(root, 'docs/goals/commerce.capabilities.md'), 'utf8');
  await writeFile(join(root, 'docs/goals/commerce.capabilities.md'), applyWalkResults(capabilities, rows));
  const slowest = report.slowestFailing;
  console.log(
    `first-public walk ${report.passing}/${report.total}` +
      (slowest
        ? `; slowest failing ${slowest.title} ${slowest.elapsedSeconds}s ${slowest.firstDiffering?.command} → ${slowest.firstDiffering?.observed}`
        : ''),
  );
  if (report.passing !== 26) process.exitCode = 1;
}

await main();
