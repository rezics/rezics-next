import { resetGrowthTables } from './growth-reset.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { newId } from '../../src/route/route.ts';
import {
  assertGrowth,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  type Capture,
  type GrowthDatabase,
  type GrowthSample,
} from '../support/growth.ts';

const root = new URL('../../../../', import.meta.url).pathname;
const audit = 'com.rezics.access.governance.bootstrapped.v1';
let db: GrowthDatabase;
let directory: string;
let preload: string;
const person = newId(0x1234);
const other = newId(0x2345);
const transaction = newId(0);
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  mkdirSync(resolve(root, '.temp'), { recursive: true });
  directory = mkdtempSync(resolve(root, '.temp/bootstrap-growth-'));
  preload = resolve(directory, 'capture.ts');
  // Observation only: run the exact deployment CLI and native executor, retaining
  // pg's transport, parameters and results. No SQL or authorization is replaced.
  writeFileSync(
    preload,
    `import pg from ${JSON.stringify(import.meta.resolve('pg'))};
import { writeFileSync } from 'node:fs';
const capture = { statements: [], plans: [] };
const emit = pg.Pool.prototype.emit;
pg.Pool.prototype.emit = function(event, ...args) {
  if (event === 'connect') {
    const client = args[0];
    const query = client.query.bind(client);
    client.on('notice', notice => {
      const marker = 'plan:\\n';
      if (notice.message?.startsWith('duration:') && notice.message.includes(marker))
        capture.plans.push(JSON.parse(notice.message.slice(notice.message.indexOf(marker) + marker.length)));
    });
    let ready = Promise.resolve();
    for (const sql of ["LOAD 'auto_explain'", 'SET auto_explain.log_min_duration=0', 'SET auto_explain.log_analyze=on', 'SET auto_explain.log_buffers=on', 'SET auto_explain.log_timing=off', 'SET auto_explain.log_triggers=off', 'SET auto_explain.log_verbose=on', 'SET auto_explain.log_nested_statements=on', "SET auto_explain.log_format='json'", "SET auto_explain.log_level='notice'", 'SET auto_explain.sample_rate=1', 'SET client_min_messages=notice']) ready = ready.then(() => query(sql));
    client.query = (...args) => { capture.statements.push(typeof args[0] === 'string' ? args[0] : args[0].text); return ready.then(() => query(...args)); };
  }
  return emit.call(this, event, ...args);
};
process.on('exit', () => writeFileSync(process.env.BOOTSTRAP_CAPTURE, JSON.stringify(capture)));
`,
  );
}, 30_000);
afterAll(async () => {
  await db?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function clearInstallation() {
  await db.admin.query('DELETE FROM access.governance_bootstrap');
  await db.admin.query(
    "DELETE FROM access.resource_role_grant WHERE route=0 AND resource_id=$1 AND grant_role='platform.governance'",
    [PLATFORM_RESOURCE.id],
  );
  await db.admin.query('DELETE FROM core.outbox WHERE partition_no=0 AND type=$1', [audit]);
}

for (const mode of ['first', 'no-op', 'refusal'] as const) {
  test(`checkGrowth 1x/8x/64x ${mode}: native operator command and exact child CLI use bounded seeks`, async () => {
    await resetGrowthTables(db.admin, [
      'access.governance_bootstrap',
      'access.resource_role_grant',
      'access.resource_grant',
      'access.operator_fence_page',
      'access.committed_continuation',
      'access.account',
      'core.receipt',
      'core.outbox',
      'editorial.write_basis',
    ]);
    await db.admin.query('DELETE FROM semantic.context WHERE route=0 AND context_id<>$1', [PLATFORM_RESOURCE.id]);
    // Starting account facts only; the functional test creates real humans with
    // lifecycle commands and verifies native Auth-issued sessions separately.
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES (4660,$1,'actor','active',$3),(9029,$2,'actor','active',$3)",
      [person, other, transaction],
    );
    // Establish the installation no-op and refusal replay against. First-install
    // clears it again. Measured CLI processes stay one cold child per scale.
    await bootstrapGovernance(db.pool, person);
    if (mode === 'first') await clearInstallation();
    const children: GrowthSample[] = [];
    // Same in-process statements as the measured call. Clearing around a first
    // install keeps that probe fresh; the child CLI is not part of this warm-up.
    const native = async (database: GrowthDatabase) => {
      if (mode === 'first') await clearInstallation();
      const id = mode === 'refusal' ? other : person;
      if (mode === 'refusal') await expect(bootstrapGovernance(database.pool, id)).rejects.toThrow();
      else expect((await bootstrapGovernance(database.pool, id)).replayed).toBe(mode === 'no-op');
      if (mode === 'first') await clearInstallation();
    };
    const report = await checkGrowth(db, {
      name: `governance bootstrap ${mode}`,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      repetitions: 1,
      warmup: native,
      async grow(database, scale, previous) {
        // Fixed unrelated rows, present at every scale, so the smallest sample is
        // already past the sequential-scan crossover. Scale growth stays 500 per unit.
        if (previous === 0) {
          const background = Array.from({ length: 4000 }, () => newId(0));
          const backgroundTransaction = newId(0);
          await database.admin.query(
            `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
            SELECT 0,id,'actor','active',$2 FROM unnest($1::uuid[]) id`,
            [background, backgroundTransaction],
          );
          await database.admin.query(
            `INSERT INTO semantic.context(route,context_id,kind,labels)
            SELECT 0,id,'community','{}' FROM unnest($1::uuid[]) id`,
            [background],
          );
          await database.admin.query(
            `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
            SELECT 0,id,id,'unrelated.reader','(,)',$2 FROM unnest($1::uuid[]) id`,
            [background, backgroundTransaction],
          );
          await database.admin.query(
            `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
            SELECT 0,id,id,'subject:read','(,)',$2 FROM unnest($1::uuid[]) id`,
            [background, backgroundTransaction],
          );
          await database.admin.query(
            `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
            SELECT 0,'account',id,'unrelated.command',id::text,$2,1,1,$3,'{}'
            FROM unnest($1::uuid[]) id`,
            [background, Buffer.alloc(32), backgroundTransaction],
          );
          await database.admin.query(
            `INSERT INTO core.outbox(partition_no,position,event_seq,event_count,epoch,id,type,data)
            SELECT 0,2000000+n,0,1,1,id,'com.rezics.subject.created.v1',jsonb_build_object('id',id)
            FROM unnest($1::uuid[]) WITH ORDINALITY a(id,n)`,
            [background],
          );
        }
        const ids = Array.from({ length: (scale - previous) * 500 }, () => newId(0));
        await database.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
          SELECT 0,id,'actor','active',$2 FROM unnest($1::uuid[]) id`,
          [ids, transaction],
        );
        await database.admin.query(
          `INSERT INTO semantic.context(route,context_id,kind,labels)
          SELECT 0,id,'community','{}' FROM unnest($1::uuid[]) id`,
          [ids],
        );
        await database.admin.query(
          `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
          SELECT 0,$1,id,'unrelated.reader','(,)',$3 FROM unnest($2::uuid[]) id`,
          [PLATFORM_RESOURCE.id, ids, transaction],
        );
        await database.admin.query(
          `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
          SELECT 0,$1,id,'subject:read','(,)',$3 FROM unnest($2::uuid[]) id`,
          [PLATFORM_RESOURCE.id, ids, transaction],
        );
        // Both same-account history and unrelated principals on Global's partition.
        await database.admin.query(
          `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
          SELECT 0,'account',principal,'unrelated.command',id::text,$3,1,1,$4,'{}'
          FROM unnest($1::uuid[]) id CROSS JOIN LATERAL (VALUES ($2::uuid),(id)) p(principal)`,
          [ids, person, Buffer.alloc(32), transaction],
        );
        await database.admin.query(
          `INSERT INTO core.outbox(partition_no,position,event_seq,event_count,epoch,id,type,data)
          SELECT 0,1000000+$2::bigint+n,0,1,1,id,'com.rezics.subject.created.v1',jsonb_build_object('id',id)
          FROM unnest($1::uuid[]) WITH ORDINALITY a(id,n)`,
          [ids, previous * 500],
        );
        for (const table of [
          'access.account',
          'access.resource_role_grant',
          'access.resource_grant',
          'core.receipt',
          'core.outbox',
          'semantic.context',
        ])
          await database.admin.query(`VACUUM (ANALYZE) ${table}`);
      },
      async operation(database, scale) {
        await native(database);
        const id = mode === 'refusal' ? other : person;
        const output = resolve(directory, `capture-${mode}-${scale}.json`);
        const child = Bun.spawn(['bun', 'services/kernel/scripts/bootstrap-governance.ts', '--account', id], {
          cwd: root,
          env: {
            ...process.env,
            DATABASE_URL: database.url,
            BUN_OPTIONS: `--preload=${preload}`,
            BOOTSTRAP_CAPTURE: output,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(code).toBe(mode === 'refusal' ? 1 : 0);
        if (mode !== 'refusal') expect(stderr).toBe('');
        else expect(stderr).toContain('BootstrapGovernanceUnavailableError');
        const raw = JSON.parse(readFileSync(output, 'utf8')) as Capture;
        const cost = costOf(raw);
        expect(cost.statements, stderr).toBeGreaterThan(0);
        expect(cost.plans).toBeGreaterThan(0);
        children.push({ scale, cost });
        const state = await database.admin.query(
          `SELECT
          (SELECT count(*)::int FROM access.governance_bootstrap WHERE route=0 AND resource_id=$1) markers,
          (SELECT count(*)::int FROM access.resource_role_grant WHERE route=0 AND resource_id=$1 AND grant_role='platform.governance') grants,
          (SELECT count(*)::int FROM core.outbox WHERE partition_no=0 AND type=$2) audits`,
          [PLATFORM_RESOURCE.id, audit],
        );
        expect(state.rows[0]).toEqual({ markers: 1, grants: 1, audits: 1 });
      },
    });
    assertGrowth(children, report.bounds);
    for (const sample of report.samples) {
      // Bootstrap now installs the organization:create standing grant as a separate command.
      expect(sample.cost.statements).toBe(mode === 'first' ? 12 : mode === 'refusal' ? 3 : 10);
      expect(sample.cost.relations?.['access.account']?.rows).toBe(mode === 'refusal' ? 1 : 4);
    }
    for (const sample of children) {
      // The CLI runs the same governance and standing-parent commands. Catalog
      // validation is classified separately from their operation statements.
      expect(sample.cost.statements).toBe(mode === 'first' ? 12 : mode === 'refusal' ? 3 : 10);
      expect(sample.cost.relations?.['access.account']?.rows).toBe(mode === 'refusal' ? 1 : 4);
    }
    const costs = (samples: readonly GrowthSample[]) =>
      samples.map(({ scale, cost }) => ({ scale, statements: cost.statements, rows: cost.rows, blocks: cost.blocks }));
    console.info(JSON.stringify({ mode, native: costs(report.samples), cli: costs(children) }));
  }, 60_000);
}
