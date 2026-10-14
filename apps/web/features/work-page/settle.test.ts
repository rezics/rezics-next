import { expect, test } from 'bun:test';
import { settle, settleNullable } from './books-edition-page.read.ts';

test('every failed Work read keeps the entire problem and HTTP status without an opt-in', async () => {
  for (const status of [400, 401, 403, 404, 409, 410, 422, 500, 503]) {
    const problem = { type: 'problem', status, code: 'read_refused', title: 'Read refused',
      current: { head: 'exact-head', occurrence: 'same-occurrence' }, additional: ['retained'] };
    for (const read of [settle, settleNullable]) {
      const result = await read(async () => ({ data: null, error: { status, value: problem } }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.status).toBe(status);
      expect(result.problem).toBe(problem);
    }
  }
});

test('only HTTP 202 becomes a pending read, even when the data contains a pending visibility', async () => {
  const data = { visibility: 'pending', nextCursor: 'continuation' };
  expect(await settle(async () => ({ data, error: null, status: 200 }))).toEqual({ ok: true, data });
  expect(await settle(async () => ({ data, error: null, status: 202 })))
    .toEqual({ ok: false, failure: 'pending', status: 202, problem: data });
  expect(await settleNullable(async () => ({ data, error: null, response: { status: 202 } })))
    .toEqual({ ok: false, failure: 'pending', status: 202, problem: data });
});

test('a first page retries a moved graph once; a cursor keeps its refusal and bound recovery data', async () => {
  let calls = 0;
  const problem = { code: 'graph_moved', current: { sequence: '21' } };
  const read = async () => { calls++; return { data: null, error: { status: 409, value: problem } }; };
  await settle(read);
  expect(calls).toBe(2);
  calls = 0;
  expect(await settle(read, 'opaque')).toEqual({ ok: false, failure: 'moved', status: 409, problem });
  expect(calls).toBe(1);
  expect(await settleNullable(async () => ({ data: null, error: null }))).toEqual({ ok: true, data: null });
});
