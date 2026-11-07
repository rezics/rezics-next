#!/usr/bin/env bun
/**
 * First-public Semantic catalogue and Zone walk. Run under `dev-stack.ts walk`.
 * Provisions the developer persona, loads seed.env, seeds, starts Auth pages and Web, then executes
 * every row in docs/goals/semantic.capabilities.md with native writes, independent readback and mounted pages.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startSeededFrontends } from '../../../services/auth/scripts/dev-stack.ts';
import {
  FIRST_PUBLIC_JOURNEYS,
  type FirstPublicJourneyId,
} from '../../../services/kernel/test/semantic/first-public-inventory.ts';
import {
  acceptCandidate,
  adoptCandidate,
  cited,
  citedDocument,
  citedQuantity,
  createContext,
  createStaticZone,
  createSubject,
  deleteCandidate,
  deleteZone,
  discloseStatement,
  MINUTE,
  patchTerms,
  propose,
  publishZone,
  readSubject,
  readZonePage,
  requireId,
  requireStatus,
  restoreCandidate,
  restoreZone,
  retractStatement,
  saveZoneConfiguration,
  searchType,
  subjectHref,
  takedownZone,
  type Json,
  type KernelCall,
} from '../../../services/kernel/test/semantic/first-public-native.ts';

const root = resolve(import.meta.dir, '../../..');
const evidenceDir = join(root, '.temp/semantic-first-public-walk');
const token = randomUUID().slice(0, 8);

type Stack = { web: string; issuer: string; kernel: string };
type Result = {
  id: FirstPublicJourneyId;
  name: string;
  status: 'Passing' | 'Failing';
  ms: number;
  persona: string;
  native?: unknown;
  browser?: unknown;
  failure?: { transition: string; expected: string; actual: string; owner: string };
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
  if (code !== 0) throw new Error(`${name} exited ${code}; see .temp/semantic-first-public-walk/${name}.log`);
}

async function parseEnv(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const match = /^(?<name>[A-Z0-9_]+)=(?<value>.*)$/.exec(line);
    if (match?.groups) values[match.groups.name!] = match.groups.value!.replace(/^'(.*)'$/, '$1');
  }
  return values;
}

function fetchCall(stack: Stack): KernelCall {
  return async (method, path, options = {}) => {
    const url = new URL(path, stack.kernel);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(60_000),
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(randomUUID()) }),
        ...(options.ifMatch ? { 'if-match': `"${options.ifMatch}"` } : {}),
        ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
        'accept-language': 'en',
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    const etag = response.headers.get('etag') ?? undefined;
    return {
      status: response.status,
      headers: response.headers,
      body: text ? (JSON.parse(text) as Json) : {},
      ...(etag === undefined ? {} : { etag }),
    };
  };
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
  const issued = await fetch(`${stack.issuer}/token`, {
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
  if (!issued.ok) throw new Error(`token for ${email} failed: HTTP ${issued.status}`);
  const body = (await issued.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`token for ${email} omitted access_token`);
  return body.access_token;
}

async function hydrated(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 180_000 });
}

async function openPage(
  context: BrowserContext,
  href: string,
  viewport: { width: number; height: number },
  theme: 'light' | 'dark',
): Promise<{ page: Page; status: number; url: string }> {
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: theme });
  const response = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await hydrated(page);
  await page
    .locator('main')
    .waitFor({ state: 'visible', timeout: 120_000 })
    .catch(() => undefined);
  return { page, status: response?.status() ?? 0, url: page.url() };
}

function ownerOf(error: string): string {
  if (/playwright|hydrat|locator|main|document/i.test(error)) return 'web';
  if (/search|opensearch|index/i.test(error)) return 'search';
  if (/document|licence|authored/i.test(error)) return 'content';
  if (/import|provider/i.test(error)) return 'imports';
  if (/auth|401|invalid_credentials|suspended/i.test(error)) return 'accounts';
  return 'semantic';
}

function fail(transition: string, expected: string, actual: string, owner = ownerOf(actual)) {
  return { transition, expected, actual: actual.slice(0, 800), owner };
}

type Session = {
  stack: Stack;
  call: KernelCall;
  editor: string;
  outsider?: string;
  anonymous: BrowserContext;
  member: BrowserContext;
  revision: string;
};

async function visit(
  session: Session,
  href: string,
  options: { width?: number; theme?: 'light' | 'dark'; persona?: 'anonymous' | 'member' } = {},
) {
  const context = options.persona === 'member' ? session.member : session.anonymous;
  const opened = await openPage(context, href, { width: options.width ?? 1280, height: 900 }, options.theme ?? 'light');
  const title = await opened.page.title();
  const heading = await opened.page
    .locator('h1, h2')
    .first()
    .textContent()
    .catch(() => null);
  await opened.page.close();
  if (opened.status >= 500) throw new Error(`${href} returned HTTP ${opened.status}`);
  return { url: opened.url, status: opened.status, title, heading };
}

async function journey(
  session: Session,
  id: FirstPublicJourneyId,
  run: () => Promise<{ native?: unknown; browser?: unknown; persona?: string }>,
): Promise<Result> {
  const meta = FIRST_PUBLIC_JOURNEYS.find((row) => row.id === id)!;
  const started = Date.now();
  try {
    const observed = await run();
    return {
      id,
      name: meta.name,
      status: 'Passing',
      ms: Date.now() - started,
      persona: observed.persona ?? 'editor+anonymous',
      native: observed.native,
      browser: observed.browser,
    };
  } catch (error) {
    const actual = error instanceof Error ? error.message : String(error);
    return {
      id,
      name: meta.name,
      status: 'Failing',
      ms: Date.now() - started,
      persona: 'editor+anonymous',
      failure: fail(id, meta.native, actual),
    };
  }
}

async function releasedDefinitions(session: Session): Promise<{ native: unknown; browser: unknown }> {
  const active = await session.call('GET', '/v1/definitions/active');
  requireStatus(active, 200, 'active definitions');
  const digest = String(active.body.digest);
  const release = await session.call('GET', `/v1/definitions/releases/${encodeURIComponent(digest)}`);
  requireStatus(release, 200, 'release');
  const book = (
    release.body.release as { types: Record<string, { labels: Record<string, string>; properties: string[] }> }
  ).types['schema:Book'];
  if (!book?.properties.includes('schema:author')) throw new Error('schema:Book omitted schema:author');
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    if (!book.labels[locale]) throw new Error(`schema:Book omitted ${locale} label`);
  }
  const types = await session.call('GET', '/v1/definitionTypes', { query: { typeId: 'schema:Book', locale: 'en' } });
  const browser = [];
  for (const locale of ['en', 'zh-Hant', 'ja'] as const) {
    const width = locale === 'ja' ? 390 : 1280;
    const theme = locale === 'zh-Hant' ? 'dark' : 'light';
    browser.push(
      await visit(
        session,
        `${session.stack.web}/${locale}/catalogue/definitions?type=${encodeURIComponent('schema:Book')}`,
        {
          width,
          theme,
        },
      ),
    );
  }
  return { native: { digest, typeStatus: types.status, author: true }, browser };
}

async function createAndRead(
  session: Session,
  type: string,
  label: string,
  pagePath: string,
  statements?: Record<string, unknown[]>,
) {
  const created = await createSubject(session.call, session.editor, type, label, statements);
  const publicRead = await readSubject(session.call, created.id);
  requireStatus(publicRead, 200, `anonymous ${type}`);
  if ((publicRead.body.subject as { type: string }).type !== type) throw new Error(`${type} public type mismatch`);
  const browser = await visit(session, `${session.stack.web}${pagePath}`, {
    width: type.endsWith('Recipe') || type.includes('Q95074') ? 390 : 1280,
    theme: type.includes('VideoGame') ? 'dark' : 'light',
    persona: 'member',
  });
  const reader = await visit(session, `${session.stack.web}${subjectHref(created.id, label)}`, { width: 1440 });
  return { native: { id: created.id, type, public: publicRead.status }, browser: { create: browser, reader } };
}

async function main() {
  const stack = stackOrigins();
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const revision = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
  await child(['bun', 'services/auth/scripts/dev-stack.ts', 'persona'], 'persona');
  const seedEnv = { ...process.env, ...(await parseEnv(join(root, '.temp/local-stack/seed.env'))) };
  await child(['bun', 'scripts/datasets/cross-media-seed.ts', '--dev'], 'seed', seedEnv);
  const frontends = await startSeededFrontends();
  const keys = JSON.parse(await readFile(join(root, '.temp/local-stack/keys.json'), 'utf8')) as { password: string };
  const editor = await accessToken(stack, 'developer@rezics.test', keys.password);
  const call = fetchCall(stack);
  await mkdir('/tmp/rw', { recursive: true, mode: 0o700 });
  const browser: Browser = await chromium.launch({ headless: true, env: { ...process.env, TMPDIR: '/tmp/rw' } });
  const anonymous = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const member = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const results: Result[] = [];
  const session: Session = { stack, call, editor, anonymous, member, revision };
  try {
    const signIn = await member.newPage();
    await signIn.goto(`${stack.web}/en/auth/sign-in?return_to=${encodeURIComponent('/en/catalogue/new')}`, {
      waitUntil: 'domcontentloaded',
      timeout: 180_000,
    });
    for (let attempt = 0; attempt < 4 && new URL(signIn.url()).origin === stack.issuer; attempt++) {
      await hydrated(signIn);
      const email = signIn.locator('input[type="email"]');
      if (await email.count()) {
        await email.fill('developer@rezics.test');
        await signIn.locator('input[type="password"]').fill(keys.password);
      }
      await signIn.locator('form button[type="submit"]').first().click();
      await signIn.waitForLoadState('domcontentloaded');
    }
    await signIn.close();

    results.push(await journey(session, 'released-definitions', () => releasedDefinitions(session)));
    results.push(
      await journey(session, 'catalogue-browsing', async () => {
        const searched = await searchType(call, 'schema:Book', 8);
        if (searched.status !== 200)
          throw new Error(`catalogue search HTTP ${searched.status}: ${JSON.stringify(searched.body).slice(0, 400)}`);
        const subjects = (searched.body.subjects as { id?: string; labels?: Record<string, string> }[]) ?? [];
        if (subjects.length === 0) throw new Error('catalogue search returned no Books');
        const first = subjects[0]!;
        const id = requireId(first.id, 'catalogue Book');
        const publicRead = await readSubject(call, id);
        requireStatus(publicRead, 200, 'catalogue Book');
        const label = (publicRead.body.subject as { labels?: Record<string, string> }).labels?.en ?? 'book';
        const profile = await visit(session, `${stack.web}/en/catalogue/literary`, { width: 1280 });
        const reader = await visit(session, `${stack.web}${subjectHref(id, label)}`, { width: 390, theme: 'dark' });
        return { native: { id, count: subjects.length }, browser: { profile, reader } };
      }),
    );
    results.push(
      await journey(session, 'generic-creation', () =>
        createAndRead(session, 'schema:Book', `Walk book ${token}`, '/en/catalogue/new'),
      ),
    );
    results.push(
      await journey(session, 'book-and-series-editing', async () => {
        const series = await createSubject(call, editor, 'schema:BookSeries', `Walk series ${token}`);
        const book = await createSubject(call, editor, 'schema:Book', `Walk literary ${token}`);
        const proposal = await propose(call, editor, book.id, cited('wdt:P179', series.id));
        const browser = await visit(session, `${stack.web}/en/catalogue/literary`, { persona: 'member' });
        const reader = await visit(session, `${stack.web}${subjectHref(book.id, `Walk literary ${token}`)}`);
        return {
          native: { book: book.id, series: series.id, candidate: proposal.candidate },
          browser: { browser, reader },
        };
      }),
    );
    results.push(
      await journey(session, 'recipe-editing', async () => {
        const recipe = await createSubject(call, editor, 'schema:Recipe', `Walk recipe ${token}`);
        const time = await propose(call, editor, recipe.id, citedQuantity('schema:cookTime', '+25', MINUTE));
        requireStatus(await readSubject(call, recipe.id), 200, 'recipe');
        return {
          native: { id: recipe.id, cookTime: time.candidate },
          browser: {
            create: await visit(session, `${stack.web}/en/catalogue/recipe`, { persona: 'member' }),
            reader: await visit(session, `${stack.web}${subjectHref(recipe.id, `Walk recipe ${token}`)}`),
          },
        };
      }),
    );
    results.push(
      await journey(session, 'game-and-visual-novel-editing', async () => {
        const game = await createSubject(call, editor, 'schema:VideoGame', `Walk game ${token}`);
        const vn = await createSubject(call, editor, 'wd:Q689445', `Walk vn ${token}`);
        if (game.id === vn.id) throw new Error('game and visual novel shared an identity');
        return {
          native: { game: game.id, vn: vn.id },
          browser: await visit(session, `${stack.web}/en/catalogue/game`, { theme: 'dark', persona: 'member' }),
        };
      }),
    );
    results.push(
      await journey(session, 'addon-editing', async () => {
        const base = await createSubject(call, editor, 'schema:VideoGame', `Walk base ${token}`);
        const addon = await createSubject(call, editor, 'wd:Q209163', `Walk addon ${token}`);
        const link = await propose(call, editor, addon.id, cited('wdt:P8646', base.id));
        return {
          native: { base: base.id, addon: addon.id, candidate: link.candidate },
          browser: await visit(session, `${stack.web}/en/catalogue/addon?work=${base.id}`, { persona: 'member' }),
        };
      }),
    );
    results.push(
      await journey(session, 'manga-editing', () =>
        createAndRead(session, 'schema:ComicSeries', `Walk manga ${token}`, '/en/catalogue/manga'),
      ),
    );
    results.push(
      await journey(session, 'screen-editing', () =>
        createAndRead(session, 'schema:Movie', `Walk film ${token}`, '/en/catalogue/screen'),
      ),
    );
    results.push(
      await journey(session, 'album-editing', () =>
        createAndRead(session, 'schema:MusicAlbum', `Walk album ${token}`, '/en/catalogue/album'),
      ),
    );
    results.push(
      await journey(session, 'publication-editing', async () => {
        const work = await createSubject(call, editor, 'schema:Book', `Walk publication work ${token}`);
        const edition = await createSubject(call, editor, 'bf:Instance', `Walk publication ${token}`);
        const workLink = await propose(call, editor, edition.id, cited('schema:exampleOfWork', work.id));
        return {
          native: { work: work.id, edition: edition.id, candidate: workLink.candidate },
          browser: await visit(session, `${stack.web}/en/catalogue/publication?work=${work.id}`, { persona: 'member' }),
        };
      }),
    );
    results.push(
      await journey(session, 'music-context-editing', () =>
        createAndRead(session, 'schema:MusicVenue', `Walk venue ${token}`, '/en/catalogue/music-context'),
      ),
    );
    results.push(
      await journey(session, 'file-and-release-group-editing', async () => {
        const file = await createSubject(call, editor, 'schema:MediaObject', `Walk file ${token}`);
        const group = await createSubject(call, editor, 'rezics:ReleaseGroup', `Walk group ${token}`);
        return {
          native: { file: file.id, group: group.id },
          browser: await visit(session, `${stack.web}/en/catalogue/file`, { persona: 'member' }),
        };
      }),
    );
    results.push(
      await journey(session, 'work-part-editing', async () => {
        const work = await createSubject(call, editor, 'schema:Book', `Walk arc work ${token}`);
        const arc = await createSubject(call, editor, 'wd:Q2620972', `Walk arc ${token}`);
        const proposal = await propose(call, editor, work.id, cited('rezics:storyArc', arc.id));
        return {
          native: { work: work.id, arc: arc.id, candidate: proposal.candidate },
          browser: await visit(
            session,
            `${stack.web}${subjectHref(work.id, `Walk arc work ${token}`, 'en', 'work-parts')}`,
            {
              persona: 'member',
            },
          ),
        };
      }),
    );
    results.push(
      await journey(session, 'character-identity-and-credit', async () => {
        const work = await createSubject(call, editor, 'wd:Q689445', `Walk character work ${token}`);
        const character = await createSubject(call, editor, 'wd:Q95074', `Walk character ${token}`);
        const credit = await propose(call, editor, work.id, cited('schema:character', character.id));
        return {
          native: { work: work.id, character: character.id, candidate: credit.candidate },
          browser: await visit(session, `${stack.web}/en/catalogue/character?work=${work.id}`, { persona: 'member' }),
        };
      }),
    );
    results.push(
      await journey(session, 'person-and-organization-editing', async () => {
        const person = await createSubject(call, editor, 'schema:Person', `Walk person ${token}`);
        const org = await createSubject(call, editor, 'schema:Organization', `Walk org ${token}`);
        return {
          native: { person: person.id, org: org.id },
          browser: await visit(session, `${stack.web}/en/catalogue/people`, { persona: 'member' }),
        };
      }),
    );
    results.push(
      await journey(session, 'concept-and-scheme-editing', async () => {
        const scheme = await createSubject(call, editor, 'skos:ConceptScheme', `Walk scheme ${token}`);
        const concept = await createSubject(call, editor, 'skos:Concept', `Walk concept ${token}`);
        const membership = await propose(call, editor, concept.id, cited('skos:inScheme', scheme.id));
        return {
          native: { scheme: scheme.id, concept: concept.id, candidate: membership.candidate },
          browser: await visit(session, `${stack.web}/en/catalogue/concept`, { persona: 'member' }),
        };
      }),
    );

    const termsBook = await createSubject(call, editor, 'schema:Book', `Walk terms ${token}`);
    results.push(
      await journey(session, 'multilingual-terms', async () => {
        await patchTerms(call, editor, termsBook.id, termsBook.revision, {
          labels: { en: `Walk terms renamed ${token}`, 'zh-Hant': '術語書籍' },
          descriptions: { en: 'Walk description', ja: '説明' },
        });
        const current = await readSubject(call, termsBook.id);
        requireStatus(current, 200, 'terms readback');
        if ((current.body.subject as { labels: Record<string, string> }).labels['zh-Hant'] !== '術語書籍')
          throw new Error('zh-Hant label missing after terms patch');
        return {
          native: { id: termsBook.id },
          browser: await visit(
            session,
            `${stack.web}${subjectHref(termsBook.id, `Walk terms renamed ${token}`, 'en', 'terms')}`,
            { persona: 'member' },
          ),
        };
      }),
    );
    results.push(
      await journey(session, 'cited-fact-correction', async () => {
        const proposal = await propose(call, editor, termsBook.id, cited('schema:inLanguage', 'ja'));
        const current = await readSubject(call, termsBook.id);
        requireStatus(current, 200, 'fact public read');
        return {
          native: { candidate: proposal.candidate, public: current.status },
          browser: await visit(
            session,
            `${stack.web}${subjectHref(termsBook.id, `Walk terms renamed ${token}`, 'en', 'edit')}`,
            { persona: 'member' },
          ),
        };
      }),
    );
    results.push(
      await journey(session, 'original-authored-text', async () => {
        const proposal = await propose(
          call,
          editor,
          termsBook.id,
          citedDocument('schema:abstract', `Walk abstract ${token}`),
        );
        const publicRead = await readSubject(call, termsBook.id);
        requireStatus(publicRead, 200, 'authored public');
        const selected = (publicRead.body.subject as { statements?: Record<string, { id: string }[]> }).statements?.[
          'schema:abstract'
        ];
        if (selected?.some((row) => row.id === proposal.candidate))
          throw new Error('proposal was selected as public text');
        return {
          native: { candidate: proposal.candidate, publicSelected: selected?.[0]?.id ?? null },
          browser: await visit(
            session,
            `${stack.web}${subjectHref(termsBook.id, `Walk terms renamed ${token}`, 'en', 'authored')}`,
            { persona: 'member' },
          ),
        };
      }),
    );
    results.push(
      await journey(session, 'relationship-correction', async () => {
        const author = await createSubject(call, editor, 'schema:Person', `Walk author ${token}`);
        const proposal = await propose(call, editor, termsBook.id, cited('schema:author', author.id));
        return {
          native: { author: author.id, candidate: proposal.candidate },
          browser: await visit(
            session,
            `${stack.web}${subjectHref(termsBook.id, `Walk terms renamed ${token}`, 'en', 'relations')}`,
            { persona: 'member' },
          ),
        };
      }),
    );
    results.push(
      await journey(session, 'missing-related-work', async () => {
        const related = await createSubject(call, editor, 'schema:BookSeries', `Walk missing series ${token}`);
        const proposal = await propose(call, editor, termsBook.id, cited('wdt:P179', related.id));
        requireStatus(await readSubject(call, related.id), 200, 'created related identity');
        return {
          native: { related: related.id, candidate: proposal.candidate },
          browser: await visit(session, `${stack.web}/en/catalogue/new`, { persona: 'member' }),
        };
      }),
    );
    results.push(
      await journey(session, 'identifier-evidence', async () => {
        const proposal = await propose(
          call,
          editor,
          termsBook.id,
          cited('schema:sameAs', `https://example.test/isbn/${token}`),
        );
        const publicRead = await readSubject(call, termsBook.id);
        requireStatus(publicRead, 200, 'identifier public');
        return {
          native: { candidate: proposal.candidate },
          browser: await visit(
            session,
            `${stack.web}${subjectHref(termsBook.id, `Walk terms renamed ${token}`, 'en', 'identifiers')}`,
            { persona: 'member' },
          ),
        };
      }),
    );
    results.push(
      await journey(session, 'why-this-value-and-history', async () => {
        const value = await visit(
          session,
          `${stack.web}${subjectHref(termsBook.id, `Walk terms renamed ${token}`, 'en', 'value')}`,
        );
        const changes = await visit(
          session,
          `${stack.web}${subjectHref(termsBook.id, `Walk terms renamed ${token}`, 'en', 'changes')}`,
        );
        const sources = await visit(
          session,
          `${stack.web}${subjectHref(termsBook.id, `Walk terms renamed ${token}`, 'en', 'sources')}`,
        );
        return { native: { id: termsBook.id }, browser: { value, changes, sources } };
      }),
    );
    results.push(
      await journey(session, 'context-creation', async () => {
        const context = await createContext(call, editor, `Walk Context ${token}`);
        const current = await call('GET', `/v1/contexts/${context.id}`, { bearer: editor });
        requireStatus(current, 200, 'Context read');
        return {
          native: { id: context.id, defaults: (current.body.context as Json).defaults },
          browser: await visit(session, `${stack.web}/en/my/contexts/new`, { persona: 'member' }),
        };
      }),
    );
    results.push(
      await journey(session, 'context-editorial-decisions', async () => {
        const proposal = await propose(call, editor, termsBook.id, cited('schema:inLanguage', 'zh'));
        await acceptCandidate(call, editor, termsBook.id, proposal.candidate);
        await adoptCandidate(call, editor, termsBook.id, proposal.candidate, 'schema:inLanguage');
        const publicRead = await readSubject(call, termsBook.id);
        requireStatus(publicRead, 200, 'adopted language');
        return {
          native: { candidate: proposal.candidate },
          browser: await visit(
            session,
            `${stack.web}${subjectHref(termsBook.id, `Walk terms renamed ${token}`, 'en', 'context-review')}`,
            { persona: 'member' },
          ),
        };
      }),
    );
    results.push(
      await journey(session, 'statement-consent', async () => {
        const person = await createSubject(call, editor, 'schema:Person', `Walk consent person ${token}`);
        const proposal = await propose(call, editor, termsBook.id, cited('schema:author', person.id));
        const disclosed = await discloseStatement(call, editor, proposal.candidate);
        const retracted = await retractStatement(call, editor, proposal.candidate);
        if (![200, 400, 403, 404, 409].includes(disclosed.status))
          throw new Error(`disclose HTTP ${disclosed.status}: ${JSON.stringify(disclosed.body).slice(0, 400)}`);
        return {
          native: { candidate: proposal.candidate, disclose: disclosed.status, retract: retracted.status },
          browser: await visit(
            session,
            `${stack.web}${subjectHref(termsBook.id, `Walk terms renamed ${token}`, 'en', 'statement-consent')}?property=${encodeURIComponent('schema:author')}&candidate=${proposal.candidate}`,
            { persona: 'member' },
          ),
        };
      }),
    );
    results.push(
      await journey(session, 'subject-lifecycle', async () => {
        const owned = await createSubject(call, editor, 'schema:Book', `Walk lifecycle ${token}`);
        const proposal = await propose(call, editor, owned.id, cited('schema:inLanguage', 'fr'));
        await acceptCandidate(call, editor, owned.id, proposal.candidate);
        await adoptCandidate(call, editor, owned.id, proposal.candidate, 'schema:inLanguage');
        await deleteCandidate(call, editor, owned.id, proposal.candidate);
        const hidden = await readSubject(call, owned.id);
        requireStatus(hidden, 200, 'deleted public');
        await restoreCandidate(call, editor, owned.id, proposal.candidate);
        requireStatus(await readSubject(call, owned.id, editor), 200, 'restored owner');
        return {
          native: { id: owned.id, candidate: proposal.candidate },
          browser: await visit(session, `${stack.web}${subjectHref(owned.id, `Walk lifecycle ${token}`)}`),
        };
      }),
    );

    const zoneLabel = `Walk zone ${token}`;
    const zoneHome = `Walk zone home ${token}`;
    const zoneAbout = `Walk zone about ${token}`;
    let zoneId = '';
    let zoneRevision = '';
    results.push(
      await journey(session, 'zone-creation-and-configuration', async () => {
        const zone = await createStaticZone(call, editor, zoneLabel, zoneHome, zoneAbout);
        zoneId = zone.id;
        zoneRevision = await saveZoneConfiguration(call, editor, zone.id, zone.revision, zone.configuration);
        const preview = await call('GET', `/v1/zones/${zone.id}/configuration`, { bearer: editor });
        requireStatus(preview, 200, 'saved configuration');
        return {
          native: { id: zone.id, revision: zoneRevision },
          browser: {
            create: await visit(session, `${stack.web}/en/my/zones/new`, { persona: 'member' }),
            edit: await visit(session, `${stack.web}/en/my/zones/${zone.id}/edit`, { persona: 'member' }),
          },
        };
      }),
    );
    results.push(
      await journey(session, 'zone-publication-and-navigation', async () => {
        if (!zoneId) throw new Error('Zone creation did not return an id');
        zoneRevision = await publishZone(call, editor, zoneId, zoneRevision);
        const home = await readZonePage(call, zoneId, '');
        requireStatus(home, 200, 'anonymous zone home');
        const about = await readZonePage(call, zoneId, 'about');
        requireStatus(about, 200, 'anonymous zone about');
        const homePage = await visit(session, `${stack.web}/en/zones/${zoneId}`, { width: 1280 });
        const aboutPage = await visit(session, `${stack.web}/en/zones/${zoneId}/about`, { width: 390, theme: 'dark' });
        const jaHome = await visit(session, `${stack.web}/ja/zones/${zoneId}`);
        return {
          native: { id: zoneId, home: home.status, about: about.status },
          browser: { homePage, aboutPage, jaHome },
        };
      }),
    );
    results.push(
      await journey(session, 'zone-lifecycle-and-moderation', async () => {
        if (!zoneId) throw new Error('Zone creation did not return an id');
        const deleted = await deleteZone(call, editor, zoneId, zoneRevision);
        requireStatus(deleted, 200, 'delete Zone');
        const missing = await readZonePage(call, zoneId, '');
        if (missing.status !== 404) throw new Error(`deleted Zone read HTTP ${missing.status}`);
        const unavailable = await visit(session, `${stack.web}/en/zones/${zoneId}`);
        const restored = await restoreZone(
          call,
          editor,
          zoneId,
          String((deleted.body.zone as { revision: string }).revision),
        );
        requireStatus(restored, 200, 'restore Zone');
        requireStatus(await readZonePage(call, zoneId, ''), 200, 'restored anonymous home');
        const withheld = await takedownZone(
          call,
          editor,
          zoneId,
          String((restored.body.zone as { revision: string }).revision),
          '/labels/en',
        );
        if (![200, 403].includes(withheld.status))
          throw new Error(`takedown HTTP ${withheld.status}: ${JSON.stringify(withheld.body).slice(0, 400)}`);
        return {
          native: { delete: deleted.status, restore: restored.status, takedown: withheld.status },
          browser: { unavailable, restored: await visit(session, `${stack.web}/en/zones/${zoneId}`) },
        };
      }),
    );
  } finally {
    await browser.close();
    await frontends.stop();
  }

  const passing = results.filter((row) => row.status === 'Passing');
  const failing = results.filter((row) => row.status === 'Failing').sort((a, b) => b.ms - a.ms);
  const slowest = failing[0];
  const summary = {
    revision,
    utc: new Date().toISOString(),
    stack,
    passing: passing.length,
    total: FIRST_PUBLIC_JOURNEYS.length,
    slowestFailing: slowest
      ? { id: slowest.id, ms: slowest.ms, owner: slowest.failure?.owner, detail: slowest.failure }
      : null,
    results,
  };
  await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `semantic first-public ${passing.length}/${FIRST_PUBLIC_JOURNEYS.length}; slowest failing: ${
      slowest ? `${slowest.name} (${slowest.failure?.owner})` : 'none'
    }`,
  );
  if (results.length !== FIRST_PUBLIC_JOURNEYS.length) {
    throw new Error(`walk recorded ${results.length} rows, expected ${FIRST_PUBLIC_JOURNEYS.length}`);
  }
  if (failing.length) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(evidenceDir, 'setup-failure.json'),
    `${JSON.stringify({ utc: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
