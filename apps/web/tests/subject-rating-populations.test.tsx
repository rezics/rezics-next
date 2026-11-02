// UNRUN: connected Subject route/context, real prepared-reader wire and mounted lifetime assertions.
// Native signatures, browser layout, physical cost and private SSR require postintegration verification.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, Suspense, type ComponentProps } from 'react';
import { createKernelClient } from '@rezics/client';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import recorded from '../src/kernel/recorded/subject-page.json';
import realmRecording from '../src/kernel/recorded/realm.json';
import { GLOBAL, QUESTION, RATING_SOURCES, readRatings } from '../src/features/pages/subject-ratings';
import { readRatingPopulations, type PopulationInput } from '../src/features/pages/subject-rating-populations';
import type { SessionEnv } from '../src/session/client';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: `https://site.test/en/subjects/${recorded.subject}/kokoro` });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const ids = Array.from(
  { length: 20 },
  (_, index) => `01a1a000-0000-7000-8000-${String(index + 100).padStart(12, '0')}`,
);
const names = new Map(ids.map((id, index) => [id, `Current Realm ${index + 1}`]));
const subjectId = recorded.subject;
let preparedReader = 'reader-one';
let preparations = 0;
const sessionEnv = {
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      signedIn: async () => ({ signedIn: true, subject: preparedReader, csrfToken: 'story-csrf-token' }),
      credential: async () => {
        preparations++;
        return {
          status: 'active',
          subject: preparedReader,
          accessToken: `token-${preparedReader}`,
          csrfToken: 'story-csrf-token',
        };
      },
    }),
  },
} as unknown as Partial<SessionEnv>;
const request = () =>
  new Request('https://site.test/subject', { headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } });
const input = (extra: Partial<PopulationInput> = {}): PopulationInput => ({
  id: subjectId,
  question: QUESTION,
  locale: 'en',
  expectedReader: preparedReader,
  ...extra,
});
let requests: Request[] = [];
let denied = new Set<string>();
let sparse = false;
let sourceFailed = false;
let globalFailed = false;
let figureFailed = false;
let aggregateFailed = false;
let count = 12;
let sourceStatuses: Partial<Record<(typeof RATING_SOURCES)[number], number>> = {};
let directoryStatus = 200;
let updating = false;
let nativePopulations = ids.map((population) => ({ population, count: 1 }));
let directoryGate: ReturnType<typeof deferred<Response>> | undefined;
let aggregateGate: ReturnType<typeof deferred<Response>> | undefined;
const opaqueNext = 'opaque.native.signed+/continuation==';
const histogram = Array.from({ length: 21 }, (_, index) => (index === 16 ? count : 0));
const question = {
  id: QUESTION,
  revision: 3,
  label: 'How much did you like this work?',
  grain: 'work' as const,
  scale: { min: 0, max: 20, displayStep: 1 },
};
const headline = () => ({
  questionId: QUESTION,
  populationId: GLOBAL,
  scale: question.scale,
  count,
  state: count === 0 ? 'insufficient_data' : 'ready',
  mean: count === 0 ? null : 8,
  score: null,
});
const aggregateFigure = (population: string) => ({
  population,
  count: denied.has(population) ? 0 : count,
  ...(count > 0 && !denied.has(population)
    ? { mean: 16, histogram: histogram.map((_, index) => (index === 16 ? count : 0)) }
    : {}),
  freshness: { asOf: '2026-11-01T00:00:00.000Z', updating },
});
const sources = [
  {
    source: 'vndb',
    sourceRecordId: 'v4',
    scale: { min: 1, max: 100 },
    mean: 84,
    count: 77,
    asOf: '2026-10-20',
    licence: 'ODbL-1.0',
    attribution: 'VNDB contributors',
  },
];
const native = createKernelClient('https://kernel.test', {
  fetch: async (raw, init) => {
    const req = new Request(raw, init);
    requests.push(req);
    const url = new URL(req.url);
    if (url.pathname.startsWith('/v1/rating-questions/'))
      return Response.json(question, { status: sourceStatuses.question ?? 200 });
    if (url.pathname.endsWith('/figure'))
      return Response.json({ figure: headline() }, { status: sourceStatuses.figure ?? (figureFailed ? 503 : 200) });
    if (url.pathname.endsWith('/source-statistics'))
      return Response.json(sources, { status: sourceStatuses.statistics ?? (sourceFailed ? 503 : 200) });
    if (url.pathname.endsWith('/ratings/populations')) {
      if (directoryGate) {
        const gate = directoryGate;
        directoryGate = undefined;
        return gate.promise;
      }
      if (
        url.searchParams.get('question') !== QUESTION ||
        !url.pathname.includes(subjectId) ||
        (url.searchParams.has('cursor') && url.searchParams.get('cursor') !== opaqueNext)
      )
        return Response.json({ code: 'invalid_cursor' }, { status: 400 });
      if (directoryStatus !== 200) return Response.json({ code: 'unavailable' }, { status: directoryStatus });
      return Response.json({
        populations: sparse && !url.searchParams.has('cursor') ? [] : nativePopulations.slice(0, 20),
        next: sparse && !url.searchParams.has('cursor') ? opaqueNext : null,
      });
    }
    if (url.pathname.startsWith('/v1/realms/')) {
      const id = url.pathname.split('/')[3]!;
      return denied.has(id)
        ? Response.json({}, { status: 404 })
        : Response.json({ realm: { ...realmRecording.realm, realmId: id, title: names.get(id) } });
    }
    if (url.pathname.endsWith('/ratings')) {
      if (aggregateGate && req.headers.has('authorization')) {
        const gate = aggregateGate;
        aggregateGate = undefined;
        return gate.promise;
      }
      const populations = url.searchParams.getAll('population');
      expect(populations.length).toBeLessThanOrEqual(20);
      const failed = req.headers.has('authorization') ? aggregateFailed : globalFailed;
      return Response.json(
        {
          question: url.searchParams.get('question'),
          subject: url.pathname.split('/')[3],
          figures: populations.map(aggregateFigure),
        },
        {
          status: !req.headers.has('authorization')
            ? (sourceStatuses.global ?? (failed ? 503 : 200))
            : failed
              ? 503
              : 200,
        },
      );
    }
    if (url.pathname.endsWith('/vote')) return Response.json({ units: 17, revision: 1, at: '2026-11-01T00:00:00Z' });
    // Unrelated page regions retain their ordinary unavailable states; no ratings or reader helper is substituted.
    return Response.json({ code: 'not_found' }, { status: 404 });
  },
});
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: sessionEnv }));
mock.module('../src/kernel/client', () => ({ kernelClient: () => native }));
mock.module('../src/settings/preferences', () => ({
  loadSettingsPage: async () => ({
    signedIn: true,
    accountId: preparedReader,
    preferences: { spoilerLevel: 0, suitability: 'blur', version: 1 },
  }),
}));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider, dehydrate, useQuery } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { SubjectOverview } = await import('../src/routes/subjects/$id_.$slug');
const { SubjectRatingPopulations } = await import('../src/features/pages/subject-rating-populations-view');
const { readSubjectRatingPopulations, validatePopulationInput } =
  await import('../src/features/pages/subject-rating-populations-actions');
const { subjectFrameQuery, subjectRelationsQuery, subjectRatingQuery } =
  await import('../src/features/pages/subject-queries');
const { pageRelationProperties, subjectPageType } = await import('../src/features/pages/subject');
const { sessionQuery } = await import('../src/session/query');
const { subjectHead } = await import('../src/features/pages/subject-head');
const { m } = await import('../src/paraglide/messages.js');
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let cache: InstanceType<typeof QueryClient>;
let extraCache: InstanceType<typeof QueryClient> | undefined;
let mounted = false;
const session = (reader = preparedReader, csrfToken: string | null = 'story-csrf-token') => ({
  state: 'signed-in' as const,
  subject: reader,
  csrfToken,
});
const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: [`/en/subjects/${subjectId}/kokoro`] }),
});
const paths = (suffix: string, privateOnly = false) =>
  requests.filter(
    (req) => new URL(req.url).pathname.endsWith(suffix) && (!privateOnly || req.headers.has('authorization')),
  );
const directoryQueries = () => cache.getQueryCache().findAll({ queryKey: ['subject-rating-populations'] });
const boxes = () => Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
const button = (text: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((node) => node.textContent === text)!;
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 40 && !predicate(); index++) await act(tick);
  expect(predicate()).toBe(true);
}
function PopulationOwner({
  id = subjectId,
  q = question,
  enabled = true,
}: {
  id?: string;
  q?: typeof question;
  enabled?: boolean;
}) {
  const { data } = useQuery({ ...sessionQuery, enabled: false });
  return (
    <SubjectRatingPopulations
      subjectId={id}
      question={q}
      locale="en"
      session={data ?? { state: 'unknown', csrfToken: null }}
      enabled={enabled}
    />
  );
}
async function paint(id = subjectId, provider = cache, q = question, enabled = true) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={provider}>
        <PopulationOwner id={id} q={q} enabled={enabled} />
      </QueryClientProvider>,
    );
    await tick();
  });
  mounted = true;
}
async function select(index: number) {
  await act(async () => {
    boxes()[index]!.click();
    await tick();
  });
}
async function seedPublic(provider = cache) {
  await Promise.all(RATING_SOURCES.map((source) => provider.fetchQuery(subjectRatingQuery(subjectId, 'en', source))));
  provider.setQueryData(subjectFrameQuery(subjectPageType(recorded) ?? '', 'en').queryKey, {});
  provider.setQueryData(subjectRelationsQuery(pageRelationProperties(recorded), 'en').queryKey, {});
}
async function ordinary(provider = cache) {
  await seedPublic(provider);
  const data = {
    page: recorded,
    tabs: [],
    reader: null,
    verification: { sitekey: '', scriptUrl: '' },
    frame: {},
    relations: {},
    ratings: await readRatings(native, subjectId),
  } as unknown as ComponentProps<typeof SubjectOverview>['data'];
  await act(async () => {
    root.render(
      <QueryClientProvider client={provider}>
        <RouterContextProvider router={router}>
          <Suspense fallback={<p>Preparing</p>}>
            <SubjectOverview data={data} search={{}} />
          </Suspense>
        </RouterContextProvider>
      </QueryClientProvider>,
    );
    await tick();
  });
  mounted = true;
}
beforeEach(() => {
  requests = [];
  preparations = 0;
  preparedReader = 'reader-one';
  denied = new Set();
  sparse = sourceFailed = globalFailed = figureFailed = aggregateFailed = false;
  count = 12;
  sourceStatuses = {};
  directoryStatus = 200;
  updating = false;
  nativePopulations = ids.map((population) => ({ population, count: 1 }));
  directoryGate = aggregateGate = undefined;
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  cache.setQueryData(sessionQuery.queryKey, session());
  start.setStoryRequestContext({ visitor: 'Signed In', url: window.location.href });
  root = createRoot(host);
  mounted = true;
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  cache.clear();
  extraCache?.clear();
  extraCache = undefined;
});
afterAll(async () => {
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

test('real server-reader prepares exactly one Request, derives actual provenance, admits null-CSRF reads and conceals refused Realm identities/counts', async () => {
  cache.setQueryData(sessionQuery.queryKey, session(preparedReader, null));
  const first = await readSubjectRatingPopulations({ data: input() });
  expect(preparations).toBe(1);
  expect(first.reader).toBe(preparedReader);
  expect(first.result.kind).toBe('ready');
  if (first.result.kind !== 'ready') throw new Error('Expected native directory');
  expect(first.result.value.items).toHaveLength(20);
  expect(paths('/ratings/populations')).toHaveLength(1);
  expect(requests.filter((req) => new URL(req.url).pathname.startsWith('/v1/realms/'))).toHaveLength(20);
  expect(requests.every((req) => req.headers.get('authorization') === `Bearer token-${preparedReader}`)).toBe(true);
  denied.add(ids[0]!);
  const selected = await readRatingPopulations(native, request(), sessionEnv, input({ selected: ids.slice(0, 5) }));
  expect(preparations).toBe(2);
  expect(JSON.stringify(selected)).not.toContain(ids[0]!);
  expect(JSON.stringify(selected)).not.toContain(names.get(ids[0]!)!);
  if (selected.result.kind !== 'ready') throw new Error('Expected independent aggregate results');
  expect(selected.result.value.items).toHaveLength(4);
  expect(selected.result.value.incomplete).toBe(true);
  const last = paths('/ratings', true).at(-1)!;
  expect(new URL(last.url).searchParams.getAll('population')).toEqual(ids.slice(0, 5));
  expect(JSON.parse(JSON.stringify(selected))).toEqual(selected);
  const before = requests.length;
  const mismatch = await readRatingPopulations(native, request(), sessionEnv, input({ expectedReader: 'other' }));
  expect(mismatch).toMatchObject({ reader: preparedReader, result: { kind: 'unavailable' } });
  expect(requests).toHaveLength(before);
});

test('one sparse bounded page retains the opaque next, rejects cursor/question/Subject reuse and never refills automatically as unrelated history grows', async () => {
  for (const history of [0, 10_000]) {
    // Only the installed bounded native page is exposed; unrelated directory rows stay at the producer.
    nativePopulations = [
      ...ids.map((population) => ({ population, count: 1 })),
      ...Array.from({ length: history }, (_, index) => ({
        population: `01a1b000-0000-7000-8000-${String(index).padStart(12, '0')}`,
        count: 99,
      })),
    ];
    sparse = true;
    const before = requests.length;
    const page = await readRatingPopulations(native, request(), sessionEnv, input());
    expect(page.result).toEqual({ kind: 'ready', value: { items: [], next: opaqueNext, incomplete: false } });
    expect(requests.length - before).toBe(1);
    const beforeNext = requests.length;
    const next = await readRatingPopulations(native, request(), sessionEnv, input({ cursor: opaqueNext }));
    expect(next.result.kind).toBe('ready');
    expect(requests.length - beforeNext).toBe(21);
    expect(paths('/ratings/populations').at(-1)?.url).toContain(encodeURIComponent(opaqueNext));
    for (const invalid of [
      { cursor: 'forged' },
      { cursor: opaqueNext, id: ids[0]! },
      { cursor: opaqueNext, question: ids[1]! },
    ]) {
      const refused = await readRatingPopulations(native, request(), sessionEnv, input(invalid));
      expect(refused.result.kind).toBe('failed');
      expect(JSON.stringify(refused)).not.toContain('Current Realm');
    }
  }
  expect(nativePopulations).toHaveLength(10_020);
  expect(() => validatePopulationInput(input({ selected: [...ids, GLOBAL] }))).toThrow();
  expect(() => validatePopulationInput(input({ selected: [GLOBAL] }))).toThrow();
  expect(() => validatePopulationInput(input({ selected: [ids[0]!, ids[0]!] }))).toThrow();
});

test('Independent healthy rating sources survive sibling failures with targeted retries and public head isolation', async () => {
  sourceFailed = true;
  await ordinary();
  await until(
    () => boxes().length === 20 && host.querySelector('[data-slot="rating-control-reserved"] input') !== null,
  );
  await select(0);
  await select(1);
  await select(2);
  await select(3);
  await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 4);
  expect(host.textContent).toContain('Global');
  const figure = host.querySelector('[data-slot="public-rating-figure"]')!;
  const distribution = host.querySelector('[data-slot="rating-distribution"]')!;
  expect(figure.textContent).toContain('8 out of 10');
  expect(distribution).not.toBeNull();
  const draft = host.querySelector<HTMLInputElement>('[data-slot="rating-control-reserved"] input[type="range"]')!;
  await act(async () => {
    draft.focus();
    draft.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  });
  const draftValue = draft.value;
  const before = {
    figure: paths('/figure').length,
    global: paths('/ratings').length,
    own: paths('/vote').length,
    directory: paths('/ratings/populations').length,
    source: paths('/source-statistics').length,
  };
  sourceFailed = false;
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-source="statistics"] button')!.click();
    await tick();
  });
  await until(() => host.querySelector('[data-slot="imported-score"]') !== null);
  expect(host.textContent).toContain('VNDB contributors');
  expect(draft.value).toBe(draftValue);
  expect(host.querySelector('[data-slot="public-rating-figure"]')).toBe(figure);
  expect(host.querySelector('[data-slot="rating-distribution"]')).toBe(distribution);
  expect(paths('/source-statistics')).toHaveLength(before.source + 1);
  expect(paths('/figure')).toHaveLength(before.figure);
  expect(paths('/ratings')).toHaveLength(before.global);
  expect(paths('/vote')).toHaveLength(before.own);
  expect(paths('/ratings/populations')).toHaveLength(before.directory);
  expect(requests.filter((req) => req.method !== 'GET')).toHaveLength(0);
  const publicCache = cache.getQueryCache().findAll({ queryKey: ['subject-rating'] });
  for (const query of publicCache) {
    const json = JSON.stringify(query.state.data);
    expect(json).not.toContain('Current Realm');
    expect(json).not.toContain(preparedReader);
    expect(json).not.toContain('Bearer');
  }
  const publicReading = await readRatings(native, subjectId);
  const head = subjectHead(recorded, {
    origin: 'https://site.test',
    locale: 'en',
    path: '/en/subjects/example',
    ...(publicReading.figure.kind === 'ready' ? { ratings: { figure: publicReading.figure.value } } : {}),
  });
  expect(JSON.stringify(head)).not.toContain('Current Realm');
  expect(JSON.stringify(head)).not.toContain(preparedReader);
  const ld = JSON.parse(head.scripts[0]!.children);
  expect(ld.aggregateRating).toMatchObject({ ratingValue: 8, ratingCount: count, bestRating: 10 });
  expect(
    JSON.stringify(dehydrate(cache, { shouldDehydrateQuery: (query) => query.queryKey[0] === 'subject-rating' })),
  ).not.toContain(preparedReader);
});

test('question/Global distribution and imported source survive headline failure; genuine zero, failed and absent remain distinct', async () => {
  figureFailed = true;
  let data = await readRatings(native, subjectId);
  expect(data.figure.kind).toBe('failed');
  const { RatingsView } = await import('../src/features/pages/subject-ratings-view');
  let html = renderToStaticMarkup(<RatingsView data={data} id="ratings" subject={subjectId} locale="en" />);
  expect(html).toContain('data-slot="rating-distribution"');
  expect(html).toContain('VNDB contributors');
  count = 0;
  data = await readRatings(native, subjectId);
  html = renderToStaticMarkup(<RatingsView data={data} id="ratings" subject={subjectId} locale="en" />);
  expect(html).toContain('No ratings yet');
  expect(html).not.toContain('data-slot="histogram"');
  globalFailed = true;
  data = await readRatings(native, subjectId);
  html = renderToStaticMarkup(<RatingsView data={data} id="ratings" subject={subjectId} locale="en" />);
  expect(html).not.toContain('No ratings yet');
  expect(data.global.kind).toBe('failed');
  expect(data.statistics.kind).toBe('ready');
});

test('Actual bounded population directory/selection/labels/aggregates and mounted reader lifetime closure', async () => {
  sparse = true;
  await paint();
  await until(() => button(m.rating_population_next()) !== undefined);
  expect(boxes()).toHaveLength(0);
  expect(paths('/ratings/populations')).toHaveLength(1);
  await act(async () => {
    const next = button(m.rating_population_next());
    next.focus();
    next.click();
    await tick();
  });
  await until(() => boxes().length === 20);
  expect(window.document.activeElement).toBe(boxes()[0]);
  expect(new URL(paths('/ratings/populations').at(-1)!.url).searchParams.get('cursor')).toBe(opaqueNext);
  for (let index = 0; index < 20; index++) await select(index);
  await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 20);
  expect(new URL(paths('/ratings', true).at(-1)!.url).searchParams.getAll('population')).toEqual(ids);
  aggregateFailed = true;
  const before = paths('/ratings/populations').length;
  // A selected-source retry is independent of the current directory page.
  const query = directoryQueries().find((query) => query.queryKey[6] === 'selected')!;
  await act(async () => {
    await cache.refetchQueries({ queryKey: query.queryKey });
  });
  await until(() => button(m.subject_section_retry()) !== undefined);
  aggregateGate = deferred<Response>();
  const pending = aggregateGate;
  await act(async () => {
    button(m.subject_section_retry()).click();
    await tick();
  });
  const oldRemove = button(m.rating_population_remove({ name: names.get(ids[0]!)! }));
  await act(async () => {
    oldRemove.click();
    await tick();
  });
  pending.resolve(Response.json({ subject: subjectId, question: QUESTION, figures: ids.map(aggregateFigure) }));
  await act(tick);
  expect(boxes()[0]?.checked).toBe(false);
  expect(host.querySelector('[data-slot="rating-selected"]')?.textContent).not.toContain(names.get(ids[0]!)!);
  expect(paths('/ratings/populations')).toHaveLength(before);
  aggregateFailed = false;
  await act(async () => {
    const restart = button(m.rating_population_restart());
    restart.focus();
    restart.click();
    await tick();
  });
  await until(() => boxes().length === 0);
  expect(paths('/ratings/populations')).toHaveLength(before + 1);
  expect(window.document.activeElement).toBe(button(m.rating_population_next()));
});

for (const replacement of [
  'equal-success',
  'ABA',
  'remove-session',
  'remove-source',
  'equal-source-success',
  'sign-out',
  'non-success-ABA',
  'non-success-source-ABA',
  'non-success-question-ABA',
  'equal-question-success',
] as const) {
  test(`${replacement} retires queued choices and retries before React commit, rejects late responses/finally and permits fresh matching recovery`, async () => {
    cache.setQueryData(sessionQuery.queryKey, session(preparedReader, null));
    const questionKey = subjectRatingQuery(subjectId, 'en', 'question').queryKey;
    cache.setQueryData(questionKey, await readRatings(native, subjectId, 'question'));
    await paint();
    await until(() => boxes().length === 20);
    aggregateFailed = true;
    await select(0);
    await until(() => button(m.subject_section_retry()) !== undefined);
    const oldBox = boxes()[1]!;
    const oldRetry = button(m.subject_section_retry());
    // Hold a real private response while the session/source observation changes.
    directoryGate = deferred<Response>();
    const delayed = directoryGate;
    const source = directoryQueries().find((query) => query.queryKey[6] === 'directory')!;
    const oldKey = source.queryKey;
    const refetch = cache.refetchQueries({ queryKey: oldKey });
    await until(() => directoryGate === undefined);
    const choicesBefore = paths('/ratings', true).length;
    await act(async () => {
      if (replacement === 'equal-success') cache.setQueryData(sessionQuery.queryKey, session(preparedReader, null));
      if (replacement === 'ABA') {
        cache.setQueryData(sessionQuery.queryKey, session('reader-two', null));
        cache.setQueryData(sessionQuery.queryKey, session(preparedReader, null));
      }
      if (replacement === 'remove-session') cache.removeQueries({ queryKey: sessionQuery.queryKey });
      if (replacement === 'remove-source') cache.removeQueries({ queryKey: oldKey });
      if (replacement === 'equal-source-success') cache.setQueryData(oldKey, source.state.data);
      if (replacement === 'non-success-source-ABA') {
        const original = source.state.data;
        source.setState({ data: {} });
        source.setState({ data: original });
      }
      if (replacement === 'equal-question-success') cache.setQueryData(questionKey, cache.getQueryData(questionKey));
      if (replacement === 'non-success-question-ABA') {
        const query = cache.getQueryCache().find({ queryKey: questionKey })!;
        const original = query.state.data;
        query.setState({ data: { question: { kind: 'failed' } } });
        query.setState({ data: original });
      }
      if (replacement === 'non-success-ABA') {
        const query = cache.getQueryCache().find({ queryKey: sessionQuery.queryKey })!;
        query.setState({ data: { state: 'signed-out', subject: null, csrfToken: null } });
        query.setState({ data: session(preparedReader, null) });
      }
      if (replacement === 'sign-out')
        cache.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
      // Old native DOM callbacks dispatch synchronously before the new React render.
      oldBox.click();
      oldRetry?.click();
    });
    delayed.resolve(Response.json({ populations: [{ population: ids[0], count: 999 }], next: null }));
    await act(async () => {
      await refetch.catch(() => {});
      await tick();
    });
    expect(paths('/ratings', true)).toHaveLength(choicesBefore);
    expect(host.textContent).not.toContain('999');
    if (replacement === 'remove-session' || replacement === 'sign-out')
      await act(async () => {
        cache.setQueryData(sessionQuery.queryKey, session(preparedReader, null));
      });
    await until(() => boxes().length === 20);
    expect(boxes()[1]).not.toBe(oldBox);
    expect(boxes().every((box) => !box.checked)).toBe(true);
    aggregateFailed = false;
    await select(0);
    await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 1);
    expect(host.textContent).toContain(names.get(ids[0]!)!);
  });
}

test('ordinary invalidation/fetch/error/observer notifications preserve useful current data and selections', async () => {
  await paint();
  await until(() => boxes().length === 20);
  await select(0);
  await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 1);
  const before = paths('/ratings/populations').length;
  const box = boxes()[0]!;
  const query = directoryQueries().find((query) => query.queryKey[6] === 'directory')!;
  await act(async () => {
    await cache.invalidateQueries({ queryKey: query.queryKey, refetchType: 'none' });
    cache.getQueryCache().notify({ type: 'observerResultsUpdated', query });
    query.setState({ error: new Error('ordinary directory refresh failed'), fetchStatus: 'idle' });
    cache
      .getQueryCache()
      .find({ queryKey: sessionQuery.queryKey })!
      .setState({ error: new Error('ordinary refetch failed'), fetchStatus: 'idle' });
  });
  expect(boxes()[0]).toBe(box);
  expect(box.checked).toBe(true);
  expect(host.querySelectorAll('[data-slot="rating-comparison"]')).toHaveLength(1);
  expect(paths('/ratings/populations')).toHaveLength(before);
  await select(1);
  await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 2);
});

test('QueryClient, Subject, question and visit replacements and unmount reject held responses without reviving ABA visits', async () => {
  await paint();
  await until(() => boxes().length === 20);
  const oldBox = boxes()[0]!;
  extraCache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  extraCache.setQueryData(sessionQuery.queryKey, session());
  await paint(subjectId, extraCache);
  await until(() => boxes().length === 20 && boxes()[0] !== oldBox);
  await act(async () => {
    oldBox.click();
  });
  expect(paths('/ratings', true)).toHaveLength(0);
  directoryGate = deferred<Response>();
  const delayed = directoryGate;
  await paint(ids[0]!, extraCache);
  await until(() => directoryGate === undefined);
  await paint(subjectId, extraCache, { ...question, id: ids[1]! });
  await paint(subjectId, extraCache);
  delayed.resolve(Response.json({ populations: [{ population: ids[0], count: 777 }], next: null }));
  await until(() => boxes().length === 20);
  expect(host.textContent).not.toContain('777');
  await paint(subjectId, extraCache, question, false);
  expect(boxes()).toHaveLength(0);
  await paint(subjectId, extraCache);
  await until(() => boxes().length === 20);
  directoryGate = deferred<Response>();
  const afterUnmount = directoryGate;
  const active = extraCache
    .getQueryCache()
    .findAll({ queryKey: ['subject-rating-populations'] })
    .find((query) => query.queryKey[6] === 'directory')!;
  const refetch = extraCache.refetchQueries({ queryKey: active.queryKey });
  await until(() => directoryGate === undefined);
  await act(async () => root.unmount());
  mounted = false;
  afterUnmount.resolve(Response.json({ populations: [{ population: ids[0], count: 111 }], next: null }));
  await refetch.catch(() => {});
  await tick();
  expect(host.textContent).toBe('');
});

for (const [status, kind] of [
  [404, 'absent'],
  [403, 'unavailable'],
  [410, 'terminal'],
  [503, 'failed'],
] as const) {
  test(`public ${status} is ${kind}, never zero; every source has a serializable independent retry`, async () => {
    const { RatingsView } = await import('../src/features/pages/subject-ratings-view');
    for (const source of RATING_SOURCES) {
      sourceStatuses = { [source]: status };
      const before = requests.length;
      const data = await readRatings(native, subjectId);
      expect(requests.length - before).toBe(4);
      expect(data[source].kind).toBe(kind);
      for (const sibling of RATING_SOURCES.filter((candidate) => candidate !== source))
        expect(data[sibling].kind).toBe('ready');
      expect(JSON.parse(JSON.stringify(data))).toEqual(data);
      const html = renderToStaticMarkup(<RatingsView data={data} id="ratings" subject={subjectId} locale="en" />);
      expect(html).toContain(`data-source="${source}" data-state="${kind}"`);
      expect(html).not.toContain('No ratings yet');
      if (source !== 'figure') expect(html).toContain('data-slot="public-rating-figure"');
      if (source !== 'question' && source !== 'global') expect(html).toContain('data-slot="rating-distribution"');
      sourceStatuses = {};
      const retryBefore = requests.length;
      const retry = await readRatings(native, subjectId, source);
      expect(requests.length - retryBefore).toBe(1);
      expect(retry[source].kind).toBe('ready');
      for (const sibling of RATING_SOURCES.filter((candidate) => candidate !== source)) {
        expect(retry[sibling].kind).toBe('idle');
        expect(data[sibling].kind).toBe('ready');
      }
    }
  });
}

test('current Realm refusal conceals a previously selected identity and masked zero; fresh eligible reads recover it', async () => {
  await paint();
  await until(() => boxes().length === 20);
  await select(0);
  await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 1);
  denied.add(ids[0]!);
  const selectedQuery = directoryQueries().find((query) => query.queryKey[6] === 'selected')!;
  await act(async () => {
    await cache.refetchQueries({ queryKey: selectedQuery.queryKey });
  });
  await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 0);
  expect(host.textContent).not.toContain(names.get(ids[0]!)!);
  expect(host.textContent).not.toContain('No ratings yet');
  expect(boxes()).toHaveLength(19);
  expect(host.textContent).toContain(m.rating_population_concealed());
  await act(async () => button(m.rating_population_clear()).click());
  expect(host.textContent).not.toContain(names.get(ids[0]!)!);
  denied.clear();
  const directoryQuery = directoryQueries().find((query) => query.queryKey[6] === 'directory')!;
  await act(async () => {
    await cache.refetchQueries({ queryKey: directoryQuery.queryKey });
  });
  await until(() => boxes().length === 20);
  await select(0);
  await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 1);
  expect(host.textContent).toContain(names.get(ids[0]!)!);
});

test('a denied sparse directory page retains Next without disclosing a Realm identity or count or automatically refilling', async () => {
  denied = new Set(ids);
  sparse = true;
  const before = requests.length;
  const page = await readSubjectRatingPopulations({ data: input({ cursor: opaqueNext }) });
  expect(page.result).toEqual({ kind: 'ready', value: { items: [], next: null, incomplete: true } });
  expect(requests.length - before).toBe(21);
  for (const id of ids) expect(JSON.stringify(page)).not.toContain(id);
  expect(JSON.stringify(page)).not.toContain('count');
  // Native sparse continuation remains visible even when no currently readable row survives.
  directoryGate = deferred<Response>();
  const response = directoryGate;
  const pending = readSubjectRatingPopulations({ data: input() });
  await until(() => directoryGate === undefined);
  response.resolve(Response.json({ populations: [{ population: ids[0], count: 1000 }], next: opaqueNext }));
  const sparseDenied = await pending;
  expect(sparseDenied.result).toEqual({ kind: 'ready', value: { items: [], next: opaqueNext, incomplete: true } });
  expect(JSON.stringify(sparseDenied)).not.toContain('1000');
});

test('directory failure has a targeted retry and separate selected work; question revision replaces the visit', async () => {
  await paint();
  await until(() => boxes().length === 20);
  await select(0);
  await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 1);
  const selectedBefore = paths('/ratings', true).length;
  directoryStatus = 503;
  const query = directoryQueries().find((query) => query.queryKey[6] === 'directory')!;
  await act(async () => {
    await cache.refetchQueries({ queryKey: query.queryKey });
  });
  await until(() => host.querySelector('[data-source="directory"][data-state="failed"]') !== null);
  expect(host.querySelectorAll('[data-slot="rating-comparison"]')).toHaveLength(1);
  const oldRetry = host.querySelector<HTMLButtonElement>('[data-source="directory"] button')!;
  directoryStatus = 200;
  await act(async () => {
    oldRetry.click();
    await tick();
  });
  await until(() => boxes().length === 20);
  expect(paths('/ratings', true)).toHaveLength(selectedBefore);
  const oldBox = boxes()[1]!;
  await paint(subjectId, cache, { ...question, revision: 4 });
  await until(() => boxes().length === 20 && boxes()[1] !== oldBox);
  await act(async () => {
    oldBox.click();
    oldRetry.click();
  });
  expect(boxes().every((box) => !box.checked)).toBe(true);
  expect(paths('/ratings', true)).toHaveLength(selectedBefore);
  await select(1);
  await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 1);
});

test('fresh equal fetched private success rejects queued old choices before React commit and admits current choices', async () => {
  await paint();
  await until(() => boxes().length === 20);
  const oldBox = boxes()[0]!;
  const query = directoryQueries().find((query) => query.queryKey[6] === 'directory')!;
  const before = paths('/ratings', true).length;
  const unsubscribe = cache.getQueryCache().subscribe((event) => {
    if (event.query === query && event.type === 'updated' && event.action.type === 'success') oldBox.click();
  });
  await act(async () => {
    await cache.refetchQueries({ queryKey: query.queryKey });
  });
  unsubscribe();
  expect(paths('/ratings', true)).toHaveLength(before);
  expect(boxes()[0]!.checked).toBe(false);
  await select(0);
  await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 1);
});

test('independent QueryClients serialize private responses separately and require their actual prepared reader', async () => {
  await paint();
  await until(() => boxes().length === 20);
  const original = directoryQueries().find((query) => query.queryKey[6] === 'directory')!;
  const originalJson = JSON.stringify(original.state.data);
  preparedReader = 'reader-two';
  extraCache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  extraCache.setQueryData(sessionQuery.queryKey, session(preparedReader, null));
  await paint(subjectId, extraCache);
  await until(() => boxes().length === 20);
  const second = extraCache
    .getQueryCache()
    .findAll({ queryKey: ['subject-rating-populations'] })
    .find((query) => query.queryKey[6] === 'directory')!;
  expect(JSON.stringify(second.queryKey)).toContain('reader-two');
  expect(second.state.data).toMatchObject({ reader: 'reader-two' });
  expect(originalJson).toContain('reader-one');
  expect(JSON.stringify(second.state.data)).not.toContain('reader-one');
  expect(JSON.parse(JSON.stringify(dehydrate(extraCache)))).toMatchObject({ queries: expect.any(Array) });
});

test('native selected zero, privacy suppression and updating preserve distinct visible meanings without stale scores', async () => {
  await paint();
  await until(() => boxes().length === 20);
  count = 0;
  await select(0);
  await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 1);
  const selected = () => host.querySelector('[data-slot="rating-selected"]')!;
  expect(selected().textContent).toContain(m.subject_ratings_empty());
  count = 3;
  const query = directoryQueries().find((query) => query.queryKey[6] === 'selected')!;
  await act(async () => {
    await cache.refetchQueries({ queryKey: query.queryKey });
  });
  expect(selected().textContent).toContain(m.subject_ratings_remaining({ count: '2' }));
  expect(selected().textContent).not.toContain('out of 10');
  updating = true;
  count = 12;
  await act(async () => {
    await cache.refetchQueries({ queryKey: query.queryKey });
  });
  expect(selected().textContent).toContain(m.rating_public_updating());
  expect(selected().textContent).not.toContain('out of 10');
  updating = false;
  await act(async () => {
    await cache.refetchQueries({ queryKey: query.queryKey });
  });
  expect(selected().textContent).toContain('8 out of 10');
  expect(selected().textContent).toContain(
    m.rating_population_as_of({
      date: new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date('2026-11-01T00:00:00.000Z'),
      ),
    }),
  );
});

test('all four public requests start concurrently and growth in unrelated native history does not add consumer reads', async () => {
  const gates = new Map<string, ReturnType<typeof deferred<Response>>>();
  const concurrent = createKernelClient('https://kernel.test', {
    fetch: async (raw, init) => {
      const req = new Request(raw, init);
      expect(req.headers.has('authorization')).toBe(false);
      const path = new URL(req.url).pathname;
      const gate = deferred<Response>();
      gates.set(path, gate);
      return gate.promise;
    },
  });
  const pending = readRatings(concurrent, subjectId);
  await until(() => gates.size === 4);
  gates.get(`/v1/rating-questions/${QUESTION}`)!.resolve(Response.json(question));
  gates.get(`/v1/subjects/${subjectId}/figure`)!.resolve(Response.json({ figure: headline() }));
  gates
    .get(`/v1/subjects/${subjectId}/ratings`)!
    .resolve(Response.json({ subject: subjectId, question: QUESTION, figures: [aggregateFigure(GLOBAL)] }));
  gates.get(`/v1/subjects/${subjectId}/source-statistics`)!.resolve(Response.json({}, { status: 503 }));
  const outcome = await pending;
  expect(outcome.question.kind).toBe('ready');
  expect(outcome.figure.kind).toBe('ready');
  expect(outcome.global.kind).toBe('ready');
  expect(outcome.statistics.kind).toBe('failed');
  for (const history of [0, 10_000]) {
    nativePopulations = [
      ...ids.map((population) => ({ population, count: 1 })),
      ...Array.from({ length: history }, (_, index) => ({
        population: `01a1c000-0000-7000-8000-${String(index).padStart(12, '0')}`,
        count: 999_999,
      })),
    ];
    const before = requests.length;
    await readRatings(native, subjectId);
    expect(requests.length - before).toBe(4);
    const selectedBefore = requests.length;
    await readRatingPopulations(native, request(), sessionEnv, input({ selected: ids }));
    expect(requests.length - selectedBefore).toBe(21);
    expect(new URL(paths('/ratings', true).at(-1)!.url).searchParams.getAll('population')).toEqual(ids);
    expect(paths('/me/realms')).toHaveLength(0);
  }
});

test('Complete eight-locale/stories/current fixture caller compatibility; all connected assertions authored UNRUN', async () => {
  const { RatingsView } = await import('../src/features/pages/subject-ratings-view');
  const english = await Bun.file(new URL('../messages/en.json', import.meta.url)).json();
  const keys = Object.keys(english)
    .filter((key) => key.startsWith('rating_population_'))
    .sort();
  expect(keys.length).toBeGreaterThan(15);
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
    const messages = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json();
    expect(
      Object.keys(messages)
        .filter((key) => key.startsWith('rating_population_'))
        .sort(),
    ).toEqual(keys);
    for (const key of keys) expect(messages[key]).toEqual(expect.any(String));
    const data = await readRatings(native, subjectId);
    for (const kind of ['absent', 'terminal', 'unavailable', 'failed'] as const) {
      const html = renderToStaticMarkup(
        <RatingsView data={{ ...data, statistics: { kind } }} id="ratings" subject={subjectId} locale={locale} />,
      );
      expect(html).toContain(`data-source="statistics" data-state="${kind}"`);
      expect(html).not.toContain('rating_population_');
      expect(html).toContain('data-slot="public-rating-figure"');
    }
  }
  // The connected story plays use these existing viewport/locale globals; browser execution is deferred.
  const preview = await Bun.file(new URL('../.storybook/preview.tsx', import.meta.url)).text();
  expect(preview).toContain('phone390');
  expect(preview).toContain('desktop1280');
});

test('sign-out retires the private visit and fresh anonymous directory/selection responses use native readable populations', async () => {
  await paint();
  await until(() => boxes().length === 20);
  await select(0);
  await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 1);
  const oldBox = boxes()[1]!;
  await act(async () => {
    start.setStoryRequestContext({ visitor: 'Signed Out', url: window.location.href });
    cache.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    oldBox.click();
  });
  await until(() => boxes().length === 20 && boxes()[1] !== oldBox);
  expect(boxes().every((box) => !box.checked)).toBe(true);
  expect(host.querySelectorAll('[data-slot="rating-comparison"]')).toHaveLength(0);
  expect(paths('/ratings/populations').at(-1)!.headers.has('authorization')).toBe(false);
  await select(1);
  await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 1);
  const last = paths('/ratings').at(-1)!;
  expect(last.headers.has('authorization')).toBe(false);
  expect(new URL(last.url).searchParams.getAll('population')).toEqual([ids[1]!]);
  const key = directoryQueries().find((query) => query.queryKey[6] === 'selected')!;
  expect(key.queryKey[4]).toBeNull();
  expect(key.state.data).toMatchObject({ reader: null });
  const mismatch = await readRatingPopulations(native, request(), sessionEnv, input({ expectedReader: null }));
  expect(mismatch).toMatchObject({ reader: preparedReader, result: { kind: 'unavailable' } });
});

test('transport replacement retires held work and recovers through the fresh actual server reader', async () => {
  cache.setQueryData(sessionQuery.queryKey, session(preparedReader, null));
  const firstRead = (data: PopulationInput) => readSubjectRatingPopulations({ data });
  const secondRead = (data: PopulationInput) => readSubjectRatingPopulations({ data });
  const render = async (read: typeof firstRead) =>
    act(async () => {
      root.render(
        <QueryClientProvider client={cache}>
          <SubjectRatingPopulations
            subjectId={subjectId}
            question={question}
            locale="en"
            session={session(preparedReader, null)}
            read={read}
          />
        </QueryClientProvider>,
      );
      await tick();
    });
  directoryGate = deferred<Response>();
  const old = directoryGate;
  await render(firstRead);
  await until(() => directoryGate === undefined);
  await render(secondRead);
  await until(() => boxes().length === 20);
  old.resolve(Response.json({ populations: [{ population: ids[0], count: 444 }], next: null }));
  await act(tick);
  expect(boxes()).toHaveLength(20);
  expect(host.textContent).not.toContain('444');
  await select(0);
  await until(() => host.querySelectorAll('[data-slot="rating-comparison"]').length === 1);
});
