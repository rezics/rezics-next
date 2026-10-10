import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { readConceptSearch } from '../src/modules/discovery/concepts.ts';
import { DiscoveryProjection } from '../src/modules/discovery/store.ts';
import {
  DiscoveryNotProduced,
  RecommendationMissing,
  RecommendationUnavailable,
} from '../src/modules/recommendation/derived-generation.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import { workReadError } from '../src/routes/work-reads.ts';

const basis = { scope: 'global' as const, realm: null, context: null, owner: null };
const position = { dataEpoch: 'epoch', sequence: '1' };

function pool(answer: (sql: string) => { rows: unknown[]; rowCount?: number }): Pool {
  return {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL'))
          return { rows: [] };
        return answer(sql);
      },
      release: () => {},
    }),
  } as unknown as Pool;
}

async function rejection(work: Promise<unknown>) {
  return work.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

test('no discovery head is never produced', async () => {
  const projection = new DiscoveryProjection(pool((sql) => {
    if (sql.startsWith('SELECT open')) return { rows: [{ open: true }] };
    if (sql.includes('SELECT active_generation')) return { rows: [] };
    throw new Error(`unexpected ${sql}`);
  }));
  const error = await rejection(projection.active(basis, position));
  expect(error).toBeInstanceOf(DiscoveryNotProduced);
  expect(error).toBeInstanceOf(RecommendationUnavailable);
});

test('a head with a missing generation row stays on the 503 path', async () => {
  const projection = new DiscoveryProjection(pool((sql) => {
    if (sql.startsWith('SELECT open')) return { rows: [{ open: true }] };
    if (sql.includes('SELECT active_generation'))
      return { rows: [{ active_generation: '00000000-0000-4000-8000-000000000001' }] };
    if (sql.includes('SELECT d.*, g.state')) return { rows: [] };
    throw new Error(`unexpected ${sql}`);
  }));
  const error = await rejection(projection.active(basis, position));
  // The generation lookup reports the row missing. The concepts route still answers 503.
  expect(error).toBeInstanceOf(RecommendationMissing);
  expect(error).not.toBeInstanceOf(DiscoveryNotProduced);
  expect(workReadError(error).status).toBe(503);
});

test('a held recovery fence stays unavailable', async () => {
  const projection = new DiscoveryProjection(pool((sql) => {
    if (sql.startsWith('SELECT open')) return { rows: [{ open: false }] };
    throw new Error(`unexpected ${sql}`);
  }));
  const error = await rejection(projection.active(basis, position));
  expect(error).toBeInstanceOf(RecommendationUnavailable);
  expect(error).not.toBeInstanceOf(DiscoveryNotProduced);
  expect((error as Error).message).toBe('Access recovery is held');
  expect(workReadError(error).status).toBe(503);
});

function session(active: () => Promise<unknown>): WorkReadSession {
  return {
    position,
    request: new Request('http://localhost/v1/discovery/concepts'),
    displayLanguages: ['en'],
    viewer: null,
    deps: { discovery: { active } },
  } as unknown as WorkReadSession;
}

test('concept search is an empty complete page when discovery was never produced', async () => {
  const page = await readConceptSearch(session(async () => {
    throw new DiscoveryNotProduced('Discovery has no active generation');
  }), {});
  expect(page).toEqual({
    profile: 'concept-search-v1',
    sourcePosition: position,
    stale: false,
    items: [],
    nextCursor: null,
    complete: true,
    count: { value: 0, kind: 'exact' },
  });
});

test('a discovery outage during concept search stays an error', async () => {
  const error = await rejection(readConceptSearch(session(async () => {
    throw new RecommendationUnavailable('Access owner is unavailable');
  }), {}));
  expect(error).toBeInstanceOf(RecommendationUnavailable);
  expect(error).not.toBeInstanceOf(DiscoveryNotProduced);
  expect(workReadError(error).status).toBe(503);
});
