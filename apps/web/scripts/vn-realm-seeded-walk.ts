/**
 * Seeded VN Realm catalogue-to-community walk. Runs inside `dev-stack.ts walk`. Persona and seed use the stack
 * origins. When seed:dev still publishes only a Global Board, this walk creates one public visual-novel Realm through
 * the documented Space/Realm/Board/thread/publication commands using actual seeded work identities, then walks
 * anonymous, ordinary-member and Realm-member personas. It never substitutes Global.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fromPlainText } from '@rezics/document';

const root = resolve(import.meta.dir, '../../..');
const evidenceDir = join(root, '.temp/vn-realm-walk');
const launchLocales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es'] as const;
const visualNovelType = 'wd:Q689445';
const selectedVndbWorks = ['v2002', 'v4'] as const;
const globalContext = '00000000-0000-8000-8000-000000000000';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Json = Record<string, unknown>;
type Origins = { web: string; issuer: string; kernel: string };
type Work = { id: string; source: string; externalId: string };
type Identities = {
  realmId: string;
  spaceId: string;
  boardId: string;
  threadId: string;
  works: Work[];
  discoveryListed: boolean;
};
type Evidence = {
  sourceRevision: string;
  stack: Origins;
  seed: { path: string; workCount: number; showcaseBoardRealmId: null | string };
  personas: string[];
  sequence: string[];
  native: Json[];
  pages: Json[];
  defects: string[];
};

function origin(variable: string, fallback: string): string {
  const value = process.env[variable];
  if (value === undefined) return fallback;
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
    throw new Error(`${variable} must be an unauthenticated loopback HTTP origin`);
  return url.origin;
}

function origins(): Origins {
  return {
    web: origin('REZICS_LOCAL_STACK_WEB_ORIGIN', 'http://127.0.0.1:3000'),
    issuer: origin('REZICS_LOCAL_STACK_ISSUER_ORIGIN', 'http://127.0.0.1:4200'),
    kernel: origin('REZICS_LOCAL_STACK_KERNEL_ORIGIN', 'http://127.0.0.1:4100'),
  };
}

function publicFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 20).map(publicFields);
  if (!value || typeof value !== 'object') return value;
  const input = value as Json;
  const output: Json = {};
  for (const [key, field] of Object.entries(input)) {
    if (/token|password|cookie|authorization|secret|credential/i.test(key)) continue;
    output[key] = publicFields(field);
  }
  return output;
}

async function parseEnv(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const match = /^(?<name>[A-Z0-9_]+)=(?<value>.*)$/.exec(line);
    if (!match?.groups) continue;
    values[match.groups.name!] = match.groups.value!.replace(/^'(.*)'$/, '$1');
  }
  return values;
}

async function run(
  command: string[],
  options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const child = Bun.spawn(command, {
    cwd: root,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    env: options.env ?? process.env,
  });
  const code = await child.exited;
  if (code !== 0 && !options.allowFailure) throw new Error(`${command.join(' ')} exited ${code}`);
  return code;
}

async function kernel(
  stack: Origins,
  method: string,
  path: string,
  options: { bearer?: string; body?: unknown; query?: Record<string, string>; ifMatch?: string } = {},
): Promise<{ status: number; value: Json }> {
  const url = new URL(path, stack.kernel);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
      ...(options.ifMatch ? { 'if-match': JSON.stringify(options.ifMatch) } : {}),
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, value: text ? (JSON.parse(text) as Json) : {} };
}

function requireOk(result: { status: number; value: Json }, label: string, expected = 200): Json {
  if (result.status !== expected)
    throw new Error(`${label} returned HTTP ${result.status}: ${JSON.stringify(publicFields(result.value))}`);
  return result.value;
}

function asId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error(`${label} is not a native identity`);
  return value;
}

async function websiteToken(stack: Origins): Promise<string> {
  const keys = JSON.parse(await readFile(join(root, '.temp/local-stack/keys.json'), 'utf8')) as { password: string };
  const bindings = await parseEnv(join(root, 'apps/web/.dev.vars'));
  const signin = await fetch(`${stack.issuer}/signin`, {
    method: 'POST',
    headers: { origin: stack.issuer, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'developer@rezics.test',
      password: keys.password,
      client_id: bindings.WEBSITE_CLIENT_ID ?? 'rezics-website',
      scope: bindings.WEBSITE_SCOPES,
    }),
  });
  if (!signin.ok) throw new Error(`Developer website sign-in failed: ${signin.status} ${await signin.text()}`);
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
  if (!token.ok) throw new Error(`Developer website token failed: ${token.status}`);
  const body = (await token.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('Developer website token omitted access_token');
  return body.access_token;
}

function selectedWorks(seed: Json): Work[] {
  const works: Work[] = [];
  const seen = new Set<string>();
  const push = (id: string, externalId: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    works.push({ id, source: 'vndb', externalId });
  };
  for (const entry of Array.isArray(seed.readings) ? seed.readings : []) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Json;
    const subject = (row.subject as Json | undefined)?.subject as Json | undefined;
    if (row.source !== 'vndb' || row.selection !== 'selected' || typeof row.externalId !== 'string') continue;
    if (typeof subject?.id !== 'string' || !uuid.test(subject.id)) continue;
    if (subject.type === visualNovelType || selectedVndbWorks.includes(row.externalId as (typeof selectedVndbWorks)[number]))
      push(subject.id, row.externalId);
  }
  for (const entry of Array.isArray(seed.workLinks) ? seed.workLinks : []) {
    if (!entry || typeof entry !== 'object') continue;
    const source = (entry as Json).source as Json | undefined;
    const subject = source?.subject as Json | undefined;
    if (source?.provider !== 'vndb' || typeof source.externalId !== 'string' || typeof subject?.subjectId !== 'string')
      continue;
    if (!uuid.test(subject.subjectId)) continue;
    if (selectedVndbWorks.includes(source.externalId as (typeof selectedVndbWorks)[number]))
      push(subject.subjectId, source.externalId);
  }
  if (works.length === 0) throw new Error('Seed result has no selected visual-novel work identities');
  return works;
}

async function provisionRealm(
  stack: Origins,
  bearer: string,
  works: Work[],
): Promise<Omit<Identities, 'discoveryListed'>> {
  const space = requireOk(
    await kernel(stack, 'POST', '/v1/spaces', {
      bearer,
      body: { title: 'Visual Novels', summary: 'Public visual-novel Realm for the seeded catalogue walk' },
    }),
    'space create',
    201,
  ).space as Json;
  const spaceId = asId(space.spaceId, 'space');
  let realm = requireOk(
    await kernel(stack, 'POST', '/v1/realms', {
      bearer,
      body: {
        spaceId,
        title: 'Visual Novels',
        summary: 'Seeded visual-novel catalogue and discussion',
        visibility: 'public',
        contextId: globalContext,
      },
    }),
    'realm create',
    201,
  ).realm as Json;
  const realmId = asId(realm.realmId, 'realm');
  const scheme = requireOk(
    await kernel(stack, 'POST', '/v1/subjects', {
      bearer,
      body: { type: 'skos:ConceptScheme', labels: { en: 'Visual novel discussion scheme' } },
    }),
    'scheme create',
    201,
  ).subject as Json;
  realm = requireOk(
    await kernel(stack, 'PUT', `/v1/realms/${realmId}/boardScheme`, {
      bearer,
      body: { schemeId: scheme.id },
      ifMatch: asId(realm.headRevisionId, 'realm head'),
    }),
    'board scheme',
  ).realm as Json;
  const concept = requireOk(
    await kernel(stack, 'POST', '/v1/subjects', {
      bearer,
      body: {
        type: 'skos:Concept',
        labels: { en: 'Visual novel discussion' },
        statements: {
          'skos:inScheme': [
            { property: { id: 'skos:inScheme' }, value: { type: 'value', content: realm.boardSchemeId } },
          ],
        },
      },
    }),
    'concept create',
    201,
  ).subject as Json;
  const board = requireOk(
    await kernel(stack, 'POST', `/v1/realms/${realmId}/boards`, {
      bearer,
      body: { conceptId: concept.id, title: 'Visual novel discussion', visibility: 'published' },
    }),
    'board create',
    201,
  ).board as Json;
  const thread = requireOk(
    await kernel(stack, 'POST', '/v1/threads', {
      bearer,
      body: {
        boardId: board.id,
        title: 'Opening the seeded visual-novel catalogue',
        body: fromPlainText('This original note opens public discussion in the visual-novel Realm.'),
        licence: 'CC-BY-4.0',
        subjectIds: [works[0]!.id],
        visibility: 'published',
      },
    }),
    'thread create',
    201,
  ).thread as Json;
  for (const work of works) {
    const published = await kernel(stack, 'POST', `/v1/realms/${realmId}/publications`, {
      bearer,
      body: { subjectId: work.id },
    });
    if (published.status !== 201 && published.status !== 409)
      throw new Error(`publish ${work.externalId} returned HTTP ${published.status}`);
  }
  return {
    realmId,
    spaceId,
    boardId: asId(board.id, 'board'),
    threadId: asId(thread.id, 'thread'),
    works,
  };
}

async function waitForDiscovery(stack: Origins, realmId: string): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    for (const sort of ['popular', 'trending'] as const) {
      const listed = await kernel(stack, 'GET', '/v1/realms/discovery', { query: { sort, limit: '20' } });
      const realms = Array.isArray(listed.value.realms) ? (listed.value.realms as Json[]) : [];
      if (realms.some((realm) => realm.realmId === realmId)) return true;
    }
    await Bun.sleep(2_000);
  }
  return false;
}

async function waitForHome(stack: Origins, realmId: string): Promise<Json> {
  const deadline = Date.now() + 60_000;
  let home = await kernel(stack, 'GET', `/v1/realms/${realmId}/home`, { query: { languages: 'en' } });
  while (home.status !== 200 && Date.now() < deadline) {
    await Bun.sleep(2_000);
    home = await kernel(stack, 'GET', `/v1/realms/${realmId}/home`, { query: { languages: 'en' } });
  }
  if (home.status !== 200) throw new Error(`Anonymous Realm home returned HTTP ${home.status}`);
  return home.value;
}

async function localeLabels(stack: Origins, realmId: string): Promise<Json[]> {
  const pages: Json[] = [];
  for (const locale of launchLocales) {
    const response = await fetch(`${stack.web}/${encodeURIComponent(locale)}/realms/${realmId}`, {
      signal: AbortSignal.timeout(30_000),
    });
    const html = await response.text();
    pages.push({
      locale,
      status: response.status,
      catalogueHeading: html.includes('realm-catalogue-navigation'),
      boardsHeading: html.includes('realm-community-boards') || html.includes('id="realm-boards-heading"'),
    });
    if (response.status !== 200) throw new Error(`${locale} Realm page returned HTTP ${response.status}`);
  }
  return pages;
}

function loopbackOnly(route: import('playwright').Route) {
  const url = new URL(route.request().url());
  return url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
}

async function walkPersonas(stack: Origins, identities: Identities, evidence: Evidence): Promise<void> {
  const require = createRequire(resolve(root, 'apps/web/package.json'));
  const { chromium } = require('playwright') as typeof import('playwright');
  const { expect } = require('playwright/test') as typeof import('playwright/test');
  const browser = await chromium.launch({ headless: true });
  const realmPath = (locale: string) => `${stack.web}/${locale}/realms/${identities.realmId}`;
  try {
    const capture = async (
      page: import('playwright').Page,
      persona: string,
      locale: string,
      width: number,
      theme: 'light' | 'dark',
    ) => {
      await page.context().addCookies([{ name: 'rezics_theme', value: theme, url: stack.web }]);
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });
      const response = await page.goto(realmPath(locale), { waitUntil: 'domcontentloaded' });
      if (response?.status() !== 200) throw new Error(`${persona} ${locale} Realm page HTTP ${response?.status()}`);
      await expect(page.locator('main')).toBeVisible();
      await expect(page.locator('[data-slot="realm-catalogue-navigation"]')).toBeVisible();
      await expect(page.getByRole('heading', { name: /Works in this catalogue|此目錄中的作品|このカタログの作品/ })).toBeVisible({
        timeout: 45_000,
      });
      await expect(page.locator('[data-slot="realm-community-boards"]')).toBeVisible();
      await expect(page.locator('[data-slot="realm-board-link"]').first()).toBeVisible();
      evidence.pages.push({
        persona,
        locale,
        width,
        theme,
        path: new URL(page.url()).pathname,
        membership: await page.locator('[data-slot="realm-membership"]').getAttribute('data-member-state'),
        boards: await page.locator('[data-slot="realm-board-link"]').count(),
        recent: await page.locator('[data-slot="realm-board-recent-link"]').count(),
        worksHeading: await page.getByRole('heading', { name: /Works in this catalogue|此目錄中的作品|このカタログの作品/ }).count(),
      });
    };

    const anonymous = await browser.newContext({ locale: 'en-US' });
    const page = await anonymous.newPage();
    page.setDefaultTimeout(45_000);
    await page.route('**/*', loopbackOnly);
    for (const width of [390, 1280, 1440])
      for (const theme of ['light', 'dark'] as const) await capture(page, 'anonymous', 'en', width, theme);
    for (const locale of ['zh-Hant', 'ja'] as const) await capture(page, 'anonymous', locale, 1440, 'light');
    evidence.sequence.push('anonymous-open-realm');
    await page.goto(realmPath('en'), { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Works in this catalogue' })).toBeVisible();
    const more = page.getByRole('link', { name: 'More results' });
    if (await more.count()) {
      await more.first().click();
      evidence.sequence.push('anonymous-continue-works');
    }
    const subject = page.locator('a[href*="/subjects/"]').first();
    await expect(subject).toBeVisible();
    await subject.click();
    await page.waitForURL(/\/en\/subjects\//);
    evidence.sequence.push('anonymous-open-work');
    await page.goBack();
    await expect(page.locator('[data-slot="realm-catalogue-navigation"]')).toBeVisible();
    evidence.sequence.push('anonymous-return');
    await page.getByRole('link', { name: 'Browse all works' }).click();
    await page.waitForURL(/\/en\/search/);
    evidence.sequence.push('anonymous-browse-catalogue');
    await page.goBack();
    const recent = page.locator('[data-slot="realm-board-recent-link"]').first();
    if (await recent.count()) {
      await recent.click();
      await page.waitForURL(/\/en\/threads\//);
      evidence.sequence.push('anonymous-open-thread');
      await page.goBack();
    } else {
      await page.locator('[data-slot="realm-board-link"]').first().click();
      await page.waitForURL(/\/en\/boards\//);
      evidence.sequence.push('anonymous-open-board');
      const thread = page.locator('a[href*="/threads/"]').first();
      await expect(thread).toBeVisible();
      await thread.click();
      await page.waitForURL(/\/en\/threads\//);
      evidence.sequence.push('anonymous-open-thread');
    }
    await page.goto(realmPath('en'), { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-slot="realm-membership"]')).toContainText(/Sign in to join/i);
    evidence.sequence.push('anonymous-membership-sign-in');
    await anonymous.close();

    const member = await browser.newContext({ locale: 'en-US' });
    const signed = await member.newPage();
    signed.setDefaultTimeout(60_000);
    await signed.route('**/*', loopbackOnly);
    await signed.goto(realmPath('en'), { waitUntil: 'domcontentloaded' });
    await signed.locator('a[href^="/auth/sign-in"]').first().click();
    await signed.waitForURL('**/login?**');
    await signed.locator('a[href^="/signup"]').click();
    const handle = `vnwalk_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const email = `${handle}@example.test`;
    const password = 'ordinary member password 123';
    await signed.locator('input[name="handle"]').fill(handle);
    await signed.locator('input[name="email"]').fill(email);
    await signed.locator('input[name="password"]').fill(password);
    await signed.locator('input[name="confirm"]').fill(password);
    await signed.locator('form[action="/signup"] button[type="submit"]').click();
    await signed.locator('.auth-signup-links a[href^="/login"]').click();
    await signed.locator('input[name="email"]').fill(email);
    await signed.locator('input[name="password"]').fill(password);
    await signed.locator('button[type="submit"]').click();
    const approve = signed.getByRole('button', { name: 'Approve' });
    if (await approve.isVisible({ timeout: 8_000 }).catch(() => false)) await approve.click();
    await signed.waitForURL(`${stack.web}/**`);
    evidence.sequence.push('ordinary-signup-return');
    await signed.goto(realmPath('en'), { waitUntil: 'domcontentloaded' });
    await expect(signed.locator('main')).toBeVisible();
    const join = signed.locator('[data-slot="realm-membership"] button').filter({ hasText: /^Join$/ });
    await expect(join).toBeVisible();
    await expect(join).toBeEnabled();
    await join.click();
    await expect
      .poll(async () => signed.locator('[data-slot="realm-membership"]').getAttribute('data-member-state'), {
        timeout: 60_000,
      })
      .toBe('member');
    evidence.sequence.push('ordinary-join');
    evidence.pages.push({
      persona: 'ordinary-member',
      locale: 'en',
      path: new URL(signed.url()).pathname,
      membership: await signed.locator('[data-slot="realm-membership"]').getAttribute('data-member-state'),
    });
    await signed.goto(realmPath('en'), { waitUntil: 'domcontentloaded' });
    await expect(signed.locator('[data-slot="realm-membership"]')).toHaveAttribute('data-member-state', 'member');
    evidence.sequence.push('realm-member-readback');
    await capture(signed, 'realm-member', 'en', 1440, 'dark');
    await member.close();
  } finally {
    await browser.close();
  }
}

const sourceRevision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim();
const stack = origins();
await mkdir(evidenceDir, { recursive: true });
const evidence: Evidence = {
  sourceRevision,
  stack,
  seed: { path: '.temp/cross-media-seed/result.json', workCount: 0, showcaseBoardRealmId: null },
  personas: ['anonymous', 'ordinary-member', 'realm-member'],
  sequence: [],
  native: [],
  pages: [],
  defects: [],
};

if (!process.env.GOAL_TASK_ID || !/native|browser/.test(process.env.GOAL_ACCEPTANCE_REQUIRES ?? ''))
  throw new Error('This walk runs on a controller-owned walk stack with native and browser acceptance');

await run(['bun', 'services/auth/scripts/dev-stack.ts', 'persona']);
evidence.sequence.push('persona');
const seedEnv = {
  ...process.env,
  ...(await parseEnv(join(root, '.temp/local-stack/seed.env'))),
  AUTH_ORIGIN: stack.issuer,
  KERNEL_ORIGIN: stack.kernel,
};
const seedCode = await run(['bun', 'scripts/datasets/cross-media-seed.ts', '--dev'], {
  allowFailure: true,
  env: seedEnv,
});
const seedPath = join(root, '.temp/cross-media-seed/result.json');
const seed = JSON.parse(await readFile(seedPath, 'utf8')) as Json;
const community = (seed.developmentShowcase as Json | undefined)?.community as Json | undefined;
const showcaseBoard = community?.board as Json | undefined;
evidence.seed.showcaseBoardRealmId =
  showcaseBoard && typeof showcaseBoard.realmId === 'string' ? showcaseBoard.realmId : null;
const works = selectedWorks(seed);
evidence.seed.workCount = works.length;
evidence.native.push({
  seedExit: seedCode,
  showcaseBoardRealmId: evidence.seed.showcaseBoardRealmId,
  works: works.map((work) => ({ source: work.source, externalId: work.externalId })),
});

const bearer = await websiteToken(stack);
let created: Omit<Identities, 'discoveryListed'>;
if (evidence.seed.showcaseBoardRealmId && uuid.test(evidence.seed.showcaseBoardRealmId)) {
  const realmId = evidence.seed.showcaseBoardRealmId;
  const current = requireOk(await kernel(stack, 'GET', `/v1/realms/${realmId}`), 'seeded realm').realm as Json;
  created = {
    realmId,
    spaceId: asId(current.spaceId, 'seeded space'),
    boardId: asId(showcaseBoard?.id, 'seeded board'),
    threadId: asId((community?.thread as Json | undefined)?.threadId ?? (community?.thread as Json | undefined)?.id, 'seeded thread'),
    works,
  };
} else {
  created = await provisionRealm(stack, bearer, works);
}

const home = await waitForHome(stack, created.realmId);
const boards = await kernel(stack, 'GET', `/v1/realms/${created.realmId}/boardShelf`);
const publications = await kernel(stack, 'GET', `/v1/realms/${created.realmId}/publicationShelf`, {
  query: { languages: 'en' },
});
evidence.native.push({
  home: { status: 200, boards: Array.isArray((home.boards as Json | undefined)?.items) ? ((home.boards as Json).items as unknown[]).length : 0 },
  boards: {
    status: boards.status,
    count: Array.isArray(boards.value.items) ? (boards.value.items as unknown[]).length : 0,
  },
  publications: {
    status: publications.status,
    count: Array.isArray(publications.value.items) ? (publications.value.items as unknown[]).length : 0,
  },
});
const discoveryListed = await waitForDiscovery(stack, created.realmId);
const identities: Identities = { ...created, discoveryListed };
evidence.native.push({
  identities: {
    realmId: identities.realmId,
    spaceId: identities.spaceId,
    boardId: identities.boardId,
    threadId: identities.threadId,
    discoveryListed,
  },
});
await writeFile(join(evidenceDir, 'identities.json'), `${JSON.stringify(identities, null, 2)}\n`);
evidence.pages.push(...(await localeLabels(stack, identities.realmId)));
await walkPersonas(stack, identities, evidence);
const members = await kernel(stack, 'GET', `/v1/realms/${identities.realmId}/members`, {
  bearer,
  query: { limit: '20' },
});
evidence.native.push({ members: { status: members.status, ...(publicFields(members.value) as Json) } });
if (members.status !== 200) evidence.defects.push(`member list readback HTTP ${members.status}`);
const memberItems = Array.isArray(members.value.items) ? (members.value.items as unknown[]) : [];
if (memberItems.length < 1) evidence.defects.push('member list readback has no joined member');
await writeFile(join(evidenceDir, 'passing.json'), `${JSON.stringify(evidence, null, 2)}\n`);
if (evidence.defects.length) throw new Error(evidence.defects.join('; '));
console.log(
  `vn-realm-walk: realm=${identities.realmId} discovery=${discoveryListed} works=${works.length} sequence=${evidence.sequence.join(',')}`,
);
