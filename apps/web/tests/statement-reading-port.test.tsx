import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('cloudflare:workers', () => ({ env: {} }));

const snak = {
  property: { id: 'schema:url', data_type: 'url' },
  value: { type: 'somevalue' as const },
};

test('uncomposed statement reading uses the isolated value renderer', async () => {
  const { PartValue, isolatedStatementReading } = await import('../src/features/catalogue/statement-reading');
  const read = {
    release: { types: {}, properties: { 'schema:url': { datatype: 'url', labels: { en: 'URL' } } } },
    public: { related: {} },
  };
  const rendered = renderToStaticMarkup(
    createElement(PartValue, { part: { property: { id: 'schema:url' }, value: snak.value }, read, locale: 'en' }),
  );
  const isolated = isolatedStatementReading.renderValue({
    snak,
    related: {},
    locale: 'en',
    link: ({ href, children }) => createElement('a', { href }, children),
  });
  expect(rendered).toBe(renderToStaticMarkup(isolated));
});

test('page composition binds the live CandidateValue surface', async () => {
  const { createPageStatementReadingPort } = await import('../src/features/pages/data');
  const { CandidateValue } = await import('../src/features/pages/data');
  const { PlainLink } = await import('../src/features/pages/shared');
  const related = {};
  const bound = createPageStatementReadingPort().renderValue({ snak, related, locale: 'en', link: PlainLink });
  const live = createElement(CandidateValue, { snak, related, locale: 'en', link: PlainLink });
  expect(renderToStaticMarkup(bound)).toBe(renderToStaticMarkup(live));
});

test('statement summary renders without constructing the editor view', async () => {
  const { StatementSummary } = await import('../src/features/catalogue/statement-summary');
  const read = {
    release: {
      types: {},
      properties: {
        'schema:url': { datatype: 'url', labels: { en: 'URL' } },
      },
    },
    source: null,
    public: { related: {}, subject: { type: 'schema:CreativeWork' } },
  };
  const markup = renderToStaticMarkup(
    createElement(StatementSummary, {
      statement: {
        property: { id: 'schema:url' },
        value: { type: 'value', content: 'https://example.org/work' },
        references: [{ parts: [] }],
        rank: 'normal',
      },
      read,
      locale: 'en',
    }),
  );
  expect(markup).toContain('schema:url');
  expect(markup).toContain('https://example.org/work');
});
