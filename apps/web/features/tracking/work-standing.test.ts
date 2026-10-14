import { expect, test } from 'bun:test';
import { workStandingRead } from './work-standing.ts';

test('a composition uses occurrence controls even when the adapter retained its 409 problem', () => {
  expect(workStandingRead({ ok: false, failure: 'has-parts' })).toEqual({ status: 'absent' });
  expect(workStandingRead({ ok: false, failure: 'moved', status: 409,
    problem: { code: 'work_has_parts' } })).toEqual({ status: 'absent' });
});

test('a moved graph and temporary server refusal retain their complete answer', () => {
  for (const status of [409, 503]) {
    const answer = { ok: false as const, failure: status === 409 ? 'moved' : 'unavailable', status,
      problem: { code: status === 409 ? 'graph_moved' : 'read_unavailable', current: { sequence: '19' } } };
    expect(workStandingRead(answer)).toEqual({ status: 'failed', answer });
  }
});

test('only the actual whole-Work mark becomes actionable', () => {
  expect(workStandingRead({ ok: true, data: { standing: 'started', version: 3 } }))
    .toEqual({ status: 'ready', mark: { standing: 'started', version: 3 } });
});
