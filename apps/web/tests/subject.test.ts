import { afterAll, expect, test } from 'bun:test';
import AxeBuilder from '@axe-core/playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { createKernelClient, type KernelClient } from '@rezics/client';
import { slug } from '@rezics/definitions/slug';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';

const app = join(import.meta.dir, '..');
const desktop = { width: 1280, height: 860 };
const phone = { width: 390, height: 844 };
const timeout = 300_000;
const missingId = '00000000-0000-4000-8000-000000000000';
// A subject merged into Kokoro: the kernel answers its read with a redirect to the survivor.
const mergedId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e08';

type Read = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['subjects']>['get']>>['data']>;
type Subject = Read['subject'];
type Snak = Subject['statements'][string][number]['qualifiers'][number];
const subjects = fixtures.subjects as Subject[];
const [kokoro, soseki, taketori, novel, shortStory] = subjects as [Subject, Subject, Subject, Subject, Subject];
const property = (id: string) => fixtures.properties.find((entry) => entry.id === id)!;
// The kernel stores only books today, so the author and genres are books too; the page never reads the type.
// The kernel does not check reference targets on write, so a value may name a subject nobody can label.
const dangling = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e09';
// A genre merged into the short story, named by one of Taketori's statements.
const mergedGenre = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e0a';
const aozora = 'https://www.aozora.gr.jp/cards/000148/card773.html';

async function messages(locale: string): Promise<Record<string, string>> {
  return (await Bun.file(join(app, 'messages', `${locale}.json`)).json()) as Record<string, string>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
let browser: Browser | undefined;

// The documented command, in its own process group so that Vite and workerd stop with it.
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/en/`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en/ in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

async function open(path: string, options: BrowserContextOptions = {}): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  // Actions before hydration reach server-rendered markup without handlers.
  if (options.javaScriptEnabled !== false) await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  return page;
}

afterAll(async () => {
  await browser?.close();
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

const languageOf = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => element.closest('[lang]')?.getAttribute('lang'));

test('the kernel client reads the local fixtures as the kernel serves them', async () => {
  // The page reads through the kernel's own client; only the network under it is local.
  expect(await Bun.file(join(app, 'src', 'kernel', 'client.ts')).text()).toContain("from '@rezics/client'");
  const sent: string[] = [];
  const local = createFakeKernelFetch(fixtures);
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push(`${request.method} ${new URL(request.url).pathname}`);
      return local(request);
    }) as typeof fetch,
  });
  const found = await client.subjects({ id: kokoro.id }).get();
  expect(found.status).toBe(200);
  expect(found.error).toBeNull();
  // The ADR-0034 session token travels in headers that the client handles, never in the body.
  expect(Object.keys(found.data!).sort()).toEqual(['account', 'related', 'subject']);
  expect(found.data!.subject).toEqual(kokoro);

  // Every property and subject the read mentions comes with its labels, so a page needs no second read.
  const properties = new Set<string>(),
    items = new Set<string>();
  const visit = (snak: Snak) => {
    properties.add(snak.property.id);
    if (snak.property.data_type === 'wikibase-item' && snak.value.type === 'value')
      items.add(snak.value.content as string);
  };
  for (const statement of Object.values(kokoro.statements).flat()) {
    visit(statement);
    statement.qualifiers.forEach(visit);
    statement.references.flatMap((reference) => reference.parts).forEach(visit);
  }
  expect(Object.keys(found.data!.related).sort()).toEqual([...properties, ...items].sort());
  for (const id of properties) expect(found.data!.related[id]).toEqual({ labels: property(id).labels });
  for (const id of items)
    expect(found.data!.related[id]).toEqual({ labels: subjects.find((entry) => entry.id === id)!.labels });

  const unlabelled = await client.subjects({ id: taketori.id }).get();
  expect(unlabelled.data!.subject).toEqual(taketori);
  expect(unlabelled.data!.related[dangling]).toBeUndefined();
  expect(unlabelled.data!.related['schema:genre']).toEqual({ labels: property('schema:genre').labels });
  // A merged subject that a statement names is labelled as its survivor and says where it went, one hop.
  // The client's type does not declare redirect yet.
  const merged = unlabelled.data!.related[mergedGenre] as (Read['related'][string] & { redirect?: string }) | undefined;
  expect(merged).toEqual({ labels: shortStory.labels, redirect: shortStory.id });

  // An unknown subject and one the viewer may not see are the same RFC 9457 problem, in the kernel's words.
  const missing = await client.subjects({ id: missingId }).get();
  expect(missing.status).toBe(404);
  expect(missing.data).toBeNull();
  expect(missing.error?.status).toBe(404);
  expect(missing.error?.value).toMatchObject({
    type: 'https://rezics.com/problems/not_found',
    title: 'Not Found',
    status: 404,
    code: 'not_found',
    retryable: false,
    effect_status: 'not_applicable',
    request_id: expect.any(String),
  });
  // The kernel exposes its one redirect hop; the web route resolves the survivor before answering with its URL.
  const survivor = await client.subjects({ id: mergedId }).get();
  expect(survivor.status).toBe(308);
  expect(survivor.error).toMatchObject({
    status: 308,
    value: { redirect: { from: mergedId, to: kokoro.id } },
  });
  expect(sent.slice(0, 3)).toEqual([kokoro.id, taketori.id, missingId].map((id) => `GET /v1/subjects/${id}`));
  expect(sent[3]).toBe(`GET /v1/subjects/${mergedId}`);
});

test(
  'a subject page renders the subject in the page language on the server',
  async () => {
    const origin = await site();
    const response = await fetch(`${origin}/en/subjects/${kokoro.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toMatch(/(?=.*\bprivate\b)(?=.*\bno-store\b)/);

    const page = await open(`/en/subjects/${kokoro.id}`, { javaScriptEnabled: false });
    expect((await page.getByRole('heading', { level: 1 }).textContent())?.trim()).toBe(kokoro.labels.en);
    expect(await page.title()).toContain(kokoro.labels.en);
    const text = await page.locator('main').innerText();
    expect(text).toContain(kokoro.descriptions.en!);
    // The overview shows the key facts; the remaining facts are in Details.
    for (const id of ['schema:author', 'schema:genre']) expect(text).toContain(property(id).labels.en);
    expect(text).not.toContain(property('schema:numberOfPages').labels.en);
    // The author is linked from the header and from the fact row; both go to the same page.
    const author = page.getByRole('link', { name: soseki.labels.en!, exact: true }).first();
    expect(await author.getAttribute('href')).toBe(
      `/en/subjects/${soseki.id}/${encodeURIComponent(slug(soseki.labels.en!))}`,
    );
    // Only the best rank shows: the preferred genre, not the deprecated one.
    expect(text).toContain(novel.labels.en!);
    expect(text).not.toContain(shortStory.labels.en!);
    expect(text).toContain('978-4-10-101013-7');
    // The source of the ISBN is listed once, as a link.
    expect(await page.locator(`a[href="${aozora}"]`).count()).toBe(1);
    await page.context().close();

    // Details holds every fact, with the page count as a number.
    const details = await open(`/en/subjects/${kokoro.id}/details`, { javaScriptEnabled: false });
    const facts = await details.locator('main').innerText();
    for (const id of ['schema:author', 'schema:genre', 'schema:isbn', 'schema:numberOfPages'])
      expect(facts).toContain(property(id).labels.en);
    expect(facts).toMatch(/\b384\b/);
    expect(facts).not.toContain('+384');
    await details.context().close();
  },
  timeout,
);

test(
  'labels fall back to English and keep their own language',
  async () => {
    let page = await open(`/ko/subjects/${taketori.id}`, { javaScriptEnabled: false });
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ko');
    expect((await page.getByRole('heading', { level: 1 }).textContent())?.trim()).toBe(taketori.labels.en);
    expect(await languageOf(page, 'h1')).toBe('en');
    await page.context().close();

    page = await open(`/ja/subjects/${taketori.id}`, { javaScriptEnabled: false });
    expect((await page.getByRole('heading', { level: 1 }).textContent())?.trim()).toBe(taketori.labels.ja);
    expect(await languageOf(page, 'h1')).toBe('ja');
    await page.context().close();

    // Property labels come in English and Japanese only, so a Korean page names properties in English.
    page = await open(`/ko/subjects/${kokoro.id}`, { javaScriptEnabled: false });
    expect((await page.getByRole('heading', { level: 1 }).textContent())?.trim()).toBe(kokoro.labels.ko);
    // The author is linked from the header and from the fact row; both go to the same page.
    const author = page.getByRole('link', { name: soseki.labels.en!, exact: true }).first();
    expect(await author.getAttribute('href')).toBe(
      `/ko/subjects/${soseki.id}/${encodeURIComponent(slug(soseki.labels.en!))}`,
    );
    expect(await author.evaluate((element) => element.closest('[lang]')?.getAttribute('lang'))).toBe('en');
    await page.context().close();

    // The page count is a remaining fact, so it is in Details.
    page = await open(`/ko/subjects/${kokoro.id}/details`, { javaScriptEnabled: false });
    expect(await languageOf(page, `main :text-is("${property('schema:numberOfPages').labels.en}")`)).toBe('en');
    await page.context().close();

    page = await open(`/ja/subjects/${kokoro.id}/details`, { javaScriptEnabled: false });
    expect(await page.locator('main').innerText()).toContain(property('schema:numberOfPages').labels.ja);
    await page.context().close();
  },
  timeout,
);

test(
  'unknown and absent values are stated, never invented',
  async () => {
    const english = await messages('en');
    for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
      const own = await messages(locale);
      for (const key of ['subject_value_unknown', 'subject_value_none', 'subject_value_unlabelled']) {
        expect(own[key]?.trim(), `${locale} ${key}`).toBeTruthy();
        if (locale !== 'en') expect(own[key], `${locale} ${key}`).not.toBe(english[key]);
      }
    }
    for (const locale of ['en', 'ja']) {
      const own = await messages(locale);
      let page = await open(`/${locale}/subjects/${taketori.id}`, { javaScriptEnabled: false });
      const text = await page.locator('main').innerText();
      expect(text).toContain(own.subject_value_unknown!);
      const unlabelled = page.getByRole('link', { name: own.subject_value_unlabelled!, exact: true });
      expect(await unlabelled.getAttribute('href')).toBe(
        `/${locale}/subjects/${dangling}/${encodeURIComponent(slug(own.subject_value_unlabelled!))}`,
      );
      await page.context().close();
      // A value that is known to be absent is stated in Details, where the remaining facts are.
      page = await open(`/${locale}/subjects/${taketori.id}/details`, { javaScriptEnabled: false });
      expect(await page.locator('main').innerText()).toContain(own.subject_value_none!);
      await page.context().close();
      // A qualifier with no value is stated too.
      page = await open(`/${locale}/subjects/${kokoro.id}/details`, { javaScriptEnabled: false });
      expect(await page.locator('main').innerText()).toContain(own.subject_value_none!);
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a merged subject redirects to its survivor, so pages link and cache only the survivor',
  async () => {
    const origin = await site();
    const response = await fetch(`${origin}/ja/subjects/${mergedId}`, { redirect: 'manual' });
    expect(response.status).toBe(301);
    expect(new URL(response.headers.get('location')!, origin).pathname).toBe(
      `/ja/subjects/${kokoro.id}/${encodeURIComponent(slug(kokoro.labels.ja!))}`,
    );

    // A value naming a merged subject links to the survivor, never to the merged id.
    const page = await open(`/ja/subjects/${taketori.id}`, { javaScriptEnabled: false });
    const genre = page.getByRole('link', { name: shortStory.labels.ja!, exact: true });
    expect(await genre.getAttribute('href')).toBe(
      `/ja/subjects/${shortStory.id}/${encodeURIComponent(slug(shortStory.labels.ja!))}`,
    );
    expect(await page.locator(`a[href*="${mergedGenre}"]`).count()).toBe(0);
    await page.context().close();
  },
  timeout,
);

test(
  'an unknown subject is a localized not-found page',
  async () => {
    const response = await fetch(`${await site()}/de/subjects/${missingId}`);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toMatch(/\bno-store\b/);
    expect(/<html[^>]*\slang="([^"]+)"/.exec(await response.text())?.[1]).toBe('de');
  },
  timeout,
);

test(
  'following a related subject is a client-side navigation to its page',
  async () => {
    const origin = await site();
    const page = await open(`/en/subjects/${kokoro.id}`);
    await page.evaluate(() => {
      (window as unknown as { kept: boolean }).kept = true;
    });
    await page.getByRole('link', { name: soseki.labels.en!, exact: true }).first().click();
    await page.waitForURL(`${origin}/en/subjects/${soseki.id}/${encodeURIComponent(slug(soseki.labels.en!))}`);
    await page.getByRole('heading', { level: 1, name: soseki.labels.en! }).waitFor();
    expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
    await page.context().close();
  },
  timeout,
);

test(
  'a subject page has no accessibility violations in either theme at phone and desktop widths',
  async () => {
    const found: string[] = [];
    const origin = await site();
    for (const theme of ['light', 'dark'])
      for (const viewport of [phone, desktop])
        for (const path of [
          `/en/subjects/${kokoro.id}`,
          `/ja/subjects/${kokoro.id}`,
          `/ko/subjects/${taketori.id}`,
          `/en/subjects/${taketori.id}`,
        ]) {
          const page = await open(path, {
            viewport,
            storageState: {
              cookies: [
                {
                  name: 'rezics_theme',
                  value: theme,
                  domain: new URL(origin).hostname,
                  path: '/',
                  expires: -1,
                  httpOnly: false,
                  secure: false,
                  sameSite: 'Lax',
                },
              ],
              origins: [],
            },
          });
          const result = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
            .analyze();
          for (const violation of result.violations)
            found.push(
              `${theme} ${viewport.width}px ${path}: ${violation.id} ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
            );
          await page.context().close();
        }
    expect(found).toEqual([]);
  },
  timeout,
);
