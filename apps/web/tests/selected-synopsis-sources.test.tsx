import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router';
import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { summaryReadingFragment } from '../src/features/pages/subject-visit-navigation';
import type { SourcesResult } from '../src/features/catalogue/subject-sources';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { m } = await import('../src/paraglide/messages.js');
const { SubjectSourcesPage } = await import('../src/features/catalogue/subject-sources-page');
const { explainSubjectSources, readSubjectSources } = await import('../src/features/catalogue/subject-sources');
const { catalogueSourcesFixture, citationUrl, sourceDefinitions } =
  await import('../src/kernel/fake/catalogue-sources');

const render = (result: SourcesResult) => {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en'] }),
  });
  return renderToString(
    createElement(QueryClientProvider, {
      client: new QueryClient(),
      children: createElement(RouterContextProvider, {
        router,
        children: createElement(SubjectSourcesPage, { result, locale: 'en' }),
      }),
    }),
  );
};

const candidateId = '00000000-0000-4000-8000-000000000102';
const documentId = '00000000-0000-4000-8000-000000000202';
const digest = 'c'.repeat(64);
const nonGlobalContext = '00000000-0000-4000-8000-000000000777';

test('exact Sources reads one admitted selection and shows only its statement, its citations and no operands', async () => {
  const fixture = catalogueSourcesFixture();
  const selection = {
    candidateId,
    documentId,
    digest,
    language: 'ja',
    locale: 'en',
    context: fixture.read.subject.context,
    subjectRelease: fixture.read.subject.release,
  };
  const via = `/en/subjects/${fixture.id}/work${summaryReadingFragment(selection)}`;
  const { rezics: _revision, ...template } = fixture.read.subject.statements['schema:isbn']![0]!;
  const fact = {
    ...template,
    id: candidateId,
    property: { id: 'schema:abstract', data_type: 'document' as const },
    value: { type: 'somevalue' as const },
    references: [
      { hash: 'no-support', parts: [] },
      {
        hash: 'support',
        parts: [{ property: { id: 'schema:url', data_type: 'url' as const }, value: { type: 'value' as const, content: citationUrl } }],
      },
    ],
  };
  const requests: URL[] = [];
  const client = createKernelClient('http://sources.test', {
    fetch: (async (input: RequestInfo | URL) => {
      requests.push(new URL(input instanceof Request ? input.url : String(input)));
      const selectedSynopsis = { kind: 'matched', fact, context: selection.context, release: selection.subjectRelease };
      return new Response(JSON.stringify({ ...fixture.read, selectedSynopsis }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });

  const result = await readSubjectSources(client, fixture.id, 'en', sourceDefinitions, false, via);

  expect(requests).toHaveLength(1);
  expect(JSON.parse(requests[0]!.searchParams.get('selectedSynopsis')!)).toMatchObject({
    statement: candidateId,
    document: documentId,
    digest,
    language: 'ja',
    context: selection.context,
    release: selection.subjectRelease,
  });
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Expected the exact selected Sources page');
  expect(result.page.fields).toHaveLength(1);
  const [shown] = result.page.fields[0]!.facts;
  expect(shown!.statement).toBe(candidateId);
  expect(shown!.citations.map((parts) => parts.length)).toEqual([0, 1]);
  expect(result.page.sources).toEqual({ credit: null, records: [], urls: [], identifiers: [] });
  const markup = render(result);
  expect(markup).toContain(citationUrl);
  expect(markup).toContain(m.sources_no_citations({}, { locale: 'en' as never }));
  expect(markup).not.toContain(documentId);
  expect(markup).not.toContain(digest);
});

test('invalid and non-Global visits stop before any read; changed and missing answers never show another assertion', async () => {
  const fixture = catalogueSourcesFixture();
  const selection = {
    candidateId,
    documentId,
    digest,
    language: 'ja',
    locale: 'en',
    context: fixture.read.subject.context,
    subjectRelease: fixture.read.subject.release,
  };
  const via = `/en/subjects/${fixture.id}/work${summaryReadingFragment(selection)}`;
  let component: unknown;
  const requests: URL[] = [];
  const client = createKernelClient('http://sources.test', {
    fetch: (async (input: RequestInfo | URL) => {
      requests.push(new URL(input instanceof Request ? input.url : String(input)));
      return new Response(JSON.stringify({ ...fixture.read, selectedSynopsis: component }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });

  const foreignSubject = `/en/subjects/00000000-0000-4000-8000-000000000009/work${summaryReadingFragment(selection)}`;
  const foreignContext = `/en/subjects/${fixture.id}/work${summaryReadingFragment({ ...selection, context: nonGlobalContext })}`;
  expect(await readSubjectSources(client, fixture.id, 'en', sourceDefinitions, false, foreignSubject)).toEqual({
    kind: 'invalid',
  });
  expect(await readSubjectSources(client, fixture.id, 'en', sourceDefinitions, false, foreignContext)).toEqual({
    kind: 'unsupported',
  });
  expect(requests).toHaveLength(0);

  for (const kind of ['changed', 'missing', 'unavailable'] as const) {
    component = { kind };
    expect(await readSubjectSources(client, fixture.id, 'en', sourceDefinitions, false, via)).toMatchObject({
      kind: 'ready',
      page: { selectedSynopsis: kind, fields: [] },
    });
  }
  expect(requests).toHaveLength(3);
});

test('general Sources keeps admitted empty citation groups without borrowing record or sibling support', () => {
  const fixture = catalogueSourcesFixture();
  const statement = fixture.read.subject.statements['schema:isbn']![0]!;
  const supported = statement.references.length;
  statement.references = [{ hash: 'empty', parts: [] }, ...statement.references, { hash: 'also-empty', parts: [] }];
  const page = explainSubjectSources(fixture.read, 'en', sourceDefinitions);
  const fact = page.fields.find((field) => field.property === 'schema:isbn')!.facts[0]!;
  expect(fact.citations).toHaveLength(supported + 2);
  expect(fact.citations[0]).toEqual([]);
  expect(fact.citations.at(-1)).toEqual([]);
  statement.references = [];
  expect(
    explainSubjectSources(fixture.read, 'en', sourceDefinitions).fields.find(
      (field) => field.property === 'schema:isbn',
    )!.facts[0]!.citations,
  ).toEqual([]);
});
