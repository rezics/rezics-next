import { replaceModule } from '../../tests/support/module-replacement.ts';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import * as fixture from './fixtures.ts';
import type { Loaded } from './types.ts';
import { messages } from '../work-page/messages.ts';
import { ACCESS_COOKIE, SESSION_KEY_COOKIE } from '../auth/cookies.ts';
import { relationRows } from './relation-rows.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { resourceHref } from '../address/path.ts';
import { serverFetch } from '../api/server-fetch.ts';

const originalHeaders = { ...(await import('next/headers')) };
const originalTransport = { ...(await import('../api/server-read.ts')) };
const originalTracking = { ...(await import('../tracking/series-progress-panel.tsx')) };
const originalNavigation = { ...(await import('next/navigation')) };
type Query = Record<string, unknown>;
type Operation = 'parts' | 'wholes' | 'relations';
type Answer = { data: unknown; error: { status: number } | null };
const calls: { operation: Operation; resource: string; query: Query }[] = [];
let signedIn = false;
let expired = false;
let actingSubject: string | undefined;
let answer: (operation: Operation, query: Query) => Answer;
let collectionCalls = 0;
let collectionStatus = 200;
let summaryStatus = 200;
let collectionGroups = false;
const collectionQueries: URLSearchParams[] = [];
const collectionSummary = fixture.summary(fixture.iri('900'), 'Public reading list', 'en', 'collection');
let pageDeadline: number | undefined;
let stallParts = false;
const requests: { path: string; authorization: string | null; status: number }[] = [];
const sessionKey = '01944100-0000-7000-8000-000000000999';
// Main rejects this bearer as expired; the public reads must never carry it.
const expiredToken = `e30.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.expired`;
function disclosed<T>(page: Loaded<T>): T {
  if (!page.ok) throw new Error('The public fixture must be disclosed');
  return page.data;
}
const pages = {
  parts: disclosed(fixture.parts),
  wholes: disclosed(fixture.wholes),
  relations: disclosed(fixture.relations),
};
const restoreOriginalHeaders = replaceModule(import.meta.resolve('next/headers'), originalHeaders, {
  cookies: async () => ({
    get: (name: string) => {
      if (!signedIn) return undefined;
      if (name === ACCESS_COOKIE) return { value: expired ? expiredToken : 'current-token' };
      if (name === SESSION_KEY_COOKIE) return { value: sessionKey };
      return undefined;
    },
  }),
  headers: async () => new Headers(),
});
// Keep reader(), sessionAgentState() and Main's Eden client real. Only the HTTP
// transport answers fixture data, including a rejected expired session lookup.
const restoreOriginalTransport = replaceModule(import.meta.resolve('../api/server-read.ts'), originalTransport, {
  serverRead: (input: RequestInfo | URL, init?: RequestInit) =>
    serverFetch(input, init, {
      deadlineAt: pageDeadline,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const authorization = new Headers(init?.headers).get('authorization');
        const respond = (data: unknown, status = 200) => {
          requests.push({ path: url.pathname, authorization, status });
          return Response.json(data, { status });
        };
        if (url.pathname === '/v1/me/session-agent') {
          expect(authorization).toBe(`Bearer ${expired ? expiredToken : 'current-token'}`);
          expect(new Headers(init?.headers).get('x-session-key')).toBe(sessionKey);
          if (expired) return respond({ error: 'expired' }, 401);
          const agent = {
            eligible: Boolean(actingSubject),
            actingSubject: actingSubject ?? null,
            revision: null,
          };
          return respond({ sessionAgent: agent, mainAgent: agent, initialActingSubject: null });
        }
        if (expired && authorization) return respond({ error: 'expired' }, 401);
        if (url.pathname === '/v1/me/person-preferences') return respond({ contentLanguages: [] });
        if (url.pathname === '/v1/resources/summaries') {
          if (summaryStatus !== 200) return respond({ code: 'summary_unavailable' }, summaryStatus);
          const body = JSON.parse(String(init?.body)) as { resources: string[] };
          return respond({
            summaries: body.resources.flatMap((reference) => reference === fixture.iri('900')
              ? [collectionSummary] : fixture.names.get(reference) ?? []),
          });
        }
        if (url.pathname.startsWith('/v1/collections/')) {
          collectionCalls += 1;
          collectionQueries.push(url.searchParams);
          if (collectionStatus !== 200) return respond({ code: 'collection_unavailable' }, collectionStatus);
          const second = url.searchParams.get('after') === 'members-page-2';
          return respond({ collection: fixture.iri('900'), occurrences: [{
            occurrence: fixture.iri(second ? '82' : '81'), role: 'member', parent: fixture.iri('9'),
            target: fixture.iri(second ? '200' : '100'), orderKey: 'a', labels: [],
          }, ...(collectionGroups ? [{ occurrence: fixture.iri('83'), role: 'group', parent: fixture.iri('9'),
            orderKey: 'b', labels: [{ value: 'مكتبة الأدب', language: 'ar' }] }] : [])], next: second ? null : 'members-page-2' });
        }
        const match = url.pathname.match(/^\/v1\/resources\/([^/]+)\/(parts|wholes|relations)$/);
        if (!match) throw new Error(`Unexpected Main request: ${url.pathname}`);
        const operation = match[2] as Operation;
        const query: Query = {
          actingSubject: url.searchParams.get('actingSubject') ?? undefined,
          after: url.searchParams.get('after') ?? undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
          ...(operation === 'parts' ? { parent: url.searchParams.get('parent') ?? undefined } : {}),
        };
        calls.push({ operation, resource: decodeURIComponent(match[1]!), query });
        if (operation === 'parts' && stallParts) return new Promise<Response>(() => {});
        const result = answer(operation, query);
        return respond(result.error ?? result.data, result.error?.status ?? 200);
      },
    }),
});
const restoreOriginalTracking = replaceModule(import.meta.resolve('../tracking/series-progress-panel.tsx'), originalTracking, {
  SeriesProgressPanel: () =>
    createElement('aside', { 'data-personal-progress': true }, 'Personal progress'),
});
const restoreOriginalNavigation = replaceModule(import.meta.resolve('next/navigation'), originalNavigation, {
  useRouter: () => ({ refresh() {} }),
});
afterAll(async () => {
  restoreOriginalHeaders();
  restoreOriginalTransport();
  restoreOriginalTracking();
  restoreOriginalNavigation();
});

const { readParts, readWholes, readRelations, readCollectionMembers, readPublicCollectionPage } = await import('./read.ts');
const { default: EntityRoute, generateMetadata } = await import('../../app/[locale]/e/[ref]/page.tsx');
const { PublicCollectionPage, collectionPageHref } = await import('./connections.tsx');
const { Parts } = await import('../work-page/hub-sections.tsx');
const { ConnectionsPage } = await import('./pages.tsx');
const reads: Record<
  Operation,
  (
    id: string,
    query: { after?: string; limit?: number },
  ) => Promise<Loaded<(typeof pages)[Operation]>>
> = { parts: readParts, wholes: readWholes, relations: readRelations };
const visitors = [
  { name: 'anonymous', signedIn: false, expired: false },
  { name: 'expired session', signedIn: true, expired: true },
  { name: 'signed in without an Agent', signedIn: true, expired: false },
];
const hubs = ['anime', 'manga', 'vn'];

function assertPublicTransport(visitor: (typeof visitors)[number]) {
  const lookups = requests.filter((request) => request.path === '/v1/me/session-agent');
  if (visitor.signedIn) {
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((request) => request.status === (visitor.expired ? 401 : 200))).toBe(true);
  } else expect(lookups).toEqual([]);
  const publicReads = requests.filter((request) => request.path.startsWith('/v1/resources/'));
  expect(publicReads.length).toBeGreaterThan(0);
  expect(publicReads.every((request) => request.authorization === null)).toBe(true);
}

beforeEach(() => {
  calls.length = 0;
  collectionCalls = 0;
  collectionQueries.length = 0;
  collectionStatus = 200;
  summaryStatus = 200;
  collectionGroups = false;
  requests.length = 0;
  signedIn = false;
  expired = false;
  actingSubject = undefined;
  pageDeadline = undefined;
  stallParts = false;
  answer = (operation) => ({ data: pages[operation], error: null });
});

async function hub(workRef: string) {
  const tree = await Parts({ id: fixture.current, workRef, locale: 'en', messages: messages.en });
  return markupOf(tree);
}

async function markupOf(tree: ReactNode) {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(tree, {
    onError: (error) => {
      errors.push(error);
    },
  });
  await stream.allReady;
  expect(errors).toEqual([]);
  return new Response(stream).text();
}

for (const visitor of visitors)
  describe(visitor.name, () => {
    for (const operation of ['parts', 'wholes', 'relations'] as const) {
      test(`pages disclosed ${operation} through Main`, async () => {
        signedIn = visitor.signedIn;
        expired = visitor.expired;
        const query = { after: 'page-2', limit: 7 };
        expect(await reads[operation](fixture.current, query)).toEqual({
          ok: true,
          data: pages[operation],
        });
        expect(calls).toEqual([
          {
            operation,
            resource: fixture.current,
            query: {
              ...query,
              actingSubject: undefined,
              ...(operation === 'parts' ? { parent: undefined } : {}),
            },
          },
        ]);
        assertPublicTransport(visitor);
      });
    }
    for (const medium of hubs)
      test(`renders disclosed structure on the ${medium} hub`, async () => {
        signedIn = visitor.signedIn;
        expired = visitor.expired;
        const markup = await hub(`${medium}-series`);
        expect(markup).toContain('A Certain Magical Index NT 1');
        expect(markup).toContain('Part of');
        expect(markup).toContain(relationRows(pages.relations.items)[1]!.label.text!.value);
        expect(markup).toContain(`${medium}-series/connections`);
        expect(markup).not.toContain('Sign in');
        expect(markup).not.toContain('data-personal-progress');
        expect(calls.map((call) => call.operation).sort()).toEqual([
          'parts',
          'relations',
          'wholes',
        ]);
        assertPublicTransport(visitor);
      });

    test('renders distinct continuation pages for parts, wholes and relations', async () => {
      signedIn = visitor.signedIn;
      expired = visitor.expired;
      answer = (operation, query) => {
        const second = query.after === `${operation}-page-2`;
        const next = second ? null : `${operation}-page-2`;
        if (operation === 'parts')
          return {
            data: {
              ...pages.parts,
              parts: [pages.parts.parts[second ? 1 : 0]!],
              next,
            },
            error: null,
          };
        if (operation === 'wholes')
          return {
            data: {
              ...pages.wholes,
              wholes: [{ ...pages.wholes.wholes[0]!, work: fixture.iri(second ? '300' : '200') }],
              next,
            },
            error: null,
          };
        const entry = pages.relations.items[1]!;
        const target = fixture.summary(
          fixture.iri(second ? '401' : '400'),
          second ? 'Second-page relation' : 'First-page relation',
        );
        return {
          data: {
            ...pages.relations,
            items: [
              {
                ...entry,
                rendering: {
                  ...entry.rendering!,
                  projections: entry.rendering!.projections.map((projection) => ({
                    ...projection,
                    arguments: [
                      {
                        role: projection.toRole,
                        type: 'resource',
                        value: { kind: 'resource', ref: target.reference },
                      },
                    ],
                  })),
                },
                counterparts: [target],
              },
            ],
            next,
          },
          error: null,
        };
      };
      const renderPage = (second: boolean) =>
        ConnectionsPage({
          id: fixture.current,
          workRef: 'anime-series',
          locale: 'en',
          pageMessages: messages.en,
          query: {
            grain: 'series',
            ...(second
              ? {
                  partsAfter: 'parts-page-2',
                  wholesAfter: 'wholes-page-2',
                  relationsAfter: 'relations-page-2',
                }
              : {}),
          },
        }).then(markupOf);
      const first = await renderPage(false);
      for (const cursor of ['parts', 'wholes', 'relations'])
        expect(first).toContain(`${cursor}After=${cursor}-page-2`);
      expect(first).toContain('A Certain Magical Index NT 1');
      expect(first).toContain('First-page relation');
      const second = await renderPage(true);
      expect(second).toContain('A Certain Magical Index NT 22');
      expect(second).toContain('とある魔術の禁書目録');
      expect(second).toContain('Second-page relation');
      expect(second).not.toContain('A Certain Magical Index NT 1');
      expect(second).not.toContain('First-page relation');
      // The named whole's link changes independently from the parts and relations.
      expect(first).toContain(
        localizedPath(resourceHref('/w/', fixture.iri('200').slice(-36)), 'en'),
      );
      expect(second).not.toContain(
        localizedPath(resourceHref('/w/', fixture.iri('200').slice(-36)), 'en'),
      );
      expect(second).toContain(
        localizedPath(resourceHref('/w/', fixture.iri('300').slice(-36)), 'en'),
      );
      expect(
        calls
          .slice(-3)
          .map((call) => [call.operation, call.query.after])
          .sort(),
      ).toEqual([
        ['parts', 'parts-page-2'],
        ['relations', 'relations-page-2'],
        ['wholes', 'wholes-page-2'],
      ]);
      assertPublicTransport(visitor);
    });
  });

for (const surface of ['hub', 'connections'] as const) {
  test(`${surface} names disclosed wholes before a stalled parts read exhausts the page deadline`, async () => {
    // The real transport consumes a residual page budget; abort-ignoring parts
    // must not postpone the successful whole's dependent summary request.
    pageDeadline = Date.now() + 200;
    stallParts = true;
    const markup =
      surface === 'hub'
        ? await hub('anime-series')
        : await markupOf(
            await ConnectionsPage({
              id: fixture.current,
              workRef: 'anime-series',
              locale: 'en',
              pageMessages: messages.en,
              query: { grain: 'series' },
            }),
          );
    expect(markup).toContain('Part of');
    const wholeList = markup.match(
      /<ul[^>]*aria-label="Wholes that contain this Work"[^]*?<\/ul>/,
    )?.[0];
    expect(wholeList).toContain('A Certain Magical Index');
    expect(wholeList).toContain(
      localizedPath(resourceHref('/w/', fixture.iri('200').slice(-36)), 'en'),
    );
    expect(requests.some((request) => request.path === '/v1/resources/summaries')).toBe(true);
  });
}

test('an eligible Agent is forwarded to all public reads and keeps personal progress', async () => {
  signedIn = true;
  actingSubject = fixture.iri('agent');
  const markup = await hub('anime-series');
  expect(markup).toContain('data-personal-progress');
  expect(calls).toHaveLength(3);
  expect(calls.every((call) => call.query.actingSubject === actingSubject)).toBe(true);
  expect(
    requests
      .filter((request) => request.path.startsWith('/v1/resources/'))
      .every((request) => request.authorization === 'Bearer current-token'),
  ).toBe(true);
  expect(await readWholes(fixture.current)).toEqual({ ok: true, data: pages.wholes });
  expect(calls.at(-1)?.query.limit).toBe(20);
});

for (const failed of ['parts', 'wholes', 'relations'] as const) {
  for (const failure of ['missing', 'timeout'] as const) {
    test(`${failed} ${failure} leaves the other public hub reads visible`, async () => {
      answer = (operation) => {
        if (operation !== failed) return { data: pages[operation], error: null };
        if (failure === 'timeout') throw new Error('Main read timed out');
        return { data: null, error: { status: 404 } };
      };
      const markup = await hub('anime-series');
      if (failed !== 'parts') expect(markup).toContain('A Certain Magical Index NT 1');
      if (failed !== 'wholes') {
        expect(markup).toContain('Part of');
        expect(markup).toContain(
          localizedPath(resourceHref('/w/', fixture.iri('200').slice(-36)), 'en'),
        );
      }
      if (failed !== 'relations')
        expect(markup).toContain(relationRows(pages.relations.items)[1]!.label.text!.value);
      expect(calls.map((call) => call.operation).sort()).toEqual(['parts', 'relations', 'wholes']);
    });
  }
}

test('parent and continuation are passed through without restarting a moved page', async () => {
  answer = () => ({ data: null, error: { status: 409 } });
  expect(
    await readParts(fixture.current, { parent: fixture.current, after: 'page-2', limit: 3 }),
  ).toEqual({ ok: false, failure: 'moved', status: 409, problem: { status: 409 } });
  expect(calls).toEqual([
    {
      operation: 'parts',
      resource: fixture.current,
      query: {
        actingSubject: undefined,
        parent: fixture.iri('100'),
        after: 'page-2',
        limit: 3,
      },
    },
  ]);
});

for (const operation of ['parts', 'wholes', 'relations'] as const) {
  test(`${operation} restarts a moved first page once`, async () => {
    answer = () =>
      calls.length === 1
        ? { data: null, error: { status: 409 } }
        : { data: pages[operation], error: null };
    expect(await reads[operation](fixture.current, {})).toEqual({
      ok: true,
      data: pages[operation],
    });
    expect(calls).toHaveLength(2);
  });
  test(`${operation} preserves Main's denied, private and deleted target outcomes`, async () => {
    for (const [status, failure] of [
      [403, 'sign-in'],
      [404, 'missing'],
      [410, 'missing'],
    ] as const) {
      answer = () => ({ data: null, error: { status } });
      expect(await reads[operation](fixture.current, {})).toEqual({
        ok: false, failure, status, problem: { status },
      });
    }
  });
}

test('the hub renders only the structure Main discloses, including withheld targets', async () => {
  answer = (operation) => ({
    data:
      operation === 'parts'
        ? { ...pages.parts, parts: [] }
        : operation === 'wholes'
          ? { ...pages.wholes, wholes: [] }
          : { ...pages.relations, items: [] },
    error: null,
  });
  const markup = await hub('vn-series');
  expect(markup).not.toContain('A Certain Magical Index');
  expect(markup).not.toContain(relationRows(pages.relations.items)[1]!.label.text!.value);
  expect(calls).toHaveLength(3);
});

test('private and deleted hub targets never render disclosed fixture names', async () => {
  for (const status of [403, 404, 410]) {
    answer = () => ({ data: null, error: { status } });
    expect(await hub('manga-series')).not.toContain('A Certain Magical Index');
  }
});

test('public Collection members reach Main for anonymous, expired and Agent-less readers', async () => {
  for (const visitor of visitors) {
    signedIn = visitor.signedIn;
    expired = visitor.expired;
    const page = await readCollectionMembers(fixture.iri('900'), {});
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.data.members[0]?.target).toBe(fixture.iri('100'));
  }
  expect(collectionCalls).toBe(visitors.length);
  actingSubject = fixture.iri('agent');
  expect((await readCollectionMembers(fixture.iri('900'), {})).ok).toBe(true);
  expect(collectionCalls).toBe(visitors.length + 1);
  expect(collectionQueries.at(-1)?.get('actingSubject')).toBe(actingSubject!);
});

test('the Collection entry and metadata use meaningful members and canonical names without an entity page call', async () => {
  collectionGroups = true;
  const params = Promise.resolve({ ref: fixture.iri('900').slice(-36) });
  const query = { language: 'sv', tag: ['a', 'b'] };
  const metadata = await generateMetadata({ params, searchParams: Promise.resolve(query) });
  expect(metadata.title).toBe('Public reading list');
  const first = await markupOf(await EntityRoute({ params, searchParams: Promise.resolve(query) }));
  expect(first).toContain('Public reading list');
  expect(first).toContain('A Certain Magical Index: New Testament');
  expect(first).toContain('مكتبة الأدب');
  expect(first).toContain(`parent=${encodeURIComponent(fixture.iri('83'))}`);
  expect(first).not.toContain('Sign in');
  expect(first).toContain('language=sv&amp;tag=a&amp;tag=b&amp;after=members-page-2');
  const second = await markupOf(await EntityRoute({ params,
    searchParams: Promise.resolve({ ...query, after: 'members-page-2' }) }));
  expect(second).toContain('A Certain Magical Index</bdi>');
  expect(second).not.toContain('A Certain Magical Index: New Testament');
  expect(collectionQueries.map(query => query.get('after'))).toEqual([null, 'members-page-2']);
  expect(requests.some(request => request.path.endsWith('/page'))).toBe(false);
});

test('temporary resource admission failure never requests an unsupported generic entity capability', async () => {
  summaryStatus = 503;
  const props = { params: Promise.resolve({ ref: fixture.iri('900').slice(-36) }), searchParams: Promise.resolve({}) };
  const metadata = await generateMetadata(props);
  expect(metadata.robots).toEqual({ index: false });
  const markup = await markupOf(await EntityRoute(props));
  expect(markup).toContain('role="alert"');
  expect(markup).toContain('Retry');
  expect(requests.every(request => request.path === '/v1/resources/summaries')).toBe(true);
});

test('Collection continuation preserves all task selections and reports owner failure without a successful member list', async () => {
  const current = `${resourceHref('/e/', fixture.iri('900'))}?after=old&parent=group&language=sv&tag=a&tag=b`;
  expect(collectionPageHref(current, { after: 'next+page' })).toBe(
    `${resourceHref('/e/', fixture.iri('900'))}?after=next%2Bpage&parent=group&language=sv&tag=a&tag=b`);
  collectionStatus = 503;
  const page = await readPublicCollectionPage(fixture.iri('900'), { after: 'old', parent: fixture.iri('9') });
  expect(page).toMatchObject({ ok: false, failure: 'unavailable', status: 503 });
  const markup = await markupOf(createElement(PublicCollectionPage, {
    summary: collectionSummary as Extract<typeof collectionSummary, { status: 'available' }>, page,
    currentUrl: current, locale: 'en', messages: messages.en,
  }));
  expect(markup).toContain('role="alert"');
  expect(markup).toContain('Retry');
  expect(markup).not.toContain('A Certain Magical Index');
  collectionStatus = 200;
  summaryStatus = 503;
  expect(await readPublicCollectionPage(fixture.iri('900'), {})).toMatchObject({ ok: false, failure: 'unavailable', status: 503 });
});

test('a denied Collection member read remains missing while an admitted signed-in read keeps its acting Agent', async () => {
  collectionStatus = 404;
  expect(await readPublicCollectionPage(fixture.iri('900'), {})).toMatchObject({ ok: false, failure: 'missing', status: 404 });
  signedIn = true;
  actingSubject = fixture.iri('999');
  collectionStatus = 200;
  expect((await readPublicCollectionPage(fixture.iri('900'), {})).ok).toBe(true);
  expect(collectionQueries.at(-1)?.get('actingSubject')).toBe(actingSubject!);
});
