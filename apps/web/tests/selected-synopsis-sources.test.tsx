import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import * as start from '../.storybook/react-start';
import { candidateContext } from '../src/subject/candidates';
import { summaryReadingFragment } from '../src/features/pages/subject-visit-navigation';
import {
  readSelectedSynopsisSources,
  selectedSynopsisSourceIntent,
  synopsisSourcesVisit,
  type SelectedSynopsisSource,
  type SelectedSynopsisSourceOutcome,
} from '../src/features/catalogue/selected-synopsis-source';
import { explainSubjectSources } from '../src/features/catalogue/subject-sources';
import { catalogueSourcesFixture, sourceDefinitions } from '../src/kernel/fake/catalogue-sources';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

const id = '00000000-0000-4000-8000-000000000001';
const candidate = '00000000-0000-4000-8000-000000000002';
const document = '00000000-0000-4000-8000-000000000003';
const release = 'a'.repeat(64);
const digest = 'b'.repeat(64);
const via = (changes = {}) =>
  `/en/subjects/${id}/selected${summaryReadingFragment({
    candidateId: candidate,
    documentId: document,
    digest,
    language: 'ja',
    locale: 'en',
    context: candidateContext,
    release,
    source: '7',
    focus: 'evidence',
    ...changes,
  })}`;
const request = (changes = {}) => ({ id, locale: 'en', via: via(), ...changes });
const source: SelectedSynopsisSource = {
  subject: id,
  context: candidateContext,
  release,
  type: 'schema:Book',
  labels: { en: 'Selected' },
  related: {},
  statement: {
    id: candidate,
    property: { id: 'schema:abstract', data_type: 'document' },
    value: { type: 'somevalue' },
    qualifiers: [],
    references: [
      { parts: [] },
      {
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: 'https://example.org/exact-support' },
          },
        ],
      },
    ],
  },
};

test('one admitted original selection reaches the native seam, retaining language and observations without a general read', async () => {
  const intents: unknown[] = [];
  let definitions = 0;
  const result = await readSelectedSynopsisSources(
    async (intent) => {
      intents.push(intent);
      return { kind: 'ready', source };
    },
    request(),
    async () => {
      definitions++;
      return sourceDefinitions;
    },
  );
  expect(intents).toEqual([
    {
      subject: id,
      holder: id,
      property: 'schema:abstract',
      context: candidateContext,
      candidate,
      document,
      digest,
      language: 'ja',
      locale: 'en',
      observedRelease: release,
      observedRevision: '7',
    },
  ]);
  expect(definitions).toBe(1);
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Missing exact source projection');
  expect(result.page.fields).toHaveLength(1);
  expect(result.page.fields[0]?.facts).toHaveLength(1);
  expect(result.page.fields[0]?.facts[0]).toMatchObject({
    statement: candidate,
    display: 'document',
    snak: { value: { type: 'somevalue' } },
    citations: [
      [],
      [
        expect.objectContaining({
          snak: expect.objectContaining({ value: { type: 'value', content: 'https://example.org/exact-support' } }),
        }),
      ],
    ],
  });
  expect(result.page.sources).toEqual({ credit: null, records: [], urls: [], identifiers: [] });
  expect(result.page.selection).toEqual({ kind: 'synopsis', context: candidateContext, release });
  const serialized = JSON.stringify(result);
  for (const privateValue of [document, digest, 'observedRevision', 'observedRelease'])
    expect(serialized).not.toContain(privateValue);
  const { SubjectSourcesPage } = await import('../src/features/catalogue/subject-sources-page');
  const root = createRootRoute({ component: () => <SubjectSourcesPage result={result} locale="en" /> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const client = new QueryClient();
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  client.clear();
  expect(markup).toContain('https://example.org/exact-support');
  expect(markup).toContain('source-statement');
  expect(markup).not.toContain('sources_metadata');
  for (const privateValue of [document, digest]) expect(markup).not.toContain(privateValue);
});

test('malformed, unsupported and changed visits do not resolve Global or substitute another assertion', async () => {
  let native = 0;
  let definitions = 0;
  const operation = async (): Promise<SelectedSynopsisSourceOutcome> => {
    native++;
    return { kind: 'changed' };
  };
  const labels = async () => {
    definitions++;
    return sourceDefinitions;
  };
  expect(selectedSynopsisSourceIntent(id, 'en', via())).toMatchObject({ kind: 'selected' });
  for (const input of [
    request({ via: undefined }),
    request({ via: via({ digest: 'invalid' }) }),
    request({ id: document }),
    request({ locale: 'ja' }),
  ]) {
    expect(await readSelectedSynopsisSources(operation, input, labels)).toEqual({ kind: 'invalid' });
  }
  for (const input of [request({ realm: document }), request({ via: via({ context: document }) })]) {
    expect(await readSelectedSynopsisSources(operation, input, labels)).toEqual({ kind: 'unsupported' });
  }
  expect(native).toBe(0);
  expect(await readSelectedSynopsisSources(null, request(), labels)).toEqual({ kind: 'unsupported' });
  for (const kind of ['changed', 'missing', 'denied', 'invalid', 'unavailable', 'unsupported'] as const) {
    expect(
      await readSelectedSynopsisSources(
        async () => {
          native++;
          return { kind };
        },
        request(),
        labels,
      ),
    ).toEqual({ kind });
  }
  expect(native).toBe(6);
  expect(definitions).toBe(0);
  expect(synopsisSourcesVisit({ via: via() })).toEqual({});
  expect(synopsisSourcesVisit({ sourceView: 'selected-synopsis', via: via() })).toEqual({
    sourceView: 'selected-synopsis',
    via: via(),
  });
  expect(() => synopsisSourcesVisit({ sourceView: 'selected-synopses', via: via() })).toThrow(
    'Invalid selected Sources visit',
  );
  expect(() => synopsisSourcesVisit({ sourceView: 'selected-synopsis', via: '文'.repeat(700) })).toThrow();
  await expect(
    readSelectedSynopsisSources(async () => {
      throw new Error('unexpected producer defect');
    }, request()),
  ).rejects.toThrow('unexpected producer defect');
});

test('general Sources retains empty citation groups without borrowing record or sibling citations', () => {
  const fixture = catalogueSourcesFixture();
  const statement = fixture.read.subject.statements['schema:isbn']![0]!;
  statement.references = [{ hash: 'empty', parts: [] }, ...statement.references, { hash: 'also-empty', parts: [] }];
  const page = explainSubjectSources(fixture.read, 'en', sourceDefinitions);
  const fact = page.fields.find((field) => field.property === 'schema:isbn')!.facts[0]!;
  expect(fact.citations.map((parts) => parts.length)).toEqual([0, 1, 0]);
  statement.references = [];
  expect(
    explainSubjectSources(fixture.read, 'en', sourceDefinitions).fields.find(
      (field) => field.property === 'schema:isbn',
    )!.facts[0]!.citations,
  ).toEqual([]);
});
