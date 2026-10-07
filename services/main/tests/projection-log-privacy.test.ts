import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { logLineCarriesPersonalData } from '@rezics/observability/log';
import type { ContentCore } from '../../content/src/core.ts';
import { ContentProjectionWorker } from '../src/content-projection-worker.ts';
import { ReadRankingProjection } from '../src/modules/rankings/projection.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const email = 'projection-reader@example.com';
const agent = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';
const sql = `Key (agent)=(${agent})`;
const privateStack = 'private-projection-stack';

class DatabaseError extends Error {
  readonly detail = sql;
  constructor(readonly code = '23505') {
    super(`duplicate ${email} ${agent}`);
    this.stack = `${privateStack}\n${email}\n${agent}\n${sql}`;
  }
}

async function capture(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const previous = { error: console.error, warn: console.warn, info: console.info };
  const take = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.error = take;
  console.warn = take;
  console.info = take;
  try { await run(); }
  finally {
    console.error = previous.error;
    console.warn = previous.warn;
    console.info = previous.info;
  }
  return lines;
}

function faults(lines: string[], worker: string): Record<string, unknown>[] {
  for (const line of lines) {
    expect(logLineCarriesPersonalData(line)).toBe(false);
    for (const privateBytes of [email, agent, sql, privateStack]) expect(line).not.toContain(privateBytes);
  }
  return lines.map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(line => line.event === 'worker_fault' && line['rezics.worker.name'] === worker);
}

test('Content scheduled poll logs only bounded fault metadata and retries', async () => {
  let attempts = 0;
  const resumed = Promise.withResolvers<void>();
  const worker = new ContentProjectionWorker(async () => {
    if (++attempts === 1) throw new DatabaseError();
    resumed.resolve();
    return null;
  }, 100);
  const lines = await capture(async () => {
    worker.start();
    try { await resumed.promise; }
    finally { await worker.stop(); }
  });
  expect(attempts).toBe(2);
  expect(faults(lines, 'main.content.projection')).toEqual([{
    level: 'error', event: 'worker_fault', 'rezics.worker.name': 'main.content.projection',
    'error.class': 'DatabaseError', 'error.code': '23505',
  }]);
});

test('Content custom failure callback retains the original error', async () => {
  const error = new DatabaseError();
  const received = Promise.withResolvers<unknown>();
  const worker = new ContentProjectionWorker(async () => { throw error; }, 100,
    fault => received.resolve(fault));
  const lines = await capture(async () => {
    worker.start();
    try { expect(await received.promise).toBe(error); }
    finally { await worker.stop(); }
  });
  expect(faults(lines, 'main.content.projection')).toEqual([]);
});

test('Ranking scheduled tick logs bounded fault metadata, drops private codes and retries', async () => {
  let attempts = 0;
  const resumed = Promise.withResolvers<void>();
  // Fail the first SQL boundary of the real tick, before any other owner is consulted.
  const access = { query: async () => {
    if (++attempts === 2) resumed.resolve();
    throw new DatabaseError(attempts === 1 ? '23505' : `${email} ${sql}`);
  } } as unknown as Pool;
  const worker = new ReadRankingProjection(access, {} as ContentCore, {} as Pool,
    {} as WorkActivationEnvironment);
  const lines = await capture(async () => {
    worker.start();
    worker.start();
    try { await resumed.promise; }
    finally { await worker.stop(); }
  });
  expect(attempts).toBe(2);
  expect(faults(lines, 'main.read-ranking.projection')).toEqual([
    { level: 'error', event: 'worker_fault', 'rezics.worker.name': 'main.read-ranking.projection',
      'error.class': 'DatabaseError', 'error.code': '23505' },
    { level: 'error', event: 'worker_fault', 'rezics.worker.name': 'main.read-ranking.projection',
      'error.class': 'DatabaseError' },
  ]);
});
