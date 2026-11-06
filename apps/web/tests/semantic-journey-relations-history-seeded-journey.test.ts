import { expect, test } from 'bun:test';
import { isView } from '@rezics/composition';
import {
  admitRelationHistorySelection,
  relationHistoryChangesHref,
  relationHistoryCount,
  relationHistoryHref,
  relationHistoryRestartHref,
  sameRelationHistorySelection,
  type RelationHistorySelection,
} from '../src/features/pages/subject-history';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';

const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const selection: RelationHistorySelection = {
  subject,
  label: 'Journey work',
  locale: 'en',
  view: 'relations',
  node: 'appearances',
  property: 'ex:appearance',
  direction: 'forward',
  cursor: 'opaque:/+?=&% 日本語#',
};

test('exact node property direction and cursor survive retry return and refuse malformed outside input', () => {
  expect(isView(selection.view)).toBe(true);
  const origin = relationHistoryHref(selection);
  expect(origin).toBeDefined();
  const admitted = subjectVisitReturn(origin, 'en');
  expect(admitted).toBe(origin);
  const url = new URL(origin!, 'https://rezics.invalid');
  expect(url.searchParams.get('node')).toBe('appearances');
  expect(url.searchParams.get('property')).toBe('ex:appearance');
  expect(url.searchParams.get('streamProperty')).toBe('ex:appearance');
  expect(url.searchParams.get('streamDirection')).toBe('forward');
  expect(url.searchParams.get('cursor')).toBe(selection.cursor);
  const retry = admitRelationHistorySelection({
    ...selection,
    cursor: url.searchParams.get('cursor'),
  });
  expect(retry).toEqual(selection);
  expect(sameRelationHistorySelection(selection, retry!)).toBe(true);
  const restart = relationHistoryRestartHref(selection)!;
  expect(new URL(restart, 'https://rezics.invalid').searchParams.has('cursor')).toBe(false);
  expect(sameRelationHistorySelection(selection, { ...selection, cursor: null })).toBe(false);
  const changes = relationHistoryChangesHref(selection)!;
  expect(changes).toContain('/changes');
  const via = new URL(changes, 'https://rezics.invalid').searchParams.get('via');
  expect(subjectVisitReturn(via, 'en')).toBe(origin);
  expect(relationHistoryCount(undefined, 15)).toBeUndefined();
  expect(relationHistoryCount({ value: 16, exact: false }, 15)).toEqual({ value: 16, relation: 'lower_bound' });
  expect(admitRelationHistorySelection({ ...selection, property: 'ex:appearance\n' })).toBeUndefined();
  expect(admitRelationHistorySelection({ ...selection, direction: 'both' })).toBeUndefined();
  expect(admitRelationHistorySelection({ ...selection, cursor: 'a'.repeat(8193) })).toBeUndefined();
  expect(admitRelationHistorySelection({ ...selection, node: 'appear ances' })).toBeUndefined();
  expect(admitRelationHistorySelection({ ...selection, view: 'changes' })).toBeUndefined();
  expect(admitRelationHistorySelection({ ...selection, extra: true })).toBeUndefined();
});
