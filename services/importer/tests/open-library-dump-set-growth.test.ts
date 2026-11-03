import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { admitOpenLibraryDumpSet } from '../src/open-library-dump-set.ts';
import { readOpenLibraryDumpSet } from '../src/open-library-dump-set-records.ts';
import { createDumpCounters, observeDumpRetention } from '../src/dumps-bytes.ts';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const scales = [32, 128, 512] as const;

function row(family: 'author' | 'work' | 'edition', id: number) {
  if (family === 'author') {
    const record = {
      type: { key: '/type/author' },
      key: `/authors/OL${id}A`,
      revision: 1,
      last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00Z' },
      name: 'n'.repeat(16),
    };
    return `${['/type/author', record.key, 1, '2025-01-01T00:00:00Z', JSON.stringify(record)].join('\t')}\n`;
  }
  if (family === 'work') {
    const record = {
      type: { key: '/type/work' },
      key: `/works/OL${id}W`,
      revision: 1,
      last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00Z' },
      title: 't'.repeat(16),
      authors: [{ author: { key: `/authors/OL${id}A` } }],
    };
    return `${['/type/work', record.key, 1, '2025-01-01T00:00:00Z', JSON.stringify(record)].join('\t')}\n`;
  }
  const record = {
    type: { key: '/type/edition' },
    key: `/books/OL${id}M`,
    revision: 1,
    last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00Z' },
    title: 't'.repeat(16),
    works: [{ key: `/works/OL${id}W` }],
  };
  return `${['/type/edition', record.key, 1, '2025-01-01T00:00:00Z', JSON.stringify(record)].join('\t')}\n`;
}

function transport() {
  const receipts = new Map<string, BatchWriteResult['results'][number]>();
  let writes = 0;
  return {
    get writes() {
      return writes;
    },
    transport: {
      setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
      async readFence() {
        return { fenced: false, securityRevision: null };
      },
      async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
        writes++;
        return {
          results: request.commands.map((command) => {
            const prior = receipts.get(command.key);
            if (prior) return structuredClone(prior);
            const result = {
              key: command.key,
              status: 201 as const,
              value:
                command.op === 'create'
                  ? { id: randomUUID(), revision: 1 }
                  : command.op === 'propose'
                    ? { candidate: randomUUID(), revision: 1 }
                    : { revision: 1 },
            };
            receipts.set(command.key, result);
            return result;
          }),
        };
      },
    },
  };
}

test('dump-set coordinator growth is linear at 32/128/512 with partitioned members', async () => {
  const root = await mkdtemp('/dev/shm/ol-dump-set-growth-');
  const observed: { n: number; bytes: number; writes: number; statements: number; peak: number }[] = [];
  try {
    for (const n of scales) {
      const authors = n / 4;
      const works = n / 4;
      const editions = n / 2;
      const partitions = n === 128 ? 4 : 1;
      const files = { author: [] as string[], work: [] as string[], edition: [] as string[] };
      for (let i = 0; i < authors; i++) files.author[i % partitions] = `${files.author[i % partitions] ?? ''}${row('author', i + 1)}`;
      for (let i = 0; i < works; i++) files.work[i % partitions] = `${files.work[i % partitions] ?? ''}${row('work', i + 1)}`;
      for (let i = 0; i < editions; i++)
        files.edition[i % partitions] = `${files.edition[i % partitions] ?? ''}${row('edition', i + 1)}`;
      const members: { family: 'author' | 'work' | 'edition'; path: string }[] = [];
      for (const family of ['author', 'work', 'edition'] as const) {
        for (let part = 0; part < partitions; part++) {
          const path = join(root, `${family}-${n}-${part}.txt`);
          await writeFile(path, files[family][part] ?? '', { mode: 0o600 });
          members.push({ family, path });
        }
      }
      const manifest = join(root, `manifest-${n}.json`);
      await writeFile(manifest, JSON.stringify({ version: 1, source: 'openlibrary', members }), { mode: 0o600 });
      const admission = await admitOpenLibraryDumpSet(manifest);
      const counters = createDumpCounters();
      let peak = 0;
      const stop = observeDumpRetention((sample) => {
        peak = Math.max(peak, sample.total);
      });
      const handles = { value: 0 };
      const stream = readOpenLibraryDumpSet(admission, {
        signal: new AbortController().signal,
        handleCount: handles,
        counters,
      });
      const host = transport();
      const importer = new Importer({
        path: join(root, `state-${n}.sqlite`),
        transport: host.transport,
      });
      try {
        const result = await importer.runDumpSet(
          createSourceRegistration('openlibrary', { source: `g${n}` }),
          stream.records,
        );
        expect(result.status).toBe('committed');
        expect(result.counts.new).toBe(works + editions);
        expect(handles.value).toBe(0);
        const pointer = importer.session.store.source(`g${n}`);
        expect(pointer.count).toBe(works + editions);
        expect(pointer.generation).toBeTruthy();
        observed.push({
          n,
          bytes: stream.consumedBytes(),
          writes: host.writes,
          statements: counters.yieldedRecords,
          peak,
        });
      } finally {
        stop();
        await importer.close();
      }
    }
    expect(observed.map((row) => row.n)).toEqual([...scales]);
    const ratio = (field: 'bytes' | 'writes' | 'statements') => observed[2]![field] / observed[0]![field];
    expect(ratio('bytes')).toBeGreaterThan(12);
    expect(ratio('bytes')).toBeLessThan(20);
    expect(ratio('writes')).toBeGreaterThan(12);
    expect(ratio('writes')).toBeLessThan(20);
    expect(ratio('statements')).toBe(16);
    expect(observed[2]!.peak / observed[0]!.peak).toBeLessThan(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
