import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { advanceContentSequence, ContentSequenceUnavailable,
  type ContentSequenceEvent } from '../src/modules/content-sequence.ts';

const root = resolve(import.meta.dir, '../../..');
// Existing owners already pair these advances with receipt/outbox writes. Their
// owners can adopt the shared helper and remove entries; new sites cannot enter.
const legacyAdvances: Record<string, number> = {
  'services/content/src/core.ts': 1,
  'services/content/src/comments.ts': 2,
  'services/content/src/moderation.ts': 1,
  'services/main/src/modules/media/store.ts': 1,
  'services/main/src/modules/media-screen/store.ts': 3,
  'services/main/src/modules/progress/store.ts': 1,
  'services/main/src/modules/protection/content-store.ts': 1,
  'services/main/src/modules/realm-reply/content-store.ts': 2,
};

test('G-896: raw Content sequence advances stay inside the helper or existing owner allowlist', async () => {
  const unexpected: string[] = [];
  for await (const path of new Bun.Glob('services/**/src/**/*.ts').scan({ cwd: root })) {
    if (path === 'services/main/src/modules/content-sequence.ts') continue;
    const source = readFileSync(resolve(root, path), 'utf8');
    const count = [...source.matchAll(/UPDATE\s+content\.owner_control\s+SET\s+sequence\s*=/gi)].length
      + [...source.matchAll(/\.update\(ownerControl\)/g)].length;
    if (count > (legacyAdvances[path] ?? 0)) unexpected.push(`${path}: ${count} raw advances`);
  }
  expect(unexpected.sort()).toEqual([]);
});

const event: ContentSequenceEvent = { operationId: 'g-896', requestDigest: 'a'.repeat(64),
  action: 'export.create', outcome: 'rejected', reason: 'cancelled', eventType: 'export.create.cancelled',
  recipe: 'export-v1', payload: {} };

test('G-896: helper uses one atomic statement and preserves the exact returned owner position', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const client = { query: async (sql: string, values: unknown[]) => {
    queries.push({ sql, values });
    return { rows: [{ data_epoch: 'epoch', sequence: '9007199254740993' }] };
  } } as unknown as PoolClient;
  expect(await advanceContentSequence(client, event)).toEqual({ owner: 'content',
    dataEpoch: 'epoch', sequence: '9007199254740993' });
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toContain('INSERT INTO content.receipt');
  expect(queries[0]!.sql).toContain('INSERT INTO content.outbox');
  expect(queries[0]!.values.slice(0, 5)).toEqual([
    event.operationId, event.requestDigest, event.action, event.outcome, event.reason,
  ]);
  expect(queries[0]!.values.slice(6)).toEqual([event.eventType, event.recipe, '{}']);
});

test('G-896: helper fails closed on missing control and propagates transaction failure', async () => {
  const absent = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
  await expect(advanceContentSequence(absent, event)).rejects.toBeInstanceOf(ContentSequenceUnavailable);
  const failure = new Error('outbox rejected');
  const failed = { query: async () => { throw failure; } } as unknown as PoolClient;
  await expect(advanceContentSequence(failed, event)).rejects.toBe(failure);
});
