import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConditionEditor } from '../src/search/condition-editor';
import { m } from '../src/paraglide/messages.js';

test('the universal editor preserves precise endpoints instead of rendering numeric year inputs', () => {
  const locale = 'ja';
  const html = renderToStaticMarkup(
    createElement(ConditionEditor, {
      value: {
        statement: { property: 'schema:datePublished', range: { type: 'time', gte: '2024-02-29', lte: '2024-03' } },
      },
      metadata: {
        types: { 'schema:Release': { facets: ['schema:datePublished'] } },
        properties: { 'schema:datePublished': { datatype: 'time' } },
      },
      locale,
      languages: ['ja'],
      onChange() {},
      onLanguages() {},
    }),
  );
  expect(html).toContain('value="2024-02-29"');
  expect(html).toContain('value="2024-03"');
  expect(html).toContain(m.refinement_lower({}, { locale }));
  expect(html).not.toContain(m.refinement_year_hint({}, { locale }));
});
