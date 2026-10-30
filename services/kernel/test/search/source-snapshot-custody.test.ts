import { expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId } from '../../src/route/route.ts';
import { createSubjectIndexer } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import type { SubjectSource } from '../../src/search/source.ts';

test('a wrong-home empty source observation cannot delete or acknowledge another home', async () => {
  const pool = createPool(process.env.DATABASE_URL!);
  const native = createOpenSearch(process.env.OPENSEARCH_URL!);
  const partition = 311,
    id = newId(partition * 16);
  const prefix = `source-custody-${crypto.randomUUID().slice(0, 8)}-`,
    index = subjectIndexName(prefix, 1);
  const consumer = `source_custody_${crypto.randomUUID().replaceAll('-', '')}`;
  let listingCalls = 0;
  await createSubjectIndex(native, prefix, 1);
  try {
    const committed = await runCommand(pool, { partition }, async () => ({
      value: null,
      events: [{ type: 'com.rezics.subject.created.v1', subject: id, data: { id } }],
    }));
    const source: SubjectSource = {
      async read() {
        return { partition: partition + 1, position: committed.position, subjects: [] };
      },
      async count() {
        throw new Error('A source observation boundary must not enumerate/count');
      },
    };
    const relay = createSubjectIndexer({
      pool,
      search: native,
      source,
      index,
      consumer,
      listing: {
        async read() {
          listingCalls++;
          return new Map();
        },
      },
    });
    await expect(relay.run(partition)).rejects.toBeInstanceOf(Error);
    expect(listingCalls).toBe(0);
    const result = await pool.query(
      'SELECT position::text FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=$2',
      [consumer, partition],
    );
    expect(result.rows[0]?.position ?? '0').toBe('0');
  } finally {
    await native.request('DELETE', `/${index}`);
    await pool.query('DELETE FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=$2', [
      consumer,
      partition,
    ]);
    await pool.end();
  }
});
