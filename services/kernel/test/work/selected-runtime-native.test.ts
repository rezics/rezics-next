import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { openGrowthDatabase } from '../support/growth.ts';
import { createWorkClient } from '../../src/work/client.ts';
import type { SelectedIdentity } from '../../src/work/selected-runtime.ts';

// UNRUN. Execute only in the controller's migrated native acceptance campaign.
// A subprocess isolates the SDK's process-global executor from the ordinary fixtures.
async function nativeScenario() {
  const db = await openGrowthDatabase();
  const work = await createWorkClient(db.url, db.pool);
  const sdk = DBOS as typeof DBOS & {
    registerSelectedStep(
      body: (mode: string) => Promise<string>,
      config: { name: string; retriesAllowed?: boolean; maxAttempts?: number; intervalSeconds?: number },
      lifecycle: unknown,
    ): (mode: string) => Promise<string>;
    getSelectedExecution(): object | undefined;
  };
  const client = work as typeof work & {
    selectedExecutionIdentity(claim: object, pool: pg.Pool): SelectedIdentity;
    consumeSelectedExecutionAdmission(claim: object, pool: pg.Pool): Promise<boolean>;
    checkSelectedExecutionInTransaction(raw: pg.PoolClient, pool: pg.Pool, claim: object): Promise<void>;
  };
  let opened = 0,
    closed = 0,
    bodies = 0,
    interrupted = 0;
  let escaped: object | undefined;
  const nativeIds: string[] = [];
  DBOS.setConfig({
    name: 'rezics-kernel',
    systemDatabaseUrl: db.url,
    systemDatabasePool: db.pool,
    systemDatabaseSchemaName: 'dbos',
  });
  const step = sdk.registerSelectedStep(
    async (mode) => {
      bodies++;
      const claim = sdk.getSelectedExecution();
      assert.ok(claim);
      escaped = claim;
      const i = client.selectedExecutionIdentity(claim, db.pool);
      assert.equal(i.workflowName, 'fixture.selected.workflow');
      assert.equal(i.stepName, 'fixture.selected.step');
      assert.equal(i.stepArguments, JSON.stringify([mode]));
      assert.equal(i.schema, 'dbos');
      assert.throws(() => client.selectedExecutionIdentity({ ...claim }, db.pool), /unavailable|foreign/);
      const foreign = new pg.Pool({ connectionString: db.url });
      try {
        assert.throws(() => client.selectedExecutionIdentity(claim, foreign), /foreign/);
      } finally {
        await foreign.end();
      }
      const raw = await db.pool.connect();
      try {
        await assert.rejects(
          client.checkSelectedExecutionInTransaction({ query: raw.query.bind(raw) } as pg.PoolClient, db.pool, claim),
          /native checked-out/,
        );
        if (mode === 'interrupted' && interrupted++ === 0) throw new Error('interrupt-before-consume');
        assert.equal(await client.consumeSelectedExecutionAdmission(claim, db.pool), mode !== 'interrupted');
        assert.equal(await client.consumeSelectedExecutionAdmission(claim, db.pool), false);
        // One claim legitimately spans released, sequential native transactions.
        for (let phase = 0; phase < 2; phase++) {
          await raw.query('BEGIN');
          await client.checkSelectedExecutionInTransaction(raw, db.pool, claim);
          await raw.query('SELECT 1');
          await client.checkSelectedExecutionInTransaction(raw, db.pool, claim);
          // Actual owner replacement conflicts with SHARE held on workflow_status,
          // not with a released observation or a process-local promise.
          const contender = await db.admin.connect();
          try {
            await contender.query('BEGIN');
            await contender.query("SET LOCAL lock_timeout='40ms'");
            await assert.rejects(
              contender.query('UPDATE dbos.workflow_status SET owner_xid=$2 WHERE workflow_uuid=$1', [
                i.workflowID,
                crypto.randomUUID(),
              ]),
              (error) => (error as { code?: string }).code === '55P03',
            );
          } finally {
            await contender.query('ROLLBACK');
            contender.release();
          }
          await raw.query(phase === 0 ? 'ROLLBACK' : 'COMMIT');
        }
        // Rolling back another native transaction cannot refund the durable admission.
        assert.equal(await client.consumeSelectedExecutionAdmission(claim, db.pool), false);
        if (mode === 'attempt') {
          const owner = (
            await db.admin.query('SELECT owner_xid FROM dbos.workflow_status WHERE workflow_uuid=$1', [i.workflowID])
          ).rows[0].owner_xid;
          await db.admin.query('SELECT * FROM dbos.select_step_execution($1,$2,$3,$4,$5,$6)', [
            i.workflowID,
            owner,
            i.functionID,
            i.stepName,
            i.stepArguments,
            i.deadline,
          ]);
          await raw.query('BEGIN');
          await assert.rejects(client.checkSelectedExecutionInTransaction(raw, db.pool, claim), /attempt changed/);
          await raw.query('ROLLBACK');
          assert.equal(
            (
              await db.admin.query('SELECT admission_spent FROM dbos.selected_step_executions WHERE workflow_uuid=$1', [
                i.workflowID,
              ])
            ).rows[0].admission_spent,
            true,
          );
        }
        if (mode === 'restore') {
          await work.advanceWorkflowWriterRestoreGeneration();
          await raw.query('BEGIN');
          await assert.rejects(
            client.checkSelectedExecutionInTransaction(raw, db.pool, claim),
            /restore generation changed/,
          );
          await raw.query('ROLLBACK');
        }
        return mode;
      } finally {
        await raw.query('ROLLBACK');
        raw.release();
      }
    },
    { name: 'fixture.selected.step', retriesAllowed: true, maxAttempts: 2, intervalSeconds: 0 },
    {
      async open() {
        opened++;
        return {
          deadline: Date.now() + 5000,
          async reserve() {},
          async close() {
            closed++;
          },
          run<T>(body: () => Promise<T>) {
            return body();
          },
        };
      },
    },
  );
  const workflow = DBOS.registerWorkflow(async (mode: string) => step(mode), { name: 'fixture.selected.workflow' });
  try {
    await DBOS.launch();
    for (const mode of ['replay', 'attempt', 'restore', 'interrupted']) {
      const id = `selected-native:${crypto.randomUUID()}`;
      nativeIds.push(id);
      const h = await DBOS.startWorkflow(workflow, { workflowID: id })(mode);
      assert.equal(await h.getResult(), mode);
      assert.ok(escaped);
      assert.throws(() => client.selectedExecutionIdentity(escaped!, db.pool), /unavailable/);
      assert.equal(sdk.getSelectedExecution(), undefined);
      if (mode === 'replay') {
        const before = { opened, closed, bodies };
        // Native fork copies completed step zero, then actually re-executes the workflow.
        const fork = `selected-native-fork:${crypto.randomUUID()}`;
        nativeIds.push(fork);
        await work.forkWorkflow(id, 1, { newWorkflowID: fork });
        assert.equal(await DBOS.retrieveWorkflow<string>(fork).getResult(), mode);
        assert.deepEqual({ opened, closed, bodies }, before);
        assert.equal(
          (await db.admin.query('SELECT 1 FROM dbos.selected_step_executions WHERE workflow_uuid=$1', [fork])).rowCount,
          0,
        );
      }
    }
    assert.equal(opened, 5);
    assert.equal(closed, 5);
    assert.equal(bodies, 5);
    // Native retired-owner refusal remains independent of selected-execution lifetime.
    const id = nativeIds[0]!;
    await work.retireWorkflow(id);
    const r = await db.admin.query(
      'SELECT function_id,step_name,step_arguments,deadline FROM dbos.selected_step_executions WHERE workflow_uuid=$1',
      [id],
    );
    await assert.rejects(
      db.admin.query('SELECT * FROM dbos.select_step_execution($1,$2,$3,$4,$5,$6)', [
        id,
        'stale',
        r.rows[0].function_id,
        r.rows[0].step_name,
        r.rows[0].step_arguments,
        Date.now() + 5000,
      ]),
      /owner changed|writer closed/,
    );
    console.log('selected-native-ok');
  } finally {
    await DBOS.shutdown();
    await work.close();
    await db.close();
  }
}
if (process.argv.includes('--selected-native-child')) await nativeScenario();
else
  test('Authentic selected issuance, completed replay, held owner lock, stale attempts, restore and permanent spending', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--selected-native-child'], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: expect.any(String) });
    expect(stdout).toContain('selected-native-ok');
  }, 120_000);
