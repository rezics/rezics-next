import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { Admission } from './admission.ts';
import { ProblemError, problemResponse } from './problem.ts';

export const REQUEST_DEADLINE_MS = 2000;

export function createApp({ pool, admission = new Admission() }: { pool: Pool; admission?: Admission }) {
  const requestIds = new WeakMap<Request, string>();
  const arrivals = new WeakMap<Request, number>();
  const idFor = (request: Request): string => {
    let id = requestIds.get(request);
    if (!id) {
      id = Bun.randomUUIDv7();
      requestIds.set(request, id);
    }
    return id;
  };

  return new Elysia()
    .onRequest(({ request }) => {
      idFor(request);
      arrivals.set(request, Date.now());
    })
    .onError('global', ({ error, request }) => problemResponse(error, { method: request.method, id: idFor(request) }))
    .derive(({ request }) => ({
      admission,
      job: { deadline: (arrivals.get(request) ?? Date.now()) + REQUEST_DEADLINE_MS, signal: request.signal },
    }))
    .get('/health', { detail: { hide: true } }, async ({ admission: lanes, job }) => {
      try {
        await lanes.run('reserved', job, () =>
          withConnection(pool, async (client) => {
            await client.query('SELECT 1');
          }),
        );
        return { status: 'ok' as const };
      } catch {
        throw new ProblemError('dependency_unavailable');
      }
    });
}
