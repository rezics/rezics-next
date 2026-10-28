import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { ProblemError, problemResponse, problemSchema } from '../../src/http/problem.ts';
test('entry restore occupied stale and expired have distinct stable nonretryable409 problem codes', async () => {
  const codes = [
    'library_entry_restore_occupied',
    'library_entry_restore_stale',
    'library_entry_restore_expired',
  ] as const;
  expect(new Set(codes).size).toBe(3);
  for (const code of codes) {
    const response = problemResponse(new ProblemError(code), { method: 'POST', id: 'entry-restore' });
    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const body = await response.json();
    expect(body.code).toBe(code);
    expect(body.status).toBe(409);
    expect(body.retryable).toBe(false);
    expect(body.effect_status).toBe('not_applied');
    expect(body.request_id).toBe('entry-restore');
    expect(Value.Check(problemSchema(code), body)).toBe(true);
    for (const field of ['deletionId', 'subjectId', 'incarnationId', 'pin', 'releaseDigest', 'stack'])
      expect(body).not.toHaveProperty(field);
  }
});
