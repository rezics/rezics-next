import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import * as fixture from './fixtures.ts';
import type { Loaded } from './types.ts';
import { messages } from '../work-page/messages.ts';
import { ACCESS_COOKIE, SESSION_KEY_COOKIE } from '../auth/cookies.ts';
import { relationRows } from './relation-rows.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { resourceHref } from '../address/path.ts';

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
await mock.module('next/headers', () => ({
  ...originalHeaders,
  cookies: async () => ({
    get: (name: string) => {
      if (!signedIn) return undefined;
      if (name === ACCESS_COOKIE) return { value: expired ? expiredToken : 'current-token' };
      if (name === SESSION_KEY_COOKIE) return { value: sessionKey };
      return undefined;
    },
  }),
  headers: async () => new Headers(),
}));
// Keep reader(), sessionAgentState() and Main's Eden client real. Only the HTTP
// transport answers fixture data, including a rejected expired session lookup.
await mock.module('../api/server-read.ts', () => ({
  ...originalTransport,
  serverRead: async (input: RequestInfo | URL, init?: RequestInit) => {
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
    if (url.pathname === '/v1/resources/summaries')
      return respond({ summaries: [...fixture.names.values()] });
    if (url.pathname.startsWith('/v1/collections/')) {
      collectionCalls += 1;
      return respond({ collection: fixture.iri('900'), occurrences: [], next: null });
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
    const result = answer(operation, query);
    return respond(result.error ?? result.data, result.error?.status ?? 200);
  },
}));
await mock.module('../tracking/series-progress-panel.tsx', () => ({
  ...originalTracking,
  SeriesProgressPanel: () =>
    createElement('aside', { 'data-personal-progress': true }, 'Personal progress'),
}));
await mock.module('next/navigation', () => ({
  ...originalNavigation,
  useRouter: () => ({ refresh() {} }),
}));
afterAll(async () => {
  await mock.module('next/headers', () => originalHeaders);
  await mock.module('../api/server-read.ts', () => originalTransport);
  await mock.module('../tracking/series-progress-panel.tsx', () => originalTracking);
  await mock.module('next/navigation', () => originalNavigation);
});

const { readParts, readWholes, readRelations, readCollectionMembers } = await import('./read.ts');
const { Parts } = await import('../work-page/hub-sections.tsx');
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
  requests.length = 0;
  signedIn = false;
  expired = false;
  actingSubject = undefined;
  answer = (operation) => ({ data: pages[operation], error: null });
});

async function hub(workRef: string) {
  const tree = await Parts({ id: fixture.current, workRef, locale: 'en', messages: messages.en });
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
  });

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
  ).toEqual({ ok: false, failure: 'moved' });
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
      expect(await reads[operation](fixture.current, {})).toEqual({ ok: false, failure });
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

test('collection reads still require an eligible Agent', async () => {
  for (const visitor of visitors) {
    signedIn = visitor.signedIn;
    expired = visitor.expired;
    expect(await readCollectionMembers(fixture.iri('900'), {})).toEqual({
      ok: false,
      failure: signedIn ? 'identity' : 'sign-in',
    });
  }
  expect(collectionCalls).toBe(0);
  actingSubject = fixture.iri('agent');
  expect((await readCollectionMembers(fixture.iri('900'), {})).ok).toBe(true);
  expect(collectionCalls).toBe(1);
});
