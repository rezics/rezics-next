import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ContentCore } from '../../content/src/core.ts';
import { ReadRankingProjection, RankingProjectionIncomplete, RankingProjectionUnavailable }
  from '../src/modules/rankings/projection.ts';
import type { RankingCaptureRow } from '../src/modules/rankings/store.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const generation = randomUUID(), contentEpoch = randomUUID(), graphEpoch = randomUUID();
const work = `https://rezics.com/id/${randomUUID()}`;
const population = { metric: 'reads' as const, interval: 'day' as const,
  bucket: '2026-10-12', context: 'urn:rezics:context:global' };

function fixture(overrides: Partial<RankingCaptureRow> = {}) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const row: RankingCaptureRow = { generation, content_epoch: contentEpoch,
    content_sequence: '7', content_scan_sequence: '11', graph_epoch: graphEpoch,
    review_position: '3', review_scan_position: '9', review_head: '20',
    coverage_intact: true, revision: '31', removal_revision: '0', removal_pending: false, removed: false,
    rows: [{ work, score: '8', growth: '3' }], ...overrides };
  const access = { query: async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    return { rows: [row] };
  } } as unknown as Pool;
  const content = { ownerPosition: async () => ({ dataEpoch: contentEpoch, sequence: '50' }) } as unknown as ContentCore;
  const contentPool = { query: async () => { throw new Error('A page must not read global progress head'); } } as unknown as Pool;
  const env = { lineage: { dataEpoch: graphEpoch } } as unknown as WorkActivationEnvironment;
  return { projection: new ReadRankingProjection(access, content, contentPool, env), row, statements };
}

test('ranking capture reads the materialization revision and bounded rows in one statement despite source lag', async () => {
  const f = fixture();
  const cut = await f.projection.capture('reads', 'day', population.bucket, 'score', null, 2);
  expect(cut).toEqual({ checkpoint: { generation, contentEpoch, contentSequence: '7',
    graphEpoch, reviewPosition: '3' }, revision: '31', removalRevision: '0', rows: f.row.rows, population });
  expect(f.statements).toHaveLength(1);
  expect(f.statements[0]!.sql).toContain('access.read_ranking_publication');
  expect(f.statements[0]!.sql).toContain('access.read_ranking_admitted');
  expect(f.statements[0]!.values).toEqual(['reads', 'day', population.bucket,
    population.context, null, '', 2]);
});

test('ranking capture preserves generation, lineage, source-ahead and retained coverage failures', async () => {
  for (const bad of [
    { coverage_intact: false }, { content_epoch: randomUUID() }, { graph_epoch: randomUUID() },
    { content_scan_sequence: '51' }, { review_head: null }, { review_scan_position: '21' }, { revision: '0' },
  ]) {
    const f = fixture(bad);
    await expect(f.projection.capture('reads', 'day', population.bucket, 'score', null, 2))
      .rejects.toBeInstanceOf(RankingProjectionUnavailable);
  }
});

test('ranking pending-removal failures retain the exact population key', async () => {
  const f = fixture({ removal_pending: true });
  const failure = await f.projection.capture('reads', 'day', population.bucket, 'score', null, 2)
    .then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(RankingProjectionIncomplete);
  expect(failure).toMatchObject({ population });
});

test('ranking delivery accepts additive source movement but rejects a removed captured row or replacement generation', async () => {
  const f = fixture();
  const cut = await f.projection.capture('reads', 'day', population.bucket, 'score', null, 2);
  f.row.revision = '32';
  f.row.content_scan_sequence = '12';
  f.row.review_scan_position = '10';
  expect(await f.projection.fence(cut)).toBe(true);
  expect(f.statements.at(-1)!.values).toEqual(['reads', 'day', population.bucket,
    population.context, '31', [work], generation]);
  f.row.removed = true;
  expect(await f.projection.fence(cut)).toBe(false);
  f.row.removed = false;
  f.row.removal_pending = true;
  await expect(f.projection.fence(cut)).rejects.toBeInstanceOf(RankingProjectionIncomplete);
  f.row.removal_pending = false;
  f.row.removal_revision = '1';
  await expect(f.projection.fence(cut)).rejects.toBeInstanceOf(RankingProjectionIncomplete);
  f.row.removal_revision = '0';
  f.row.generation = randomUUID();
  await expect(f.projection.fence(cut)).rejects.toBeInstanceOf(RankingProjectionUnavailable);
});

test('ranking malformed seek windows fail before issuing owner SQL', async () => {
  const f = fixture();
  await expect(f.projection.capture('reads', 'day', population.bucket, 'score',
    { value: '1.5', work }, 2)).rejects.toBeInstanceOf(RankingProjectionUnavailable);
  await expect(f.projection.capture('reads', 'day', population.bucket, 'score', null, 101))
    .rejects.toBeInstanceOf(RankingProjectionUnavailable);
  await expect(f.projection.capture('reads', 'day', population.bucket, 'score', null, 2, 'invalid-realm'))
    .rejects.toBeInstanceOf(RankingProjectionUnavailable);
  expect(f.statements).toHaveLength(0);
});
