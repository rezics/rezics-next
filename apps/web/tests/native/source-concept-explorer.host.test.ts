import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { expect as ui } from 'playwright/test';
import type { Page } from 'playwright';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  buildSearchImage,
  cgroupArgs,
  subjectAutoCreateIndexSetting,
  waitForSearch,
} from '../../../../services/kernel/scripts/search.ts';
import { catalogueEntries } from '../../src/features/catalogue/catalogue-entry.ts';
import { subjectHref } from '../../src/subject/subject-href.ts';
import {
  startCatalogueClassificationFixture,
  type NativeClassificationFixture,
} from './catalogue-classification-fixture.ts';
import { nativeSiteLocales } from './native-site-foundation-fixture.ts';

setDefaultTimeout(900_000);

let fixture: NativeClassificationFixture;
let ownedSearch: string | undefined;
let priorSearchUrl: string | undefined;

function docker(args: string[]): string {
  const result = Bun.spawnSync(['docker', ...args]);
  if (result.exitCode !== 0) throw new Error(`Owned search setup failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function publishedLoopbackSearchUrl(container: string): string | undefined {
  const published = docker(['port', container, '9200/tcp']);
  const port = published.match(/127\.0\.0\.1:(\d+)/)?.[1] ?? published.match(/0\.0\.0\.0:(\d+)/)?.[1];
  return port ? `http://127.0.0.1:${port}` : undefined;
}

async function waitForPublishedSearch(container: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no mapping';
  while (Date.now() < deadline) {
    try {
      const url = publishedLoopbackSearchUrl(container);
      if (url) return url;
      last = docker(['port', container, '9200/tcp']);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  throw new Error(`Owned search has no 127.0.0.1 mapping within ${timeoutMs} ms (${last}).`);
}

beforeAll(async () => {
  priorSearchUrl = process.env.OPENSEARCH_URL;
  if (!priorSearchUrl) {
    ownedSearch = `concept-works-search-${crypto.randomUUID().slice(0, 12)}`;
    docker([
      'run',
      '-d',
      ...cgroupArgs(),
      '--name',
      ownedSearch,
      '-p',
      '127.0.0.1::9200',
      '--tmpfs',
      '/usr/share/opensearch/data:rw,size=1g,uid=1000,gid=1000,mode=0755',
      '-e',
      'discovery.type=single-node',
      '-e',
      subjectAutoCreateIndexSetting,
      '-e',
      'DISABLE_SECURITY_PLUGIN=true',
      '-e',
      'DISABLE_INSTALL_DEMO_CONFIG=true',
      '-e',
      'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m',
      buildSearchImage(),
    ]);
    const url = await waitForPublishedSearch(ownedSearch);
    process.env.OPENSEARCH_URL = url;
    await waitForSearch(url, ownedSearch, 180_000);
  }
  fixture = await startCatalogueClassificationFixture();
}, 600_000);

afterAll(async () => {
  try {
    await fixture?.close();
  } finally {
    if (ownedSearch) docker(['rm', '-fv', ownedSearch]);
    if (priorSearchUrl === undefined) delete process.env.OPENSEARCH_URL;
    else process.env.OPENSEARCH_URL = priorSearchUrl;
  }
}, 180_000);

function statement(property: string, dataType: string, content: string) {
  return {
    property: { id: property, data_type: dataType },
    value: { type: 'value', content },
    qualifiers: [],
    references: [],
    rank: 'normal',
  };
}

async function createSourceSubject(
  type: string,
  label: string,
  statements: Record<string, ReturnType<typeof statement>[]> = {},
) {
  const response = await fixture.stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
      body: JSON.stringify({ type, labels: { en: label }, ...(Object.keys(statements).length ? { statements } : {}) }),
    },
    'editor',
  );
  const text = await response.text();
  expect(response.status).toBe(201);
  return (JSON.parse(text) as { subject: { id: string } }).subject.id;
}

async function hydrate(page: import('playwright').Page) {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

test('mounted source Concept visit reads native identity and hierarchy, recovers the exact cursor, and returns to its classification', async () => {
  const marker = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const schemeLabel = `Native scheme ${marker}`;
  const parentLabel = `Native broader ${marker}`;
  const sourceLabel = `Native source concept ${marker}`;
  const scheme = await createSourceSubject('skos:ConceptScheme', schemeLabel);
  const membership = { 'skos:inScheme': [statement('skos:inScheme', 'wikibase-item', scheme)] };
  const parent = await createSourceSubject('skos:Concept', parentLabel, membership);
  const source = await createSourceSubject('skos:Concept', sourceLabel, {
    ...membership,
    'skos:broader': [statement('skos:broader', 'wikibase-item', parent)],
    'wdt:P3180': [statement('wdt:P3180', 'external-id', `v${100000 + Math.floor(Math.random() * 800000)}`)],
  });
  const children: string[] = [];
  for (let index = 0; index < 21; index++) {
    children.push(
      await createSourceSubject('skos:Concept', `Native narrower ${marker} ${index}`, {
        ...membership,
        'skos:broader': [statement('skos:broader', 'wikibase-item', source)],
      }),
    );
  }

  const sourceRead = await fixture.stack.kernel(`/v1/subjects/${source}`);
  expect(sourceRead.status).toBe(200);
  const native = (await sourceRead.json()) as {
    subject: { id: string; statements: Record<string, { id: string; value: { content: unknown } }[]> };
  };
  expect(native.subject.id).toBe(source);
  expect(native.subject.statements['skos:inScheme']?.[0]?.value.content).toBe(scheme);
  expect(native.subject.statements['skos:broader']?.[0]?.value.content).toBe(parent);
  expect(native.subject.statements['wdt:P3180']?.[0]?.value.content).toMatch(/^v[1-9][0-9]*$/);
  const linkRead = await fixture.stack.kernel(
    `/v1/subjects/${source}/links?property=skos:broader&limit=20&language=en`,
  );
  expect(linkRead.status).toBe(200);
  const nativeLinks = (await linkRead.json()) as {
    links: { subject: string; property: string; statement: string }[];
    next: string | null;
  };
  expect(nativeLinks.links).toHaveLength(20);
  expect(nativeLinks.links.every((row) => row.property === 'skos:broader')).toBe(true);
  expect(nativeLinks.links.every((row) => children.includes(row.subject) && row.statement)).toBe(true);
  expect(nativeLinks.next).toBeTruthy();

  const origin = catalogueEntries.graph({ id: fixture.manga.id, label: fixture.manga.label, locale: 'en' }).href;
  const path = catalogueEntries.concepts({ id: source, label: sourceLabel, locale: 'en' }).href;
  const address = `${path}?${new URLSearchParams({ returnTo: origin, pin: 'sha256:requested-historical-pin' })}`;
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  await fixture.stack.injectKernelFailureOnce({
    method: 'GET',
    path: `/v1/subjects/${source}/links`,
    status: 503,
    body: JSON.stringify({ title: 'Temporary links failure', status: 503, code: 'dependency_unavailable' }),
  });
  const opened = await page.goto(new URL(address, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
  expect(opened?.status()).toBe(200);
  await hydrate(page);
  await ui(page.getByText(source, { exact: false })).toBeVisible();
  await ui(page.getByText('A historical source pin was requested', { exact: false })).toBeVisible();
  await ui(page.getByRole('link', { name: 'Correct this fact', exact: true })).toBeVisible();
  const hierarchy = page.locator('section[aria-labelledby="concept-narrower-heading"]');
  await ui(hierarchy.getByRole('alert')).toBeVisible();
  await hierarchy.getByRole('button', { name: 'Retry this page', exact: true }).click();
  await ui(hierarchy.getByRole('link', { name: new RegExp(`Native narrower ${marker}`) }).first()).toBeVisible({
    timeout: 60_000,
  });
  await ui(hierarchy.getByRole('button', { name: 'More hierarchy', exact: true })).toBeEnabled();
  const firstPageLabels = await hierarchy
    .getByRole('link', { name: new RegExp(`Native narrower ${marker}`) })
    .allTextContents();

  await fixture.stack.injectKernelFailureOnce({
    method: 'GET',
    path: `/v1/subjects/${source}/links`,
    status: 503,
    body: JSON.stringify({ title: 'Temporary links failure', status: 503, code: 'dependency_unavailable' }),
  });
  await hierarchy.getByRole('button', { name: 'More hierarchy', exact: true }).click();
  await ui(hierarchy.getByRole('alert')).toBeVisible();
  expect(
    await hierarchy.getByRole('link', { name: new RegExp(`Native narrower ${marker}`) }).allTextContents(),
  ).toEqual(firstPageLabels);
  const linkRequests = () =>
    fixture.stack
      .kernelRequests()
      .filter(
        (request) =>
          request.method === 'GET' &&
          new URL(request.url, fixture.stack.kernelOrigin).pathname === `/v1/subjects/${source}/links`,
      )
      .map((request) => new URL(request.url, fixture.stack.kernelOrigin).searchParams.get('cursor'));
  const failedCursor = linkRequests().at(-1);
  expect(failedCursor).toBeTruthy();
  await hierarchy.getByRole('button', { name: 'Retry this page', exact: true }).click();
  expect(linkRequests().at(-1)).toBe(failedCursor);
  await ui(hierarchy.getByRole('button', { name: 'Previous page', exact: true })).toBeEnabled();
  await page.getByRole('link', { name: 'Return to the selected fact', exact: true }).click();
  expect(new URL(page.url()).pathname).toBe(new URL(origin, fixture.stack.web).pathname);
  await page.close();
});

const worksTitles: Record<(typeof nativeSiteLocales)[number], string> = {
  en: 'Works carrying this Concept',
  'zh-Hant': '帶有此概念的作品',
  'zh-Hans': '带有此概念的作品',
  ja: 'このConceptが付いた作品',
  ko: '이 Concept가 붙은 작품',
  de: 'Werke mit diesem Konzept',
  fr: 'Œuvres associées à ce concept',
  es: 'Obras que usan este concepto',
};

async function openSearch(stack: NativeClassificationFixture['stack']) {
  for (const group of ['search', 'search_advanced'] as const) {
    const opened = await stack.kernel(
      `/v1/platform/exposure/${group}:open`,
      { method: 'POST', headers: { 'idempotency-key': `"${crypto.randomUUID()}"` } },
      'governor',
    );
    expect(opened.status, `open ${group}`).toBe(200);
  }
}

async function waitForTaggedWorks(
  stack: NativeClassificationFixture['stack'],
  conceptId: string,
  schemeId: string,
  expected: number,
) {
  const { conceptWorksAdmission } = await import('../../src/features/catalogue/source-concept-explorer');
  const { conceptWorksRequest } = await import('../../src/features/catalogue/concept-works/index.ts');
  const admission = conceptWorksAdmission(bundledRelease, true);
  const request = conceptWorksRequest(
    { conceptId, property: 'schema:genre', scheme: schemeId, type: 'schema:Book' },
    admission,
    [{ id: schemeId, label: 'Scheme', lang: 'en', readable: true, conceptPage: true }],
    'en',
  );
  if (!request) throw new Error('Bundled release must admit Concept-tagged Book search');
  const until = Date.now() + 60_000;
  let last = '';
  while (Date.now() < until) {
    const response = await stack.kernel('/v1/subjects:search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const text = await response.text();
    last = `${response.status} ${text}`;
    if (response.status === 200) {
      const body = JSON.parse(text) as {
        subjects?: { id?: string }[];
        hits?: { key?: { id?: string } }[];
        next?: string | null;
      };
      const ids = [
        ...(body.subjects ?? []).map((row) => row.id),
        ...(body.hits ?? []).map((row) => row.key?.id),
      ].filter((id): id is string => !!id);
      if (ids.length >= Math.min(expected, 24) && (expected <= 24 || body.next))
        return { subjects: ids.map((id) => ({ id })), next: body.next ?? null };
    }
    await Bun.sleep(250);
  }
  throw new Error(`Native Concept works search did not project tagged Books: ${last}`);
}

test('anonymous and member walk a real Concept hierarchy to filtered native Works, recover the exact page, and return without mixing identities', async () => {
  const { parseConceptVisitDescriptor } = await import('../../src/features/pages/source-concept-reading/navigation.ts');
  await openSearch(fixture.stack);
  const marker = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const schemeLabel = `Works scheme ${marker}`;
  const parentLabel = `Works parent ${marker}`;
  const childLabel = `Works child ${marker}`;
  const scheme = await createSourceSubject('skos:ConceptScheme', schemeLabel);
  const membership = { 'skos:inScheme': [statement('skos:inScheme', 'wikibase-item', scheme)] };
  const parent = await createSourceSubject('skos:Concept', parentLabel, membership);
  const child = await createSourceSubject('skos:Concept', childLabel, {
    ...membership,
    'skos:broader': [statement('skos:broader', 'wikibase-item', parent)],
  });
  const books: { id: string; label: string }[] = [];
  for (let index = 0; index < 25; index++) {
    const label = `Tagged book ${marker} ${String(index).padStart(2, '0')}`;
    books.push({
      id: await createSourceSubject('schema:Book', label, {
        'schema:genre': [statement('schema:genre', 'wikibase-item', parent)],
      }),
      label,
    });
  }
  const mangaLabel = `Tagged manga ${marker}`;
  const manga = await createSourceSubject('schema:ComicSeries', mangaLabel, {
    'schema:genre': [statement('schema:genre', 'wikibase-item', parent)],
  });
  const childBookLabel = `Child tagged book ${marker}`;
  await createSourceSubject('schema:Book', childBookLabel, {
    'schema:genre': [statement('schema:genre', 'wikibase-item', child)],
  });
  const nativePage = await waitForTaggedWorks(fixture.stack, parent, scheme, 25);
  const originWork = books[0]!;
  const origin = subjectHref({ id: originWork.id, label: originWork.label }, 'en').href;
  const evidence = {
    sourceRevision: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: join(import.meta.dir, '../../../..') })
      .stdout.toString()
      .trim(),
    stack: 'native-isolated-web',
    personas: ['anonymous', 'member'],
    identities: { scheme, parent, child, manga, books: books.map((book) => book.id) },
    nativeSearch: { count: nativePage.subjects?.length ?? 0, next: nativePage.next ?? null },
    sequence: [] as string[],
    defects: [] as string[],
  };

  async function walk(page: Page, persona: 'anonymous' | 'member') {
    evidence.sequence.push(`${persona}:open-work-tag`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    const opened = await page.goto(new URL(origin, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
    expect(opened?.status()).toBe(200);
    await hydrate(page);
    const tags = page.locator('[data-slot="subject-concept-tags"]');
    await ui(tags.getByRole('link', { name: parentLabel, exact: true })).toBeVisible({ timeout: 60_000 });
    await tags.getByRole('link', { name: parentLabel, exact: true }).click();
    await page.waitForURL((url) => url.pathname.endsWith('/concepts') && url.pathname.includes(parent));
    await hydrate(page);
    expect(new URL(page.url()).pathname).toContain(`/${parent}/`);
    expect(new URL(page.url()).searchParams.get('role')).toBe('schema:genre');
    await ui(page.getByRole('heading', { name: parentLabel })).toBeVisible();
    const hierarchy = page.locator('section[aria-labelledby="concept-narrower-heading"]');
    await ui(hierarchy.getByRole('link', { name: childLabel, exact: true })).toBeVisible({ timeout: 60_000 });
    const works = page.locator('[data-slot="concept-tagged-works-results"]');
    await ui(page.getByRole('heading', { name: 'Works carrying this Concept', exact: true })).toBeVisible();
    await page.locator('#concept-work-property').selectOption('schema:genre');
    await ui(page.locator('#concept-work-scheme')).not.toHaveValue('', { timeout: 30_000 });
    evidence.sequence.push(`${persona}:filter-books`);
    await page.locator('#concept-work-type').selectOption('schema:Book');
    await page.waitForURL((url) => url.searchParams.get('type') === 'schema:Book');
    await page.locator('#concept-work-descendants').check();
    await page.waitForURL((url) => url.searchParams.get('children') === 'true');
    await ui(works.getByRole('link', { name: originWork.label }).first()).toBeVisible({ timeout: 60_000 });
    expect(await works.getByRole('link', { name: mangaLabel }).count()).toBe(0);
    const next = page.getByRole('button', { name: 'Show more works', exact: true });
    await ui(next).toBeVisible();
    const nextBox = await next.boundingBox();
    expect(nextBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(nextBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    evidence.sequence.push(`${persona}:recover-continuation`);
    await fixture.stack.injectKernelFailureOnce({
      method: 'POST',
      path: '/v1/subjects:search',
      status: 503,
      body: JSON.stringify({ title: 'Temporary search failure', status: 503, code: 'dependency_unavailable' }),
    });
    await next.click();
    await page.waitForURL((url) => url.searchParams.has('cursor'));
    const failedCursor = new URL(page.url()).searchParams.get('cursor');
    expect(failedCursor).toBeTruthy();
    await ui(page.getByRole('alert')).toBeVisible();
    await ui(page.getByText('The next result page is unavailable', { exact: false })).toBeVisible();
    await ui(works.getByRole('link', { name: originWork.label }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Retry this result page', exact: true }).click();
    expect(new URL(page.url()).searchParams.get('cursor')).toBe(failedCursor);
    await ui(page.getByRole('alert')).toBeHidden({ timeout: 60_000 });

    evidence.sequence.push(`${persona}:open-work-and-return`);
    const result = works.getByRole('link').first();
    const resultName = (await result.innerText()).trim();
    await result.click();
    await page.waitForURL((url) => !url.pathname.endsWith('/concepts'));
    await hydrate(page);
    const via = new URL(page.url()).searchParams.get('via');
    expect(via).toBeTruthy();
    const returnedVisit = parseConceptVisitDescriptor(new URL(via!, 'https://rezics.test').searchParams.get('conceptVisit'));
    expect(returnedVisit?.subject).toBe(parent);
    expect(returnedVisit?.works.type).toBe('schema:Book');
    expect(returnedVisit?.works.includeChildren).toBe(true);
    await page.getByRole('link', { name: 'Return to the source page', exact: true }).click();
    await page.waitForURL((url) => url.pathname.endsWith('/concepts') && url.pathname.includes(parent));
    await hydrate(page);
    expect(new URL(page.url()).pathname).toContain(`/${parent}/`);
    expect(new URL(page.url()).searchParams.get('type') ?? returnedVisit?.works.type).toBe('schema:Book');
    await ui(page.getByRole('heading', { name: parentLabel })).toBeVisible();
    await ui(page.getByRole('heading', { name: 'Works carrying this Concept', exact: true })).toBeVisible();

    evidence.sequence.push(`${persona}:locale-and-desktop`);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    const language = page.getByRole('button', { name: /Language: English/i });
    await ui(language).toBeVisible();
    await language.click();
    await page.getByRole('menuitemradio', { name: /繁體中文/ }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/zh-Hant/'));
    await hydrate(page);
    expect(new URL(page.url()).pathname).toContain(`/${parent}/`);
    expect(new URL(page.url()).pathname.startsWith('/zh-Hant/subjects/')).toBe(true);
    await ui(page.getByRole('heading', { name: worksTitles['zh-Hant'], exact: true })).toBeVisible();
    await page.goto(
      new URL(catalogueEntries.concepts({ id: parent, label: parentLabel, locale: 'ja' }).href, fixture.stack.web).href,
      { waitUntil: 'domcontentloaded' },
    );
    await hydrate(page);
    expect(new URL(page.url()).pathname).toContain(`/${parent}/`);
    await ui(page.getByRole('heading', { name: worksTitles.ja, exact: true })).toBeVisible();

    await page.goto(
      new URL(
        `${catalogueEntries.concepts({ id: parent, label: parentLabel, locale: 'en' }).href}?${new URLSearchParams({
          role: 'schema:genre',
          property: 'schema:genre',
          scheme,
          type: 'schema:Book',
          children: 'true',
        })}`,
        fixture.stack.web,
      ).href,
      { waitUntil: 'domcontentloaded' },
    );
    await hydrate(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await ui(page.getByRole('heading', { name: parentLabel })).toBeVisible();
    expect(resultName.length).toBeGreaterThan(0);
  }

  const anonymous = await fixture.auth.newContext('anonymous');
  const anonymousPage = await anonymous.newPage();
  anonymousPage.setDefaultTimeout(60_000);
  try {
    await walk(anonymousPage, 'anonymous');
  } finally {
    await anonymousPage.close();
    await anonymous.close();
  }

  const member = await fixture.auth.signUp('newcomer');
  const memberPage = await member.context.newPage();
  memberPage.setDefaultTimeout(60_000);
  try {
    await walk(memberPage, 'member');
  } finally {
    await memberPage.close();
  }

  const labels = await fixture.auth.newContext('anonymous');
  const labelsPage = await labels.newPage();
  labelsPage.setDefaultTimeout(60_000);
  try {
    for (const locale of nativeSiteLocales) {
      await labelsPage.goto(
        new URL(catalogueEntries.concepts({ id: parent, label: parentLabel, locale }).href, fixture.stack.web).href,
        { waitUntil: 'domcontentloaded' },
      );
      await hydrate(labelsPage);
      await ui(labelsPage.getByRole('heading', { name: worksTitles[locale], exact: true })).toBeVisible();
      expect(new URL(labelsPage.url()).pathname).toContain(`/${parent}/`);
    }
  } finally {
    await labelsPage.close();
    await labels.close();
  }

  await mkdir(join(import.meta.dir, '../../../.temp'), { recursive: true });
  await writeFile(
    join(import.meta.dir, '../../../.temp/concept-hierarchy-filtered-works-walk.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
});
