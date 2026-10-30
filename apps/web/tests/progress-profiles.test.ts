import { afterAll, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { pickText } from '@rezics/composition';
import type { LibraryLabels, LibraryProfile } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { m } from '../src/paraglide/messages.js';
import {
  progressChoicesForType,
  progressInputRules,
  progressPairLabel,
  progressDisplay,
  progressSessionProfile,
} from '../src/library/progress-profile.ts';

setDefaultTimeout(60_000);

const profile: LibraryProfile = {
  id: 'profile-test',
  entryStateSet: { id: 'states', states: [] },
  progress: {
    allowed: [
      {
        mode: 'scalar_amount',
        units: [
          {
            id: 'folio-x',
            labels: { en: 'Folio', fr: 'feuillet', 'zh-Hans': '册' },
            countForms: {
              en: { zero: 'Empty folios', one: 'Folio', other: 'Folios' },
              fr: { other: 'feuillets' },
            },
            minimum: '0.25',
            maximum: '98.5',
            precision: 2,
            totalPolicy: 'required',
            identity: { kind: 'none' },
            structure: { kind: 'none' },
          },
          {
            id: 'ratio-x',
            labels: { en: 'Coverage' },
            minimum: '0',
            maximum: '120',
            precision: 1,
            totalPolicy: 'forbidden',
            dimension: 'percent',
            identity: { kind: 'none' },
            structure: { kind: 'none' },
          },
        ],
      },
      {
        mode: 'cursor_position',
        units: [
          {
            id: 'coordinate-x',
            labels: { en: 'Position' },
            minimum: '0',
            maximum: '999',
            identity: { kind: 'none' },
            structure: { kind: 'none' },
          },
        ],
      },
    ],
  },
  importSources: [],
};
const legacy: LibraryProfile = {
  id: 'legacy-fixed-v1',
  progress: {
    allowed: [
      {
        mode: 'scalar_amount',
        units: [
          {
            id: 'page',
            labels: { en: 'Page' },
            countForms: { en: { one: 'Page', other: 'Legacy pages' } },
            identity: { kind: 'none' },
            structure: { kind: 'none' },
          },
        ],
      },
    ],
  },
  importSources: [],
};
const currentPageWithoutForms: LibraryProfile = {
  id: 'current-page-without-forms',
  progress: {
    allowed: [
      {
        mode: 'scalar_amount',
        units: [
          {
            id: 'page',
            labels: { en: 'Leaf' },
            identity: { kind: 'none' },
            structure: { kind: 'none' },
          },
        ],
      },
    ],
  },
  importSources: [],
};
const release = {
  types: {
    Novel: { library: { profileId: 'profile-test' } },
    CurrentPage: { library: { profileId: 'current-page-without-forms' } },
    Empty: { library: { profileId: 'empty' } },
    Missing: {},
  },
  libraryProfiles: {
    'profile-test': profile,
    'current-page-without-forms': currentPageWithoutForms,
    empty: { id: 'empty', importSources: [] },
    'legacy-fixed-v1': legacy,
  },
} as never;

test('the form offers profile modes and units in declaration order with profile labels', () => {
  expect(progressChoicesForType(release, 'Novel', 'en')).toEqual([
    {
      mode: 'scalar_amount',
      units: [
        { id: 'folio-x', label: 'Folio' },
        { id: 'ratio-x', label: 'Coverage' },
      ],
    },
    { mode: 'cursor_position', units: [{ id: 'coordinate-x', label: 'Position' }] },
  ]);
});

test('the selected pair supplies decimal bounds, precision step and total requirement', () => {
  expect(progressInputRules(release, 'Novel', 'scalar_amount', 'folio-x')).toEqual({
    min: '0.25',
    max: '98.5',
    step: '0.01',
    total: 'required',
  });
  expect(progressInputRules(release, 'Novel', 'scalar_amount', 'ratio-x')).toEqual({
    min: '0',
    max: '120',
    step: '0.1',
    total: 'forbidden',
  });
  expect(progressInputRules(release, 'Novel', 'cursor_position', 'coordinate-x')?.step).toBe('any');
  expect(progressInputRules(release, 'Novel', 'scalar_amount', 'ratio-x')?.total).toBe('forbidden');
});

test('missing profiles and profiles without progress have no choices', () => {
  expect(progressChoicesForType(release, 'Missing', 'en')).toBeUndefined();
  expect(progressChoicesForType(release, 'Empty', 'en')).toBeUndefined();
});

test('session labels resolve the exact mode and unit from current profile then legacy', () => {
  expect(progressPairLabel(release, 'Novel', 'scalar_amount', 'folio-x', 'en')).toBe('Folio');
  expect(progressPairLabel(release, 'Novel', 'scalar_amount', 'page', 'en')).toBe('Page');
  expect(progressPairLabel(release, 'Novel', 'cursor_position', 'page', 'en')).toBeUndefined();
});

test('an arbitrary unit uses the grammatical count, and missing same-language forms keep its released label', () => {
  expect(
    progressDisplay(release, 'Novel', { mode: 'scalar_amount', unit: 'folio-x', amount: '1', total: null }, 'en').text,
  ).toBe('1 Folio');
  expect(
    progressDisplay(release, 'Novel', { mode: 'scalar_amount', unit: 'folio-x', amount: '2', total: null }, 'en').text,
  ).toBe('2 Folios');
  expect(
    progressDisplay(release, 'Novel', { mode: 'scalar_amount', unit: 'folio-x', amount: '0', total: null }, 'en').text,
  ).toBe('0 Folios');
  expect(
    progressDisplay(release, 'Novel', { mode: 'scalar_amount', unit: 'folio-x', amount: '0.5', total: null }, 'fr')
      .text,
  ).toBe('0,5 feuillet');

  expect(
    progressDisplay(release, 'Novel', { mode: 'scalar_amount', unit: 'folio-x', amount: '1', total: '12' }, 'en').text,
  ).toBe('1 / 12 Folios');
  expect(
    progressDisplay(release, 'Novel', { mode: 'scalar_amount', unit: 'folio-x', amount: '1', total: '1' }, 'en').text,
  ).toBe('1 / 1 Folio');
  expect(
    progressDisplay(release, 'Novel', { mode: 'scalar_amount', unit: 'folio-x', amount: '2', total: null }, 'zh-Hans')
      .text,
  ).toBe('2册');

  expect(progressSessionProfile(release, 'Novel', 'scalar_amount', 'folio-x', 'en')).toMatchObject({
    unitLabel: 'Folio',
    unitLabelLanguage: 'en',
    unitCountForms: profile.progress!.allowed[0]!.units[0]!.countForms!.en,
  });
  expect(progressSessionProfile(release, 'Novel', 'scalar_amount', 'folio-x', 'zh-Hans')).not.toHaveProperty(
    'unitCountForms',
  );
  expect(
    progressDisplay(release, 'Novel', { mode: 'scalar_amount', unit: 'page', amount: '2', total: null }, 'en').text,
  ).toBe('2 Legacy pages');
  expect(
    progressDisplay(release, 'CurrentPage', { mode: 'scalar_amount', unit: 'page', amount: '2', total: null }, 'en')
      .text,
  ).toBe('2 Leaf');
  expect(progressSessionProfile(release, 'CurrentPage', 'scalar_amount', 'page', 'en')).not.toHaveProperty(
    'unitCountForms',
  );
});

test('bundled count forms are used with their selected labels in all launch locales', () => {
  const locales = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const;
  const type = 'schema:Book';
  const profileId = bundledRelease.types[type]?.library?.profileId;
  const profile = profileId ? bundledRelease.libraryProfiles?.[profileId] : undefined;
  expect(profile, 'the bundled Book type selects its released progress profile').toBeDefined();

  for (const locale of locales) {
    const choice = profile!.progress?.allowed.find((item) => item.mode === 'scalar_amount');
    const unit = choice?.units.find((item) => {
      const label = pickText(item.labels, locale);
      return label.lang !== null && item.countForms?.[label.lang as keyof LibraryLabels] !== undefined;
    });
    expect(unit, `${locale} has a bundled native unit count map`).toBeDefined();
    const selected = pickText(unit!.labels, locale);
    expect(selected.lang, `${locale} has a released unit label`).not.toBeNull();
    const forms = unit!.countForms![selected.lang as keyof LibraryLabels]!;
    const category = new Intl.PluralRules(selected.lang!).select(2);
    const form = forms[category] ?? selected.text;
    const amount = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(2);
    const expected = m.home_continue_amount({ amount, unit: form }, { locale });
    const view = progressDisplay(
      bundledRelease,
      type,
      { mode: 'scalar_amount', unit: unit!.id, amount: '2', total: null },
      locale,
    );
    expect(view.text, `${locale} uses the released ${unit!.id} form`).toBe(expected);
  }
});

test('percent metadata formats the stored amount and clamps only the bar', () => {
  const view = progressDisplay(
    release,
    'Novel',
    { mode: 'scalar_amount', unit: 'ratio-x', amount: '123.4', total: '200' },
    'en',
  );
  expect(view.text).toBe('123.4%');
  expect(view.percent).toBe(100);
  expect(
    progressDisplay(release, 'Novel', { mode: 'scalar_amount', unit: 'folio-x', amount: '2', total: '10' }, 'en').text,
  ).toContain('2');
});

test('unknown mode and unit pairs have no unit label', () => {
  expect(progressPairLabel(release, 'Novel', 'completed_units', 'mystery', 'en')).toBeUndefined();
});

test('the web progress implementation contains no fixed progress unit IDs', async () => {
  const files = await Array.fromAsync(glob('**/*.{ts,tsx}', { cwd: new URL('../src/', import.meta.url).pathname }));
  const oldIds =
    /(?:value|id)\s*:\s*['"](?:page|chapter|episode|volume|minute|percent)['"]|\[(?:\s*['"](?:page|chapter|episode|volume|minute|percent)['"]\s*,?){2,}\]/;
  for (const file of files) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    expect(source, file).not.toMatch(oldIds);
  }
});

test('a percent pair keeps an over-100 cursor position while clamping its bar', () => {
  const cursorRelease = {
    ...release,
    types: { Novel: { library: { profileId: 'cursor-percent' } } },
    libraryProfiles: {
      ...release.libraryProfiles,
      'cursor-percent': {
        ...profile,
        id: 'cursor-percent',
        progress: {
          allowed: [
            {
              mode: 'cursor_position',
              units: [
                {
                  id: 'ratio-x',
                  labels: { en: 'Coverage' },
                  dimension: 'percent',
                  identity: { kind: 'none' },
                  structure: { kind: 'none' },
                },
              ],
            },
          ],
        },
      },
    },
  } as never;
  expect(
    progressDisplay(
      cursorRelease,
      'Novel',
      { mode: 'cursor_position', unit: 'ratio-x', amount: '123.4', total: null },
      'en',
    ),
  ).toEqual({ text: '123.4%', percent: 100 });
});

// Mount the actual pages. Only transport, routing and unrelated page chrome are replaced.
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { build as buildStyles } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { join, resolve } from 'node:path';
import { routes as profileRoutes, profileSessionId } from '../src/kernel/fake/progress-profiles';
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let page: Page;
let writes = 0;
const root = resolve(import.meta.dir, '../../..');
const library = join(root, 'apps/web/src/library');
const session = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000801',
  subjectId: profileSessionId,
  versionSubjectId: null,
  mode: 'scalar_amount',
  unit: 'folio-x',
  amount: '2',
  total: null,
  position: null,
  locator: null,
  completedUnitCount: 0,
  state: 'active',
  revision: 1,
  startedAt: '2026-10-29T00:00:00Z',
  completedAt: null,
  subject: { id: profileSessionId, type: 'Novel', types: ['Novel'], label: 'A new journey', cover: null },
  versionSubject: null,
  changes: [],
  changesNext: null,
  units: [],
  unitsNext: null,
};
let currentSession = session;
let currentRequest = new Request('http://page/en/library/progress');
const sessionRoute = () => ({
  get: async () => ({ status: 200, data: { progressSession: structuredClone(currentSession) } }),
  changes: { get: async () => ({ status: 200, data: { changes: [], next: null } }) },
  completedUnits: { get: async () => ({ status: 200, data: { completedUnits: [], next: null } }) },
});
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => ({
  createIsomorphicFn: () => {
    let server: (...args: any[]) => any = () => undefined;
    const builder = {
      server(fn: (...args: any[]) => any) {
        server = fn;
        return builder;
      },
      client(fn: (...args: any[]) => any) {
        return (...args: any[]) => (typeof window === 'undefined' ? server : fn)(...args);
      },
    };
    return builder;
  },
  createServerFn: () => ({
    validator() {
      return this;
    },
    handler(fn: unknown) {
      return fn;
    },
  }),
  createServerOnlyFn: (fn: (...args: any[]) => any) => fn,
}));
mock.module('@tanstack/react-start/server', () => ({ getRequest: () => currentRequest, setResponseHeader: () => {} }));
mock.module('../src/session/request', () => ({
  prepareSession: async () => {},
  viewerCredential: () => 'Bearer test',
}));
mock.module('../src/kernel/client', () => ({
  requestLocale: () => 'en',
  kernelClient: () => ({
    progressSessions: Object.assign(sessionRoute, {
      get: async () => ({ status: 200, data: { progressSessions: [structuredClone(currentSession)], next: null } }),
    }),
  }),
}));
mock.module('../src/subject/definitions', () => ({
  readRelease: async () => release,
  nameSubjectTypes: async () => {},
}));
const serverReads = await import('../src/library/progress-server');

async function mount(kind: 'index' | 'session', type = 'Novel', overrides = {}) {
  if (!server) {
    const directory = join(root, '.temp/goal/progress-profile-browser');
    await mkdir(directory, { recursive: true });
    const entry = join(directory, 'entry.tsx');
    await writeFile(
      entry,
      `
      import React from ${JSON.stringify(join(root, 'apps/web/node_modules/react/index.js'))};
      import {createRoot} from ${JSON.stringify(join(root, 'apps/web/node_modules/react-dom/client.js'))};
      import {ProgressIndexPage} from ${JSON.stringify(join(library, 'progress-page.tsx'))};
      import {ProgressSessionPage} from ${JSON.stringify(join(library, 'progress-session.tsx'))};
      let root;
      window.mount = (kind, page) => { root?.unmount(); root=createRoot(document.getElementById('app'));
        root.render(React.createElement(kind==='index'?ProgressIndexPage:ProgressSessionPage,{page})); };
    `,
    );
    const mocks: Record<string, string> = {
      'progress-server': `import {recordProgress} from ${JSON.stringify(join(library, 'progress-reads.ts'))};
        export async function recordProgressSession({data}) {
          const client={progressSessions:()=>({$record:{post:async(body)=>{const r=await fetch('/record',{method:'POST',body:JSON.stringify(body)});return {status:r.status,error:{value:await r.json()}};}}})};
          return recordProgress(client,new Request(location.href),{},data);
        }
        export const readProgressChoices=async()=>undefined;
        export const startProgressSession=async()=>({ok:false,reason:'invalid'});
        export const finishProgressSession=startProgressSession;`,
      exposure: 'export const Exposure=({children})=>children; export const useOperation=()=>true;',
      composer: 'export const csrfHeaders=()=>({});',
      'logs-progress': 'export const RelativeTime=()=>null;',
      'subject-row':
        'export const rowRatio=()=>"5:7"; export const SubjectCover=()=>null; export const SubjectIdentity=()=>null;',
      'progress-picker': 'export const pickerSubject=s=>s; export const ProgressPicker=()=>null;',
      request: 'export const prepareSession=async()=>{}; export const viewerCredential=()=>"Bearer test";',
    };
    const build = await Bun.build({
      entrypoints: [entry],
      target: 'browser',
      plugins: [
        {
          name: 'page-services',
          setup(build) {
            build.onResolve({ filter: /^react(?:\/.*)?$/ }, (args) => ({
              path: Bun.resolveSync(args.path, join(root, 'apps/web')),
            }));
            build.onResolve({ filter: /^(?:@tanstack\/react-router)$/ }, () => ({ path: 'router', namespace: 'mock' }));
            build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
              loader: 'jsx',
              contents:
                'import React from ' +
                JSON.stringify(join(root, 'apps/web/node_modules/react/index.js')) +
                '; export const useRouter=()=>({}); export const Link=({children,...p})=><a {...p}>{children}</a>; export const notFound=()=>new Error();',
            }));
            build.onLoad(
              {
                filter:
                  /(?:progress-server|exposure|composer|logs-progress|subject-row|progress-picker|request)\.tsx?$/,
              },
              (args) => {
                const key = args.path
                  .split('/')
                  .at(-1)!
                  .replace(/\.tsx?$/, '');
                return mocks[key] ? { contents: mocks[key], loader: 'jsx' } : undefined;
              },
            );
          },
        },
      ],
    });
    expect(build.success, build.logs.map(String).join('\n')).toBe(true);
    const code = await build.outputs[0]!.text();
    // Shared controls need the same layout and stacking rules as the served page.
    const styles = await buildStyles({
      configFile: false,
      root: join(root, 'apps/web'),
      logLevel: 'silent',
      plugins: [tailwindcss()],
      build: { write: false, rollupOptions: { input: join(root, 'apps/web/src/styles.css') } },
    });
    const outputs = Array.isArray(styles) ? styles : [styles];
    const css = outputs
      .flatMap((output) => ('output' in output ? output.output : []))
      .filter((output) => output.type === 'asset' && output.fileName.endsWith('.css'))
      .map((output) => output.source)
      .join('\n');
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/app.js') return new Response(code, { headers: { 'content-type': 'text/javascript' } });
        if (path === '/record') {
          writes++;
          const answer = profileRoutes.find((route) => route.method === 'POST')!.story!({
            request: new Request(`http://kernel/v1/progressSessions/${profileSessionId}:record`, { method: 'POST' }),
            recordings: {},
            match: null,
          }) as any;
          return Response.json(answer, { status: answer.status });
        }
        return new Response(
          `<html lang="en"><head><style>${css}</style></head><body><main id="app"></main><script type="module" src="/app.js"></script></body></html>`,
          { headers: { 'content-type': 'text/html' } },
        );
      },
    });
    browser = await chromium.launch();
    page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(server.url.href);
    await page.waitForFunction(() => typeof (window as any).mount === 'function');
  }
  const item = { ...session, subject: { ...session.subject, type }, ...overrides };
  currentSession = item;
  currentRequest = new Request(`http://page/en/library/progress`, { headers: { cookie: crypto.randomUUID() } });
  const data =
    kind === 'index'
      ? await (serverReads.readProgressIndex as any)({ data: { subjectId: profileSessionId } })
      : await (serverReads.readProgressSession as any)({ data: { id: item.id } });
  await page.evaluate(({ kind, data }) => (window as any).mount(kind, data), { kind, data });
  await page.getByRole('heading', { level: 1 }).waitFor();
}
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

test('the page form offers only declared modes and the selected mode units in profile order', async () => {
  await mount('index');
  expect(await page.getByRole('radio').allTextContents()).toHaveLength(2);
  expect(await page.locator('select[name="unit"] option').allTextContents()).toEqual(['Folio', 'Coverage']);
  await page.getByRole('radio', { name: 'Cursor position', exact: true }).check();
  expect(await page.locator('select[name="unit"] option').allTextContents()).toEqual(['Position']);
});
test('the page inputs follow pair bounds, precision and total policy', async () => {
  await mount('index');
  const total = page.locator('input[name="total"]');
  expect(await total.getAttribute('required')).not.toBeNull();
  await page.locator('select[name="unit"]').selectOption('ratio-x');
  expect(await total.count()).toBe(0);
  await mount('session');
  await page.getByRole('button', { name: 'Update progress', exact: true }).click();
  const amount = page.getByRole('spinbutton', { name: 'Amount', exact: true });
  expect(await amount.getAttribute('min')).toBe('0.25');
  expect(await amount.getAttribute('max')).toBe('98.5');
  expect(await amount.getAttribute('step')).toBe('0.01');
  await mount('session', 'Novel', { mode: 'cursor_position', unit: 'coordinate-x', position: '42', locator: 'Marker' });
  await page.getByRole('button', { name: 'Update progress', exact: true }).click();
  const position = page.getByRole('spinbutton', { name: 'Position', exact: true });
  expect(await position.getAttribute('min')).toBe('0');
  expect(await position.getAttribute('max')).toBe('999');
  expect(await position.getAttribute('step')).toBe('any');
});
test('the page keeps sessions but offers no new-session form without a progress profile', async () => {
  for (const type of ['Missing', 'Empty']) {
    await mount('index', type);
    expect(await page.getByText('A new journey', { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.locator('form').count()).toBe(0);
  }
});
test('the session page names exact current and legacy pairs and leaves unnamed pairs bare', async () => {
  for (const [unit, label] of [
    ['folio-x', '2 Folios'],
    ['page', '2 Legacy pages'],
    ['mystery', '2'],
  ]) {
    await mount('session', 'Novel', { unit });
    expect(await page.getByText(label!, { exact: true }).count()).toBe(1);
  }
  expect(await page.getByRole('button', { name: 'Update progress', exact: true }).count()).toBe(0);
});
test('the session page renders metadata percentages and other units against totals', async () => {
  await mount('session', 'Novel', { unit: 'ratio-x', amount: '123.4', total: '200' });
  expect(await page.getByText('123.4%', { exact: true }).count()).toBe(1);
  expect(await page.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  await mount('session', 'Novel', { total: '10' });
  expect(await page.getByText('2 / 10 Folios', { exact: true }).count()).toBe(1);
});
test('a real record-progress 422 keeps the page session unchanged, explains unsupported and offers no retry', async () => {
  await mount('session');
  writes = 0;
  await page.getByRole('button', { name: 'Update progress', exact: true }).click();
  await page.getByLabel('Amount', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await page.getByRole('alert').waitFor();
  expect(await page.getByRole('alert').innerText()).toBe('This item does not support this kind of progress.');
  expect(await page.getByText('2 Folios', { exact: true }).count()).toBe(1);
  expect(writes).toBe(1);
  expect(await page.getByRole('button', { name: /Record|Retry/ }).count()).toBe(0);
});
