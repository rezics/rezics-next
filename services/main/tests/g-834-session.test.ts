import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import * as fc from 'fast-check';
import { sessionChanges, InvalidSession, type SessionState } from '../src/modules/session/contract.ts';
import { t } from 'elysia';
import { applySessionChanges, sessionLibraryProjection, validateSessionDates } from '../src/modules/session/state.ts';
import { capabilityBases } from '../src/modules/target/contract.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-10-01T00:00:00.000Z';
function initial(): SessionState {
  const target = { resource: id(1), work: id(1), base: 'work' as const, revision: id(2), types: [], disclosure: 'public' as const };
  return { id: id(3), target, state: 'planned', startedOn: '2026', finishedOn: null,
    selections: [{ target, language: 'zh-Hant', format: null, progress: 'locator' },
      { target: { ...target, resource: id(6), base: 'release', revision: id(7) },
        language: 'zh-Hant', format: 'print', progress: 'locator' }], locators: [],
    completedAt: null, version: 1, createdAt: now, changedAt: now };
}

test('G-834: exact Trackable grains and state machine distinguish completion from ownership and position', () => {
  expect(capabilityBases.session).toEqual(['work', 'realization', 'release', 'occurrence']);
  let current = initial();
  for (const state of ['active', 'paused', 'active', 'dnf'] as const) {
    current = applySessionChanges(current, { state }, [], now);
    expect(current).toMatchObject({ state, startedOn: '2026', finishedOn: null, completedAt: null });
  }
  expect(() => applySessionChanges(current, { state: 'active' }, [], now)).toThrow(InvalidSession);
  const schema = t.Object(sessionChanges, { additionalProperties: false });
  for (const bad of [{ state: 'owned' }, { completed: true }, { format: 'audio', completed: true },
    { position: { target: id(1), unit: 'page', value: 5, furthest: 1 } }]) expect(Value.Check(schema, bad)).toBe(false);
  current = applySessionChanges(initial(), { position: { target: id(6), unit: 'percentage', value: 100 } }, [], now);
  expect(current).toMatchObject({ state: 'planned', completedAt: null });
});

test('G-834: one attempt completes once across print and audio and needs a new attempt for a reread', () => {
  const base = initial();
  const audio = { target: { ...base.target, resource: id(4), base: 'release' as const, revision: id(5) },
    language: 'ja', format: 'audio', progress: 'locator' as const };
  const multi = applySessionChanges(base, { state: 'active' }, [audio], now);
  const reordered = { format: audio.format, progress: audio.progress, language: audio.language,
    target: { revision: audio.target.revision, disclosure: audio.target.disclosure,
      types: audio.target.types, work: audio.target.work, base: audio.target.base, resource: audio.target.resource } };
  expect(applySessionChanges(multi, {}, [reordered], now).selections).toEqual(multi.selections);
  const finished = applySessionChanges(multi, { state: 'finished' }, [], now);
  expect(finished.selections).toEqual([...base.selections, audio]);
  expect(applySessionChanges(finished, { state: 'finished', finishedOn: '2026-10' }, [], 'later'))
    .toMatchObject({ completedAt: now, startedOn: '2026', finishedOn: '2026-10' });
  expect(() => applySessionChanges(finished, { state: 'active' }, [], now)).toThrow(InvalidSession);
  expect(() => applySessionChanges(multi, {}, [{ ...audio, language: 'en' }], now)).toThrow(InvalidSession);
  expect(() => applySessionChanges(multi, {}, [{ ...audio, target: { ...audio.target, work: id(9) } }], now))
    .toThrow(InvalidSession);
});

test('G-834: partial dates and explicit unknown survive state-only updates and impossible dates fail', () => {
  for (const [start, finish] of [['2026', '2026-01-01'], ['2026-02', '2026-02-01'], [null, null],
    ['2024-02-29', '2024-03'], ['0001', '0001-12-31']] as const) expect(() => validateSessionDates(start, finish)).not.toThrow();
  for (const [start, finish] of [['2026-02-29', null], ['0000', null], ['2026-13', null],
    ['2026-02-30', null], ['2026-03', '2026-02'], ['', null]] as const) {
    expect(() => validateSessionDates(start, finish)).toThrow(InvalidSession);
  }
  const state = applySessionChanges(initial(), { startedOn: null, finishedOn: '2026-10', state: 'finished' }, [], now);
  expect(applySessionChanges(state, { state: 'finished' }, [], now)).toMatchObject({ startedOn: null, finishedOn: '2026-10' });
});

test('G-834: furthest never rewinds over arbitrary current positions; units and hosted progress stay separate', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 60 }), positions => {
    let current = initial();
    for (const [index, value] of positions.entries()) {
      current = applySessionChanges(current, { position: { target: id(6), unit: 'percentage', value } }, [], now);
      expect(current.locators).toEqual([{ target: id(6), unit: 'percentage', current: value,
        furthest: Math.max(...positions.slice(0, index + 1)) }]);
      expect(current.startedOn).toBe('2026');
    }
  }), { seed: 834, numRuns: 80 });
  for (const position of [{ target: id(6), unit: 'page' as const, value: 0.5 },
    { target: id(6), unit: 'percentage' as const, value: 101 },
    { target: id(9), unit: 'page' as const, value: 3 }]) {
    expect(() => applySessionChanges(initial(), { position }, [], now)).toThrow(InvalidSession);
  }
  const located = applySessionChanges(initial(), { position: { target: id(6), unit: 'page', value: 50 } }, [], now);
  expect(() => applySessionChanges(located, { position: { target: id(6), unit: 'media-time', value: 30 } }, [], now))
    .toThrow(InvalidSession);
  const hosted = initial();
  hosted.selections[1]!.progress = 'structure';
  expect(() => applySessionChanges(hosted, { position: { target: id(6), unit: 'page', value: 3 } }, [], now))
    .toThrow(InvalidSession);
});

test('G-834: Work metadata pins never accept page, percentage or time positions', () => {
  const work = initial();
  for (const unit of ['page', 'percentage', 'media-time'] as const) {
    expect(() => applySessionChanges(work, { position: { target: id(1), unit, value: 3 } }, [], now))
      .toThrow('Choose an exact realization or release for locator progress');
  }
  expect(work.locators).toEqual([]);
  const realization = { ...work.selections[1]!, target: { ...work.selections[1]!.target, base: 'realization' as const } };
  const pinned = { ...work, selections: [realization] };
  expect(applySessionChanges(pinned, { position: { target: id(6), unit: 'page', value: 3 } }, [], now).locators)
    .toEqual([{ target: id(6), unit: 'page', current: 3, furthest: 3 }]);
});

test('G-834: only mapped status and day dates contribute to the Library projection', () => {
  let state = initial();
  expect(sessionLibraryProjection(state)).toEqual(['want-to-read', null, null]);
  state = applySessionChanges(state, { state: 'active', startedOn: '2026-09' }, [], now);
  const active = sessionLibraryProjection(state);
  expect(active).toEqual(['reading', null, null]);
  state = applySessionChanges(state, { state: 'paused', startedOn: '2026-10',
    position: { target: id(6), unit: 'page', value: 3 } }, [], now);
  expect(sessionLibraryProjection(state)).toEqual(active);
  state = applySessionChanges(state, { startedOn: '2026-10-01' }, [], now);
  expect(sessionLibraryProjection(state)).toEqual(['reading', '2026-10-01', null]);
  const finished = applySessionChanges(state, { state: 'finished', finishedOn: '2026-10-02' }, [], now);
  expect(sessionLibraryProjection(finished)).toEqual(['read', '2026-10-01', '2026-10-02']);
  expect(sessionLibraryProjection(applySessionChanges(state, { state: 'dnf' }, [], now)))
    .toEqual([null, '2026-10-01', null]);
});
