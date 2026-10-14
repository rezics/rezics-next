import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { contentsItem } from '../src/modules/work-contents/read-contract.ts';
import { assertContentsCompositionMapping } from '../src/modules/work-contents/read.ts';
import type { CompositionHeader } from '../src/modules/structure/graph.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const item = { occurrence: id(1), parent: id(2), role: 'part',
  label: { value: 'Authored episode', language: 'en' }, target: id(3),
  division: null, number: null, childCount: null, selectedRevision: null, progress: null,
  availability: 'available', displayLabel: 'Episode one', inclusion: 'required' };

test('Contents contract retains Work parts without chapter publication or progress', () => {
  expect(Value.Check(contentsItem, item)).toBe(true);
  expect(Value.Check(contentsItem, { ...item, number: 1 })).toBe(false);
  expect(Value.Check(contentsItem, { ...item, selectedRevision: `urn:rezics:content:revision:${id(10).slice(-36)}` }))
    .toBe(false);
  expect(Value.Check(contentsItem, { ...item, progress: { composition: id(2), occurrence: id(1),
    selectedRevision: `urn:rezics:content:revision:${id(10).slice(-36)}` } })).toBe(false);
});

test('Contents contract preserves nullable unavailable chapters and Book group numbering', () => {
  const { displayLabel: _displayLabel, inclusion: _inclusion, ...common } = item;
  expect(Value.Check(contentsItem, { ...common, role: 'chapter', target: null,
    label: null, number: 2, availability: 'unavailable' })).toBe(true);
  expect(Value.Check(contentsItem, { ...common, role: 'group', target: null,
    division: 'volume', number: 1, childCount: 0 })).toBe(true);
});

const header: CompositionHeader = { structure: id(4), profile: 'work-composition',
  owner: id(5), work: id(5), component: id(6), mainVersion: id(6), head: id(7),
  generation: id(8), placementCount: 0, manifest: `urn:rezics:sha256:${'a'.repeat(64)}` };

test('Contents mapping accepts registered Work and chapter profiles independently of descriptive kind', () => {
  expect(() => assertContentsCompositionMapping(header, id(5), id(6))).not.toThrow();
  expect(() => assertContentsCompositionMapping({ ...header, profile: 'book-composition' }, id(5), id(6))).not.toThrow();
});

test('Contents mapping rejects absent headers, wrong Work and wrong main version as distinct predicates', () => {
  expect(() => assertContentsCompositionMapping(null, id(5), id(6))).toThrow('Composition mapping differs');
  expect(() => assertContentsCompositionMapping({ ...header, work: id(9) }, id(5), id(6)))
    .toThrow('Composition mapping differs');
  expect(() => assertContentsCompositionMapping({ ...header, mainVersion: id(9) }, id(5), id(6)))
    .toThrow('Composition mapping differs');
});
