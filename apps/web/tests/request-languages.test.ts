import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { KernelClient } from '@rezics/client';
import { exportJWK, generateKeyPair } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';
import { loadAgentPage } from '../src/features/pages/agent.tsx';
import { loadRoutePage } from '../src/features/pages/route.tsx';
import { loadSubjectPage } from '../src/features/pages/subject.tsx';
import homePage from '../src/kernel/recorded/home-page.json' with { type: 'json' };
import subjectPage from '../src/kernel/recorded/subject-page.json' with { type: 'json' };
import agentPage from '../src/kernel/recorded/agent-page.json' with { type: 'json' };

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const resource = 'https://api.rezics.test';
const scopes = [
  'library_entry:list',
  'library_entry:read',
  'library_entry:update',
  'library_entry:delete',
  'progress_session:list',
];
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const japaneseId = '01a1773a-f700-7071-b5ef-2b02f7d0e8c6';
const recordedSubjectId = String((subjectPage as { subject: string }).subject);
const digest = 'request-languages-release';
const published = 'schema:datePublished';
const locales = ['zh-Hans', 'en'] as const;
const expectedLanguages = (locale: (typeof locales)[number]) =>
  locale === 'en' ? ['en'] : ['zh-Hans', 'zh', 'zh-Hant'];
const calls: {
  method: string;
  path: string;
  search: URLSearchParams;
  body: Record<string, unknown> | null;
  acceptLanguage: string | null;
}[] = [];

const release = {
  types: {
    'schema:Book': { labels: { en: 'book', 'zh-Hans': '书籍' }, bases: [], facets: [published] },
    'schema:Recipe': { labels: { en: 'recipe', 'zh-Hans': '食谱' }, bases: [], facets: [published] },
    'bf:Instance': { labels: { en: 'edition', 'zh-Hans': '版本' }, bases: [], facets: [published] },
    'wd:Q20631656': { labels: { en: 'release', 'zh-Hans': '版本' }, bases: [], facets: [published] },
  },
  properties: { [published]: { labels: { en: 'publication date', 'zh-Hans': '出版日期' }, datatype: 'time' } },
};
const facetTypes = [
  { value: 'schema:Book', count: 1, labels: { en: 'book', 'zh-Hans': '书籍' } },
  { value: 'schema:Recipe', count: 7, labels: { en: 'recipe', 'zh-Hans': '菜谱' } },
  { value: 'bf:Instance', count: 3, labels: { en: 'edition', 'zh-Hans': '版本' } },
  { value: 'wd:Q20631656', count: 3, labels: { en: 'release', 'zh-Hans': '版本' } },
];

let matchCount = 1;
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let originPromise: Promise<string> | undefined;
let serverOutput = '';

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function languageFor(labels: Record<string, string>, languages: unknown, original = 'ja'): string | undefined {
  if (!Array.isArray(languages)) return undefined;
  for (const language of languages) if (typeof language === 'string' && labels[language]) return language;
  if (labels[original]) return original;
  if (labels.en) return 'en';
  return Object.keys(labels).sort()[0];
}

function chosenLabels(labels: Record<string, string>, languages: unknown, original = 'ja') {
  const language = languageFor(labels, languages, original);
  return language ? { [language]: labels[language]! } : labels;
}

function bodyFromRecording(recording: Record<string, unknown>, languages: unknown, expand = false) {
  const body = structuredClone(recording) as Record<string, unknown>;
  delete body.status;
  const reads = body.reads;
  if (reads && typeof reads === 'object' && !Array.isArray(reads)) {
    for (const read of Object.values(reads as Record<string, unknown>)) {
      if (!read || typeof read !== 'object' || Array.isArray(read)) continue;
      const result = (read as { body?: unknown }).body;
      if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
      const value = result as { subjects?: unknown; total?: { value?: number } };
      if (!Array.isArray(value.subjects)) continue;
      const source = value.subjects as Record<string, unknown>[];
      const japaneseHomeSubject = {
        ...source[0],
        id: japaneseId,
        labels: { en: 'I Am a Cat', ja: '吾輩は猫である' },
        summary: {
          ...((source[0]?.summary as Record<string, unknown> | undefined) ?? {}),
          id: japaneseId,
          label: { value: '吾輩は猫である', language: 'ja' },
        },
      };
      const addJapaneseBook = source[0]?.type === 'schema:Book';
      const subjects = expand
        ? Array.from({ length: matchCount }, (_, index) => ({
            ...(addJapaneseBook && index === 0 ? japaneseHomeSubject : source[index % source.length]),
            id:
              addJapaneseBook && index === 0
                ? japaneseId
                : `01f00000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          }))
        : source;
      value.subjects = subjects.map((subject) => {
        const labels = subject.labels;
        if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return subject;
        return {
          ...subject,
          labels: chosenLabels(labels as Record<string, string>, languages),
        };
      });
      if (expand && value.total) value.total.value = matchCount;
    }
  }
  return body;
}

function matchingHits(text: unknown, languages: unknown) {
  const count = typeof text === 'string' && /^matches-(\d+)$/.test(text) ? Number(text.slice('matches-'.length)) : 1;
  return Array.from({ length: Math.min(Math.max(count, 1), 100) }, (_, index) => {
    const labels = { en: 'I Am a Cat', ja: '吾輩は猫である' };
    const selected = chosenLabels(labels, languages);
    const language = Object.keys(selected)[0] ?? 'en';
    return {
      id: index === 0 ? japaneseId : `01f00000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      type: 'schema:Book',
      labels: selected,
      summary: {
        id: index === 0 ? japaneseId : `01f00000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        type: 'schema:Book',
        types: ['schema:Book', 'schema:CreativeWork', 'schema:Thing'],
        creativeWork: true,
        label: { value: labels[language] ?? 'I Am a Cat', language },
        cover: null,
      },
      facts: { [published]: [{ kind: 'time', year: 1905 }] },
    };
  });
}

const fake = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    let body: Record<string, unknown> | null = null;
    if (request.method === 'POST')
      body = (await request
        .clone()
        .json()
        .catch(() => null)) as Record<string, unknown> | null;
    calls.push({
      method: request.method,
      path: url.pathname,
      search: url.searchParams,
      body,
      acceptLanguage: request.headers.get('accept-language'),
    });

    if (url.pathname === '/v1/definitions/active') return json({ digest });
    if (url.pathname === `/v1/definitions/releases/${digest}`) return json({ digest, release });
    if (url.pathname === '/v1/pages:read' && body) {
      const target = body.target as Record<string, unknown> | undefined;
      const languages = body.languages;
      if (target?.route === '/') return json(bodyFromRecording(homePage as Record<string, unknown>, languages, true));
      if (typeof target?.subject === 'string')
        return json(bodyFromRecording(subjectPage as Record<string, unknown>, languages));
      if (target?.account === 'haruka') return json(bodyFromRecording(agentPage as Record<string, unknown>, languages));
      return json({ type: 'about:blank', status: 404, code: 'not_found' }, 404);
    }
    if (url.pathname === '/v1/subjects:search' && body) {
      const text = body.text;
      const subjects = matchingHits(text, body.languages);
      return json({
        subjects,
        total: { value: subjects.length, relation: 'exact' },
        next: null,
        as_of: '2026-10-27T00:00:00Z',
      });
    }
    if (url.pathname === '/v1/subjects:suggest' && request.method === 'GET') {
      const subjects = matchingHits(url.searchParams.get('q'), url.searchParams.getAll('languages')).slice(0, 8);
      return json({ subjects, as_of: '2026-10-27T00:00:00Z' });
    }
    if (url.pathname === '/v1/subjects:facets' && body) {
      const facets = body.facets as { property: string }[] | undefined;
      if (facets?.some((facet) => facet.property === 'type'))
        return json({
          facets: [{ property: 'type', relation: 'exact', values: facetTypes }],
          total: { value: 14, relation: 'exact' },
          as_of: '2026-10-27T00:00:00Z',
        });
      return json({
        facets: (facets ?? []).map((facet) => ({ property: facet.property, relation: 'exact', values: [] })),
        total: { value: 1, relation: 'exact' },
        as_of: '2026-10-27T00:00:00Z',
      });
    }
    return json({ type: 'about:blank', status: 404, code: 'not_found' }, 404);
  },
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a web test port');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function site(): Promise<string> {
  originPromise ??= (async () => {
    const port = await freePort();
    let output = '';
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000',
        KERNEL_ORIGIN: fake.url.origin,
        AUTH_ISSUER: `${fake.url.origin}/auth`,
        WEBSITE_CLIENT_ID: clientId,
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: resource,
        WEBSITE_SCOPES: scopes.join(' '),
      },
    });
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
      serverOutput = output;
    };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/en`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) return origin;
      } catch {
        // The dev server is still starting.
      }
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return originPromise;
}

async function openLive(path: string): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  try {
    await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  } catch (error) {
    const details = await page
      .locator('body')
      .innerText()
      .catch(() => 'unavailable');
    throw new Error(
      `${String(error)}; page errors: ${errors.join(' | ')}; body: ${details.slice(0, 2000)}; calls: ${JSON.stringify(calls.slice(-12))}; server: ${serverOutput}`,
    );
  }
  try {
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  } catch (error) {
    const details = await page
      .locator('body')
      .innerText()
      .catch(() => 'unavailable');
    throw new Error(
      `${String(error)}; page errors: ${errors.join(' | ')}; body: ${details.slice(0, 2000)}; server: ${serverOutput}`,
    );
  }
  return page;
}

const calledPaths = (path: string) => calls.filter((call) => call.path === path);
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const expectedAcceptLanguage = (locale: (typeof locales)[number]) =>
  locale === 'en' ? 'en' : 'zh-Hans, zh;q=0.9, zh-Hant;q=0.8';

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The dev server has already exited.
    }
});

test(
  'requests carry the reader languages, Japanese titles and counted type facets',
  async () => {
    for (const locale of locales) {
      calls.length = 0;
      const home = await openLive(`/${locale}`);
      try {
        if (locale === 'zh-Hans') {
          const title = home.locator('[data-slot="type-list"] [lang="ja"]').filter({ hasText: '吾輩は猫である' });
          expect(await title.count()).toBe(1);
        }
        const pageRead = calledPaths('/v1/pages:read').at(-1)!;
        expect(pageRead.body?.languages).toEqual(expectedLanguages(locale));
        expect(pageRead.acceptLanguage).toBe(expectedAcceptLanguage(locale));
      } finally {
        await home.context().close();
      }

      const suggestionsPage = await openLive(`/${locale}/library`);
      try {
        const input = suggestionsPage.getByRole('combobox').and(suggestionsPage.locator('input'));
        await input.fill('cat');
        const option = suggestionsPage.getByRole('option').first();
        try {
          await option.waitFor({ timeout: 10_000 });
        } catch (error) {
          throw new Error(
            `${String(error)}; suggestion calls: ${JSON.stringify(calls.filter((call) => call.path.includes('suggest')))}; body: ${(await suggestionsPage.locator('body').innerText()).slice(0, 1500)}; server: ${serverOutput}`,
          );
        }
        if (locale === 'zh-Hans') {
          expect(await option.locator('[lang="ja"]').innerText()).toBe('吾輩は猫である');
        } else {
          expect(squash(await option.innerText())).toContain('I Am a Cat');
          expect(await option.locator('[lang="ja"]').count()).toBe(0);
        }
        const suggestion = calledPaths('/v1/subjects:suggest').at(-1)!;
        expect(suggestion.search.getAll('languages')).toEqual(expectedLanguages(locale));
      } finally {
        await suggestionsPage.context().close();
      }

      calls.length = 0;
      const page = await openLive(`/${locale}/search?q=cat`);
      try {
        const row = page.getByRole('main').locator('[data-slot="item"]').first();
        const title = row.getByRole('link', { name: locale === 'en' ? 'I Am a Cat' : '吾輩は猫である', exact: true });
        expect(await title.count()).toBe(1);
        if (locale === 'zh-Hans') expect(await title.getAttribute('lang')).toBe('ja');

        const search = calledPaths('/v1/subjects:search').at(-1)!;
        expect(search.body?.languages).toEqual(expectedLanguages(locale));
        const typeFacet = calledPaths('/v1/subjects:facets').find((call) =>
          ((call.body?.facets as { property: string }[] | undefined) ?? []).some((facet) => facet.property === 'type'),
        );
        expect(typeFacet?.body?.languages).toEqual(expectedLanguages(locale));

        if (locale === 'zh-Hans') {
          const entries = page
            .getByRole('main')
            .locator('section')
            .filter({ has: page.getByRole('heading', { name: '类型' }) })
            .locator('li');
          expect((await entries.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim())).toEqual([
            '菜谱 (7)',
            '版本 (3)',
            '版本 (3)',
            '书籍 (1)',
          ]);
          const types = await entries
            .locator('a')
            .evaluateAll((nodes) =>
              nodes.map((node) => new URL(node.getAttribute('href')!, 'http://x').searchParams.get('type')),
            );
          expect(types).toEqual(['schema:Recipe', 'bf:Instance', 'wd:Q20631656', 'schema:Book']);
        }

        const propertyPage = await fetch(`${await site()}/${locale}/search?q=cat&type=schema%3ABook`);
        expect(propertyPage.status).toBe(200);
        const propertyFacet = calledPaths('/v1/subjects:facets').find((call) =>
          ((call.body?.facets as { property: string }[] | undefined) ?? []).some(
            (facet) => facet.property === published,
          ),
        );
        expect(propertyFacet?.body?.languages).toEqual(expectedLanguages(locale));
      } finally {
        await page.context().close();
      }
    }

    const searchCounts: number[] = [];
    const homeCounts: number[] = [];
    for (const count of [1, 10, 100]) {
      matchCount = count;
      calls.length = 0;
      const search = await fetch(`${await site()}/zh-Hans/search?q=matches-${count}`);
      expect(search.status).toBe(200);
      searchCounts.push(calls.filter((call) => call.path.startsWith('/v1/subjects:')).length);

      calls.length = 0;
      const home = await fetch(`${await site()}/zh-Hans`);
      expect(home.status).toBe(200);
      homeCounts.push(calls.filter((call) => call.path.startsWith('/v1/')).length);
    }
    expect(searchCounts).toEqual([searchCounts[0], searchCounts[0], searchCounts[0]]);
    expect(homeCounts).toEqual([homeCounts[0], homeCounts[0], homeCounts[0]]);
  },
  timeout,
);

test('subject, agent and route page reads carry the requested languages', async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    pages: {
      $read: {
        post: async (body: Record<string, unknown>) => {
          calls.push(body);
          return { status: 404 };
        },
      },
    },
  } as unknown as KernelClient;

  for (const locale of locales) {
    calls.length = 0;
    await loadSubjectPage(client, recordedSubjectId, undefined, locale);
    await loadAgentPage(client, 'haruka', undefined, locale);
    await loadRoutePage(client, '/', locale);
    expect(calls.map((call) => call.languages)).toEqual([
      expectedLanguages(locale),
      expectedLanguages(locale),
      expectedLanguages(locale),
    ]);
  }
});
