import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import { assertGrowth, type GrowthSample } from '../../kernel/test/support/growth-bound.ts';
import { runStoreCost, type Staged } from '../../../specs/imports-run-store-driver.ts';
import { createImportRunStoreDriver } from './run-store-driver.ts';

function record(key: string, revision: number): Staged {
  const projection: Staged['projection'] = [
    {
      property: { id: 'schema:name' },
      value: { type: 'value', content: { language: 'en', text: `Book ${revision}` } },
      references: [
        {
          parts: [
            { property: { id: 'schema:sameAs' }, value: { type: 'value', content: `https://example.org/${key}` } },
          ],
        },
      ],
    },
  ];
  return {
    row: {
      source: 'growth',
      recordKey: key,
      recordRevision: 'unversioned',
      digest: new Bun.CryptoHasher('sha256').update(JSON.stringify(projection)).digest('hex'),
      converter_revision: 'fixture@1',
      state: 'present',
    },
    projection,
  };
}
function command(r: Staged): Extract<BatchCommand, { op: 'propose' }> {
  return {
    op: 'propose',
    key: `${r.row.recordKey}:${r.row.digest}`,
    source: {
      source: r.row.source,
      external_id: r.row.recordKey,
      record_revision: r.row.recordRevision,
      digest: r.row.digest,
      converter_revision: r.row.converter_revision,
      field_group: 'facts',
    },
    subject: '00000000-0000-4000-8000-000000000001',
    statement: r.projection[0]!,
  };
}
const ack = (keys: string[]): BatchWriteResult => ({
  results: keys.map((key) => ({ key, status: 200, value: { revision: 1 } })),
});

test('fixed run-state operations stay indexed at three scales', async () => {
  await mkdir('.temp', { recursive: true });
  const directory = await mkdtemp('.temp/run-growth-');
  const d = await createImportRunStoreDriver({ directory });
  const samples = new Map<string, GrowthSample[]>();
  try {
    for (const scale of [32, 128, 512]) {
      // One deterministic population, same source and indexes, three historical versions.
      for (const revision of [1, 2, 3]) {
        const run = await d.begin('growth');
        if (run === 'busy') throw new Error('Unexpected busy');
        for (let i = 0; i < scale; i++) await d.stage(run, record(`K${String(i).padStart(4, '0')}`, revision));
        expect((await d.seal(run, { complete: true })).status).toBe('ready');
        for (let i = 0; i < scale; i++) {
          const r = record(`K${String(i).padStart(4, '0')}`, revision);
          await d.classify(run, r.row.recordKey, { commands: [command(r)] });
        }
        for (;;) {
          const pending = await d.pagePending(run, { limit: 8 });
          if (!pending.length) break;
          for (const p of pending) await d.acknowledge(run, ack(p.keys));
        }
        while ((await d.finalize(run, 8)) === 'more') {
          /* bounded durable pages */
        }
      }
      const measure = async <T>(name: string, operation: () => Promise<T>) => {
        const measured = await d.measure(operation);
        const cost = runStoreCost(measured.evidence, 8);
        expect(cost.rows).toBeLessThanOrEqual(64);
        expect(cost.statements).toBeLessThanOrEqual(48);
        const group = samples.get(name) ?? [];
        group.push({ scale, cost });
        samples.set(name, group);
        return measured.value;
      };
      const blocked = await d.begin('growth');
      if (blocked === 'busy') throw new Error('Unexpected busy');
      await d.stage(blocked, record('K0000', 3));
      await d.analyze();
      expect((await measure('mass-check', () => d.seal(blocked, { complete: true }))).status).toBe(
        'mass-disappearance',
      );
      const run = await d.begin('growth');
      if (run === 'busy') throw new Error('Unexpected busy');
      for (let i = 0; i < scale; i++) await d.stage(run, record(`K${String(i).padStart(4, '0')}`, i === 0 ? 4 : 3));
      await d.seal(run, { complete: true });
      await d.analyze();
      const r = record('K0000', 4);
      expect(await measure('classify', () => d.classify(run, 'K0000', { commands: [command(r)] }))).toBe('changed');
      const pending = await measure('pending-page', () => d.pagePending(run, { limit: 8 }));
      expect(pending).toHaveLength(1);
      const bytes = pending[0]!.bytes;
      await expect(
        d.acknowledge(run, { results: [{ key: command(r).key, status: 200, value: {} }] } as never),
      ).rejects.toThrow();
      await d.acknowledge(run, {
        results: [{ key: command(r).key, status: 409, problem: { type: 'conflict', title: 'Conflict', status: 409 } }],
      });
      const resumed = await d.reopen(run);
      await expect(
        d.classify(resumed, 'K0000', { commands: [{ ...command(r), statement: record('K0000', 9).projection[0]! }] }),
      ).rejects.toThrow();
      expect((await d.pagePending(resumed, { limit: 8 }))[0]!.bytes).toBe(bytes);
      await d.analyze();
      await measure('ack', () => d.acknowledge(resumed, ack(pending[0]!.keys)));
      await d.acknowledge(resumed, ack(pending[0]!.keys));
      expect(await d.finalize(resumed, 8)).toBe('incomplete');
      for (let i = 1; i < scale; i++) await d.classify(resumed, `K${String(i).padStart(4, '0')}`, { commands: [] });
      while ((await d.finalize(resumed, 8)) === 'more') {
        /* bounded durable pages */
      }
      expect((await d.source('growth')).count).toBe(scale);
    }
    for (const group of samples.values())
      assertGrowth(group, { rows: 'constant', blocks: 'constant', statements: 'constant' });
  } finally {
    await d.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
