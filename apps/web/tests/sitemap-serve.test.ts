import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import { robotsResponse } from '../src/sitemap/robots.ts';
import { sitemapResponse } from '../src/sitemap/serve.ts';

const app = join(import.meta.dir, '..');
const origin = 'https://www.rezics.test';
const locales: string[] = JSON.parse(readFileSync(join(app, 'project.inlang/settings.json'), 'utf8')).locales;
const digest = 'a1b2c3d4e5f60718293a4b5c';
const indexXml = '<?xml version="1.0"?><sitemapindex/>';
const gzipBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f]);

type Stored = { bytes: Uint8Array; etag: string };
// A bucket that records every operation and answers `onlyIf` the way R2 does for If-None-Match.
class FakeBucket {
  objects = new Map<string, Stored>();
  operations: string[] = [];
  put(key: string, bytes: Uint8Array | string, etag: string) {
    this.objects.set(key, { bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, etag });
  }
  async get(key: string, options?: { onlyIf?: Headers }) {
    this.operations.push(`get ${key}`);
    const stored = this.objects.get(key);
    if (!stored) return null;
    const meta = { key, size: stored.bytes.length, etag: stored.etag, httpEtag: `"${stored.etag}"` };
    const none = options?.onlyIf?.get('if-none-match');
    if (none && none.split(',').some((tag) => tag.trim() === meta.httpEtag || tag.trim() === '*')) return meta;
    const bytes = stored.bytes;
    return { ...meta, body: new Response(bytes).body! };
  }
  head(key: string) {
    this.operations.push(`head ${key}`);
    return null;
  }
  list() {
    this.operations.push('list');
    return { objects: [], truncated: false };
  }
  delete() {
    this.operations.push('delete');
  }
}
const env = (bucket: FakeBucket) => ({ SITEMAPS: bucket as unknown as R2Bucket });
const call = (path: string, bucket: FakeBucket, init?: RequestInit) =>
  sitemapResponse(new Request(`${origin}${path}`, init), env(bucket));

test('GET /sitemap.xml streams the stored index as application/xml with Cache-Control public, max-age=300, its ETag and 304 on a match, and answers 503 with Retry-After and no-store while no index exists', async () => {
  const empty = new FakeBucket();
  const missing = (await call('/sitemap.xml', empty))!;
  expect(missing.status).toBe(503);
  expect(missing.headers.get('retry-after')).toBe('3600');
  expect(missing.headers.get('cache-control')).toBe('no-store');
  expect(missing.headers.get('set-cookie')).toBeNull();
  await missing.arrayBuffer();
  expect(empty.operations).toEqual(['get index.xml']);

  const bucket = new FakeBucket();
  bucket.put('index.xml', indexXml, 'index-etag');
  bucket.put('shards/other.xml.gz', gzipBytes, 'other');
  const response = (await call('/sitemap.xml', bucket))!;
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  expect(response.headers.get('etag')).toBe('"index-etag"');
  expect(response.headers.get('content-encoding')).toBeNull();
  expect(await response.text()).toBe(indexXml);

  const revalidated = (await call('/sitemap.xml', bucket, { headers: { 'if-none-match': '"index-etag"' } }))!;
  expect(revalidated.status).toBe(304);
  expect(revalidated.headers.get('etag')).toBe('"index-etag"');
  expect(revalidated.headers.get('cache-control')).toBe('public, max-age=300');
  expect(await revalidated.text()).toBe('');
  const stale = (await call('/sitemap.xml', bucket, { headers: { 'if-none-match': '"older"' } }))!;
  expect(stale.status).toBe(200);
  await stale.arrayBuffer();

  const head = (await call('/sitemap.xml', bucket, { method: 'HEAD' }))!;
  expect(head.status).toBe(200);
  expect(head.headers.get('etag')).toBe('"index-etag"');
  expect(await head.text()).toBe('');

  const post = (await call('/sitemap.xml', bucket, { method: 'POST' }))!;
  expect(post.status).toBe(405);
  expect(post.headers.get('allow')).toBe('GET, HEAD');
  await post.arrayBuffer();
});

test('GET /sitemap-{type}-{digest}.xml.gz streams the stored file as application/gzip with no Content-Encoding, Cache-Control public, max-age=86400, immutable and its ETag, and an unknown or malformed name answers 404', async () => {
  const bucket = new FakeBucket();
  bucket.put(`shards/subjects-${digest}.xml.gz`, gzipBytes, 'shard-etag');
  bucket.put('private/state.json', '{}', 'private');
  bucket.put('manifest.json', '{}', 'manifest');
  const path = `/sitemap-subjects-${digest}.xml.gz`;

  const response = (await call(path, bucket))!;
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/gzip');
  expect(response.headers.get('content-encoding')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
  expect(response.headers.get('etag')).toBe('"shard-etag"');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(gzipBytes);

  const revalidated = (await call(path, bucket, { headers: { 'if-none-match': '"shard-etag"' } }))!;
  expect(revalidated.status).toBe(304);
  expect(revalidated.headers.get('etag')).toBe('"shard-etag"');
  expect(revalidated.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
  expect(await revalidated.text()).toBe('');

  const head = (await call(path, bucket, { method: 'HEAD' }))!;
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');

  const malformed = [
    `/sitemap-subjects-${digest.slice(1)}.xml.gz`,
    `/sitemap-subjects-${digest}0.xml.gz`,
    `/sitemap-subjects-${digest.toUpperCase()}.xml.gz`,
    `/sitemap-Subjects-${digest}.xml.gz`,
    `/sitemap-subj3cts-${digest}.xml.gz`,
    `/sitemap--${digest}.xml.gz`,
    `/sitemap-subjects-${digest}.xml`,
    `/sitemap-subjects-${digest}.xml.gz/`,
    `/sitemap-../private/state-${digest}.xml.gz`,
    `/sitemap-subjects-${digest}.xml.gz.bak`,
    '/sitemap-.xml.gz',
  ];
  for (const name of [...malformed, `/sitemap-boards-${digest}.xml.gz`]) {
    const refused = (await call(name, bucket))!;
    expect(refused.status, name).toBe(404);
    expect(refused.headers.get('cache-control'), name).toBe('no-store');
    await refused.arrayBuffer();
  }
  // A malformed name never reaches the bucket; an unknown well-formed one costs one get.
  expect(bucket.operations.filter((operation) => operation.includes('private'))).toEqual([]);

  for (const key of ['index.xml', 'private/state.json', 'manifest.json']) {
    const served = (await call(`/sitemap-${key}`, bucket))!;
    expect(served.status).toBe(404);
    await served.arrayBuffer();
  }
});

test('requests outside the sitemap paths are not handled', async () => {
  const bucket = new FakeBucket();
  for (const path of [
    '/',
    '/en',
    '/en/sitemap.xml',
    '/sitemap.xml/',
    '/robots.txt',
    '/sitemaps.xml',
    '/media/sitemap-x',
  ]) {
    expect(await call(path, bucket), path).toBeUndefined();
  }
  expect(bucket.operations).toEqual([]);
});

test('sitemap and robots responses read no session, set no cookie and make no kernel request', async () => {
  const touched: string[] = [];
  const trap = (name: string) =>
    new Proxy(
      {},
      {
        get(_target, property) {
          touched.push(`${name}.${String(property)}`);
          throw new Error(`${name} must not be used`);
        },
      },
    );
  const fetched: string[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    throw new Error('no network request is allowed');
  }) as typeof fetch;
  try {
    const bucket = new FakeBucket();
    bucket.put('index.xml', indexXml, 'index-etag');
    bucket.put(`shards/subjects-${digest}.xml.gz`, gzipBytes, 'shard-etag');
    const sessionHeaders = { cookie: '__Host-rezics_session=' + 'a'.repeat(43), authorization: 'Bearer x' };
    const responses = [
      await sitemapResponse(new Request(`${origin}/sitemap.xml`, { headers: sessionHeaders }), {
        ...env(bucket),
        SESSIONS: trap('SESSIONS'),
        MEDIA: trap('MEDIA'),
        KERNEL_ORIGIN: 'https://kernel.invalid',
      } as never),
      await sitemapResponse(new Request(`${origin}/sitemap-subjects-${digest}.xml.gz`, { headers: sessionHeaders }), {
        ...env(bucket),
        SESSIONS: trap('SESSIONS'),
      } as never),
      await sitemapResponse(new Request(`${origin}/sitemap-bad.xml.gz`), env(new FakeBucket())),
      await sitemapResponse(new Request(`${origin}/sitemap.xml`), env(new FakeBucket())),
      robotsResponse(new Request(`${origin}/robots.txt`, { headers: sessionHeaders }), { origin, locales }),
    ];
    for (const response of responses) {
      expect(response).toBeDefined();
      expect(response!.headers.get('set-cookie')).toBeNull();
      await response!.arrayBuffer();
    }
  } finally {
    globalThis.fetch = previous;
  }
  expect(touched).toEqual([]);
  expect(fetched).toEqual([]);
});

test('sitemap requests make exactly one R2 get whatever the number of stored files', async () => {
  for (const files of [1, 10, 100]) {
    const bucket = new FakeBucket();
    bucket.put('index.xml', indexXml, 'index-etag');
    for (let n = 0; n < files; n += 1)
      bucket.put(`shards/subjects-${n.toString(16).padStart(24, '0')}.xml.gz`, gzipBytes, `shard-${n}`);
    const target = `shards/subjects-${(files - 1).toString(16).padStart(24, '0')}.xml.gz`;
    const requests: [string, string, RequestInit?][] = [
      ['/sitemap.xml', 'index.xml'],
      ['/sitemap.xml', 'index.xml', { headers: { 'if-none-match': '"index-etag"' } }],
      ['/sitemap.xml', 'index.xml', { method: 'HEAD' }],
      [`/sitemap-${target.slice('shards/'.length)}`, target],
      [`/sitemap-${target.slice('shards/'.length)}`, target, { headers: { 'if-none-match': `"shard-${files - 1}"` } }],
      [`/sitemap-subjects-${'f'.repeat(24)}.xml.gz`, `shards/subjects-${'f'.repeat(24)}.xml.gz`],
    ];
    for (const [path, key, init] of requests) {
      bucket.operations.length = 0;
      const response = (await call(path, bucket, init))!;
      await response.arrayBuffer();
      expect(bucket.operations, `${files} files: ${path}`).toEqual([`get ${key}`]);
    }
  }
});

// Disallow matching as crawlers apply it: prefix match, `*` for any run, `$` for the end.
function disallowed(robots: string, path: string): boolean {
  return robots
    .split('\n')
    .filter((line) => line.startsWith('Disallow:'))
    .map((line) => line.slice('Disallow:'.length).trim())
    .filter(Boolean)
    .some((rule) =>
      new RegExp(
        '^' +
          rule
            .replace(/[.+?^{}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\$$/, '$'),
      ).test(path),
    );
}

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? routeFiles(path) : name.endsWith('.tsx') ? [path] : [];
  });
}
// A sample URL for a file route: parameters become values, `_` suffixes and `index` leaves disappear.
function routePath(file: string): string {
  const name = relative(join(app, 'src/routes'), file).replace(/\.tsx$/, '');
  const segments = name
    .split(/[./]/)
    .map((part) => part.replace(/_$/, ''))
    .filter((part) => part !== 'index')
    .map((part) => part.replace(/\{\$\w+\}/g, 'x1').replace(/^\$\w+$/, 'x1'));
  return '/' + segments.join('/');
}

// docs/seo.md Indexing: account, settings, library, checkout and order pages, editors, authentication pages.
const notCrawled = new Set([
  'settings.tsx',
  'library/collections.tsx',
  'library/copies.tsx',
  'library/following.tsx',
  'library/index.tsx',
  'library/progress.$id.tsx',
  'library/progress.index.tsx',
  'orders/$id.tsx',
  'collections/new.tsx',
  'boards/$id_.new.tsx',
  'curate/presentation.tsx',
]);

test('GET /robots.txt disallows every not-crawled route of docs/seo.md Indexing in every locale and the API paths, disallows no indexed route, and names PUBLIC_ORIGIN/sitemap.xml', async () => {
  const response = robotsResponse(new Request(`${origin}/robots.txt`), { origin: `${origin}/`, locales })!;
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
  expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
  const robots = await response.text();
  const lines = robots.split('\n');
  expect(lines[0]).toBe('User-agent: *');
  expect(lines.at(-2)).toBe(`Sitemap: ${origin}/sitemap.xml`);
  expect(lines.at(-1)).toBe('');

  const files = routeFiles(join(app, 'src/routes')).filter((file) => !file.endsWith('__root.tsx'));
  expect(files.length).toBeGreaterThan(20);
  const relativeFiles = new Set(files.map((file) => relative(join(app, 'src/routes'), file)));
  for (const file of notCrawled) expect(relativeFiles.has(file), file).toBe(true);
  let blocked = 0;
  for (const file of files) {
    const route = routePath(file);
    const wanted = notCrawled.has(relative(join(app, 'src/routes'), file));
    for (const locale of locales) {
      const path = `/${locale}${route === '/' ? '' : route}`;
      expect(disallowed(robots, path), path).toBe(wanted);
      if (wanted) blocked += 1;
      // Pages below a not-crawled route stay disallowed.
      if (wanted) expect(disallowed(robots, `${path}/more`), `${path}/more`).toBe(true);
    }
  }
  expect(blocked).toBe(notCrawled.size * locales.length);

  for (const path of [
    '/auth/sign-in',
    '/auth/callback',
    '/auth/sign-out',
    '/api/search/suggestions',
    '/_serverFn/abc',
    '/checkout',
    '/orders/abc/status',
  ])
    expect(disallowed(robots, path), path).toBe(true);
  for (const path of ['/', '/sitemap.xml', '/robots.txt', `/sitemap-subjects-${digest}.xml.gz`, '/media/abc/thumb'])
    expect(disallowed(robots, path), path).toBe(false);
  for (const locale of locales) expect(disallowed(robots, `/${locale}`), locale).toBe(false);

  expect(
    await robotsResponse(new Request(`${origin}/robots.txt`, { method: 'HEAD' }), { origin, locales })!.text(),
  ).toBe('');
  expect(robotsResponse(new Request(`${origin}/robots.txt`, { method: 'POST' }), { origin, locales })!.status).toBe(
    405,
  );
});

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

const kernelRequests: string[] = [];
const kernel = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    kernelRequests.push(`${request.method} ${new URL(request.url).pathname}`);
    return new Response('unavailable', { status: 503 });
  },
});
let child: ChildProcess | undefined;
afterAll(() => {
  kernel.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

test('the Worker answers the sitemap and robots paths itself, with an empty bucket, before session and kernel', async () => {
  const port = await freePort();
  let output = '';
  const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-8000));
  child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: app,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, KERNEL_ORIGIN: kernel.url.origin, PUBLIC_ORIGIN: origin },
  });
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
    try {
      if ((await fetch(`${base}/robots.txt`, { redirect: 'manual' })).status < 500) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`dev server did not start:\n${output}`);
    await Bun.sleep(250);
  }
  kernelRequests.length = 0;
  const session = { cookie: '__Host-rezics_session=' + 'a'.repeat(43) };
  const robots = await fetch(`${base}/robots.txt`, { headers: session, redirect: 'manual' });
  expect(robots.status).toBe(200);
  expect(robots.headers.get('set-cookie')).toBeNull();
  expect(robots.headers.get('cache-control')).toBe('public, max-age=3600');
  const text = await robots.text();
  expect(text).toContain('Disallow: /en/settings');
  expect(text).toContain(`Sitemap: ${origin}/sitemap.xml`);

  const index = await fetch(`${base}/sitemap.xml`, { headers: session, redirect: 'manual' });
  expect(index.status).toBe(503);
  expect(index.headers.get('retry-after')).toBe('3600');
  expect(index.headers.get('cache-control')).toBe('no-store');
  expect(index.headers.get('set-cookie')).toBeNull();
  await index.arrayBuffer();

  const file = await fetch(`${base}/sitemap-subjects-${digest}.xml.gz`, { headers: session, redirect: 'manual' });
  expect(file.status).toBe(404);
  expect(file.headers.get('set-cookie')).toBeNull();
  await file.arrayBuffer();
  const malformed = await fetch(`${base}/sitemap-nope.xml.gz`, { redirect: 'manual' });
  expect(malformed.status).toBe(404);
  await malformed.arrayBuffer();

  expect(kernelRequests).toEqual([]);
}, 300_000);
