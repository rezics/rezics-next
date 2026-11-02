import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchInputRecovery } from '../src/search/search-input-recovery';
import { correctSearchInput, removeSearchInput, searchFormFields, searchLoaderDeps } from '../src/search/search-params';

test('malformed conditions and ranges stay editable and are not omitted from search forms', () => {
  const condition = '{"and":[]}';
  const search = {
    q: 'Mira',
    condition,
    type: 'schema:Book',
    'r.schema:datePublished': '{"gte":"not-a-number"}',
    'f.schema:genre': ['myth'],
    cursor: 'old-hit',
  };
  const deps = searchLoaderDeps(search);
  expect(deps.invalidInput).toEqual({ key: 'condition', value: condition });
  expect(searchFormFields(search)).toEqual([
    ['type', 'schema:Book'],
    ['condition', condition],
    ['r.schema:datePublished', '{"gte":"not-a-number"}'],
    ['f.schema:genre', 'myth'],
  ]);

  for (const issue of [
    deps.invalidInput!,
    { key: 'r.schema:datePublished', value: search['r.schema:datePublished'] },
  ]) {
    const html = renderToStaticMarkup(
      createElement(SearchInputRecovery, {
        parameter: issue.key,
        value: issue.value,
        onApply() {},
        onRemove() {},
      }),
    );
    expect(html).toContain('<textarea');
    expect(html).toContain(issue.value);
    expect(html).toContain('Apply correction');
    expect(html).toContain('Remove this input');
    expect(html).not.toMatch(/FilterError|SyntaxError|stack/i);
  }
});

test('correcting or removing one invalid input keeps other selections and resets the continuation', () => {
  const search = {
    q: 'Mira',
    type: 'schema:Book',
    condition: '{"type":{"in":["schema:Book"]}}',
    'r.schema:datePublished': '{bad json',
    'f.schema:genre': ['myth', 'fable'],
    cursor: 'old-hit',
  };
  expect(correctSearchInput(search, 'r.schema:datePublished', '{"gte":1900}')).toEqual({
    ...search,
    'r.schema:datePublished': '{"gte":1900}',
    cursor: undefined,
  });
  expect(removeSearchInput(search, 'r.schema:datePublished')).toEqual({
    q: 'Mira',
    type: 'schema:Book',
    condition: search.condition,
    'f.schema:genre': ['myth', 'fable'],
    cursor: undefined,
  });
});
