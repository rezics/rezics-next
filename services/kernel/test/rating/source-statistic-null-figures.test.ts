import { expect, test } from 'bun:test';
import { Pool } from 'pg';

test('a valid source statistic without a histogram binds SQL null before execution', async () => {
  await import('reylo/register');
  const { default: upsert } = await import('../../src/rating/source-statistic-upsert.sql');
  let executions = 0;
  const metadata = new Pool({ connectionString: process.env.DATABASE_URL });
  // Keep the real schema guard; intercept only mutation execution, so no business rows are changed.
  const client = {
    query: async (query: any, values?: any) => {
      const sql = typeof query === 'string' ? query : query.text;
      if (sql.includes('INSERT INTO rating.source_statistic')) {
        executions++;
        return { rows: [] };
      }
      return metadata.query(query, values);
    },
  } as unknown as Parameters<typeof upsert.run>[0];
  try {
    const rows = await upsert.run(client, {
      route: 0,
      subject_id: '00000000-0000-4000-8000-000000000001',
      source: 'vndb',
      source_alias: 'vndb_cross_media',
      source_record_id: 'v2002',
      scale_min: 1,
      scale_max: 10,
      figures: null,
      mean: '9.02',
      count: 17136,
      as_of: '2026-10-25',
      licence: 'ODbL-1.0',
      attribution: 'VNDB',
      transaction_id: '00000000-0000-4000-8000-000000000002',
      observation_digest: 'a'.repeat(64),
      expose_observation: false,
    });
    expect(rows).toEqual([]);
    expect(executions).toBe(1);
  } finally {
    await metadata.end();
  }
});
