import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { Client, Pool } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { projectJudgmentBadge } from '../../../services/main/src/modules/judgment/badge.ts';
import { judgmentDigest } from '../../../services/main/src/modules/judgment/schema.ts';

const root = resolve(import.meta.dir, '../../..');
const migrationDirectory = join(root, 'services/main/migrations/access');

test('GOV09/GOV10: Access 230 to 231 upgrade baselines an existing judgment aggregate', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId)
    || !Bun.env.ACCESS_DATABASE_URL) throw new Error('Run through isolated QA integration');
  const compose = readEnv(join(root, '.temp', 'stack', `rezics-qa-${runId}`, 'compose.env'));
  const adminUrl = `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres`;
  const database = `qa_judgment_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  let created = false;
  try {
    await admin.query(`CREATE DATABASE ${database} OWNER access`);
    created = true;
    const url = new URL(Bun.env.ACCESS_DATABASE_URL);
    url.pathname = `/${database}`;
    const db = new Client({ connectionString: url.toString() });
    await db.connect();
    try {
      const migrations = [...new Bun.Glob('*.sql').scanSync({ cwd: migrationDirectory })].sort();
      for (const file of migrations.filter(file => Number(file.slice(0, 3)) <= 230)) {
        await db.query(readFileSync(join(migrationDirectory, file), 'utf8'));
      }
      const principal = randomUUID(), receipt = randomUUID();
      const statement = `https://rezics.com/id/${randomUUID()}`;
      await db.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1,'https://judgment-upgrade.test','voter')`, [principal]);
      await db.query(`INSERT INTO access.judgment_aggregate
        (statement, context_key, spoiler_major, generation) VALUES ($1,'global',1,1)`, [statement]);
      await db.query(`INSERT INTO access.judgment_head
        (principal_id, statement, context_key, spoiler_value, spoiler_revision)
        VALUES ($1,$2,'global',2,1)`, [principal, statement]);
      await db.query(`INSERT INTO access.judgment_receipt
        (id, principal_id, idempotency_key, request_digest, statement,
          context_key, dimension, revision, value)
        VALUES ($1,$2,'old-vote',$3,$4,'global','spoiler',1,2)`, [receipt, principal,
        judgmentDigest('old-vote'), statement]);
      await db.query(`INSERT INTO access.judgment_revision
        (id, principal_id, statement, context_key, dimension,
          revision, value, previous_value, receipt_id)
        VALUES ($1,$2,$3,'global','spoiler',1,2,NULL,$4)`, [randomUUID(), principal, statement, receipt]);
      await db.query(readFileSync(join(migrationDirectory,
        '231_judgment_badge_and_hint.sql'), 'utf8'));
      const baseline = (await db.query<{ id: string; kind: string; generation: string }>(`
        SELECT id, kind, generation FROM access.judgment_outbox
        WHERE statement = $1 AND context_key = 'global'`, [statement])).rows[0]!;
      expect(baseline).toMatchObject({ kind: 'judgment.aggregate.baselined.v1', generation: '1' });
      const pool = new Pool({ connectionString: url.toString() });
      try {
        expect(await projectJudgmentBadge(pool, statement, { kind: 'global' }, null))
          .toMatchObject({ generation: '1', sourceEvent: baseline.id,
            status: 'major', sampleSize: 1 });
        const next = await new AccessJudgments(pool).write({ issuer: 'https://judgment-upgrade.test',
          subject: 'voter' }, { statement, context: { kind: 'global' }, dimension: 'spoiler',
          value: 0, expectedRevision: '1', idempotencyKey: 'next-vote',
          requestDigest: judgmentDigest('next-vote') });
        expect(next.revision).toBe('2');
        const events = (await pool.query<{ kind: string; generation: string }>(`
          SELECT kind, generation FROM access.judgment_outbox
          WHERE statement = $1 ORDER BY generation`, [statement])).rows;
        expect(events).toEqual([{ kind: 'judgment.aggregate.baselined.v1', generation: '1' },
          { kind: 'judgment.aggregate.invalidated.v1', generation: '2' }]);
      } finally { await pool.end(); }
    } finally { await db.end(); }
  } finally {
    if (created) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
}, 120_000);
