import { expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { contentsItem } from '../src/modules/work-contents/read-contract.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const item = { occurrence: id(1), parent: id(2), role: 'part',
  label: { value: 'Authored episode', language: 'en' }, target: id(3),
  division: null, number: null, childCount: null, selectedRevision: null, progress: null,
  availability: 'available', displayLabel: 'Episode one', inclusion: 'required' };

test('Contents contract retains Work parts without chapter publication or progress', () => {
  expect(Value.Check(contentsItem, item)).toBe(true);
});

test('Contents contract preserves nullable unavailable chapters and Book group numbering', () => {
  const { displayLabel: _displayLabel, inclusion: _inclusion, ...common } = item;
  expect(Value.Check(contentsItem, { ...common, role: 'chapter', target: null,
    label: null, number: 2, availability: 'unavailable' })).toBe(true);
  expect(Value.Check(contentsItem, { ...common, role: 'group', target: null,
    division: 'volume', number: 1, childCount: 0 })).toBe(true);
});
