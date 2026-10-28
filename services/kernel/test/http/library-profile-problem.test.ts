import { expect, test } from 'bun:test';
import { ProblemError, problemResponse, problemSchema } from '../../src/http/problem.ts';
import { Value } from 'typebox/value';
test('unsupported Library capability is a closed nonretryable RFC9457 write failure rather than a programmer error', async () => {
  const response = problemResponse(new ProblemError('unsupported_library_profile'), {
    method: 'POST',
    id: 'profile-operation',
  });
  expect(response.status).toBe(422);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const body = await response.json();
  expect(body.code).toBe('unsupported_library_profile');
  expect(body.effect_status).toBe('not_applied');
  expect(body.retryable).toBe(false);
  expect(body.request_id).toBe('profile-operation');
  const schemas = problemSchema('unsupported_library_profile');
  expect(Value.Check(schemas[422]!, body)).toBe(true);
  expect(body).not.toHaveProperty('stack');
  expect(body).not.toHaveProperty('pin');
});
