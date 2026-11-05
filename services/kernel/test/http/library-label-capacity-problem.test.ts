import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { ProblemError, problemResponse, problemSchema } from '../../src/http/problem.ts';
test('label assignment capacity has a stable nonretryable409 problem for the thirty-two reserved-slot limit', async () => {
  const response = problemResponse(new ProblemError('library_label_capacity'), {
    method: 'POST',
    id: 'label-capacity',
  });
  expect(response.status).toBe(409);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const body = await response.json();
  expect(body.code).toBe('library_label_capacity');
  expect(body.status).toBe(409);
  expect(body.effect_status).toBe('not_applied');
  expect(body.retryable).toBe(false);
  expect(body.request_id).toBe('label-capacity');
  expect(Value.Check(problemSchema('library_label_capacity'), body)).toBe(true);
  for (const field of ['labelId', 'assignmentId', 'subjectId', 'name', 'stack', 'pin'])
    expect(body).not.toHaveProperty(field);
});
