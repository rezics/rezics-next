import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { bookGroupQualifierId, projectBookGroup } from '../src/modules/structure/book-group.ts';
import { InvalidCompositionChange, checkedOperations, compositionChangeDigest }
  from '../src/modules/structure/change.ts';
import { InvalidStructureObject, OccurrenceRecord, checkOccurrenceRecord } from '../src/modules/structure/format.ts';
import { derivedId, placementIri } from '../src/modules/structure/graph.ts';
import { deepestLevel, structureProfileFor } from '../src/modules/structure/profiles.ts';

const structure = derivedId('book-groups-structure');
const volume = derivedId('book-groups-volume');
const revision = derivedId('book-groups-revision');
const group = (overrides: Partial<OccurrenceRecord> = {}): OccurrenceRecord => ({
  occurrence: volume, state: 'active', parent: structure, segmentKey: 'i', orderKey: 'i', role: 'group',
  labels: [{ value: '第一卷 雨夜', language: 'zh-Hans' }], introducedBy: revision,
  qualifier: { type: 'book-group', division: 'volume' }, ...overrides,
});

test('BOOK02: a Book group says whether it is a volume, a part or extras; other uses cannot', () => {
  for (const division of ['volume', 'part', 'extras'] as const) {
    const record = group({ qualifier: { type: 'book-group', division } });
    expect(Value.Check(OccurrenceRecord, record)).toBe(true);
    checkOccurrenceRecord(record, 'book-composition');
  }
  // A group that does not say reads as a part; the record stays valid.
  checkOccurrenceRecord(group({ qualifier: undefined }), 'book-composition');
  expect(Value.Check(OccurrenceRecord, group({ qualifier: { type: 'book-group',
    division: 'chapter' as never } }))).toBe(false);
  expect(() => checkOccurrenceRecord(group(), 'collection-membership', [], ['member']))
    .toThrow(InvalidStructureObject);
  const chapter = group({ role: 'chapter', target: derivedId('book-groups-chapter'),
    selection: { mode: 'follow-context' } });
  expect(() => checkOccurrenceRecord(chapter, 'book-composition')).toThrow('qualifier');
});

test('BOOK02: groups stand directly under the Book and chapters at most one group deep', () => {
  const book = structureProfileFor('book-composition');
  expect(deepestLevel(book, 'group')).toBe(1);
  expect(deepestLevel(book, 'chapter')).toBe(2);
  // Profiles that do not narrow the shared depth keep it for every role.
  const collection = structureProfileFor('collection-membership');
  expect(deepestLevel(collection, 'group')).toBe(deepestLevel(collection, 'member'));
});

test('BOOK02: renaming a group or changing its division is one canonical update in the change digest', () => {
  const rename = { op: 'update' as const, occurrence: volume, label: { value: 'Volume II', language: 'en' } };
  const divide = { op: 'update' as const, occurrence: volume,
    qualifier: { type: 'book-group' as const, division: 'extras' as const } };
  expect(checkedOperations([rename], 'book-composition')).toEqual([rename]);
  expect(checkedOperations([divide], 'book-composition')).toEqual([divide]);
  expect(compositionChangeDigest(structure, revision, [rename]))
    .not.toBe(compositionChangeDigest(structure, revision, [divide]));
  expect(() => checkedOperations([{ op: 'update', occurrence: volume }], 'book-composition'))
    .toThrow(InvalidCompositionChange);
  expect(() => checkedOperations([{ ...rename, label: { value: 'bad\u0007', language: 'en' } }],
    'book-composition')).toThrow('label');
  expect(() => checkedOperations([divide], 'collection-membership')).toThrow('division');
  expect(() => checkedOperations([{ ...divide, qualifier: { type: 'zone-mount', zone: volume,
    routeSegment: 'x', disclosure: 'public' } }], 'book-composition')).toThrow('division');
  // One kind of change per request, as for insert, move and remove.
  expect(() => checkedOperations([rename, { op: 'remove', occurrence: volume }], 'book-composition'))
    .toThrow('one kind');
});

test('BOOK02: the group division is projected as its own qualifier node of the placement', () => {
  const generation = derivedId('book-groups-generation');
  const placement = placementIri(generation, volume);
  const projected = projectBookGroup({ occurrence: volume, placement, active: true, parent: structure,
    role: 'group', introducedBy: revision, qualifier: { type: 'book-group', division: 'extras' } }, generation);
  expect(projected?.iri).toBe(bookGroupQualifierId(placement));
  expect(projected?.triples.join(' ')).toContain('rv:BookGroup');
  expect(projected?.triples.join(' ')).toContain('https://rezics.com/vocab/ExtrasDivision');
  expect(projectBookGroup({ occurrence: volume, placement, active: true, parent: structure,
    role: 'group', introducedBy: revision }, generation)).toBeNull();
});
