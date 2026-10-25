import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { ProblemError, problemResponse } from './problem.ts';

export function createApp({ pool }: { pool: Pool }) {
  const requestIds = new WeakMap<Request, string>();
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
    })
    .onError('global', ({ error, request }) => problemResponse(error, { method: request.method, id: idFor(request) }))
    .get('/health', { detail: { hide: true } }, async () => {
      try {
        await withConnection(pool, async (client) => {
          await client.query('SELECT 1');
        });
        return { status: 'ok' as const };
      } catch {
        throw new ProblemError('dependency_unavailable');
      }
    });
}
