import { afterEach, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { TYPES_READ_COST } from '../src/modules/types/contract.ts';
import { installRegisteredTypes } from '../src/modules/types/registry.ts';
import { AdmittedTypeStore } from '../src/modules/types/store.ts';

afterEach(() => installRegisteredTypes([]));

function catalogPool(queries: string[]) {
  return {
    connect: async () => ({
      query: async (text: string) => {
        queries.push(text);
        if (text.includes('access.admitted_type')) return { rows: [{ fence_open: true }] };
        if (text.includes('recovery_fence')) return { rows: [{ open: true }] };
        return { rows: [] };
      },
      release: () => undefined,
    }),
  } as unknown as Pool;
}

const admittedReads = (queries: string[]) =>
  queries.filter((text) => text.includes('access.admitted_type')).length;

test('catalogue pages of 1, 16 and 64 read the admitted-type catalog once each', async () => {
  const queries: string[] = [];
  let time = 0;
  const store = new AdmittedTypeStore(catalogPool(queries), () => time);
  const app = createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'),
    { types: store } as MainWorkDependencies);
  const counts: number[] = [];
  for (const limit of [1, 16, 64]) {
    // The size-64 request is the one that used to start after the process TTL.
    if (limit === 64) time += TYPES_READ_COST.ttlMs + 1;
    const before = admittedReads(queries);
    const response = await app.handle(new Request(`http://main.local/v1/types?limit=${limit}`));
    expect(response.status).toBe(200);
    counts.push(admittedReads(queries) - before);
    time += 1_000;
  }
  expect(counts).toEqual([1, 1, 1]);
  expect(queries.some((text) => text.startsWith('BEGIN'))).toBe(false);
});

test('a request that never reads types issues no catalog statement', async () => {
  const queries: string[] = [];
  const store = new AdmittedTypeStore(catalogPool(queries), () => 0);
  const app = createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'),
    { types: store } as MainWorkDependencies);
  const response = await app.handle(new Request('http://main.local/v1/no-type-read'));
  expect(response.status).toBe(404);
  expect(admittedReads(queries)).toBe(0);
  expect(queries.some((text) => text.includes('recovery_fence'))).toBe(false);
});

test('a request that outlives the catalog TTL does not read admitted types again', async () => {
  const queries: string[] = [];
  let time = 0;
  const store = new AdmittedTypeStore(catalogPool(queries), () => time);
  await store.beginRequest();
  expect(admittedReads(queries)).toBe(1);
  time += TYPES_READ_COST.ttlMs + 1;
  await store.refresh();
  expect(admittedReads(queries)).toBe(1);
  store.endRequest();
});
