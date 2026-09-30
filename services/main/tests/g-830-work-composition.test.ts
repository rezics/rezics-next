import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { checkedOperations, compositionChangeDigest } from '../src/modules/structure/change.ts';
import { checkOccurrenceRecord, OccurrenceRecord, WorkCompletion } from '../src/modules/structure/format.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';
import { projectWorkPart, invalidWorkTargets, workTargetGuard } from '../src/modules/composition/structure-profile.ts';
import { WORK_COMPOSITION_READ_COST } from '../src/modules/composition/read.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const part = (): OccurrenceRecord => ({ occurrence: id(), state: 'active', parent: id(),
  segmentKey: 'a', orderKey: 'b', role: 'part', target: id(), labels: [], introducedBy: id(),
  qualifier: { type: 'work-part', displayLabel: '22 Reverse', inclusion: 'required' } });

test('G-830: one Work profile admits every native Work grain; a part carries no Content selection', () => {
  const profile = structureProfileFor('work-composition');
  expect(profile.ownerType).toBe('https://schema.org/CreativeWork');
  expect(profile.componentType).toBe('https://rezics.com/vocab/MainVersion');
  expect(profile.editAction).toBe('work.edit');
  const record = part();
  expect(Value.Check(OccurrenceRecord, record)).toBe(true);
  expect(() => checkOccurrenceRecord(record, profile.id, [], profile.selectionRequiredRoles)).not.toThrow();
  const insert = { op: 'insert' as const, parent: record.parent, role: 'part' as const,
    position: 'last' as const, target: record.target, qualifier: record.qualifier };
  expect(checkedOperations([insert], profile)[0]).not.toHaveProperty('selection');
  expect(() => checkedOperations([{ ...insert, selection: { mode: 'follow-context' } }], profile)).toThrow();
  expect(() => checkedOperations([insert], 'book-composition')).toThrow();
  for (const invalid of [{ ...record, target: undefined }, { ...record, qualifier: undefined },
    { ...record, qualifier: { type: 'work-part' as const, displayLabel: '', inclusion: 'extra' as const } }]) {
    expect(() => checkOccurrenceRecord(invalid, profile.id, [], [])).toThrow();
  }
});

test('G-830: local numbering and inclusion affect the request identity and survive qualifier projection', () => {
  const record = part(), structure = id(), head = id();
  const update = { op: 'update' as const, occurrence: record.occurrence, qualifier: record.qualifier };
  expect(checkedOperations([update], 'work-composition')).toEqual([update]);
  const digest = compositionChangeDigest(structure, head, [update], 'work-composition');
  expect(compositionChangeDigest(structure, head, [{ ...update,
    qualifier: { type: 'work-part', displayLabel: '22', inclusion: 'optional' } }], 'work-composition')).not.toBe(digest);
  const state = { ...record, selection: undefined, placement: 'urn:rezics:placement:test', active: true };
  const projected = projectWorkPart(state, id())!;
  expect(projected.triples.join('\n')).toContain('22 Reverse');
  expect(projected.triples.join('\n')).toContain('rv:composedWork');
  expect(projectWorkPart({ ...state, active: false }, id())!.triples.join('\n')).not.toContain('rv:composedWork');
  expect(projected.triples.join('\n')).not.toContain('schema:isPartOf');
});

test('G-830: evidenced completion is explicit and cannot be silently asserted without evidence', () => {
  expect(Value.Check(WorkCompletion, { status: 'unknown', evidence: [] })).toBe(true);
  for (const status of ['concluded', 'ongoing'] as const) {
    expect(() => checkedOperations([{ op: 'completion', completion: { status, evidence: [] } }], 'work-composition')).toThrow();
    expect(checkedOperations([{ op: 'completion', completion: { status, evidence: ['https://publisher.example/status'] } }], 'work-composition')).toHaveLength(1);
  }
  expect(() => checkedOperations([{ op: 'completion', completion: { status: 'unknown', evidence: [] } }], 'book-composition')).toThrow();
});

test('G-830: ancestry costs one bounded query, retains a transactional guard and does not use arbitrary closure', async () => {
  let calls = 0;
  const env = { fuseki: { query: async (query: string) => {
    calls++; expect(query).toContain('LIMIT 1'); return { results: { bindings: [] } };
  } } } as unknown as WorkActivationEnvironment;
  const owner = id(), targets = Array.from({ length: 16 }, id);
  const query = invalidWorkTargets(owner, targets);
  expect(query).not.toContain('*');
  expect(query).not.toContain('+');
  expect(query.length).toBeLessThan(20_000);
  expect(query).toContain('rv:selectedGeneration');
  expect(query).toContain('rv:composedWork');
  const guarded = await workTargetGuard(env, owner, targets);
  expect(calls).toBe(1);
  expect(guarded.guard).toContain('FILTER NOT EXISTS');
  expect(guarded.rejection).toContain('FILTER EXISTS');
  expect(Number(WORK_COMPOSITION_READ_COST.candidateProbe)).toBe(WORK_COMPOSITION_READ_COST.page + 1);
});
