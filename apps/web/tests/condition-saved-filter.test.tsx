import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FilterDocument } from '@rezics/filter';
import { m } from '../src/paraglide/messages.js';
import { ConditionEditor } from '../src/search/condition-editor';
import { ConditionSavedFilter, editSavedFilterTree } from '../src/search/condition-saved-filter';
import { conditionTreeAdmission, type ConditionMetadata } from '../src/search/condition-editor-model';

const thing: FilterDocument = { type: { in: ['ex:Thing'] } };
const metadata: ConditionMetadata = {
  types: { 'ex:Thing': { facets: ['ex:name'] } },
  properties: { 'ex:name': { datatype: 'string' } },
  filters: {
    'things/one': { filter: thing },
    'things/two': { filter: { and: [thing, { statement: { property: 'ex:name', in: ['x'] } }] } },
    'things/negated': { filter: { not: thing } },
    'things/cycle': { filter: { saved: 'things/cycle' } },
    'things/large': { filter: { and: Array.from({ length: 32 }, () => thing) } },
  },
};

test('released references append and replace only their addressed tree nodes while preserving Boolean siblings', () => {
  const tree: FilterDocument = {
    and: [thing, { or: [{ saved: 'things/one' }, { not: thing }] }],
  };
  const admits = conditionTreeAdmission(metadata);
  const appended = editSavedFilterTree(tree, ['and', 1, 'or'], 'things/two', 'append', admits);
  expect(appended).toEqual({
    and: [thing, { or: [{ saved: 'things/one' }, { not: thing }, { saved: 'things/two' }] }],
  });
  expect(
    editSavedFilterTree(appended!, ['and', 1, 'or', 0], 'things/two', 'replace', admits),
  ).toEqual({ and: [thing, { or: [{ saved: 'things/two' }, { not: thing }, { saved: 'things/two' }] }] });
});

test('saved edits require full-tree expansion admission, including leaf limits, NOT rules and cycles', () => {
  const admits = conditionTreeAdmission(metadata);
  expect(editSavedFilterTree({ and: [thing] }, [], 'things/large', 'append', admits)).toBeUndefined();
  expect(editSavedFilterTree({ and: [thing] }, [], 'things/cycle', 'append', admits)).toBeUndefined();
  expect(editSavedFilterTree({ not: thing }, ['not'], 'things/negated', 'replace', admits)).toBeUndefined();
});

test('unavailable references stay identified and removable; additions without released metadata are disabled', () => {
  const retained = renderToStaticMarkup(
    createElement(ConditionEditor, {
      value: { and: [{ saved: 'things/missing' }] },
      metadata,
      onChange() {},
      locale: 'en',
    }),
  );
  expect(retained).toContain(m.condition_saved_filter_label({ id: 'things/missing' }));
  expect(retained).toContain(m.condition_saved_filter_unavailable_reference({ id: 'things/missing' }));
  expect(retained).toContain(m.condition_remove());

  const unavailable = renderToStaticMarkup(
    createElement(ConditionSavedFilter, { filters: [], canSelect: () => false, onSelect: () => false }),
  );
  expect(unavailable).toContain(m.condition_saved_filter_unavailable());
  expect(unavailable).toMatch(/<select\b[^>]*disabled=""/);
  expect(unavailable).toMatch(/<button\b(?=[^>]*disabled="")[^>]*>Add saved filter<\/button>/);
});
