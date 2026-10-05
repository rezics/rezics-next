import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { advanceContentSequence, ContentSequenceUnavailable,
  type ContentSequenceEvent } from '../src/modules/content-sequence.ts';

const root = resolve(import.meta.dir, '../../..');
const sequencer = 'services/content/src/event-sequencer.ts';

test('G-896: no writer advances the Content owner position or appends outside the sequencer module', async () => {
  // Only content.sequence_events (migration 791) numbers events; writers append
  // through appendContentEvent, which keeps one event per receipt and no position.
  const unexpected: string[] = [];
  for await (const path of new Bun.Glob('services/**/src/**/*.ts').scan({ cwd: root })) {
    const source = readFileSync(resolve(root, path), 'utf8');
    const advances = [...source.matchAll(/UPDATE\s+content\.owner_control\s+SET\s+sequence\s*=/gi)].length
      + [...source.matchAll(/\.update\(ownerControl\)/g)].length;
    const appends = path === sequencer ? 0
      : [...source.matchAll(/INSERT\s+INTO\s+content\.(receipt|outbox)\b(?!_)/gi)].length;
    if (advances) unexpected.push(`${path}: ${advances} owner position advances`);
    if (appends) unexpected.push(`${path}: ${appends} raw receipt or event inserts`);
  }
  expect(unexpected.sort()).toEqual([]);
});

const event: ContentSequenceEvent = { operationId: 'g-896', requestDigest: 'a'.repeat(64),
  action: 'export.create', outcome: 'rejected', reason: 'cancelled', eventType: 'export.create.cancelled',
  recipe: 'export-v1', payload: {} };

test('G-896: helper appends receipt and event in one statement and returns the pending operation', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const client = { query: async (sql: string, values: unknown[]) => {
    queries.push({ sql, values });
    return { rowCount: 1, rows: [] };
  } } as unknown as PoolClient;
  expect(await advanceContentSequence(client, event)).toEqual({ owner: 'content', operationId: 'g-896' });
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toContain('INSERT INTO content.receipt');
  expect(queries[0]!.sql).toContain('INSERT INTO content.outbox');
  expect(queries[0]!.sql).not.toContain('owner_control');
  expect(queries[0]!.values.slice(0, 5)).toEqual([
    event.operationId, event.requestDigest, event.action, event.outcome, event.reason,
  ]);
  expect(queries[0]!.values.slice(8)).toEqual([event.eventType, event.recipe, '{}']);
});

test('G-896: helper fails closed when the receipt is not recorded and propagates transaction failure', async () => {
  const absent = { query: async () => ({ rowCount: 0, rows: [] }) } as unknown as PoolClient;
  await expect(advanceContentSequence(absent, event)).rejects.toBeInstanceOf(ContentSequenceUnavailable);
  const failure = new Error('outbox rejected');
  const failed = { query: async () => { throw failure; } } as unknown as PoolClient;
  await expect(advanceContentSequence(failed, event)).rejects.toBe(failure);
});
