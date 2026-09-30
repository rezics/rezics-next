import { expect, test } from 'bun:test';
import type { StatusState } from '../src/modules/library/status.ts';
import type { SessionState } from '../src/modules/session/contract.ts';
import type { CoveragePin } from '../src/modules/session/series-policy.ts';
import { workProgress } from '../src/modules/progress-summary/policy.ts';
import { readProgressCoverage } from '../src/modules/progress-summary/coverage.ts';
import { WORK_PROGRESS_COST } from '../src/modules/progress-summary/contract.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const work = id(1), rewrite = id(2);
function attempt(state: SessionState['state'], targetWork = work,
  base: SessionState['target']['base'] = 'work'): SessionState {
  const target = { base, resource: base === 'work' ? targetWork : id(3), work: targetWork,
    revision: id(4), types: [], disclosure: 'public' as const };
  return { id: id(5), target, state, version: 1, startedOn: null, finishedOn: null,
    selections: [{ target, language: 'ja', format: null, progress: 'locator' }],
    locators: [{ target: target.resource, unit: 'percentage', current: 100, furthest: 100 }],
    completedAt: null, createdAt: '2026-10-01', changedAt: '2026-10-01' };
}
const status = (value: StatusState['status'], target = work): StatusState => ({ work: target, status: value,
  startedOn: null, finishedOn: null, version: 1, changedAt: '2026-10-01' });
const summary = (sessions: SessionState[] = [], library: StatusState[] = [], pins: CoveragePin[] = [], partial = false) =>
  workProgress(work, sessions, pins, partial, library);

test('G-894: one Work is finished only by its own explicit finish or Library read across languages', () => {
  expect(summary()).toMatchObject({ status: 'not-started', counts: { required: 1, completed: 0 }, partial: false });
  for (const state of ['active', 'paused'] as const) expect(summary([attempt(state)]).status).toBe('reading');
  for (const state of ['planned', 'dnf'] as const) expect(summary([attempt(state)]).status).toBe('not-started');
  expect(summary([attempt('finished'), attempt('active')], [status('reading')]))
    .toMatchObject({ status: 'finished', counts: { required: 1, completed: 1, completedRequired: 1 } });
  expect(summary([], [status('read')]).status).toBe('finished');
  expect(summary([], [status('reading')]).status).toBe('reading');
  expect(summary([], [status('want-to-read')]).status).toBe('not-started');
  expect(summary([attempt('finished', rewrite)], [status('read', rewrite)]).status).toBe('not-started');
  expect(summary([attempt('finished', work, 'occurrence')]).status).toBe('not-started');
});

test('G-894: exact coverage pins count complete finishes without inferring them from percentages or partial coverage', () => {
  const session = attempt('finished', work, 'release');
  const pin: CoveragePin = { resource: session.target.resource, revision: session.target.revision,
    entries: [{ work, language: 'ja', completeness: 'complete', realization: id(6), revision: id(7) }] };
  expect(summary([session], [], [pin]).status).toBe('finished');
  expect(summary([{ ...session, state: 'active' }], [], [pin]).status).toBe('reading');
  expect(summary([session], [], [{ ...pin, revision: id(8) }]))
    .toMatchObject({ status: 'not-started', states: { correspondenceUnresolved: true } });
  for (const completeness of ['partial', 'trial', 'unknown'] as const) {
    const partial = { ...pin, entries: [{ ...pin.entries[0]!, completeness }] };
    expect(summary([session], [], [partial]).status).toBe('not-started');
    expect(summary([{ ...session, state: 'active' }], [], [partial]).status).toBe('reading');
  }
  expect(summary([session], [], [{ ...pin, entries: [{ ...pin.entries[0]!, work: rewrite }] }]).status).toBe('not-started');
});

test('G-894: a history window cannot assert no finish, while positive completion remains proven', () => {
  expect(summary([], [], [], true)).toMatchObject({ status: null, partial: true, counts: { completed: 0 } });
  expect(summary([attempt('active')], [], [], true).status).toBeNull();
  expect(summary([attempt('finished')], [], [], true).status).toBe('finished');
  expect(summary([], [status('read')], [], true).status).toBe('finished');
});

test('G-894: immutable coverage hydration deduplicates all selection pins in one bounded query', async () => {
  const session = attempt('active', work, 'realization');
  const sessions = Array.from({ length: WORK_PROGRESS_COST.sessions }, () => session);
  let queries = 0;
  const reader = { query: async (query: string, limit: number) => {
    queries++;
    expect(limit).toBe(1);
    expect(query.split(`(<${id(3)}> <${id(4)}>)`).length - 1).toBe(1);
    return [{ resource: { value: id(3), type: 'uri' }, revision: { value: id(4), type: 'uri' },
      nativeWork: { value: work, type: 'uri' }, nativeLanguage: { value: 'ja', type: 'literal' } }];
  } } as unknown as WorkReadSession;
  expect(await readProgressCoverage(reader, sessions)).toHaveLength(1);
  expect(queries).toBe(WORK_PROGRESS_COST.coverageQueries);
});
