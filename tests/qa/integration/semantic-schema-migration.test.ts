import { migrationVersion, schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';

const root = resolve(import.meta.dir, '../../..');
const migrations = join(root, 'services/content/migrations');
const STAGE_MIGRATION = 110;
const native = () => `https://rezics.com/id/${Bun.randomUUIDv7()}`;
const digest = () => randomBytes(32).toString('hex');
const modelGeneration = () => `urn:rezics:model-generation:${digest()}`;

async function rejects(pool: Pool, sql: string, params: unknown[], code: string, constraint?: string): Promise<void> {
  const error = await pool.query(sql, params).then(() => null, (caught: unknown) => caught as { code?: string; constraint?: string });
  expect(error?.code).toBe(code);
  if (constraint) expect(error?.constraint).toBe(constraint);
}

test('MODEL21/MODEL22 schema: semantic staging installs empty and upgrades the current Content head', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the isolated QA integration tier');
  const stack = readEnv(join(root, '.temp', 'stack', `rezics-qa-${runId}`, 'compose.env'));
  const adminUrl = `postgres://postgres:${encodeURIComponent(stack.POSTGRES_PASSWORD!)}@127.0.0.1:${stack.POSTGRES_PORT}`;
  const suffix = randomBytes(6).toString('hex');
  const names = { empty: `qa_${suffix}_semantic_empty`, upgrade: `qa_${suffix}_semantic_upgrade` };
  const admin = new Client({ connectionString: `${adminUrl}/postgres` });
  await admin.connect();
  const pools: Pool[] = [];
  try {
    for (const name of Object.values(names)) await admin.query(`CREATE DATABASE ${name}`);
    const empty = new Pool({ connectionString: `${adminUrl}/${names.empty}`, max: 4 });
    const upgrade = new Pool({ connectionString: `${adminUrl}/${names.upgrade}`, max: 4 });
    pools.push(empty, upgrade);
    const files = schemaFiles(root, 'content');
    const all = files.map(name => migrationVersion(name));
    expect(all).toContain(STAGE_MIGRATION);

    // Empty install: the runner applies every migration once and is idempotent.
    await migrateContent(empty);
    await migrateContent(empty);
    expect((await empty.query<{ version: number }>('SELECT version FROM content.schema_migration ORDER BY version'))
      .rows.map(row => row.version)).toEqual(all);

    // Upgrade: a database at the current head before this range keeps its rows.
    const before = files.filter(name => migrationVersion(name) < STAGE_MIGRATION);
    await upgrade.query(`CREATE SCHEMA content; CREATE TABLE content.schema_migration (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const name of before) {
      await upgrade.query(readFileSync(join(migrations, name), 'utf8'));
      await upgrade.query('INSERT INTO content.schema_migration (version) VALUES ($1)', [migrationVersion(name)]);
    }
    const record = randomUUID();
    await upgrade.query(`INSERT INTO source.record (id, provider, namespace, external_id)
      VALUES ($1, 'fixture', 'work', 'retained')`, [record]);
    const epoch = (await upgrade.query<{ data_epoch: string }>('SELECT data_epoch FROM content.owner_control')).rows[0]!;
    await migrateContent(upgrade);
    await migrateContent(upgrade);
    expect((await upgrade.query<{ version: number }>('SELECT version FROM content.schema_migration ORDER BY version'))
      .rows.map(row => row.version)).toEqual(all);
    expect((await upgrade.query('SELECT 1 FROM source.record WHERE id = $1', [record])).rowCount).toBe(1);
    expect((await upgrade.query<{ data_epoch: string }>('SELECT data_epoch FROM content.owner_control')).rows[0])
      .toEqual(epoch);

    for (const pool of [empty, upgrade]) {
      const generation = modelGeneration(); const nextGeneration = modelGeneration();
      const stage = randomUUID(); const principal = randomUUID();
      const insertStage = (id: string, key: string, posture = 'reject', pages = 2) => pool.query(`INSERT INTO semantic.change_stage
        (id, admission_id, principal_id, acting_subject, idempotency_key, request_digest, profile, model_generation,
         validation_posture, manifest_digest, page_count, item_count, byte_count)
        VALUES ($1, $2, $3, $4, $5, $6, 'semantic-change-bulk-v1', $7, $8, $9, $10, 3, 900)`,
      [id, randomUUID(), principal, native(), key, digest(), generation, posture, digest(), pages]);
      // The fixed reject posture cannot be overridden by a request.
      await rejects(pool, `INSERT INTO semantic.change_stage (id, admission_id, principal_id, acting_subject,
        idempotency_key, request_digest, profile, model_generation, validation_posture, manifest_digest, page_count,
        item_count, byte_count) VALUES ($1, $2, $3, $4, 'warn', $5, 'semantic-change-bulk-v1', $6, 'warn', $7, 1, 1, 1)`,
      [randomUUID(), randomUUID(), principal, native(), digest(), generation, digest()], '23514');
      await insertStage(stage, 'bulk-1');
      await rejects(pool, `INSERT INTO semantic.change_stage (id, admission_id, principal_id, acting_subject,
        idempotency_key, request_digest, profile, model_generation, manifest_digest, page_count, item_count, byte_count)
        VALUES ($1, $2, $3, $4, 'bulk-1', $5, 'semantic-change-bulk-v1', $6, $7, 1, 1, 1)`,
      [randomUUID(), randomUUID(), principal, native(), digest(), generation, digest()], '23505');
      expect((await pool.query('SELECT 1 FROM semantic.change_stage_pending WHERE stage_id = $1', [stage])).rowCount).toBe(1);
      const page = (ordinal: number) => pool.query(`INSERT INTO semantic.change_stage_page
        (stage_id, ordinal, page_digest, item_count, byte_size) VALUES ($1, $2, $3, 1, 450)`, [stage, ordinal, digest()]);
      await page(0);
      await rejects(pool, `INSERT INTO semantic.change_stage_page (stage_id, ordinal, page_digest, item_count, byte_size)
        VALUES ($1, 2, $2, 1, 1)`, [stage, digest()], '23514', 'semantic_stage_page_open');
      const validate = (ordinal: number, model: string, outcome = 'conforming') => pool.query(`INSERT INTO
        semantic.change_stage_validation (stage_id, ordinal, model_generation, outcome, report_digest)
        VALUES ($1, $2, $3, $4, $5)`, [stage, ordinal, model, outcome, outcome === 'conforming' ? null : digest()]);
      await validate(0, generation);
      const activate = (model: string) => pool.query(`INSERT INTO semantic.change_stage_outcome
        (stage_id, outcome, model_generation, graph_receipt, data_epoch, sequence)
        VALUES ($1, 'activated', $2, $3, $4, 7)`, [stage, model, `urn:rezics:receipt:${digest()}`, randomUUID()]);
      // A missing page or a page validated under another generation blocks activation.
      await rejects(pool, `INSERT INTO semantic.change_stage_outcome (stage_id, outcome, model_generation,
        graph_receipt, data_epoch, sequence) VALUES ($1, 'activated', $2, $3, $4, 7)`,
      [stage, generation, `urn:rezics:receipt:${digest()}`, randomUUID()], '23514', 'semantic_stage_conforming');
      await page(1);
      await validate(1, generation);
      await validate(0, nextGeneration);
      await validate(1, nextGeneration, 'nonconforming');
      await rejects(pool, `INSERT INTO semantic.change_stage_outcome (stage_id, outcome, model_generation,
        graph_receipt, data_epoch, sequence) VALUES ($1, 'activated', $2, $3, $4, 7)`,
      [stage, nextGeneration, `urn:rezics:receipt:${digest()}`, randomUUID()], '23514', 'semantic_stage_conforming');
      await rejects(pool, `INSERT INTO semantic.change_stage_outcome (stage_id, outcome, model_generation)
        VALUES ($1, 'activated', $2)`, [stage, generation], '23514');
      await rejects(pool, 'UPDATE semantic.change_stage_validation SET outcome = $2 WHERE stage_id = $1',
        [stage, 'conforming'], '23514');
      await activate(generation);
      expect((await pool.query('SELECT 1 FROM semantic.change_stage_pending WHERE stage_id = $1', [stage])).rowCount).toBe(0);
      await rejects(pool, `INSERT INTO semantic.change_stage_outcome (stage_id, outcome, reason, model_generation)
        VALUES ($1, 'rejected', 'stale-head', $2)`, [stage, generation], '23514', 'semantic_stage_settled');
      await rejects(pool, `INSERT INTO semantic.change_stage_validation (stage_id, ordinal, model_generation, outcome)
        VALUES ($1, 0, $2, 'conforming')`, [stage, native()], '23514', 'semantic_stage_validation_open');
      await rejects(pool, 'DELETE FROM semantic.change_stage_outcome WHERE stage_id = $1', [stage], '23514');
      await rejects(pool, 'UPDATE semantic.change_stage SET page_count = 1 WHERE id = $1', [stage], '23514');

      // A rejected or abandoned stage settles without a graph receipt and admits no later page.
      const rejected = randomUUID();
      await insertStage(rejected, 'bulk-2', 'reject', 1);
      await rejects(pool, `INSERT INTO semantic.change_stage_outcome (stage_id, outcome, reason, model_generation)
        VALUES ($1, 'rejected', NULL, $2)`, [rejected, generation], '23514');
      await pool.query(`INSERT INTO semantic.change_stage_outcome (stage_id, outcome, reason, model_generation)
        VALUES ($1, 'rejected', 'nonconforming', $2)`, [rejected, generation]);
      await rejects(pool, `INSERT INTO semantic.change_stage_page (stage_id, ordinal, page_digest, item_count, byte_size)
        VALUES ($1, 0, $2, 1, 1)`, [rejected, digest()], '23514', 'semantic_stage_page_open');
      // Recovery reads open stages through the ordered pending index, not a stage-table scan.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT stage_id
          FROM semantic.change_stage_pending ORDER BY created_at, stage_id LIMIT 100`);
        expect(plan.rows.map(row => row['QUERY PLAN']).join('\n')).toContain('semantic_change_stage_pending_order');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
  } finally {
    for (const pool of pools) await pool.end();
    for (const name of Object.values(names)) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
