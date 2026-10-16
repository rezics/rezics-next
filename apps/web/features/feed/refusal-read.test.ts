import { expect, test } from 'bun:test';
import { failedRead, referenceOf } from './types.ts';

test('every display category keeps the complete problem while only server failures expose its reference', () => {
  const problem = { requestId: 'support-1234', code: 'opaque', title: 'Refused', detail: 'Exact detail',
    extensions: { entries: [null, 7, { opaque: true }] } };
  for (const failure of ['sign-in', 'missing', 'moved', 'closed', 'unavailable'] as const) {
    expect(failedRead(failure, problem)).toEqual({ ok: false, failure, problem,
      ...(failure === 'unavailable' ? { reference: referenceOf(problem) } : {}) });
  }
});

test('support references from headers accompany the original body', () => {
  const problem = { title: 'Unavailable', detail: 'Original', custom: ['opaque'] };
  const headers = new Headers({ 'x-request-id': 'support-1234' });
  expect(failedRead('unavailable', problem, headers))
    .toEqual({ ok: false, failure: 'unavailable', reference: 'support-1234', problem });
  expect(failedRead('unavailable')).toEqual({ ok: false, failure: 'unavailable' });
});
