import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { MAIN_RELAY_STREAM_SCOPE, type RelayHandoffPosition } from '../src/modules/outbox/relay-position.ts';
import { ZoneBrowseProjection } from '../src/modules/zone-browse/store.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

function projection(checkpoint: string, coverage: RelayHandoffPosition, nextBatch?: {
  stream_scope: string; data_epoch: string; sequence: string; event_count: number;
}) {
  const queries: { sql: string; values?: unknown[] }[] = [];
  const relay = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes('FROM relay.checkpoint')) {
        expect(sql).toContain('FROM relay.checkpoint');
        expect(sql).not.toContain('WHERE stream_scope =');
        expect(values).toBeUndefined();
        return { rows: [{ stream_scope: coverage.streamScope, data_epoch: coverage.dataEpoch,
          sequence: coverage.sequence }] };
      }
      if (sql.includes('FROM relay.delivered_batch AS batch')) {
        expect(sql).toContain('batch.sequence = $3::numeric');
        return { rows: nextBatch ? [nextBatch] : [] };
      }
      throw new Error(`unexpected relay query: ${sql}`);
    },
  } as unknown as Pool;
  const instance = new ZoneBrowseProjection({} as Pool, relay,
    { lineage: { dataEpoch: 'epoch' }, fuseki: { query: async () => ({ results: { bindings: [{
      sequence: { value: '100' }, relaySequence: { value: coverage.sequence },
    }] } }) } } as unknown as WorkActivationEnvironment);
  const state = instance as unknown as { usableCut: boolean; checkpoint: RelayHandoffPosition };
  state.usableCut = true;
  state.checkpoint = { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: checkpoint };
  return { instance, state, queries };
}

test('A5: Main coverage 3 is current at graph diagnostic position 100', async () => {
  const { instance } = projection('3', {
    streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '3',
  });
  expect(await instance.current({ dataEpoch: 'epoch', sequence: '100' })).toBe(true);
});

test('A5: a projection behind Main coverage is not current', async () => {
  const { instance } = projection('3', {
    streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '4',
  });
  expect(await instance.current({ dataEpoch: 'epoch', sequence: '100' })).toBe(false);
});

test('A5: foreign stream and epoch positions are refused', async () => {
  const foreignScope = projection('3', { streamScope: 'urn:rezics:stream:other', dataEpoch: 'epoch', sequence: '3' });
  const foreignEpoch = projection('3', { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'restored', sequence: '3' });
  expect(await foreignScope.instance.current({ dataEpoch: 'epoch', sequence: '100' })).toBe(false);
  expect(await foreignEpoch.instance.current({ dataEpoch: 'epoch', sequence: '100' })).toBe(false);
  expect(await projection('3', { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '3' })
    .instance.current({ dataEpoch: 'restored', sequence: '100' })).toBe(false);
});

test('finding 1: a healing missing Main batch leaves its projection checkpoint behind', async () => {
  const { instance, state } = projection('3', {
    streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '5',
  });
  expect(await instance.tick()).toBe(0);
  expect(instance.recoveryStatus().state).toBe('incomplete-healing');
  expect(state.checkpoint.sequence).toBe('3');
  expect(await instance.current({ dataEpoch: 'epoch', sequence: '100' })).toBe(false);
});
