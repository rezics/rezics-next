import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { chromium, type Browser } from '../packages/ui/node_modules/playwright/index.mjs';
import {
  classifySection,
  formatLine,
  hasItems,
  nativeKind,
  pageKind,
  parseArgs,
  parseManifest,
  pointer,
  publicOrigin,
  redact,
  runPageDataCheck,
  signInRequestBody,
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
      page({ text: 'No visible entries on this page.', dataState: 'empty' }),
      '/relations',
      null,
    ),
  ).toBe('WEB');
});

test('native request errors are API and explicit readiness is UNAVAILABLE', () => {
  expect(classifySection(native(400, { code: 'invalid_request' }), page({ text: 'Invalid' }), '/relations', null)).toBe(
    'API',
  );
  expect(classifySection(native(503, { code: 'server_error' }), page({ text: 'Unavailable' }), '/hits', null)).toBe(
    'API',
  );
  expect(classifySection(native(503, { code: 'index_not_ready' }), page({ text: 'Unavailable' }), '/hits', null)).toBe(
    'UNAVAILABLE',
  );
  expect(nativeKind(native(200, { admitted: ['collection.list'] }), '/admitted', 'library_entry.list')).toBe(
    'unavailable',
  );
  expect(nativeKind(native(200, { admitted: ['library_entry.list'] }), '/admitted', 'library_entry.list')).toBe('data');
  expect(classifySection(native(401, { code: 'expired' }, true), page({ text: 'Sign in' }), '/feedItems', null)).toBe(
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

test('authenticated 403 is API; candidate presence alone does not make an empty reading API', () => {
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
  ).toBe('EMPTY');
  expect(
    classifySection(
      native(200, { subject: { statements: {} } }),
      page({ itemCount: 1, text: 'Synopsis text' }),
      '/subject/statements/schema:abstract',
      0,
      true,
    ),
  ).toBe('API');
  expect(
    classifySection(
      native(200, { relations: [] }),
      page({ itemCount: 1, text: 'Loading', dataState: 'loading', busy: true }),
      '/relations',
      0,
      true,
    ),
  ).toBe('UNAVAILABLE');
});

test('Auth sign-in uses the existing login client profile', () => {
  expect(signInRequestBody('reader@example.test', 'secret')).toEqual({
    email: 'reader@example.test',
    password: 'secret',
    client_id: 'login',
    scope: [],
  });
  expect(pageKind(page({ itemCount: 1, dataState: 'loading', text: 'Loading', busy: true }))).toBe('loading');
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
            native: { method: 'GET', path: `${kernelPath}/server-error`, items: '/hits' },
          },
        ],
      },
      {
        id: 'native-ready',
        path: paths.empty,
        sections: [
          {
            id: 'index',
            name: 'Index readiness',
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
      {
        id: 'reader-states',
        path: paths.readers,
        personas: ['anonymous'],
        sections: [
          {
            id: 'aria-label',
            name: 'ARIA label',
            selector: '[data-case="aria-label"]',
            heading: 'ARIA label region',
            itemSelector: 'li[data-item]',
            native: { method: 'GET', path: `${kernelPath}/data`, items: '/relations' },
          },
          {
            id: 'aria-labelledby',
            name: 'ARIA labelled by',
            selector: '[data-case="aria-labelledby"]',
            heading: 'Labelled region',
            itemSelector: 'li[data-item]',
            native: { method: 'GET', path: `${kernelPath}/data`, items: '/relations' },
          },
          {
            id: 'empty-title-fallback',
            name: 'Empty title fallback',
            selector: '[data-case="empty-title"]',
            heading: 'Heading fallback',
            itemSelector: 'li[data-item]',
            native: { method: 'GET', path: `${kernelPath}/data`, items: '/relations' },
          },
          {
            id: 'root-item',
            name: 'Root and child items',
            selector: '[data-case="root-item"]',
            heading: 'Root reader',
            itemSelector: '[data-item]',
            native: { method: 'GET', path: `${kernelPath}/data`, items: '/relations' },
          },
          {
            id: 'following-action',
            name: 'Following feed action',
            selector: '[data-case="action-feed"]',
            heading: 'Following feed',
            itemSelector: 'li[data-item]',
            native: {
              method: 'GET',
              path: `${kernelPath}/data`,
              items: '/relations',
              action: { role: 'button', name: 'Following' },
            },
          },
        ],
      },
      {
        id: 'slow-navigation',
        path: paths.slow,
        personas: ['anonymous'],
        sections: [
          {
            id: 'bounded-reader',
            name: 'Timed out navigation',
            selector: "[data-slot='type-list']",
            itemSelector: "[data-slot='cover-card']",
            native: { method: 'GET', path: `${kernelPath}/data`, items: '/relations' },
          },
        ],
      },
      {
        id: 'after-timeout',
        path: paths.empty,
        personas: ['anonymous'],
        sections: [
          {
            id: 'continues',
            name: 'Coverage continues',
            selector: "[data-slot='type-list']",
            itemSelector: "[data-slot='cover-card']",
            native: { method: 'GET', path: `${kernelPath}/empty`, items: '/relations' },
          },
        ],
      },
    ],
  });

const pages = {
  web: `<!doctype html><html><body>
    <section data-slot="type-list" data-state="empty">
      <h2>Related works</h2>
      <p>No visible entries on this page.</p>
    </section>
  </body></html>`,
  empty: `<!doctype html><html><body>
    <section data-slot="type-list" data-state="empty">
      <h2>Related works</h2>
      <p>No visible entries on this page.</p>
    </section>
  </body></html>`,
  readers: `<!doctype html><html><body>
    <span id="labelled-title">Labelled region</span><span id="empty-title"></span>
    <section data-case="aria-label" aria-label="ARIA label region">
      <h2>Static heading only</h2><ul><li data-item>reader row</li></ul>
      <p role="status">Loading reader</p>
    </section>
    <section data-case="aria-labelledby" aria-labelledby="labelled-title" aria-label="Wrong name">
      <h2>Another static heading</h2><ul><li data-item>reader row</li></ul>
    </section>
    <section data-case="empty-title" aria-labelledby="empty-title" aria-label="">
      <h2>Heading fallback</h2><ul><li data-item>reader row</li></ul>
    </section>
    <section data-case="root-item" data-item>
      <h2>Root reader</h2><span data-item>nested row</span>
    </section>
    <button type="button">Following</button>
    <section data-case="action-feed" aria-label="Following feed" data-state="empty">
      <h2>Home</h2><p>No visible entries</p>
    </section>
    <script>setTimeout(() => document.querySelector('[data-case="aria-label"] [role="status"]').textContent = '', 80)</script>
    <script>document.querySelector('button').addEventListener('click', () => {
      const section = document.querySelector('[data-case="action-feed"]');
      section.dataset.state = 'ready';
      section.innerHTML = '<h2>Following feed</h2><ul><li data-item>following row</li></ul>';
    })</script>
  </body></html>`,
};

test('fixture pages exercise classification, reader readiness and coverage after navigation timeout', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const web = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/en/web') return new Response(pages.web, { headers: { 'content-type': 'text/html' } });
      if (path === '/en/empty') return new Response(pages.empty, { headers: { 'content-type': 'text/html' } });
      if (path === '/en/readers') return new Response(pages.readers, { headers: { 'content-type': 'text/html' } });
      if (path === '/en/slow') {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return new Response(pages.empty, { headers: { 'content-type': 'text/html' } });
      }
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
      if (path === '/v1/server-error') return Response.json({ code: 'internal_error' }, { status: 503 });
      if (path === '/v1/empty') return Response.json({ relations: [] });
      return new Response('no', { status: 404 });
    },
  });
  const lines: string[] = [];
  try {
    const result = await runPageDataCheck({
      baseUrl: `http://127.0.0.1:${web.port}`,
      kernel: `http://127.0.0.1:${kernel.port}`,
      manifest: fixtureManifest(
        { web: '/en/web', empty: '/en/empty', readers: '/en/readers', slow: '/en/slow' },
        '/v1',
      ),
      memberToken: 'secret-member-token',
      browser,
      pageTimeoutMs: 250,
      readerTimeoutMs: 300,
      requestTimeoutMs: 1000,
      queryCount: async () => 0,
      stdout: {
        write(chunk) {
          lines.push(chunk);
        },
      },
    });
    const printed = lines.join('');
    expect(printed).not.toContain('secret-member-token');
    const diagnosticText = result.diagnostics.join('\n');
    expect(printed).toContain(
      formatLine({
        page: 'web-hide',
        persona: 'anonymous',
        section: 'hidden',
        name: '',
        class: 'WEB',
        evidence: {
          nativeStatus: 200,
          nativeItems: 1,
          pageItems: 0,
          reader: 'empty',
          seedCount: null,
          seedExpected: false,
          nativeProbe: 'run',
          browserProbe: 'run',
        },
      }),
    );
    expect(printed).toContain('api-400 anonymous bad-request API');
    expect(printed).toContain('api-503 anonymous down API');
    expect(printed).toContain('native-ready anonymous index UNAVAILABLE');
    expect(printed).toContain('seed-gap anonymous relations SEED');
    expect(printed).toContain('web-hide member hidden UNAVAILABLE');
    expect(printed).toContain('reader-states anonymous aria-label DATA');
    expect(printed).toContain('reader-states anonymous aria-labelledby DATA');
    expect(printed).toContain('reader-states anonymous empty-title-fallback DATA');
    expect(printed).toContain('reader-states anonymous root-item DATA');
    expect(printed).toContain('reader-states anonymous following-action DATA');
    expect(printed).toContain('slow-navigation anonymous bounded-reader UNAVAILABLE');
    expect(printed).toContain('after-timeout anonymous continues EMPTY');
    expect(diagnosticText).toContain('Page navigation timed out for slow-navigation anonymous');
    expect(
      result.results.find((entry) => entry.page === 'reader-states' && entry.section === 'root-item')?.evidence
        .pageItems,
    ).toBe(2);
    expect(result.incomplete).toBe(true);
    expect(result.defects).toBeGreaterThan(0);
    expect(result.results.every((entry) => printed.includes(formatLine(entry)))).toBe(true);
  } finally {
    await browser.close();
    web.stop(true);
    kernel.stop(true);
  }
}, 60_000);

test.each([true, false])(
  'member browser setup failure retains independent evidence (native token=%s)',
  async (hasToken) => {
    const requests: (string | null)[] = [];
    const output: string[] = [];
    let pagesClosed = 0;
    let contextsClosed = 0;
    let sqlReads = 0;
    const browser = {
      newContext: async () => ({
        newPage: async () => ({
          goto: async (url: string, options: { timeout: number }) => {
            expect(options.timeout).toBe(50);
            if (url.endsWith('/auth/sign-in')) throw new Error('navigation timed out password=hidden');
          },
          waitForFunction: async () => {},
          evaluate: async () => page({ itemCount: 1 }),
          close: async () => {
            pagesClosed++;
          },
        }),
        close: async () => {
          contextsClosed++;
        },
      }),
    } as unknown as Browser;
    const result = await runPageDataCheck({
      baseUrl: 'http://web.test',
      kernel: 'http://kernel.test',
      browser,
      pageTimeoutMs: 50,
      invocation: 'fixture-invocation',
      ...(hasToken ? { memberToken: 'independent-token' } : {}),
      signIn: { origin: 'http://auth.test', email: 'member@test.invalid', password: 'hidden' },
      manifest: {
        version: 1,
        context: '',
        question: '',
        pages: [
          {
            id: 'home',
            path: '/',
            sections: ['feed', 'broken'].map((id) => ({
              id,
              name: id,
              selector: '#feed',
              native: { method: 'GET' as const, path: `/${id}`, items: '/items' },
              sql: { text: 'SELECT 3 AS n', params: [] },
            })),
          },
        ],
      },
      fetch: (async (request: Request) => {
        if (request.url.includes('auth.test')) throw new Error('auth offline');
        requests.push(request.headers.get('authorization'));
        return request.url.endsWith('/broken')
          ? Response.json({ code: 'internal_error' }, { status: 500 })
          : Response.json({ items: ['one'] });
      }) as typeof fetch,
      queryCount: async () => {
        sqlReads++;
        return 3;
      },
      stdout: {
        write: (line) => {
          output.push(line);
        },
      },
      stderr: { write() {} },
    });
    expect(result.results.map((row) => [row.persona, row.section, row.class])).toEqual([
      ['anonymous', 'feed', 'DATA'],
      ['anonymous', 'broken', 'API'],
      ['member', 'feed', 'UNAVAILABLE'],
      ['member', 'broken', hasToken ? 'API' : 'UNAVAILABLE'],
    ]);
    expect(result.results[2]?.evidence).toMatchObject({
      nativeStatus: hasToken ? 200 : 0,
      nativeItems: hasToken ? 1 : 0,
      nativeProbe: hasToken ? 'run' : 'unrun',
      browserProbe: 'unrun',
      seedCount: 3,
    });
    expect(requests).toEqual(
      hasToken ? [null, null, 'Bearer independent-token', 'Bearer independent-token'] : [null, null],
    );
    expect([pagesClosed, contextsClosed, sqlReads]).toEqual([2, 2, 4]);
    expect(result.incomplete).toBe(true);
    expect(output.slice(0, 4)).toEqual(result.results.map((row) => `${formatLine(row)}\n`));
    expect(output.at(-1)).toContain('"sections":4,"defects":' + (hasToken ? 2 : 1) + ',"incomplete":true');
    const diagnostics = result.diagnostics.join('\n');
    expect(diagnostics).toContain('browser setup unavailable');
    expect(diagnostics).toContain('SQL=3');
    expect(diagnostics + output.join('')).not.toMatch(/hidden|independent-token/);
  },
);

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
  const sections = Object.fromEntries(
    manifest.pages.flatMap((page) => page.sections.map((section) => [`${page.id}.${section.id}`, section])),
  );
  expect(sections['vn.tags']?.native.items).toBe('/subject/statements/schema:genre');
  expect(sections['anime.tags']?.native.items).toBe('/subject/statements/schema:genre');
  expect(sections['home.library-nav']?.native.admission).toBe('library_entry.list');
  expect(sections['home.collections-nav']?.native.admission).toBe('collection.list');
  const inverse = sections['tag.works']?.sql;
  expect(inverse?.text).toContain('semantic.inbound_link_count');
  expect(inverse?.text).toContain('subject_id = $1::uuid');
  expect(inverse?.params).toEqual(['subject', 'property', 'filter']);
  expect(
    classifySection(
      native(200, { links: [] }),
      page({ text: 'No visible entries on this page.', dataState: 'empty' }),
      '/links',
      0,
      true,
    ),
  ).toBe('SEED');
  expect(sections['collections.discovery']?.sql).toBeUndefined();
});
