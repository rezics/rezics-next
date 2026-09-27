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
