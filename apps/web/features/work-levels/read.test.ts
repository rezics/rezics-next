import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import * as fixture from './fixtures.ts';
import type { Loaded } from './types.ts';
import { messages } from '../work-page/messages.ts';

const originalReader = { ...(await import('../work-page/read.ts')) };
const originalTracking = { ...(await import('../tracking/series-progress-panel.tsx')) };
const originalNavigation = { ...(await import('next/navigation')) };
type Query = Record<string, unknown>;
type Operation = 'parts' | 'wholes' | 'relations';
type Answer = { data: unknown; error: { status: number } | null };
const calls: { operation: Operation; resource: string; query: Query }[] = [];
let signedIn = false;
let actingSubject: string | undefined;
let answer: (operation: Operation, query: Query) => Answer;
let collectionCalls = 0;
function disclosed<T>(page: Loaded<T>): T {
  if (!page.ok) throw new Error('The public fixture must be disclosed');
  return page.data;
}
const pages = {
  parts: disclosed(fixture.parts),
  wholes: disclosed(fixture.wholes),
  relations: disclosed(fixture.relations),
};
const main = {
  v1: {
    resources: Object.assign(
      ({ resource }: { resource: string }) =>
        Object.fromEntries(
          (['parts', 'wholes', 'relations'] as const).map((operation) => [
            operation,
            {
              get: async ({ query }: { query: Query }) => {
                calls.push({ operation, resource, query });
                return answer(operation, query);
              },
            },
          ]),
        ),
      {
        summaries: {
          post: async () => ({ data: { summaries: [...fixture.names.values()] }, error: null }),
        },
      },
    ),
    collections: () => ({
      get: async () => {
        collectionCalls += 1;
        return {
          data: { collection: fixture.iri('900'), occurrences: [], next: null },
          error: null,
        };
      },
    }),
  },
};

await mock.module('../work-page/read.ts', () => ({
  ...originalReader,
  reader: async () => ({ main, signedIn, actingSubject }),
  readingAgent: async () => ({ signedIn, actingSubject: actingSubject ?? null }),
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
  await mock.module('../work-page/read.ts', () => originalReader);
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
  { name: 'anonymous', signedIn: false },
  // An expired bearer leaves a cookie, but reader() supplies the public client without an Agent.
  { name: 'expired session', signedIn: true },
  { name: 'signed in without an Agent', signedIn: true },
];
const hubs = ['anime', 'manga', 'vn'];

beforeEach(() => {
  calls.length = 0;
  collectionCalls = 0;
  signedIn = false;
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
      });
    }
    for (const medium of hubs)
      test(`renders disclosed structure on the ${medium} hub`, async () => {
        signedIn = visitor.signedIn;
        const markup = await hub(`${medium}-series`);
        expect(markup).toContain('A Certain Magical Index NT 1');
        expect(markup).toContain('Part of');
        expect(markup).toContain('Spin-offs');
        expect(markup).toContain(`${medium}-series/connections`);
        expect(markup).not.toContain('Sign in');
        expect(markup).not.toContain('data-personal-progress');
        expect(calls.map((call) => call.operation).sort()).toEqual([
          'parts',
          'relations',
          'wholes',
        ]);
      });
  });

test('an eligible Agent is forwarded to all public reads and keeps personal progress', async () => {
  signedIn = true;
  actingSubject = fixture.iri('agent');
  const markup = await hub('anime-series');
  expect(markup).toContain('data-personal-progress');
  expect(calls).toHaveLength(3);
  expect(calls.every((call) => call.query.actingSubject === actingSubject)).toBe(true);
  expect(await readWholes(fixture.current)).toEqual({ ok: true, data: pages.wholes });
  expect(calls.at(-1)?.query.limit).toBe(20);
});

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
  expect(markup).not.toContain('Spin-offs');
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
