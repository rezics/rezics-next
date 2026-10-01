import { describe, expect, test } from 'bun:test';
import type { MainClient } from '../features/discover/types.ts';
import { mainTrackingApi } from '../features/tracking/api.ts';
import { spiderRelations } from '../features/tracking/fixtures.ts';

/** A Main whose relations answer from `answers` in turn; the last repeats. */
function relationsFrom(answers: ({ status: number } | ReturnType<typeof spiderRelations>)[]) {
  const asked: unknown[] = [];
  const main = { v1: { resources: () => ({ relations: { get: async (request: unknown) => {
    asked.push(request);
    const answer = answers[Math.min(asked.length, answers.length) - 1]!;
    return 'status' in answer ? { data: null, error: { status: answer.status, value: null } } : { data: answer, error: null };
  } } }) } } as unknown as MainClient;
  return { api: mainTrackingApi('https://rezics.com/id/agent', () => main), asked };
}

describe('G-936 the panel hears of a counterpart although Main’s graph moved under the first read', () => {
  test('a 409 restarts the read from its first page and the next answer stands', async () => {
    const { api, asked } = relationsFrom([{ status: 409 }, spiderRelations()]);
    const read = await api.relations('https://rezics.com/id/00000000-0000-4000-8000-000000000001');
    expect(read.ok).toBe(true);
    expect(asked).toHaveLength(2);
  });

  test('a read that keeps moving ends as moved, and another failure is not retried', async () => {
    const moving = relationsFrom([{ status: 409 }]);
    expect(await moving.api.relations('https://rezics.com/id/00000000-0000-4000-8000-000000000001')).toEqual({ ok: false, failure: 'moved' });
    expect(moving.asked).toHaveLength(5);
    const missing = relationsFrom([{ status: 404 }]);
    expect(await missing.api.relations('https://rezics.com/id/00000000-0000-4000-8000-000000000001')).toEqual({ ok: false, failure: 'missing' });
    expect(missing.asked).toHaveLength(1);
  });
});
