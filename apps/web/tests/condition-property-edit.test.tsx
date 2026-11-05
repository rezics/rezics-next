import { expect, test } from 'bun:test';
import { validateFilter, type FilterDocument } from '@rezics/filter';
import type { ConditionMetadata } from '../src/search/condition-editor-model';
import {
  changeQualifierProperty,
  changeStatementProperty,
  resolveConditionPropertyChange,
} from '../src/search/condition-property-edit';

const properties: ConditionMetadata['properties'] = {
  'ex:weight': { labels: { en: 'Measure' }, datatype: 'quantity', units: ['kg'], qualifiers: ['ex:language'] },
  'ex:weightCopy': { labels: { en: 'Measure' }, datatype: 'quantity', units: ['kg'], qualifiers: ['ex:language'] },
  'ex:date': { labels: { en: 'Measure' }, datatype: 'time' },
  'ex:language': { labels: { en: 'Language' }, datatype: 'string', value: { pattern: '^[a-z]{2}$' } },
  'ex:languageCopy': { labels: { en: 'Language' }, datatype: 'string', value: { pattern: '^[a-z]{2}$' } },
  'ex:languageOther': { labels: { en: 'Language' }, datatype: 'string', value: { pattern: '^[a-z]{3}$' } },
};

test('statement changes retain released-compatible ranges and require confirmation before resetting incompatible operands', () => {
  const draft: FilterDocument = {
    statement: {
      property: 'ex:weight',
      range: { gte: 4, unit: 'kg' },
      qualifiers: [{ property: 'ex:language', in: ['ja'] }],
    },
  };
  const compatible = changeStatementProperty(draft, 'ex:weightCopy', { types: {}, properties: properties });
  expect(compatible.requiresConfirmation).toBe(false);
  expect(compatible.next).toEqual({
    statement: { ...draft.statement, property: 'ex:weightCopy' },
  });

  const incompatible = changeStatementProperty(draft, 'ex:date', { types: {}, properties: properties });
  expect(incompatible.requiresConfirmation).toBe(true);
  expect(incompatible.next).toEqual({ statement: { property: 'ex:date', range: {} } });
  expect(resolveConditionPropertyChange(incompatible, false)).toEqual(draft);
  expect(resolveConditionPropertyChange(incompatible, true)).toEqual(incompatible.next);
});

test('qualifier changes preserve only the same released value definition and cancellation keeps the full draft', () => {
  const draft: FilterDocument = {
    statement: {
      property: 'ex:weight',
      range: { lte: 9, unit: 'kg' },
      qualifiers: [
        { property: 'ex:language', in: ['ja'] },
        { property: 'ex:language', in: ['fr'] },
      ],
    },
  };
  const compatible = changeQualifierProperty(draft, 0, 'ex:languageCopy', properties);
  expect(compatible.requiresConfirmation).toBe(false);
  expect(compatible.next).toEqual({
    statement: {
      ...draft.statement,
      qualifiers: [{ property: 'ex:languageCopy', in: ['ja'] }, draft.statement.qualifiers![1]],
    },
  });

  const incompatible = changeQualifierProperty(draft, 0, 'ex:languageOther', properties);
  expect(incompatible.requiresConfirmation).toBe(true);
  expect(incompatible.next).toEqual({
    statement: {
      ...draft.statement,
      qualifiers: [{ property: 'ex:languageOther', in: [''] }, draft.statement.qualifiers![1]],
    },
  });
  expect(resolveConditionPropertyChange(incompatible, false)).toEqual(draft);
});

test('inverse property transitions preserve compatible meaning and explicitly reset unsupported direction', () => {
  const relation = { datatype: 'wikibase-item', targets: ['ex:Work'], relation: { group: 'association' }, qualifiers: ['ex:language'] } as const;
  const metadata: ConditionMetadata = {
    types: { 'ex:Work': { facets: ['ex:relation', 'ex:copy', 'ex:plain', 'ex:weight'] } },
    properties: { ...properties, 'ex:relation': relation, 'ex:copy': relation,
      'ex:plain': { datatype: 'wikibase-item', targets: ['ex:Work'] } },
  };
  const original: FilterDocument = { statement: { property: 'ex:relation', inverse: true,
    in: ['018f0000-0000-7000-8000-00a000000020'], qualifiers: [{ property: 'ex:language', in: ['ja'] }] } };
  expect(changeStatementProperty(original, 'ex:copy', metadata)).toMatchObject({
    requiresConfirmation: false, next: { statement: { ...original.statement, property: 'ex:copy' } },
  });
  for (const property of ['ex:plain', 'ex:weight', 'ex:date', 'ex:missing']) {
    const transition = changeStatementProperty(original, property, metadata);
    expect(transition.requiresConfirmation).toBe(true);
    expect(resolveConditionPropertyChange(transition, false)).toBe(original);
    expect('inverse' in (transition.next as typeof original).statement).toBe(false);
  }
  const range = changeStatementProperty(original, 'ex:weight', metadata).next;
  expect(range).toEqual({ statement: { property: 'ex:weight', range: { unit: 'kg' },
    qualifiers: original.statement.qualifiers } });
  expect(validateFilter({ statement: { property: 'ex:weight', range: { gte: 4 }, inverse: true } }, metadata, { inverse: true }).length).toBeGreaterThan(0);
});
