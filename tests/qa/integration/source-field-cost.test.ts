import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { identityHarness, sha } from './source-identity-harness.ts';

type Plan = { 'Actual Rows': number; 'Shared Hit Blocks': number; 'Shared Read Blocks': number;
  'Temp Read Blocks': number; Plans?: Plan[] };

/** Source owner reads should remain bounded as unrelated supports and captures grow. */
test('LIVE05/LIVE06/LIVE08: exact source owner lookups have bounded PostgreSQL work', async () => {
  const h = await identityHarness();
  const client = await h.pool.connect();
  try {
    const prefix = randomUUID().replaceAll('-', '');
    await client.query(`CREATE TEMP TABLE source_bulk AS SELECT n,
      gen_random_uuid() AS from_id, gen_random_uuid() AS to_id,
      gen_random_uuid() AS observation_id, gen_random_uuid() AS change_id,
      gen_random_uuid() AS statistic_id, gen_random_uuid() AS support_id,
      gen_random_uuid() AS target_id FROM generate_series(1, 512) AS n`);
    await client.query(`INSERT INTO source.record (id, provider, namespace, external_id)
      SELECT from_id, 'fixture', 'work', $1 || '-from-' || n FROM source_bulk
      UNION ALL SELECT to_id, 'fixture', 'work', $1 || '-to-' || n FROM source_bulk`, [prefix]);
    const bytes = Buffer.from('{"score":7}');
    await client.query(`INSERT INTO source.observation (id, record_id, principal_id,
      source_revision, media_type, retention, raw_bytes, byte_digest, coverage, rights_evidence)
      SELECT observation_id, from_id, $1, NULL, 'application/json', 'retained', $2, $3,
        '{"scope":"record","complete":true,"omittedFields":[]}'::jsonb,
        '{"basis":"unknown","note":""}'::jsonb FROM source_bulk`,
    [h.principalId, bytes, sha(bytes)]);
    await client.query(`INSERT INTO source.record_identity_change
      (id, principal_id, kind, from_record_id, to_record_id, observation_id, evidence_pointer)
      SELECT change_id, $1, 'redirect', from_id, to_id, observation_id, '/score' FROM source_bulk`, [h.principalId]);
    await client.query(`INSERT INTO source.statistic (id, principal_id, record_id,
      observation_id, kind, score_pointer, user_pointer, provider_user_key, score,
      observation_digest, idempotency_key, request_digest)
      SELECT statistic_id, $1, from_id, observation_id, 'aggregate-score', '/score', NULL,
        NULL, 7, $2, 'bulk-' || $3 || '-' || n, repeat('a',64) FROM source_bulk`,
    [h.principalId, sha(bytes), prefix]);
    await client.query(`INSERT INTO source.field_support (id, principal_id, target, slot,
      occurrence, context, record_id)
      SELECT support_id, $1, 'https://rezics.com/id/' || target_id,
        'work-metadata-v2#subtitle', NULL, 'global', from_id FROM source_bulk`, [h.principalId]);
    for (const table of ['source.record_identity_change', 'source.statistic', 'source.field_support']) {
      await client.query(`ANALYZE ${table}`);
    }
    const sample = (await client.query<{ change_id: string; statistic_id: string; support_id: string }>(
      'SELECT change_id, statistic_id, support_id FROM source_bulk WHERE n = 512')).rows[0]!;
    const explain = async (sql: string, id: string) => {
      const row = (await client.query<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${sql}`, [id, h.principalId])).rows[0]!;
      const plan = row['QUERY PLAN'][0]!.Plan;
      expect(plan['Actual Rows']).toBe(1);
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(80);
      expect(plan['Temp Read Blocks']).toBe(0);
    };
    await explain(`SELECT c.id FROM source.record_identity_change c
      JOIN source.record f ON f.id = c.from_record_id JOIN source.record t ON t.id = c.to_record_id
      JOIN source.observation o ON o.id = c.observation_id
      WHERE c.id = $1 AND c.principal_id = $2 AND o.principal_id = c.principal_id`, sample.change_id);
    await explain(`SELECT id FROM source.statistic WHERE id = $1 AND principal_id = $2`, sample.statistic_id);
    await explain(`SELECT s.id FROM source.field_support s
      JOIN source.field_support_head h ON h.support_id = s.id
      LEFT JOIN source.field_support_step st ON st.id = h.settled_step_id
      LEFT JOIN source.field_support_outcome out ON out.step_id = st.id
      LEFT JOIN source.field_support_withdrawal w ON w.support_id = s.id
      WHERE s.id = $1 AND s.principal_id = $2`, sample.support_id);
  } finally { client.release(); await h.close(); }
}, 30_000);
