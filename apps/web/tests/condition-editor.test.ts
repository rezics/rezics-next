import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FilterDocument } from '@rezics/filter';
import recording from '../src/kernel/recorded/definitions-release.json';
import { ConditionEditor } from '../src/search/condition-editor';
import {
  CONDITION_POINTER,
  conditionChoiceLabels,
  conditionMetadata,
  conditionSearchState,
} from '../src/search/condition-editor-model';
import { localizedLabel } from '../src/search/results';
import { searchLoaderDeps } from '../src/search/search-params';
import { discoveryRequest } from '../src/search/search-request';
import { m } from '../src/paraglide/messages.js';

test('Distinct released condition choices with identical localized labels are distinguishable in the existing selector without changing native IDs filter meaning or retained problem pointers', () => {
  const metadata = conditionMetadata(recording.release);
  const before = JSON.stringify(metadata);
  const tree: FilterDocument = {
    and: [
      { type: { in: ['bf:Instance'] } },
      { or: [{ not: { type: { in: ['wd:Q20631656'] } } }, { type: { in: ['retired:Type'] } }] },
    ],
  };
  const pointer = `${CONDITION_POINTER}/and/1/or/0/not/type/in/0`;
  const html = renderToStaticMarkup(
    createElement(ConditionEditor, {
      value: tree,
      metadata,
      locale: 'zh-Hans',
      issues: [{ pointer, code: 'unsupported' }],
      onChange() {},
    }),
  );
  const selectors = [...html.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)].map(([select]) => select);
  const invalid = selectors.find((select) => select.includes('aria-invalid="true"'))!;
  expect(invalid).toContain('value="bf:Instance">版本 (bf:Instance)</option>');
  expect(invalid).toContain('value="wd:Q20631656" selected="">版本 (wd:Q20631656)</option>');
  expect(invalid).toContain('value="schema:Book">书籍</option>');
  expect(invalid).toContain('aria-describedby=');
  expect(html).toContain('value="bf:Instance" selected="">版本 (bf:Instance)</option>');
  expect(html).toContain('value="retired:Type" selected="">retired:Type</option>');
  expect(html).toContain(`data-error-pointer="${pointer}"`);
  expect(html).toContain(m.condition_unsupported());
  const actualValues = [...invalid.matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)].map(([, value]) => value);
  expect(actualValues).toEqual(['', ...Object.keys(metadata.types)]);
  expect(JSON.stringify(metadata)).toBe(before);

  const state = searchLoaderDeps({ q: 'Mira', language: ['ja'], condition: JSON.stringify(tree), cursor: 'old' });
  const edited = conditionSearchState(state, tree);
  expect(edited).toEqual({ ...state, cursor: undefined });
  expect(discoveryRequest(edited, ['en']).filter).toEqual({ and: [tree] });
});

test('choice labels use generic native IDs only for collisions and retain unique labels and missing-label fallbacks', () => {
  const choices = [
    { value: 'ex:first', label: 'Shared' },
    { value: 'ex:second', label: 'Shared' },
    { value: 'ex:unique', label: 'Unique' },
    { value: 'ex:missing', label: '' },
    { value: 'ex:collision', label: 'ex:missing' },
  ];
  expect(conditionChoiceLabels(choices)).toEqual([
    { value: 'ex:first', label: 'Shared (ex:first)' },
    { value: 'ex:second', label: 'Shared (ex:second)' },
    { value: 'ex:unique', label: 'Unique' },
    { value: 'ex:missing', label: 'ex:missing' },
    { value: 'ex:collision', label: 'ex:missing (ex:collision)' },
  ]);
  const metadata = conditionMetadata(recording.release);
  const english = Object.entries(metadata.types).map(([value, definition]) => ({
    value,
    label: localizedLabel(definition.labels ?? {}, 'en').text,
  }));
  const labeled = conditionChoiceLabels(english);
  expect(labeled.find(({ value }) => value === 'bf:Instance')?.label).toBe('edition');
  expect(labeled.find(({ value }) => value === 'wd:Q20631656')?.label).toBe('release');
});
