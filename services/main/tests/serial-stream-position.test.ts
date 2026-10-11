import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { SerialStatisticsProjection } from '../src/modules/work/serial-projection.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

function projection(
  relayHead: string,
  options: { streamScope?: string; dataEpoch?: string; checkpointEpoch?: string; checkpointSequence?: string } = {},
) {
  const relay = {
    query: async (sql: string, args?: unknown[]) => {
      expect(sql).toContain('stream_scope = $1');
      expect(sql).toContain('data_epoch = $2');
      expect(args).toEqual([MAIN_RELAY_STREAM_SCOPE, 'epoch']);
      return {
        rows: [{
          stream_scope: options.streamScope ?? MAIN_RELAY_STREAM_SCOPE,
          data_epoch: options.dataEpoch ?? 'epoch',
          sequence: relayHead,
        }],
      };
    },
  } as unknown as Pool;
  const access = {
    query: async () => ({ rows: [{
      generation: 'generation',
      graph_epoch: options.checkpointEpoch ?? 'epoch',
      sequence: options.checkpointSequence ?? '3',
      work,
      chapter_count: 2,
      word_count: '480',
      last_updated_at: new Date('2026-10-01T00:00:00Z'),
    }] }),
  } as unknown as Pool;
  const env = { lineage: { dataEpoch: 'epoch' } } as WorkActivationEnvironment;
  return new SerialStatisticsProjection(access, relay, {} as Pool, env);
}

test('A6: completed Main stream projection still returns statistics after graph-only position 100', async () => {
  const result = await projection('3').batch([work], '100');
  expect(result.get(work)).toEqual({ chapterCount: 2, wordCount: 480, lastUpdatedAt: '2026-10-01T00:00:00.000Z' });
});

test('A6: an actual Main stream gap keeps serial statistics unknown', async () => {
  expect((await projection('4').batch([work], '100')).size).toBe(0);
});

test('A6: foreign stream coverage is refused', async () => {
  await expect(
    projection('3', { streamScope: 'urn:rezics:stream:foreign' }).batch([work], '100'),
  ).rejects.toThrow('foreign stream position');
});

test('A6: foreign epoch coverage and checkpoint positions are refused', async () => {
  await expect(
    projection('3', { dataEpoch: 'foreign-epoch' }).batch([work], '100'),
  ).rejects.toThrow('foreign stream position');
  expect((await projection('3', { checkpointEpoch: 'foreign-epoch' }).batch([work], '100')).size).toBe(0);
});
