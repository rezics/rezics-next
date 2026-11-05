import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

const app = join(import.meta.dir, '..');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'];
const timeout = 180_000;

async function messages(locale: string): Promise<Record<string, unknown>> {
  const { $schema: _, ...entries } = (await Bun.file(join(app, 'messages', `${locale}.json`)).json()) as Record<
    string,
    unknown
  >;
  return entries;
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

// The documented command, run as a developer runs it, in its own process group so that Vite and workerd stop with it.
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

afterAll(() => {
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

function htmlLang(html: string): string | undefined {
  return /<html[^>]*\slang="([^"]+)"/.exec(html)?.[1];
}

test(
  'the documented dev command serves server-rendered pages from the Worker',
  async () => {
    const manifest = (await Bun.file(join(app, 'package.json')).json()) as {
      name: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.name).toBe('@rezics/web');
    expect(typeof manifest.scripts?.check).toBe('string');
    expect(typeof manifest.scripts?.dev).toBe('string');
    const versions = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const name of [
      '@tanstack/react-start',
      '@cloudflare/vite-plugin',
      '@inlang/paraglide-js',
      'react',
      'tailwindcss',
    ])
      expect(versions[name]).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
    expect(await Bun.file(join(app, 'README.md')).text()).toContain('bun run dev');

    const response = await fetch(`${await site()}/en/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toMatch(/(?=.*\bprivate\b)(?=.*\bno-store\b)/);
    expect(htmlLang(await response.text())).toBe('en');
  },
  timeout,
);

test(
  'every launch locale renders its own messages under its path prefix',
  async () => {
    const origin = await site();
    const english = await messages('en');
    expect(typeof english.nav_home).toBe('string');
    for (const locale of locales) {
      const own = await messages(locale);
      if (locale !== 'en') expect(own.nav_home).not.toBe(english.nav_home);
      const response = await fetch(`${origin}/${locale}/`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(htmlLang(html)).toBe(locale);
      expect(html).toContain(Bun.escapeHTML(String(own.nav_home)));
    }
  },
  timeout,
);

test('every locale carries every English message and nothing else', async () => {
  const settings = (await Bun.file(join(app, 'project.inlang', 'settings.json')).json()) as {
    baseLocale: string;
    locales: string[];
  };
  expect(settings.baseLocale).toBe('en');
  expect([...settings.locales].sort()).toEqual([...locales].sort());
  const keys = Object.keys(await messages('en')).sort();
  expect(keys.length).toBeGreaterThan(0);
  for (const locale of locales) {
    const own = await messages(locale);
    expect(Object.keys(own).sort()).toEqual(keys);
    for (const value of Object.values(own)) expect(typeof value === 'string' && value.trim().length > 0).toBe(true);
  }
});

test(
  'the root redirects to the negotiated locale',
  async () => {
    const origin = await site();
    async function target(headers: Record<string, string>): Promise<string> {
      const response = await fetch(`${origin}/`, { headers, redirect: 'manual' });
      expect([302, 303, 307]).toContain(response.status);
      expect(response.headers.get('cache-control')).toMatch(/\bno-store\b/);
      return new URL(response.headers.get('location')!, origin).pathname.replace(/\/$/, '');
    }
    expect(await target({})).toBe('/en');
    expect(await target({ 'accept-language': 'ja,en;q=0.5' })).toBe('/ja');
    expect(await target({ 'accept-language': 'zh-TW' })).toBe('/zh-Hant');
    expect(await target({ 'accept-language': 'zh-HK,zh;q=0.8' })).toBe('/zh-Hant');
    expect(await target({ 'accept-language': 'zh-CN,zh;q=0.8' })).toBe('/zh-Hans');
    expect(await target({ 'accept-language': 'fr-CA' })).toBe('/fr');
    expect(await target({ 'accept-language': 'pt-BR' })).toBe('/en');
    expect(await target({ 'accept-language': 'ja', cookie: 'rezics_locale=ko' })).toBe('/ko');
  },
  timeout,
);

test(
  'an unknown page is a localized not-found page',
  async () => {
    const response = await fetch(`${await site()}/de/no-such-page`);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toMatch(/\bno-store\b/);
    expect(htmlLang(await response.text())).toBe('de');
  },
  timeout,
);
