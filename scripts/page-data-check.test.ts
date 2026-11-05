import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { chromium } from '../packages/ui/node_modules/playwright/index.mjs';
import {
  classifySection,
  formatLine,
  hasItems,
  nativeKind,
  parseArgs,
  parseManifest,
  pointer,
  publicOrigin,
  redact,
  runPageDataCheck,
  type Manifest,
  type NativeObservation,
  type PageObservation,
} from './page-data-check.ts';

const native = (status: number, body: unknown, authorized = false): NativeObservation => ({
  status,
  body,
  authorized,
});
const page = (partial: Partial<PageObservation>): PageObservation => ({
  present: true,
  itemCount: 0,
  text: '',
  dataState: null,
  busy: false,
  ...partial,
});

test('a section that hides a successful native response is WEB', () => {
  expect(
    classifySection(
      native(200, { relations: [{ id: '1' }] }),
      page({ text: 'This section could not be loaded.' }),
      '/relations',
      null,
    ),
  ).toBe('WEB');
});

test('a native 400 or 503 is API', () => {
  expect(classifySection(native(400, { code: 'invalid_request' }), page({ text: 'Invalid' }), '/relations', null)).toBe(
    'API',
  );
  expect(classifySection(native(503, { code: 'index_not_ready' }), page({ text: 'Unavailable' }), '/hits', null)).toBe(
    'API',
  );
});

test('a zero-count relation is SEED', () => {
  expect(
    classifySection(
      native(200, { relations: [] }),
      page({ text: 'No visible entries on this page.', dataState: 'empty' }),
      '/relations',
      0,
    ),
  ).toBe('SEED');
});

test('native data the page renders is DATA; stated empty, unauthorized and unavailable are not defects', () => {
  expect(
    classifySection(
      native(200, { relations: [{ id: '1' }] }),
      page({ itemCount: 2, text: 'Steins;Gate' }),
      '/relations',
      1,
    ),
  ).toBe('DATA');
  expect(
    classifySection(
      native(200, { threads: [] }),
      page({ text: 'No reviews yet', dataState: 'empty' }),
      '/threads',
      null,
    ),
  ).toBe('EMPTY');
  expect(
    classifySection(native(401, { code: 'unauthorized' }), page({ text: 'Sign in' }), '/libraryEntries', null),
  ).toBe('UNAUTHORIZED');
  expect(
    classifySection(
      native(200, { feedItems: [], sources: { discovery: 'preparing' } }),
      page({ text: 'Public Collection discovery is being prepared.' }),
      '/feedItems',
      null,
    ),
  ).toBe('UNAVAILABLE');
});

test('an authenticated 403 is API; native empty with remaining seed candidates is API', () => {
  expect(
    classifySection(native(403, { code: 'forbidden' }, true), page({ text: 'Forbidden' }), '/feedItems', null),
  ).toBe('API');
  expect(
    classifySection(
      native(200, { subject: { statements: {} } }),
      page({ text: 'No supplied work synopsis' }),
      '/subject/statements/schema:abstract',
      1,
    ),
  ).toBe('API');
});

test('pointer, items, origin and redaction validate only outside input', () => {
  expect(pointer({ relations: [{ id: 'a' }] }, '/relations')).toEqual([{ id: 'a' }]);
  expect(hasItems({ labels: { en: 'VN' } })).toBe(true);
  expect(hasItems({ statements: { 'schema:abstract': [] } })).toBe(false);
  expect(nativeKind(native(200, { relations: [] }), '/relations')).toBe('empty');
  expect(() => publicOrigin('not-a-url', 'base URL')).toThrow('absolute URL');
  expect(() => publicOrigin('http://user:secret@127.0.0.1:3000', 'base URL')).toThrow('credentials');
  expect(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaa.bbbb password=hunter2')).not.toMatch(
    /Bearer |hunter2/i,
  );
});

test('CLI requires the web and kernel origins', () => {
  expect(() => parseArgs([])).toThrow('--base-url');
  const args = parseArgs(['--base-url', 'http://127.0.0.1:3000', '--kernel', 'http://127.0.0.1:4100']);
  expect(args.baseUrl).toBe('http://127.0.0.1:3000');
  expect(args.kernel).toBe('http://127.0.0.1:4100');
});

const fixtureManifest = (paths: Record<string, string>, kernelPath: string): Manifest =>
  parseManifest({
    version: 1,
    context: '00000000-0000-8000-8000-000000000000',
    question: '00000000-0000-7000-8000-000000000001',
    pages: [
      {
        id: 'web-hide',
        path: paths.web,
        subject: '00000000-0000-4000-8000-000000000001',
        sections: [
          {
            id: 'hidden',
            name: 'Hidden native data',
            selector: "[data-slot='type-list']",
            native: { method: 'GET', path: `${kernelPath}/data`, items: '/relations' },
          },
        ],
      },
      {
        id: 'api-400',
        path: paths.empty,
        sections: [
          {
            id: 'bad-request',
            name: 'Native 400',
            selector: "[data-slot='type-list']",
            native: { method: 'GET', path: `${kernelPath}/invalid`, items: '/relations' },
          },
        ],
      },
      {
        id: 'api-503',
        path: paths.empty,
        sections: [
          {
            id: 'down',
            name: 'Native 503',
            selector: "[data-slot='type-list']",
            native: { method: 'GET', path: `${kernelPath}/unavailable`, items: '/hits' },
          },
        ],
      },
      {
        id: 'seed-gap',
        path: paths.empty,
        subject: '00000000-0000-4000-8000-000000000002',
        sections: [
          {
            id: 'relations',
            name: 'Zero-count relation',
            selector: "[data-slot='type-list']",
            property: 'schema:character',
            native: { method: 'GET', path: `${kernelPath}/empty`, items: '/relations' },
            sql: {
              text: 'SELECT count(*)::int AS n FROM semantic.candidate WHERE subject_id = $1::uuid AND property = $2',
              params: ['subject', 'property'],
            },
          },
        ],
      },
    ],
  });

const pages = {
  web: `<!doctype html><html><body>
    <section data-slot="type-list" data-state="unavailable">
      <h2>Related works</h2>
      <p role="alert">This section could not be loaded.</p>
    </section>
  </body></html>`,
  empty: `<!doctype html><html><body>
    <section data-slot="type-list" data-state="empty">
      <h2>Related works</h2>
      <p>No visible entries on this page.</p>
    </section>
  </body></html>`,
};

test('fixture pages reproduce WEB, API and SEED through the CLI runner', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const web = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/en/web') return new Response(pages.web, { headers: { 'content-type': 'text/html' } });
      if (path === '/en/empty') return new Response(pages.empty, { headers: { 'content-type': 'text/html' } });
      return new Response('missing', { status: 404 });
    },
  });
  const kernel = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.headers.get('authorization')?.includes('secret-member-token')) {
        /* member authorization is accepted and never written to the result */
      }
      if (path === '/v1/data') return Response.json({ relations: [{ id: 'work-1' }] });
      if (path === '/v1/invalid') return Response.json({ code: 'invalid_request' }, { status: 400 });
      if (path === '/v1/unavailable') return Response.json({ code: 'index_not_ready' }, { status: 503 });
      if (path === '/v1/empty') return Response.json({ relations: [] });
      return new Response('no', { status: 404 });
    },
  });
  const lines: string[] = [];
  try {
    const result = await runPageDataCheck({
      baseUrl: `http://127.0.0.1:${web.port}`,
      kernel: `http://127.0.0.1:${kernel.port}`,
      manifest: fixtureManifest({ web: '/en/web', empty: '/en/empty' }, '/v1'),
      memberToken: 'secret-member-token',
      browser,
      queryCount: async () => 0,
      stdout: {
        write(chunk) {
          lines.push(chunk);
        },
      },
    });
    const printed = lines.join('');
    expect(printed).not.toContain('secret-member-token');
    expect(printed).toContain(
      formatLine({ page: 'web-hide', persona: 'anonymous', section: 'hidden', name: '', class: 'WEB' }),
    );
    expect(printed).toContain('api-400 anonymous bad-request API');
    expect(printed).toContain('api-503 anonymous down API');
    expect(printed).toContain('seed-gap anonymous relations SEED');
    expect(printed).toContain('web-hide member hidden WEB');
    expect(result.defects).toBeGreaterThan(0);
    expect(result.results.every((entry) => printed.includes(formatLine(entry)))).toBe(true);
  } finally {
    await browser.close();
    web.stop(true);
    kernel.stop(true);
  }
}, 60_000);

test('the tracked M1 manifest names the starting pages and seed counts', () => {
  const manifest = parseManifest(JSON.parse(readFileSync('scripts/page-data-sections.json', 'utf8')));
  expect(manifest.pages.map((page) => page.id)).toEqual([
    'home',
    'vn',
    'anime',
    'book',
    'character',
    'person',
    'tag',
    'search',
    'collections',
    'library',
  ]);
  expect(manifest.pages.find((page) => page.id === 'library')?.personas).toEqual(['member']);
  expect(manifest.pages.some((page) => page.sections.some((section) => section.sql))).toBe(true);
});
