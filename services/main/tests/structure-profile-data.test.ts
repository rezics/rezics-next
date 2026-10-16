import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { OccurrenceRecord, checkOccurrenceQualifier, checkOccurrenceRecord } from '../src/modules/structure/format.ts';
import { roleFromIri, roleIri } from '../src/modules/structure/graph.ts';
import { discoverStructureProfiles, structureProfileFor } from '../src/modules/structure/profiles.ts';
import type { PlacementState } from '../src/modules/structure/graph.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;

test('a structure profile document is the allowlist', async () => {
  const profiles = await discoverStructureProfiles();
  expect(profiles.get('section-list-v1')?.roles).toEqual(['section', 'entry']);
  expect(profiles.get('book-composition')?.roles).toEqual(['group', 'chapter']);
  expect(structureProfileFor('book-composition').qualifiers?.group).toEqual({ type: 'book-group', required: false });
  expect(() => structureProfileFor('wiki-navigation')).toThrow('No registered Structure profile');
  const note = { type: 'fields' as const, id: 'entry', values: { note: 'A margin note' } };
  const record = { occurrence: id(), state: 'active' as const, parent: id(), segmentKey: 'a', orderKey: 'a',
    role: 'entry', target: id(), labels: [], introducedBy: id(), qualifier: note };
  expect(Value.Check(OccurrenceRecord, record)).toBe(true);
  checkOccurrenceRecord(record, 'section-list-v1');
  const state: PlacementState = { occurrence: record.occurrence, placement: id(), active: true,
    parent: record.parent, role: 'entry', target: record.target, qualifier: note, introducedBy: record.introducedBy };
  const projected = structureProfileFor('section-list-v1').projectQualifier?.(state, id());
  const triples = projected?.triples.join('\n') ?? '';
  expect(triples).toContain('"A margin note"');
  expect(triples).toContain('rv:composedWork');
  expect(roleFromIri(roleIri('entry'))).toBe('entry');
  expect(roleFromIri(roleIri('section'))).toBe('section');
  expect(roleFromIri(roleIri('chapter'))).toBe('chapter');
});

test('Recipe relational checks belong to its profile, beyond the shared qualifier envelope', () => {
  const qualifier = { type: 'ingredient-line' as const, originalText: { value: '1 cup flour', language: 'en' },
    amountUpper: { numerator: 2, denominator: 1 }, optional: false, scaling: 'linear' as const,
    substituteFor: [], parseStatus: 'parsed' as const };
  const record = { occurrence: id(), state: 'active' as const, parent: id(), segmentKey: 'a', orderKey: 'a',
    role: 'ingredient', labels: [], introducedBy: id(), qualifier };
  expect(checkOccurrenceQualifier(qualifier)).toEqual(qualifier);
  expect(() => checkOccurrenceRecord(record, 'recipe-composition')).toThrow('lower bound');
  const amount = { numerator: 1, denominator: 1 };
  const valid = { ...record, qualifier: { ...qualifier, amount } };
  expect(() => checkOccurrenceRecord(valid, 'recipe-composition')).not.toThrow();
  const badSpans = { ...valid, qualifier: { ...valid.qualifier,
    textParts: { amount: { start: 0, end: 3 }, name: { start: 2, end: 20 } } } };
  expect(checkOccurrenceQualifier(badSpans.qualifier)).toEqual(badSpans.qualifier);
  expect(() => checkOccurrenceRecord(badSpans, 'recipe-composition')).toThrow('retained source');
});
