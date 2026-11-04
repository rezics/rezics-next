import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { SubjectSourcesPage } from '../src/features/catalogue/subject-sources-page';
import {
  explainSubjectSources,
  readSubjectSources,
  type SourcesResult,
} from '../src/features/catalogue/subject-sources';
import { catalogueSourcesFixture, citationUrl, sourceDefinitions } from '../src/kernel/fake/catalogue-sources';

mock.module('cloudflare:workers', () => ({ env: {} }));

const render = (result: SourcesResult) => renderToString(createElement(SubjectSourcesPage, { result, locale: 'en' }));

test('Explain the currently selected subject facts and their sources through the existing API and reader with honest failure states', async () => {
  const fixture = catalogueSourcesFixture();
  fixture.read.viewerActions = {
    state: 'available',
    actions: [{ action: 'statement:propose', operations: ['subject.propose'] }],
  };
  const result = await readSubjectSources(fixture.client, fixture.id, 'en', sourceDefinitions);
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Expected selected public facts');
  const html = render(result);
  expect(html).toContain('Publication date');
  expect(html).toContain('1943');
  expect(html).toContain(`href="${citationUrl}"`);
  expect(html).toContain('Reviewed bibliography');
  expect(html).toContain('Bibliography contributors');
  expect(html).toContain('CC0-1.0');
  expect(result.page.fields[0]?.compareHref).toContain('candidateField=schema%3AdatePublished');
  expect(html).toContain('returnTo=sources');
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
    fixture.read.viewerActions = actions;
    const page = explainSubjectSources(fixture.read, 'en', sourceDefinitions);
    const html = render({ kind: 'ready', page });
    expect(html).toContain(citationUrl);
    expect(page.fields.every((field) => !field.compareHref && field.facts.every((fact) => !fact.correctionHref))).toBe(
      true,
    );
    expect(html).toContain(actions.state === 'available' ? 'current authority' : 'temporarily unavailable');
  }
});
