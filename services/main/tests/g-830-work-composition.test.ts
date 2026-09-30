import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { checkedOperations, compositionChangeDigest, pinTree, structureCreationValidations } from '../src/modules/structure/change.ts';
import { checkOccurrenceRecord, OccurrenceRecord, WorkCompletion } from '../src/modules/structure/format.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';
import { projectWorkPart, invalidWorkTargets, workTargetGuard } from '../src/modules/composition/structure-profile.ts';
import { WORK_COMPOSITION_READ_COST } from '../src/modules/composition/read.ts';
import { readCompositionSeal } from '../src/modules/structure/seal-read.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import lock from '../../../model/accepted/profiles/structure-work-composition-v1.json';
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


test('G-830: creation validates the owner Structure shape and pins the generated profile lock', async () => {
  const env = { fuseki: { commandHealth: async () => ({ profiles: Object.fromEntries(
    Object.entries(profileRegistry).map(([id, profile]) => [id, profile.sha256])) }) } } as unknown as WorkActivationEnvironment;
  const structure = id();
  const checks = await structureCreationValidations(env, structureProfileFor('work-composition'), id(), structure, id(), id());
  expect(checks.find(check => check.focus.includes(structure))).toMatchObject({
    profile: 'structure-work-composition-v1',
    shape: 'https://rezics.com/definition/structure-work-composition-v1/structure-shape' });
  expect(lock).toEqual({ sha256: profileRegistry['structure-work-composition-v1'].sha256 });
});

test('G-830: seals page disclosed pins only and reveal no private occurrence IDs or counts', async () => {
  const retained = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = { put: async bytes => {
    const digest = createHash('sha256').update(bytes).digest('hex');
    retained.set(digest, bytes); return digest;
  }, get: async digest => retained.get(digest)! };
  const structure = id(), seal = id(), revision = id(), epoch = randomUUID();
  const pins = Array.from({ length: 225 }, (_, index) => ({
    occurrence: `https://rezics.com/id/00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    target: id(), unavailable: 'missing' as const }));
  const cost = newCost(), tree = pinTree(objects);
  const root = await tree.apply(await tree.empty(cost), new Map(pins.map(pin => [`${pin.occurrence}\u0001`, pin])), cost);
  const digest = await objects.put(new TextEncoder().encode(JSON.stringify({
    format: 'rezics-structure-seal-v1', structure, structureRevision: revision,
    structureManifest: `sha256:${'a'.repeat(64)}`, pins: root, coverage: 'partial', unavailableCount: pins.length,
    model: 'https://rezics.com/definition/structure-composition-v1' })));
  const binding = (value: string) => ({ type: 'literal', value });
  const env = { structureObjects: objects, fuseki: { query: async () => ({ results: { bindings: [{
    revision: binding(revision), manifest: binding(`urn:rezics:sha256:${digest}`),
    coverage: binding('https://rezics.com/vocab/Partial'), unavailable: binding(String(pins.length)),
    epoch: binding(epoch), sequence: binding('3') }] } }) } } as unknown as WorkActivationEnvironment;
  const canReadTarget = async (target: string) => [pins[103]!.target, pins[203]!.target].includes(target);
  const first = await readCompositionSeal(env, { structure, seal, limit: 1, canReadTarget });
  expect(first.pins).toEqual([pins[103]!]);
  expect(first.next).not.toBeNull();
  const last = await readCompositionSeal(env, { structure, seal, limit: 1, canReadTarget, after: first.next! });
  expect(last.pins).toEqual([pins[203]!]);
  expect(last.next).toBeNull();
  for (const page of [first, last]) {
    expect(page).not.toHaveProperty('unavailableCount');
    expect(page).not.toHaveProperty('cost');
    for (const hidden of pins.filter((_, index) => index !== 103 && index !== 203)) expect(JSON.stringify(page)).not.toContain(hidden.occurrence);
  }
  const empty = await readCompositionSeal(env, { structure, seal, limit: 1, canReadTarget: async () => false });
  expect(empty.pins).toEqual([]);
  expect(empty.next).toBeNull();
});
