import { expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { rebuildSubjects } from '../../src/search/generations.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import type { SubjectSource } from '../../src/search/source.ts';

test('an executed negative Source count position cannot certify native reconciliation or activate the next generation', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  const searchUrl = process.env.OPENSEARCH_URL;
  if (!databaseUrl || !searchUrl) throw new Error('Native check database and OpenSearch are required');
  const pool = createPool(databaseUrl);
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const native = createOpenSearch(searchUrl);
  const prefix = `test-rebuild-${crypto.randomUUID().slice(0, 8)}-`;
  const partition = 3771;
  const consumer = subjectConsumer(prefix, 2);
  let counts = 0;
  let activations = 0;
  const search: OpenSearch = {
    ...native,
    request: (async (...args: Parameters<OpenSearch['request']>) => {
      if (args[0] === 'POST' && args[1] === '/_aliases') activations++;
      return native.request(...args);
    }) as OpenSearch['request'],
  };
  const source: SubjectSource = {
    async read(home) {
      return { partition: home, position: 0n, subjects: [] };
    },
    async count(home) {
      counts++;
      const { rows } = await admin.query<{ position: string }>(
        'SELECT position::text FROM core.partition WHERE partition_no = $1',
        [home],
      );
      return { position: home === partition ? -1n : BigInt(rows[0]!.position), count: 0 };
    },
  };
  try {
    await createSubjectIndex(native, prefix, 1);
    await native.request('POST', '/_aliases', {
      actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
    });
    // Fixture control: a consumed native position with no subjects, not a fabricated Semantic publication.
    await admin.query('UPDATE core.partition SET position = 1 WHERE partition_no = $1', [partition]);
    await admin.query(
      'INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position) SELECT partition_no, $2, epoch, position FROM core.partition WHERE partition_no = $1',
      [partition, consumer],
    );
    const result = await rebuildSubjects({
      pool,
      search,
      source,
      prefix,
      runner: { async refresh() {} },
      pollMs: 0,
      rounds: 1,
    }).catch((error: unknown) => error);
    expect(counts).toBeGreaterThan(0);
    expect(result).toBeInstanceOf(SearchUnavailableError);
    expect(activations).toBe(0);
    expect((await subjectGenerations(native, prefix)).active).toBe(1);
  } finally {
    try {
      for (const generation of [1, 2])
        await native.request('DELETE', `/${subjectIndexName(prefix, generation)}`).catch(() => undefined);
      await admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer = $1', [consumer]);
    } finally {
      await pool.end();
      await admin.end();
    }
  }
}, 60_000);
