import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router';
import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { summaryReadingFragment } from '../src/features/pages/subject-visit-navigation';
import type { SourcesResult } from '../src/features/catalogue/subject-sources';

mock.module('cloudflare:workers', () => ({ env: {} }));
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

test('Explain the currently selected subject facts and their sources through the existing API and reader with honest failure states', async () => {
  const fixture = catalogueSourcesFixture();
  Object.assign(fixture.read, {
    viewerActions: {
      state: 'available',
      actions: [{ action: 'statement:propose', operations: ['subject.propose'] }],
    },
  });
  const result = await readSubjectSources(fixture.client, fixture.id, 'en', sourceDefinitions, true);
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Expected selected public facts');
  expect(result.page.viewer?.state).toBe('signed-in');
  const html = render(result);
  expect(html).toContain('Publication date');
  expect(html).toContain('1943');
  expect(html).toContain(`href="${citationUrl}"`);
  expect(html).toContain('Reviewed bibliography');
  expect(html).toContain('Bibliography contributors');
  expect(html).toContain('CC0-1.0');
  expect(result.page.fields[0]?.compareHref).toContain('candidateField=schema%3AdatePublished');
  expect(html).toContain('returnTo=sources');
  const comparison = new URL(result.page.fields[0]!.compareHref!, 'https://site.invalid');
  expect(comparison.searchParams.get('sourceStatement')).toBe(
    fixture.read.subject.statements['schema:datePublished']![0]!.id,
  );
  expect(comparison.searchParams.get('via')).toBe(`${result.page.sourcesHref}#subject-sources-heading`);
  expect(html).toContain(`href="${result.page.href}"`);
  expect(fixture.calls).toEqual([
    { path: `/v1/subjects/${fixture.id}`, authorization: null, session: 'sources-session' },
  ]);
  expect(fixture.calls.some(({ path }) => /candidates|revisions|source-records/.test(path))).toBe(false);
  for (const kind of ['denied', 'invalid', 'conflict', 'unavailable'] as const) {
    const refused = catalogueSourcesFixture(kind);
    const failed = await readSubjectSources(refused.client, refused.id, 'en', sourceDefinitions);
    expect(failed).toEqual({ kind });
    expect(render(failed)).toContain('role="alert"');
    expect(render(failed)).not.toContain(citationUrl);
    refused.recover();
    expect((await readSubjectSources(refused.client, refused.id, 'en', sourceDefinitions)).kind).toBe('ready');
    expect(refused.calls[1]).toMatchObject({
      path: `/v1/subjects/${fixture.id}`,
      session: 'current-sources-session',
      authorization: null,
    });
  }
  const missing = createKernelClient('http://sources.test', {
    fetch: (async () =>
      new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  expect(await readSubjectSources(missing, fixture.id, 'en')).toEqual({ kind: 'missing' });
});

test('selected values remain useful without citations or optional metadata, with separate unknown media rights', () => {
  const fixture = catalogueSourcesFixture('no-citations');
  const page = explainSubjectSources(fixture.read, 'en', sourceDefinitions);
  const html = render({ kind: 'ready', page });
  expect(html).toContain('9780156012195');
  expect(html).toContain('No citations were supplied for this selected value.');
  expect(html).toContain('Provider name, URL, licence and attribution metadata are unavailable.');
  expect(html).not.toContain('Wikidata contributors');
  const partial = catalogueSourcesFixture('partial-metadata');
  partial.read.summary = null;
  const partialHtml = render({ kind: 'ready', page: explainSubjectSources(partial.read, 'en', sourceDefinitions) });
  expect(partialHtml).toContain('Licence unavailable');
  expect(partialHtml).toContain('Attribution unavailable');
  expect(partialHtml).toContain('Cover rights are unknown');
  expect(partialHtml).toContain(citationUrl);
  expect(partialHtml).not.toContain('CC0-1.0');
});

test('only selected disclosed values and their reference parts are explained; hidden targets and locators stay concealed', () => {
  const fixture = catalogueSourcesFixture();
  const statements = fixture.read.subject.statements;
  const current = statements['schema:isbn']![0]!;
  current.rank = 'preferred';
  statements['schema:isbn']!.push({
    ...current,
    rank: 'normal',
    value: { type: 'value', content: 'superseded-private-value' },
    references: [
      {
        hash: 'debug',
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: 'https://hidden.example/old' },
          },
        ],
      },
    ],
  });
  statements['schema:author'] = [
    {
      ...current,
      property: { id: 'schema:author', data_type: 'wikibase-item' },
      value: { type: 'value', content: 'concealed-target' },
      references: [
        {
          hash: 'debug',
          parts: [
            {
              property: { id: 'schema:url', data_type: 'url' },
              value: { type: 'value', content: 'https://hidden.example/target' },
            },
          ],
        },
      ],
    },
  ];
  statements['schema:abstract'] = [
    {
      ...current,
      property: { id: 'schema:abstract', data_type: 'document' },
      value: { type: 'value', content: { language: 'en', document: 'document-debug-id', digest: 'private-digest' } },
    },
  ];
  statements['schema:keywords'] = [
    {
      ...current,
      value: { type: 'value', content: 'spoiler-secret' },
      qualifiers: [
        {
          property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
          value: { type: 'value', content: { amount: '2', unit: '1' } },
        },
      ],
    },
  ];
  const result = explainSubjectSources(fixture.read, 'en', sourceDefinitions);
  const serialized = JSON.stringify(result);
  for (const secret of [
    'superseded-private-value',
    'hidden.example',
    'concealed-target',
    'document-debug-id',
    'private-digest',
    'spoiler-secret',
  ])
    expect(serialized).not.toContain(secret);
  const html = render({ kind: 'ready', page: result });
  expect(html).toContain('Authored text');
  expect(html).toContain('9780156012195');
  expect(html).not.toContain('<img');
});

test('current native denial and unavailable actions preserve evidence without correction authority', () => {
  const fixture = catalogueSourcesFixture();
  for (const actions of [{ state: 'available' as const, actions: [] }, { state: 'unavailable' as const }]) {
    Object.assign(fixture.read, { viewerActions: actions });
    const page = explainSubjectSources(fixture.read, 'en', sourceDefinitions);
    const html = render({ kind: 'ready', page });
    expect(html).toContain(citationUrl);
    expect(page.fields.every((field) => !field.compareHref && field.facts.every((fact) => !fact.correctionHref))).toBe(
      true,
    );
    expect(html).toContain(actions.state === 'available' ? 'current authority' : 'temporarily unavailable');
  }
});

test('exact projection owns an empty citation list and cannot borrow page support or preferred language', () => {
  const fixture = catalogueSourcesFixture();
  const template = fixture.read.subject.statements['schema:isbn']![0]!;
  const fact = {
    ...template,
    property: { id: 'schema:abstract', data_type: 'document' as const },
    value: { type: 'somevalue' as const },
    qualifiers: [],
    references: [],
  };
  const page = explainSubjectSources(
    {
      ...fixture.read,
      selectedSynopsis: {
        kind: 'matched',
        fact,
        context: fixture.read.subject.context,
        release: fixture.read.subject.release,
      },
    },
    'ja',
    sourceDefinitions,
  );
  expect(page.fields).toHaveLength(1);
  expect(page.fields[0]!.facts[0]!.statement).toBe(fact.id);
  expect(page.fields[0]!.facts[0]!.citations).toEqual([]);
  expect(page.sources.records).toEqual([]);
  expect(page.sources.credit).toBeNull();
  expect(render({ kind: 'ready', page })).toContain('No citations were supplied');
  const changed = explainSubjectSources(
    { ...fixture.read, selectedSynopsis: { kind: 'changed' } },
    'en',
    sourceDefinitions,
  );
  expect(changed.fields).toEqual([]);
  expect(changed.sources.records).toEqual([]);
  const hiddenTarget = '00000000-0000-4000-8000-000000000099';
  const hidden = explainSubjectSources(
    {
      ...fixture.read,
      related: { ...fixture.read.related, [hiddenTarget]: { labels: { en: 'Hidden citation author' } } },
      selectedSynopsis: {
        kind: 'matched',
        context: fixture.read.subject.context,
        release: fixture.read.subject.release,
        fact: {
          ...fact,
          qualifiers: [
            {
              property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
              value: { type: 'value', content: { amount: '2', unit: '1' } },
            },
          ],
          references: [
            {
              hash: 'hidden-reference',
              parts: [
                {
                  property: { id: 'schema:author', data_type: 'wikibase-item' },
                  value: { type: 'value', content: hiddenTarget },
                },
              ],
            },
          ],
        },
      },
    },
    'en',
    sourceDefinitions,
  );
  expect(hidden.fields).toEqual([]);
  expect(hidden.related).toEqual({});
  expect(hidden.selectedSynopsis).toBeUndefined();
  expect(JSON.stringify(hidden)).not.toContain('Hidden citation author');
});

test('exact HTTP receiving binds the original second/non-default selection and rejects foreign or leaking results', async () => {
  const fixture = catalogueSourcesFixture();
  const candidateId = '00000000-0000-4000-8000-000000000102';
  const documentId = '00000000-0000-4000-8000-000000000202';
  const selection = {
    candidateId,
    documentId,
    digest: 'c'.repeat(64),
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
    property: { id: 'schema:abstract', data_type: 'document' },
    value: { type: 'somevalue' },
    references: [],
  };
  const matched = { kind: 'matched', fact, context: selection.context, release: selection.subjectRelease };
  let component: unknown = matched;
  const requests: URL[] = [];
  const client = createKernelClient('http://sources.test', {
    fetch: (async (input, init) => {
      requests.push(new URL(input instanceof Request ? input.url : String(input)));
      expect(init?.cache).toBe('no-store');
      return new Response(JSON.stringify({ ...fixture.read, selectedSynopsis: component }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
  const read = () => readSubjectSources(client, fixture.id, 'en', sourceDefinitions, false, via);
  const result = await read();
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Expected exact Sources');
  expect(result.page.fields[0]?.facts.map((row) => row.statement)).toEqual([candidateId]);
  expect(result.page.fields[0]?.facts[0]?.citations).toEqual([]);
  for (const secret of [documentId, selection.digest, citationUrl])
    expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.parse(requests[0]!.searchParams.get('selectedSynopsis')!)).toMatchObject({
    statement: candidateId,
    document: documentId,
    digest: selection.digest,
    language: 'ja',
  });
  for (component of [
    undefined,
    { ...matched, body: 'secret' },
    { ...matched, context: candidateId },
    { ...matched, release: 'other' },
    { ...matched, fact: { ...fact, id: documentId } },
    { ...matched, fact: { ...fact, value: { type: 'value', content: { document: documentId } } } },
    {
      ...matched,
      fact: {
        ...fact,
        qualifiers: [
          { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'somevalue' }, document: documentId },
        ],
      },
    },
  ])
    expect(await read()).toEqual({ kind: 'unavailable' });
  const count = requests.length;
  const nonGlobal = via.replace(encodeURIComponent(selection.context), encodeURIComponent(candidateId));
  expect(await readSubjectSources(client, fixture.id, 'en', sourceDefinitions, false, nonGlobal)).toEqual({
    kind: 'unsupported',
  });
  expect(requests).toHaveLength(count);
});
