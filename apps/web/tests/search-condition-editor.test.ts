import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { type FilterDocument } from '@rezics/filter';
import * as v from 'valibot';
import recording from '../src/kernel/recorded/definitions-release.json';
import { m } from '../src/paraglide/messages.js';
import { ConditionEditor } from '../src/search/condition-editor';
import { changeConditionDirection } from '../src/search/condition-direction';
import {
  CONDITION_POINTER,
  conditionAdmission,
  conditionFieldIssues,
  conditionMetadata,
  conditionSearchState,
  type ConditionMetadata,
} from '../src/search/condition-editor-model';
import { discoverySearchHref, searchFormFields, searchLoaderDeps, searchParams } from '../src/search/search-params';
import { discoveryRequest, readSearchPage } from '../src/search/search-request';
import { readDiscovery } from '../src/search/discovery';
import { facetProblem } from '../src/search/refinement/request';
import {
  changeQualifierProperty,
  changeStatementProperty,
  resolveConditionPropertyChange,
} from '../src/search/condition-property-edit';

const metadata = conditionMetadata(recording.release);
const tree: FilterDocument = {
  and: [
    { type: { in: ['schema:Book'] } },
    {
      or: [
        { statement: { property: 'schema:wordCount', range: { gte: 1000001, unit: '1' } } },
        { not: { type: { in: ['schema:Movie'] } } },
      ],
    },
  ],
};
const state = searchLoaderDeps({
  q: '  reading | "原文"  ',
  condition: JSON.stringify(tree),
  cursor: 'old+/=',
  language: ['ja'],
  kinds: ['schema:Book', 'account'],
  'f.schema:inLanguage': ['en'],
  'r.schema:datePublished': JSON.stringify({ gte: 1900 }),
});

function render(
  value: FilterDocument | undefined,
  issues: { pointer: string; code: string }[] = [],
  definitions: ConditionMetadata | undefined = metadata,
  locale = 'en',
  values: Record<string, { value: string; labels: Record<string, string> }[]> = {},
) {
  return renderToStaticMarkup(
    createElement(ConditionEditor, {
      value,
      metadata: definitions,
      onChange() {},
      locale,
      languages: ['ja'],
      onLanguages() {},
      issues,
      values,
    }),
  );
}

test('the actual nested editor submits one typed request through the current URL and SDK, retaining simple filters and kind applicability', async () => {
  expect(conditionAdmission(metadata)(tree, state)).toEqual([]);
  const html = render(tree);
  expect(html).toContain('All (AND)');
  expect(html).toContain('Any (OR)');
  expect(html).toContain('Exclude (NOT)');
  expect(html).toContain('1000001');
  expect(html).toContain('name="condition"');
  expect(html).not.toMatch(/textarea|SQL|total|estimate/);
  const edited = conditionSearchState(state, tree);
  const href = discoverySearchHref('en', edited);
  const params = new URL(href, 'https://example.test').searchParams;
  const restored = searchLoaderDeps({
    ...Object.fromEntries(params),
    kinds: params.getAll('kinds'),
    'f.schema:inLanguage': params.getAll('f.schema:inLanguage'),
  });
  expect(restored).toEqual({ ...state, cursor: undefined });
  expect(searchFormFields({ condition: JSON.stringify(tree), cursor: 'old' })).toEqual([
    ['condition', JSON.stringify(tree)],
  ]);
  const body = discoveryRequest(restored, ['en']);
  const calls: unknown[] = [];
  const client = createKernelClient('http://kernel.local', {
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Response.json(
        { code: 'unsupported_query', errors: [{ pointer: '/filter/and/4/kind', code: 'unsupported' }] },
        { status: 422 },
      );
    },
  });
  const response = await client.subjects.$search.post(body);
  expect(calls).toEqual([{ url: 'http://kernel.local/v1/subjects:search', body, authorization: null }]);
  expect(body.filter).toEqual({
    and: [
      tree,
      { statement: { property: 'schema:inLanguage', in: ['en'] } },
      { statement: { property: 'schema:datePublished', range: { gte: 1900 } } },
      { kind: { in: ['schema:Book', 'account'] } },
    ],
  });
  expect(facetProblem(response.error)?.errors?.[0]?.code).toBe('unsupported');
});

test('native 422 pointers mark the actual nested control and retain values, qualifiers, query and unavailable resources under OR/NOT', async () => {
  const pointer = `${CONDITION_POINTER}/and/1/or/0/statement/range/unit`;
  const problem = { code: 'unsupported_query', errors: [{ pointer, code: 'unsupported' }] };
  const input = discoveryRequest(state, ['en']);
  const result = await readDiscovery(input, async (body) => {
    expect(body).toEqual(input);
    return { status: 422, error: { value: problem } };
  });
  expect(result.discovery.status).toBe('unsupported');
  const html = render(tree, facetProblem({ value: problem })!.errors);
  expect(html).toContain(`data-error-pointer="${pointer}"`);
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain('aria-describedby=');
  expect(html).toContain('1000001');
  expect(state.query).toBe('  reading | "原文"  ');
  expect(state.condition).toEqual(tree);
  expect(conditionFieldIssues(problem.errors, `${CONDITION_POINTER}/and/1/or/1`)).toEqual([]);
  const resource = { not: { collection: { id: '0192f3a0-6c1e-7b2a-9d4e-000000000001' } } };
  const scoped = { ...state, filter: JSON.stringify({ or: [{ type: { in: ['schema:Book'] } }, resource] }) };
  expect(conditionAdmission(metadata)(tree, scoped)).toEqual([]);
  const request = discoveryRequest(scoped, ['en']);
  expect(request.filter).toEqual({
    and: [
      tree,
      JSON.parse(scoped.filter),
      { statement: { property: 'schema:inLanguage', in: ['en'] } },
      { statement: { property: 'schema:datePublished', range: { gte: 1900 } } },
      { kind: { in: ['schema:Book', 'account'] } },
    ],
  });
  const refusal = await readDiscovery(request, async () => ({ status: 403, error: { code: 'forbidden' } }));
  expect(refusal.discovery.status).toBe('denied');
});

test('same-statement qualifiers and released datatype/unit values survive editing and admission without owner predicates', () => {
  const definitions: ConditionMetadata = {
    types: { 'ex:Thing': { labels: { en: 'Thing' }, facets: ['ex:amount'] } },
    properties: {
      'ex:amount': {
        labels: { en: 'Amount' },
        datatype: 'quantity',
        units: ['native-unit'],
        qualifiers: ['ex:language'],
      },
      'ex:language': { labels: { en: 'Original language' }, datatype: 'string', value: { pattern: '^[a-z]{2}$' } },
    },
  };
  const qualified: FilterDocument = {
    statement: {
      property: 'ex:amount',
      range: { gte: 4, unit: 'native-unit' },
      qualifiers: [{ property: 'ex:language', in: ['ja'] }],
    },
  };
  const admit = conditionAdmission(definitions);
  expect(admit(qualified, { ...state, condition: qualified, facets: {}, ranges: {}, kinds: undefined })).toEqual([]);
  const html = render(qualified, [], definitions);
  expect(html).toContain('Original language');
  expect(html).toContain('native-unit');
  expect(html).toContain('value="ja"');
  expect(qualified.statement.qualifiers).toEqual([{ property: 'ex:language', in: ['ja'] }]);
  expect(admit({ or: [{ type: { in: ['ex:Thing'] } }, { not: { owner: { presence: true } } }] }, state)[0]?.code).toBe(
    'unsupported',
  );
  expect(html).not.toMatch(/owner\.presence|account selector|Save filter/);
});

test('item operands show stable native identities through entity controls while literals keep their datatype editor', () => {
  const itemId = '0192f3a0-6c1e-7b2a-9d4e-000000000021';
  const qualifierId = '0192f3a0-6c1e-7b2a-9d4e-000000000022';
  const definitions: ConditionMetadata = {
    types: {
      'ex:Work': { labels: { en: 'Work' }, facets: ['ex:related'] },
      'ex:Language': { labels: { en: 'Language' } },
    },
    properties: {
      'ex:related': {
        labels: { en: 'Related work' },
        datatype: 'wikibase-item',
        targets: ['ex:Work'],
        qualifiers: ['ex:language'],
      },
      'ex:language': { labels: { en: 'Language' }, datatype: 'wikibase-item', targets: ['ex:Language'] },
      'ex:caption': { labels: { en: 'Caption' }, datatype: 'string' },
    },
  };
  const lookup = { locale: 'en', reader: 'reader-a', release: 'release-a', available: true };
  const html = renderToStaticMarkup(
    createElement(ConditionEditor, {
      value: {
        statement: {
          property: 'ex:related',
          in: [itemId],
          qualifiers: [{ property: 'ex:language', in: [qualifierId] }],
        },
      },
      metadata: definitions,
      onChange() {},
      locale: 'en',
      entityLookup: lookup,
    }),
  );
  expect(html).toContain('data-condition-entity-property="ex:related"');
  expect(html).toContain('data-condition-entity-property="ex:language"');
  expect(html).toContain(`data-condition-pointer="${CONDITION_POINTER}/statement/in/chooser"`);
  expect(html).toContain(`value="${itemId}"`);
  expect(html).toContain(`value="${qualifierId}"`);
  expect(html).not.toContain('datalist');

  const condition: FilterDocument = {
    statement: {
      property: 'ex:related',
      in: [itemId],
      qualifiers: [{ property: 'ex:language', in: [qualifierId] }],
    },
  };
  expect(
    conditionAdmission(definitions)(condition, { ...state, condition, kinds: undefined, facets: {}, ranges: {} }),
  ).toEqual([]);
  const submitted = discoveryRequest({ ...state, condition }, ['ja']);
  expect(JSON.stringify(submitted.filter)).toContain(itemId);
  expect(JSON.stringify(submitted.filter)).toContain(qualifierId);

  const literal = renderToStaticMarkup(
    createElement(ConditionEditor, {
      value: { statement: { property: 'ex:caption', in: ['Original wording'] } },
      metadata: definitions,
      onChange() {},
      locale: 'en',
      entityLookup: lookup,
    }),
  );
  expect(literal).not.toContain('data-condition-entity-property="ex:caption"');
  expect(literal).toContain('value="Original wording"');
  expect(literal).not.toContain('readonly=""');

  const invalidItem = renderToStaticMarkup(
    createElement(ConditionEditor, {
      value: { statement: { property: 'ex:related', in: ['Typed name'] } },
      metadata: definitions,
      onChange() {},
      locale: 'en',
      entityLookup: lookup,
    }),
  );
  expect(invalidItem).toContain('This value is not a native item ID.');
  expect(invalidItem).toContain('value="Typed name"');
});

test('item property changes retain IDs only for an unchanged released target domain', () => {
  const operand = '0192f3a0-6c1e-7b2a-9d4e-000000000031';
  const definitions: ConditionMetadata['properties'] = {
    'ex:work': { datatype: 'wikibase-item', targets: ['ex:Work'], labels: {} },
    'ex:otherWork': { datatype: 'wikibase-item', targets: ['ex:Work'], labels: {} },
    'ex:language': { datatype: 'wikibase-item', targets: ['ex:Language'], labels: {} },
    'ex:unbounded': { datatype: 'wikibase-item', labels: {} },
  };
  const statement: FilterDocument = { statement: { property: 'ex:work', in: [operand] } };
  expect(changeStatementProperty(statement, 'ex:otherWork', definitions)).toMatchObject({
    requiresConfirmation: false,
    next: { statement: { property: 'ex:otherWork', in: [operand] } },
  });
  expect(changeStatementProperty(statement, 'ex:language', definitions)).toMatchObject({
    requiresConfirmation: true,
    next: { statement: { property: 'ex:language', in: [''] } },
  });
  expect(changeStatementProperty(statement, 'ex:unbounded', definitions)).toMatchObject({
    requiresConfirmation: true,
    next: { statement: { property: 'ex:unbounded', in: [''] } },
  });
  const qualified: FilterDocument = {
    statement: { property: 'ex:work', in: [''], qualifiers: [{ property: 'ex:work', in: [operand] }] },
  };
  expect(changeQualifierProperty(qualified, 0, 'ex:language', definitions)).toMatchObject({
    requiresConfirmation: true,
    next: { statement: { qualifiers: [{ property: 'ex:language', in: [''] }] } },
  });
});

test('released inverse relations round-trip through editing and the URL with their labelled operand and qualifier', () => {
  const relation = Object.entries(metadata.properties).find(
    ([, definition]) =>
      definition.datatype === 'wikibase-item' &&
      definition.relation &&
      definition.qualifiers?.some((property) => metadata.properties[property]?.datatype === 'wikibase-item'),
  );
  expect(relation).toBeDefined();
  const [property, definition] = relation!;
  const qualifierProperty = definition.qualifiers!.find(
    (candidate) => metadata.properties[candidate]?.datatype === 'wikibase-item',
  )!;
  const operand = '018f0000-0000-7000-8000-00a000000020';
  const qualifierValue = '018f0000-0000-7000-8000-00a000000021';
  const inverse = {
    statement: {
      property,
      inverse: true,
      in: [operand],
      qualifiers: [{ property: qualifierProperty, in: [qualifierValue] }],
    },
  } satisfies FilterDocument;
  const operandLabels = { en: 'Selected work', ja: '選択した作品', 'zh-Hant': '選取的作品' };
  const values = {
    [property]: [{ value: operand, labels: operandLabels }],
    [qualifierProperty]: [{ value: qualifierValue, labels: { en: 'Writer', ja: '担当者', 'zh-Hant': '角色' } }],
  };

  expect(conditionAdmission(metadata)(inverse, state)).toEqual([]);
  const propertyChange = changeStatementProperty(inverse, 'schema:inLanguage', metadata.properties);
  expect(propertyChange.requiresConfirmation).toBe(true);
  expect(resolveConditionPropertyChange(propertyChange, false)).toEqual(inverse);
  expect(resolveConditionPropertyChange(propertyChange, true)).toMatchObject({
    statement: { property: 'schema:inLanguage', inverse: true },
  });
  const direct = changeConditionDirection(inverse, 'direct');
  expect(direct).toEqual({ statement: { property, in: [operand], qualifiers: inverse.statement.qualifiers } });
  expect(changeConditionDirection(direct, 'inverse')).toEqual(inverse);

  const edited = conditionSearchState(state, inverse);
  expect(edited.cursor).toBeUndefined();
  const url = new URL(discoverySearchHref('ja', edited), 'https://example.test').searchParams;
  const restored = searchLoaderDeps({
    ...Object.fromEntries(url),
    kinds: url.getAll('kinds'),
    'f.schema:inLanguage': url.getAll('f.schema:inLanguage'),
  });
  expect(restored.condition).toEqual(inverse);
  expect(discoveryRequest(restored, ['ja']).filter?.and[0]).toEqual(inverse);

  for (const locale of ['ja', 'zh-Hant'] as const) {
    const propertyLabel = metadata.properties[property]?.labels?.[locale] ?? property;
    const html = render(inverse, [], metadata, locale, values);
    expect(html).toContain(`data-condition-field-pointer="${CONDITION_POINTER}/statement/inverse"`);
    expect(html).toContain(operandLabels[locale]);
    expect(html).toContain(
      m.condition_relation_inverse({ property: propertyLabel, values: operandLabels[locale] }, { locale }),
    );
  }
});

test('an unsupported inverse stays visible and correctable, clears old pagination, and never broadens a refused request', async () => {
  const unsupportedMetadata: ConditionMetadata = {
    types: { 'ex:Thing': { labels: { en: 'Thing' }, bases: [], facets: ['ex:label'] } },
    properties: {
      'ex:label': { labels: { en: 'Label' }, datatype: 'string', value: { pattern: '^[a-z]+$' } },
    },
  };
  const unsupported: FilterDocument = {
    statement: { property: 'ex:label', inverse: true, in: ['label'] },
  };
  const issues = conditionAdmission(unsupportedMetadata)(unsupported, state);
  expect(issues).toEqual([
    { pointer: `${CONDITION_POINTER}/statement/inverse`, code: 'unsupported' },
  ]);
  const html = render(unsupported, issues, unsupportedMetadata);
  expect(html).toContain('Relation direction');
  expect(html).toContain(`data-condition-field-pointer="${CONDITION_POINTER}/statement/inverse"`);
  expect(html).toContain('aria-invalid="true"');

  const edited = conditionSearchState(state, unsupported);
  expect(edited.condition).toEqual(unsupported);
  expect(edited.cursor).toBeUndefined();
  const request = discoveryRequest(edited, ['en']);
  expect(request.filter?.and[0]).toEqual(unsupported);
  const calls: unknown[] = [];
  const refused = await readDiscovery(request, async (body) => {
    calls.push(body);
    return {
      status: 422,
      error: { value: { code: 'unsupported_query', errors: [{ pointer: issues[0]!.pointer, code: 'unsupported' }] } },
    };
  });
  expect(refused.discovery.status).toBe('unsupported');
  expect(calls).toEqual([request]);
});

test('shared admission enforces all grammar ceilings, byte bounds and invalid ranges while unfinished controls retain their input', () => {
  const admit = conditionAdmission(metadata);
  const type: FilterDocument = { type: { in: ['schema:Book'] } };
  const tooDeep: FilterDocument = { and: [{ and: [{ and: [{ and: [type] }] }] }] };
  const cases: FilterDocument[] = [
    { and: Array.from({ length: 33 }, () => type) },
    tooDeep,
    { or: Array.from({ length: 17 }, () => type) },
    { type: { in: Array.from({ length: 65 }, () => 'schema:Book') } },
    { statement: { property: 'schema:wordCount', range: { gte: 2, lte: 1, unit: '1' } } },
    { statement: { property: 'schema:wordCount', range: { gte: NaN, unit: '1' } } },
    { statement: { property: 'schema:wordCount', range: { gte: 1, unit: 'kg' } } },
    {
      statement: {
        property: 'schema:inLanguage',
        in: ['en'],
        qualifiers: Array.from({ length: 5 }, () => ({ property: 'schema:inLanguage', in: ['ja'] })),
      },
    },
  ];
  for (const input of cases) expect(admit(input, state).length).toBeGreaterThan(0);
  const unfinished: FilterDocument = { statement: { property: 'schema:inLanguage', in: ['en', ''] } };
  const html = render(unfinished, admit(unfinished, state));
  expect(html).toContain('value="en"');
  expect(html).toContain('value=""');
  expect(html).toContain('aria-invalid="true"');
  expect(v.safeParse(searchParams, { q: '界'.repeat(170) }).success).toBe(true);
  expect(v.safeParse(searchParams, { q: '界'.repeat(171) }).success).toBe(false);
  expect(v.safeParse(searchParams, { cursor: 'x'.repeat(4864) }).success).toBe(true);
  expect(v.safeParse(searchParams, { cursor: 'x'.repeat(4865) }).success).toBe(false);
  const missing = render(undefined);
  expect(missing).toContain('Add conditions');
});

test('language, sort and current-bound restart retain the entire tree and opaque filter while dropping only the old result cursor; legacy mode stays explicit', async () => {
  const changed = conditionSearchState({ ...state, filter: JSON.stringify({ saved: 'books/long' }) }, tree, ['fr']);
  const url = new URL(discoverySearchHref('en', { ...changed, sort: 'rating' }), 'https://example.test');
  expect(url.searchParams.has('cursor')).toBe(false);
  expect(url.searchParams.get('q')).toBe(state.query);
  expect(url.searchParams.getAll('language')).toEqual(['fr']);
  expect(JSON.parse(url.searchParams.get('condition')!)).toEqual(tree);
  expect(JSON.parse(url.searchParams.get('filter')!)).toEqual({ saved: 'books/long' });
  const request = discoveryRequest({ ...changed, cursor: state.cursor }, ['en']);
  const calls: unknown[] = [];
  const response = await readSearchPage(request, async (body) => {
    calls.push(body);
    return calls.length === 1 ? { status: 409, error: { code: 'search_restart_required' } } : { status: 200 };
  });
  expect(response.restarted).toBe(true);
  const { cursor: _cursor, ...first } = request;
  expect(calls).toEqual([request, first]);
  const { representation: _representation, kindPage: _page, kindCountLeaf: _counts, ...legacy } = request;
  const read = await readSearchPage(legacy, async (body) => {
    expect(body).toEqual(legacy);
    return { status: 422, error: { code: 'unsupported_query' } };
  });
  expect(read.response.status).toBe(422);
  expect(read.restarted).toBe(false);
});
