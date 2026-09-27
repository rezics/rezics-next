import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { DiscoveryProjection, type DiscoveryGeneration } from '../src/modules/discovery/store.ts';
import { RecommendationRestart, RecommendationUnavailable } from '../src/modules/recommendation/derived-generation.ts';

test('G323 activation between head lookup and generation lookup retains the first-page pin', async () => {
  const row: DiscoveryGeneration = { generation_id: '00000000-0000-4000-8000-000000000001',
    scope: 'global', realm: null, context: null, principal_id: null, source_epoch: 'epoch',
    source_sequence: '7', access_revision: '3', recovery_generation: 'recovery', checkpoint: '',
    complete: true, state: 'superseded', work_count: '2', active_head: '2' };
  let retained = true;
  const projection = new DiscoveryProjection({ connect: async () => ({
    query: async (sql: string) => {
      if (sql.startsWith('SELECT open')) return { rows: [{ open: true }] };
      if (sql.includes('SELECT active_generation')) return { rows: [{ active_generation: row.generation_id }] };
      if (sql.includes('SELECT d.*, g.state')) return { rows: [row] };
      if (sql.includes('SELECT id FROM access.derived_generation')) return { rowCount: retained ? 1 : 0 };
      if (sql.includes('d.revision::text')) return { rows: [{ revision: '3', generation: 'recovery' }] };
      return { rows: [] };
    }, release: () => {},
  }) } as unknown as Pool);
  const basis = { scope: 'global' as const, realm: null, context: null, owner: null };
  const position = { dataEpoch: 'epoch', sequence: '7' };
  for (const state of ['superseded', 'expired']) {
    row.state = state;
    expect(await projection.active(basis, position)).toMatchObject({ generation_id: row.generation_id, stale: true });
    expect(await projection.active(basis, position, row.generation_id)).toMatchObject({ stale: true });
  }
  retained = false;
  await expect(projection.active(basis, position, row.generation_id)).rejects.toBeInstanceOf(RecommendationRestart);
  await expect(projection.active(basis, position)).rejects.toBeInstanceOf(RecommendationUnavailable);
});
