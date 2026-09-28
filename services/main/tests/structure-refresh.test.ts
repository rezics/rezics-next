import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { OccurrenceRecord, checkOccurrenceRecord, type OccurrenceRecord as Record } from '../src/modules/structure/format.ts';
import { derivedId } from '../src/modules/structure/graph.ts';
import { planBookRefresh, sourceCorrespondence } from '../src/modules/structure/refresh.ts';

const sourceStructure = derivedId('refresh-source');
const localStructure = derivedId('refresh-local');
const revision = derivedId('refresh-revision');
const target = derivedId('refresh-target');
const row = (structure: string, key: string, rank: number, label = key): Record => ({
  occurrence: derivedId(`${structure}:${key}`), state: 'active', parent: structure,
  segmentKey: '0', orderKey: rank.toString(36).padStart(3, '0'), role: 'chapter',
  target, selection: { mode: 'follow-context' },
  labels: [{ value: label, language: 'en' }], sourceKey: key,
  introducedBy: revision,
});
const localCopy = (key: string, rank: number, label = key): Record => ({
  ...row(localStructure, key, rank, label),
  sourceKey: sourceCorrespondence(sourceStructure, key),
});

test('BOOK07: refresh carries source edits and removal while preserving human placement', () => {
  const base = [row(sourceStructure, 'A', 1), row(sourceStructure, 'B', 2)];
  const source = [row(sourceStructure, 'A', 1, 'revised'), row(sourceStructure, 'C', 2)];
  const human = row(localStructure, 'human', 2);
  const local = [localCopy('A', 1), human, localCopy('B', 3)];
  const plan = planBookRefresh({ source: { structure: sourceStructure, records: source },
    base: { structure: sourceStructure, records: base },
    local: { structure: localStructure, records: local }, revision });
  expect(plan.conflicts).toEqual([]);
  expect(plan.records.filter(item => item.state === 'active').map(item => item.sourceKey))
    .toEqual([local[0]!.sourceKey, 'human', sourceCorrespondence(sourceStructure, 'C')]);
  expect(plan.records.find(item => item.sourceKey === local[0]!.sourceKey)?.labels[0]?.value)
    .toBe('revised');
  const removed = plan.records.find(item => item.sourceKey === local[2]!.sourceKey);
  expect(removed).toMatchObject({ occurrence: local[2]!.occurrence,
    state: 'removed', removedBy: revision });
  expect(removed?.orderKey).toBeUndefined();
  for (const item of plan.records) {
    expect(Value.Check(OccurrenceRecord, item)).toBe(true);
    checkOccurrenceRecord(item, 'book-composition');
  }
  expect(plan.cost.comparisons).toBeLessThanOrEqual(source.length + base.length + local.length);
});

test('BOOK07: concurrent source and local content edits return a specific conflict', () => {
  const base = row(sourceStructure, 'A', 1);
  const plan = planBookRefresh({ source: { structure: sourceStructure,
    records: [row(sourceStructure, 'A', 1, 'source edit')] },
  base: { structure: sourceStructure, records: [base] },
  local: { structure: localStructure, records: [localCopy('A', 1, 'local edit')] },
  revision });
  expect(plan.records).toEqual([]);
  expect(plan.conflicts).toEqual([{ sourceKey: sourceCorrespondence(sourceStructure, 'A'),
    reason: 'local-and-source-edit' }]);
});

test('BOOK07: refresh rejects duplicate correspondence and unknown child mapping', () => {
  const duplicate = row(sourceStructure, 'A', 2);
  duplicate.occurrence = derivedId('different-source-occurrence');
  const child = { ...row(sourceStructure, 'child', 3), parent: duplicate.occurrence };
  const plan = planBookRefresh({ source: { structure: sourceStructure,
    records: [row(sourceStructure, 'A', 1), duplicate, child] },
  local: { structure: localStructure, records: [] }, revision });
  expect(plan.records).toEqual([]);
  expect(plan.conflicts.map(item => item.reason)).toEqual([
    'ambiguous-key', 'unknown-child-correspondence',
  ]);
});

test('BOOK07: refresh comparison count grows with bounded records', () => {
  const base = Array.from({ length: 256 }, (_, index) =>
    row(sourceStructure, `source-${index}`, index + 1));
  const local = base.map((item, index) => localCopy(item.sourceKey!, index + 1));
  const plan = planBookRefresh({ source: { structure: sourceStructure, records: base },
    base: { structure: sourceStructure, records: base },
    local: { structure: localStructure, records: local }, revision });
  expect(plan.conflicts).toEqual([]);
  expect(plan.records).toHaveLength(256);
  expect(plan.cost.comparisons).toBe(256);
});

const group = (structure: string, key: string, rank: number, division: 'volume' | 'extras' = 'volume'): Record => ({
  occurrence: derivedId(`${structure}:${key}`), state: 'active', parent: structure,
  segmentKey: '0', orderKey: rank.toString(36).padStart(3, '0'), role: 'group',
  labels: [{ value: key, language: 'en' }], sourceKey: key, introducedBy: revision,
  qualifier: { type: 'book-group', division },
});
const inGroup = (record: Record, owner: Record): Record => ({ ...record, parent: owner.occurrence });
const localGroup = (key: string, rank: number, division: 'volume' | 'extras' = 'volume'): Record => ({
  ...group(localStructure, key, rank, division), sourceKey: sourceCorrespondence(sourceStructure, key),
});
/** Active uses as `group>use` labels in reading order, the way a reader meets them. */
const outline = (records: readonly Record[]) => {
  const active = records.filter(item => item.state === 'active')
    .sort((a, b) => a.segmentKey!.localeCompare(b.segmentKey!) || a.orderKey!.localeCompare(b.orderKey!));
  const label = (item: Record) => item.labels[0]!.value;
  return active.filter(item => item.parent === localStructure).flatMap(item => [label(item),
    ...active.filter(child => child.parent === item.occurrence).map(child => `${label(item)}>${label(child)}`)]);
};

test('BOOK07: a first import keeps the source volumes, their divisions and chapters', () => {
  const one = group(sourceStructure, 'Volume 1', 1);
  const extras = group(sourceStructure, 'Extras', 2, 'extras');
  const plan = planBookRefresh({ source: { structure: sourceStructure, records: [one, extras,
    inGroup(row(sourceStructure, 'A', 1), one), inGroup(row(sourceStructure, 'B', 2), one),
    inGroup(row(sourceStructure, 'X', 1), extras)] },
  local: { structure: localStructure, records: [] }, revision });
  expect(plan.conflicts).toEqual([]);
  expect(outline(plan.records)).toEqual(['Volume 1', 'Volume 1>A', 'Volume 1>B', 'Extras', 'Extras>X']);
  expect(plan.records.find(item => item.labels[0]?.value === 'Extras')?.qualifier)
    .toEqual({ type: 'book-group', division: 'extras' });
  for (const item of plan.records) {
    expect(Value.Check(OccurrenceRecord, item)).toBe(true);
    checkOccurrenceRecord(item, 'book-composition');
  }
});

test('BOOK07: a local move between volumes survives a source that adds a chapter', () => {
  const one = group(sourceStructure, 'Volume 1', 1), two = group(sourceStructure, 'Volume 2', 2);
  const base = [one, two, inGroup(row(sourceStructure, 'A', 1), one), inGroup(row(sourceStructure, 'B', 2), one),
    inGroup(row(sourceStructure, 'C', 1), two)];
  const source = [...base, inGroup(row(sourceStructure, 'D', 2), two)];
  const localOne = localGroup('Volume 1', 1), localTwo = localGroup('Volume 2', 2);
  // Locally, B was moved to the start of volume 2.
  const local = [localOne, localTwo, inGroup(localCopy('A', 1), localOne), inGroup(localCopy('B', 0), localTwo),
    inGroup(localCopy('C', 1), localTwo)];
  const plan = planBookRefresh({ source: { structure: sourceStructure, records: source },
    base: { structure: sourceStructure, records: base },
    local: { structure: localStructure, records: local }, revision });
  expect(plan.conflicts).toEqual([]);
  expect(outline(plan.records)).toEqual(['Volume 1', 'Volume 1>A', 'Volume 2', 'Volume 2>B',
    'Volume 2>C', 'Volume 2>D']);
  expect(plan.records.find(item => item.labels[0]?.value === 'B')?.occurrence).toBe(local[3]!.occurrence);
});

test('BOOK07: moving one chapter to different volumes on both sides is an order conflict', () => {
  const one = group(sourceStructure, 'Volume 1', 1), two = group(sourceStructure, 'Volume 2', 2);
  const a = row(sourceStructure, 'A', 1);
  const base = [one, two, inGroup(a, one)];
  const localOne = localGroup('Volume 1', 1), localTwo = localGroup('Volume 2', 2);
  const plan = planBookRefresh({ source: { structure: sourceStructure, records: [one, two, inGroup(a, two)] },
    base: { structure: sourceStructure, records: base },
    local: { structure: localStructure, records: [localOne, localTwo, localCopy('A', 3)] }, revision });
  expect(plan.records).toEqual([]);
  expect(plan.conflicts).toEqual([{ sourceKey: '*', reason: 'local-and-source-order' }]);
});

test('BOOK07: a Book source nested deeper than one group level has no correspondence', () => {
  const one = group(sourceStructure, 'Volume 1', 1);
  const nested = inGroup(group(sourceStructure, 'Part A', 1), one);
  const plan = planBookRefresh({ source: { structure: sourceStructure, records: [one, nested,
    inGroup(row(sourceStructure, 'A', 1), nested)] }, local: { structure: localStructure, records: [] }, revision });
  expect(plan.records).toEqual([]);
  expect(plan.conflicts.map(item => item.reason)).toEqual(['unknown-child-correspondence',
    'unknown-child-correspondence']);
});
