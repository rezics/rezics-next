import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { negotiateLocale } from '../src/i18n/locales.ts';
import { pageIds, pageSlug } from '../src/pages.ts';
import { handleDynamic } from '../worker/dynamic.ts';
import type { AboutEnv, D1Database } from '../worker/env.ts';

/** A D1 stand-in that keeps the table's primary key semantics. */
function memoryDb(
  options: { failing?: boolean } = {},
): D1Database & { rows: Map<string, { locale: string; createdAt: string }> } {
  const rows = new Map<string, { locale: string; createdAt: string }>();
  return {
    rows,
    prepare: () => ({
      bind: (...values: unknown[]) => ({
        run: () => {
          if (options.failing) return Promise.reject(new Error('D1 unavailable'));
          const [email, locale, createdAt] = values as [string, string, string];
          if (!rows.has(email)) rows.set(email, { locale, createdAt });
          return Promise.resolve({});
        },
      }),
    }),
  };
}

const assets = { fetch: () => Promise.resolve(new Response('asset')) };
const envWith = (db: D1Database): AboutEnv => ({ ASSETS: assets, DB: db });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://about.test/api/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('the root and unprefixed pages negotiate a locale from the cookie, then Accept-Language, then English', async () => {
  expect(negotiateLocale(null, 'ja,en;q=0.8')).toBe('ja');
  expect(negotiateLocale(null, 'zh-TW,zh;q=0.9,en;q=0.5')).toBe('zh-Hant');
  expect(negotiateLocale(null, 'zh-CN')).toBe('zh-Hans');
  expect(negotiateLocale(null, 'pt-BR,fr;q=0.6')).toBe('fr');
  expect(negotiateLocale(null, 'sv, *;q=0.1')).toBe('en');
  expect(negotiateLocale('rezics_theme=dark; rezics_locale=ko', 'de')).toBe('ko');
  expect(negotiateLocale('rezics_locale=xx', 'de')).toBe('de');
  const root = await handleDynamic(
    new Request('https://about.test/', { headers: { 'accept-language': 'de-DE,de;q=0.9' } }),
    envWith(memoryDb()),
  );
  expect(root?.status).toBe(302);
  expect(root?.headers.get('location')).toBe('https://about.test/de/');
  expect(root?.headers.get('vary')).toContain('Accept-Language');
  const page = await handleDynamic(
    new Request('https://about.test/roadmap?ref=x', { headers: { cookie: 'rezics_locale=es' } }),
    envWith(memoryDb()),
  );
  expect(page?.headers.get('location')).toBe('https://about.test/es/roadmap/?ref=x');
  expect(
    await handleDynamic(new Request('https://about.test/en/'), envWith(memoryDb())),
  ).toBeUndefined();
});

test('every page the Worker negotiates is listed in wrangler.jsonc, and only those', () => {
  const jsonc = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(
    /^\s*\/\/.*$/gm,
    '',
  );
  const first = (JSON.parse(jsonc) as { assets: { run_worker_first: string[] } }).assets
    .run_worker_first;
  const pages = pageIds.filter((id) => id !== 'home').map((id) => `/${pageSlug(id)}`);
  expect([...first].sort()).toEqual(['/', '/api/*', ...pages].sort());
});

test('notify stores a lower-cased address with its locale and answers a repeat exactly the same way', async () => {
  const db = memoryDb();
  const first = await handleDynamic(
    post({ email: '  Reader@Example.COM ', locale: 'ja' }),
    envWith(db),
  );
  expect(first?.status).toBe(200);
  expect(await first?.json()).toEqual({ status: 'subscribed' });
  expect([...db.rows.keys()]).toEqual(['reader@example.com']);
  expect(db.rows.get('reader@example.com')?.locale).toBe('ja');
  const again = await handleDynamic(
    post({ email: 'reader@example.com', locale: 'de' }),
    envWith(db),
  );
  expect(again?.status).toBe(200);
  expect(await again?.json()).toEqual({ status: 'subscribed' });
  expect(db.rows.get('reader@example.com')?.locale).toBe('ja');
});

test('notify refuses bad addresses, unknown locales fall back to English, and cross-origin posts are denied', async () => {
  const db = memoryDb();
  for (const email of ['', 'no-at-sign', 'a@b', 'a b@c.co', 'x'.repeat(250) + '@example.com', 42]) {
    const response = await handleDynamic(post({ email, locale: 'en' }), envWith(db));
    expect(response?.status, String(email)).toBe(422);
    expect(((await response?.json()) as { code: string }).code).toBe('invalid_email');
  }
  expect(db.rows.size).toBe(0);
  await handleDynamic(post({ email: 'a@example.com', locale: 'tlh' }), envWith(db));
  expect(db.rows.get('a@example.com')?.locale).toBe('en');
  const foreign = await handleDynamic(
    post({ email: 'b@example.com', locale: 'en' }, { origin: 'https://evil.test' }),
    envWith(db),
  );
  expect(foreign?.status).toBe(403);
  expect(db.rows.has('b@example.com')).toBe(false);
  const same = await handleDynamic(
    post({ email: 'c@example.com', locale: 'en' }, { origin: 'https://about.test' }),
    envWith(db),
  );
  expect(same?.status).toBe(200);
  const method = await handleDynamic(new Request('https://about.test/api/notify'), envWith(db));
  expect(method?.status).toBe(405);
  const unknown = await handleDynamic(new Request('https://about.test/api/other'), envWith(db));
  expect(unknown?.status).toBe(404);
});

test('a filled honeypot looks successful but stores nothing', async () => {
  const db = memoryDb();
  const response = await handleDynamic(
    post({ email: 'bot@example.com', locale: 'en', company: 'ACME' }),
    envWith(db),
  );
  expect(response?.status).toBe(200);
  expect(db.rows.size).toBe(0);
});

test('a plain form post redirects to the localized confirmation, and a failure keeps the visitor on the form', async () => {
  const db = memoryDb();
  const form = (fields: Record<string, string>) =>
    new Request('https://about.test/api/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
  const done = await handleDynamic(form({ email: 'form@example.com', locale: 'ko' }), envWith(db));
  expect(done?.status).toBe(303);
  expect(done?.headers.get('location')).toBe('https://about.test/ko/notified/');
  expect(db.rows.has('form@example.com')).toBe(true);
  const invalid = await handleDynamic(form({ email: 'nope', locale: 'ko' }), envWith(db));
  expect(invalid?.headers.get('location')).toBe('https://about.test/ko/#notify');
  const down = await handleDynamic(
    form({ email: 'late@example.com', locale: 'fr' }),
    envWith(memoryDb({ failing: true })),
  );
  expect(down?.headers.get('location')).toBe('https://about.test/fr/#notify');
});

test('when storage fails a script caller learns it and can retry', async () => {
  const response = await handleDynamic(
    post({ email: 'late@example.com', locale: 'en' }),
    envWith(memoryDb({ failing: true })),
  );
  expect(response?.status).toBe(503);
  expect(((await response?.json()) as { code: string }).code).toBe('unavailable');
});
