import { expect, test } from 'bun:test';
import * as fc from 'fast-check';
import { seriesProgress, SERIES_POLICY, type SeriesPart, type CoveragePin } from '../src/modules/session/series-policy.ts';
import { readableSeriesCoverage } from '../src/modules/session/series-coverage.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { SessionState } from '../src/modules/session/contract.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const parts: SeriesPart[] = Array.from({ length: 24 }, (_, i) => ({ occurrence: id(100 + i), work: id(i + 1),
  displayLabel: i < 22 ? String(i + 1) : `SS${i - 21}`, inclusion: i < 22 ? 'required' : 'extra', available: i < 20 }));
function attempt(n: number, work: string, base: 'work' | 'release' | 'realization' | 'occurrence' = 'work',
  resource = work, language: string | null = 'zh-Hant', state: SessionState['state'] = 'finished'): SessionState {
  const target = { resource, revision: id(900 + n), work, base, types: [], disclosure: 'public' as const };
  return { id: id(1000 + n), target, state, version: 1, startedOn: null, finishedOn: null,
    selections: [{ target, language, format: null, progress: 'locator' }], locators: [],
    completedAt: state === 'finished' ? '2026-10-01' : null, createdAt: '2026-10-01', changedAt: '2026-10-01' };
}
const summary = (sessions: SessionState[] = [], coverage: CoveragePin[] = [], items = parts,
  conclusion: 'concluded' | 'ongoing' | 'unknown' = 'ongoing', partial = false) =>
  seriesProgress(items, sessions, coverage, 'zh-Hant', conclusion, partial);

test('G-835: reference states distinguish caught up, published finish, conclusion and unresolved coverage', () => {
  const read = parts.slice(0, 20).map((part, n) => attempt(n, part.work));
  expect(summary(read)).toMatchObject({ policy: SERIES_POLICY, counts: { completed: 20, required: 22 },
    states: { caughtUpWithAvailableMaterial: true, finishedPublishedParts: false, seriesConcluded: false,
      correspondenceUnresolved: false }, next: { part: { displayLabel: '21' }, reason: 'awaiting_chosen_language' } });
  expect(summary(parts.slice(0, 22).map((part, n) => attempt(n, part.work)), [], parts, 'concluded'))
    .toMatchObject({ states: { caughtUpWithAvailableMaterial: true, finishedPublishedParts: true, seriesConcluded: true } });
  expect(summary([], [], parts, 'unknown', true)).toMatchObject({ partial: true, next: null,
    states: { caughtUpWithAvailableMaterial: null, finishedPublishedParts: null, seriesConcluded: null } });
  const release = attempt(30, id(80), 'release', id(81));
  expect(summary([release], [{ resource: id(81), revision: release.target.revision,
    entries: [{ work: parts[0]!.work, language: 'zh-Hant', completeness: 'partial', realization: id(82), revision: id(83) }] }]))
    .toMatchObject({ counts: { completed: 0 }, states: { correspondenceUnresolved: true } });
});

test('G-835: reference omnibus plus volume one completes 24 distinct parts, never 25', () => {
  const release = attempt(30, id(80), 'release', id(81));
  const coverage: CoveragePin = { resource: id(81), revision: release.target.revision,
    entries: parts.map(part => ({ work: part.work, language: 'zh-Hant', completeness: 'complete', realization: id(82), revision: id(83) })) };
  expect(summary([release, attempt(0, parts[0]!.work)], [coverage])).toMatchObject({ counts: { completed: 24, required: 22 },
    furthestCompleted: { part: { displayLabel: 'SS2' }, locator: null } });
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 23 }), { maxLength: 80 }), indices => {
    const sessions = indices.map((index, n) => attempt(n, parts[index]!.work));
    expect(summary(sessions).counts.completed).toBe(new Set(indices).size);
    expect(summary([release, ...sessions], [coverage]).counts.completed).toBe(24);
  }));
});

test('G-835: percentages, ownership, partial coverage and another Work never fabricate completion', () => {
  const active = attempt(0, parts[0]!.work, 'realization', id(90), 'en', 'active');
  active.locators = [{ target: id(90), unit: 'percentage', current: 100, furthest: 100 }];
  const coverage: CoveragePin = { resource: id(90), revision: active.target.revision, entries: [{ work: parts[0]!.work,
    language: 'en', completeness: 'complete', realization: id(90), revision: active.target.revision }] };
  expect(summary([active], [coverage]).counts.completed).toBe(0);
  expect(summary([{ ...active, state: 'finished' }], [coverage]).counts.completed).toBe(1);
  expect(summary().counts.completed).toBe(0); // Ownership is outside the policy's input.
  expect(summary([attempt(1, id(500))]).counts.completed).toBe(0); // Web Spider does not finish book Spider.
  expect(summary([attempt(1, parts[0]!.work, 'occurrence', id(501))]).counts.completed).toBe(0);
  const reverse = { ...parts[0]!, work: id(600), displayLabel: '22 Reverse' };
  expect(summary([attempt(1, parts[0]!.work)], [], [parts[0]!, reverse]).counts.completed).toBe(1);
});

test('G-835: same-target furthest never rewinds and an omnibus locator cannot identify its last volume position', () => {
  const one = attempt(0, parts[0]!.work, 'realization', id(90));
  const two = { ...one, id: id(1500), locators: [{ target: id(90), unit: 'page' as const, current: 1, furthest: 90 }] };
  one.locators = [{ target: id(90), unit: 'page', current: 2, furthest: 70 }];
  const coverage: CoveragePin = { resource: id(90), revision: one.target.revision,
    entries: [{ work: parts[0]!.work, language: 'zh-Hant', completeness: 'complete', realization: id(90), revision: one.target.revision }] };
  expect(summary([one, two], [coverage]).furthestCompleted?.locator?.furthest).toBe(90);
  coverage.entries.push({ ...coverage.entries[0]!, work: parts[1]!.work });
  expect(summary([one, two], [coverage]).furthestCompleted?.locator).toBeNull();
});

test('G-835: optional uses do not block finish and repeated required uses retain one denominator', () => {
  const optional = { ...parts[1]!, inclusion: 'optional' as const, available: true };
  const extra = { ...parts[2]!, inclusion: 'extra' as const, available: true };
  expect(summary([attempt(0, parts[0]!.work)], [], [parts[0]!, optional, extra])).toMatchObject({
    counts: { completed: 1, required: 1 }, states: { finishedPublishedParts: true, caughtUpWithAvailableMaterial: true },
    next: { part: { work: optional.work }, reason: 'optional_extra' } });
  const repeat = { ...parts[0]!, inclusion: 'extra' as const };
  expect(summary([], [], [repeat, parts[0]!]).counts.required).toBe(1);
  expect(summary([attempt(0, parts[0]!.work)], [], [repeat, parts[0]!]).counts.completed).toBe(1);
  const release = attempt(1, parts[0]!.work, 'release', id(80));
  expect(summary([release], [{ resource: id(80), revision: id(9999), entries: [{ work: parts[0]!.work,
    language: 'zh-Hant', completeness: 'complete', realization: id(81), revision: id(82) }] }]))
    .toMatchObject({ counts: { completed: 0 }, states: { correspondenceUnresolved: true } });
});

test('G-835: Japanese completion and Library/import read states finish Works for a zh-Hant reader', () => {
  const read = parts.slice(0, 10).map((part, n) => attempt(n, part.work, 'work', part.work, 'ja'));
  const library = parts.slice(5, 12).map(part => ({ work: part.work, status: 'read' as const,
    startedOn: null, finishedOn: '2020-01-01', version: 1, changedAt: '2026-10-01' }));
  library.push({ ...library[0]!, work: id(700) });
  const result = seriesProgress(parts, read, [], 'zh-Hant', 'ongoing', false, library);
  expect(result.counts.completed).toBe(12);
  expect(result.next?.part.work).toBe(parts[12]!.work);
  expect(seriesProgress(parts, [], [], 'zh-Hant', 'ongoing', false,
    [{ ...library[0]!, status: 'reading' }]).counts.completed).toBe(0);
});

test('G-835: coverage readability batches distinct Works once across every edition', async () => {
  const works = Array.from({ length: 130 }, (_, n) => id(n + 1));
  const pins = works.map((work, n): CoveragePin => ({ resource: id(n + 200), revision: id(n + 400),
    entries: [work, works[0]!].map(work => ({ work, language: 'ja', completeness: 'complete', realization: null, revision: null })) }));
  const batches: string[][] = [];
  const session = { summaries: async (resources: string[]) => {
    batches.push(resources);
    return resources.map(reference => ({ reference, status: reference === works[129] ? 'unavailable' : 'available' }));
  } } as unknown as Pick<WorkReadSession, 'summaries'>;
  expect(await readableSeriesCoverage(session, works.slice(0, 24), [...pins, ...pins])).toHaveLength(258);
  expect(batches.map(batch => batch.length)).toEqual([64, 64, 2]);
  expect(batches.flat()).toEqual(works);
  await expect(readableSeriesCoverage(session, [works[129]!], pins)).rejects.toThrow('Progress inputs');
});
