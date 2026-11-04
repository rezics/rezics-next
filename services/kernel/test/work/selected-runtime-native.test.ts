import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { openGrowthDatabase } from '../support/growth.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeSelectedRuntime } from '../../src/work/selected-runtime.ts';
import { bindExecutionContract } from '../../src/command/execution-contract.ts';
import { historyExecutionPort } from '../../src/history/operational-work.ts';
import { workExecutionPort } from '../../src/work/selected-runtime.ts';
import { newId } from '../../src/route/route.ts';
import type { SelectedIdentity } from '../../src/work/selected-runtime.ts';

type Deferred<T> = ReturnType<typeof Promise.withResolvers<T>>;
type LifecycleScenario = {
  mode: 'body-error' | 'cancel' | 'deadline';
  operationStarted: Deferred<void>;
  releaseBody: Deferred<void>;
  unblockQuery: Deferred<void>;
  closeStarted: Deferred<void>;
  releaseDone: Deferred<void>;
  dispatches: Array<'issue' | 'release'>;
  blockAdmission: boolean;
  blockHold: boolean;
  releaseQueries: number;
  duplicateReleaseRefused: boolean;
  issueAfterCloseRefused: boolean;
};

// UNRUN. Execute only in the controller's migrated native acceptance campaign.
// A subprocess isolates the SDK's process-global executor from the ordinary fixtures.
async function nativeScenario() {
  const db = await openGrowthDatabase();
  const work = await createWorkClient(db.url, db.pool);
  bindExecutionContract(work, workExecutionPort, historyExecutionPort);
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
  let currentScenario: LifecycleScenario | undefined;
  let escapedUsefulCall: (() => Promise<unknown>) | undefined;
  let releaseQueries = 0;
  const originalRegister = sdk.registerSelectedStep;
  sdk.registerSelectedStep = ((
    body: (mode: string) => Promise<string>,
    config: { name: string; retriesAllowed?: boolean; maxAttempts?: number; intervalSeconds?: number },
    lifecycle: unknown,
  ) => {
    const trustedLifecycle = lifecycle as {
      open(): Promise<{
        deadline: number;
        reserve(dispatch: 'issue' | 'release'): Promise<void>;
        close(): Promise<void>;
        run<T>(body: () => Promise<T>): Promise<T>;
      }>;
    };
    return originalRegister.call(sdk, body, config, {
      async open() {
        const admission = await trustedLifecycle.open();
        const scenario = currentScenario;
        if (!scenario) throw new Error('Missing selected lifecycle test scenario');
        return {
          deadline: admission.deadline,
          run: <T>(run: () => Promise<T>) => admission.run(run),
          async reserve(dispatch: 'issue' | 'release') {
            scenario.dispatches.push(dispatch);
            await admission.reserve(dispatch);
            if (dispatch === 'release') {
              try {
                await admission.reserve('release');
              } catch {
                scenario.duplicateReleaseRefused = true;
              }
              try {
                await admission.reserve('issue');
              } catch {
                scenario.issueAfterCloseRefused = true;
              }
            }
          },
          async close() {
            scenario.closeStarted.resolve();
            await admission.close();
          },
        };
      },
    });
  }) as typeof sdk.registerSelectedStep;
  let selectedStep: ReturnType<ReturnType<typeof composeSelectedRuntime>['registerMembersStep']>;
  try {
    selectedStep = composeSelectedRuntime(db.pool, work).registerMembersStep(
      async (invocation, locator) => {
        escapedUsefulCall = () => invocation.select(locator);
        const scenario = currentScenario;
        if (!scenario) throw new Error('Missing selected lifecycle test scenario');
        const operation = invocation.select(locator);
        void operation.catch(() => undefined);
        await scenario.operationStarted.promise;
        if (scenario.mode === 'body-error') throw new Error('selected-native-primary-body-error');
        await scenario.releaseBody.promise;
        if (scenario.mode === 'deadline') return await operation;
        return 'incomplete';
      },
      { native: [] },
    );
  } finally {
    sdk.registerSelectedStep = originalRegister;
  }
  const selectedWorkflow = DBOS.registerWorkflow(
    async (locator: Parameters<typeof selectedStep>[0]) => selectedStep(locator),
    { name: 'library.membersPreparation' },
  );
  const instrumented = new WeakSet<pg.PoolClient>();
  db.pool.on('acquire', (raw: pg.PoolClient) => {
    if (instrumented.has(raw)) return;
    instrumented.add(raw);
    const query = raw.query.bind(raw);
    raw.query = ((...args: unknown[]) => {
      const input = args[0];
      const sql =
        typeof input === 'string'
          ? input
          : typeof input === 'object' && input !== null && 'text' in input && typeof input.text === 'string'
            ? input.text
            : '';
      const scenario = currentScenario;
      if (scenario?.blockHold && sql.includes('hold_selected_execution')) {
        scenario.blockHold = false;
        scenario.operationStarted.resolve();
        return scenario.unblockQuery.promise.then(() => Reflect.apply(query, raw, args as never[]));
      }
      return Reflect.apply(query, raw, args as never[]);
    }) as typeof raw.query;
  });
  const poolQuery = db.pool.query.bind(db.pool);
  db.pool.query = ((...args: unknown[]) => {
    const input = args[0];
    const sql =
      typeof input === 'string'
        ? input
        : typeof input === 'object' && input !== null && 'text' in input && typeof input.text === 'string'
          ? input.text
          : '';
    const scenario = currentScenario;
    if (scenario?.blockAdmission && sql.includes('consume_selected_execution')) {
      scenario.blockAdmission = false;
      scenario.operationStarted.resolve();
      return scenario.unblockQuery.promise.then(() => Reflect.apply(poolQuery, db.pool, args as never[]));
    }
    const result = Reflect.apply(poolQuery, db.pool, args as never[]);
    if (sql.includes('release_selected_execution') && currentScenario) {
      return Promise.resolve(result as Promise<unknown>).then(
        (value) => {
          currentScenario!.releaseQueries++;
          releaseQueries++;
          currentScenario!.releaseDone.resolve();
          return value;
        },
        (error) => {
          currentScenario!.releaseDone.reject(error);
          throw error;
        },
      );
    }
    return result;
  }) as typeof db.pool.query;
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
  async function verifyProductionLifecycle(mode: LifecycleScenario['mode']) {
    const scenario: LifecycleScenario = {
      mode,
      operationStarted: Promise.withResolvers<void>(),
      releaseBody: Promise.withResolvers<void>(),
      unblockQuery: Promise.withResolvers<void>(),
      closeStarted: Promise.withResolvers<void>(),
      releaseDone: Promise.withResolvers<void>(),
      dispatches: [],
      blockAdmission: mode === 'body-error',
      blockHold: mode !== 'body-error',
      releaseQueries: 0,
      duplicateReleaseRefused: false,
      issueAfterCloseRefused: false,
    };
    currentScenario = scenario;
    releaseQueries = 0;
    const workflowID = `selected-production:${mode}:${crypto.randomUUID()}`;
    const route = 0;
    const locator = {
      route,
      ownerAccountId: newId(route),
      collectionId: newId(route),
      episodeId: newId(route),
    };
    const handle = await DBOS.startWorkflow(selectedWorkflow, { workflowID })(locator);
    let restoreClock: (() => void) | undefined;
    try {
      await scenario.operationStarted.promise;
      const before = await db.admin.query<{ live: boolean; admission_spent: boolean; deadline: string }>(
        'SELECT live,admission_spent,deadline FROM dbos.selected_step_executions WHERE workflow_uuid=$1',
        [workflowID],
      );
      assert.equal(before.rowCount, 1);
      assert.deepEqual(
        { live: before.rows[0]!.live, admission_spent: before.rows[0]!.admission_spent },
        { live: true, admission_spent: mode !== 'body-error' },
      );
      if (mode === 'body-error') {
        await scenario.closeStarted.promise;
      } else if (mode === 'cancel') {
        await DBOS.cancelWorkflow(workflowID);
        scenario.releaseBody.resolve();
        await scenario.closeStarted.promise;
      } else {
        const originalNow = Date.now;
        Date.now = () => Number(before.rows[0]!.deadline) + 1;
        restoreClock = () => {
          Date.now = originalNow;
        };
        scenario.releaseBody.resolve();
      }
      const beforeRelease = await db.admin.query<{ live: boolean }>(
        'SELECT live FROM dbos.selected_step_executions WHERE workflow_uuid=$1',
        [workflowID],
      );
      assert.equal(beforeRelease.rows[0]!.live, true);
      assert.deepEqual(scenario.dispatches, ['issue']);
      scenario.unblockQuery.resolve();
      await scenario.releaseDone.promise;
      restoreClock?.();
      restoreClock = undefined;
      const afterRelease = await db.admin.query<{ live: boolean; admission_spent: boolean }>(
        'SELECT live,admission_spent FROM dbos.selected_step_executions WHERE workflow_uuid=$1',
        [workflowID],
      );
      assert.deepEqual(afterRelease.rows, [{ live: false, admission_spent: true }]);
      assert.deepEqual(scenario.dispatches, ['issue', 'release']);
      assert.equal(scenario.releaseQueries, 1);
      assert.equal(releaseQueries, 1);
      assert.equal(scenario.duplicateReleaseRefused, true);
      assert.equal(scenario.issueAfterCloseRefused, true);
      let workflowError: unknown;
      try {
        await handle.getResult({ pollingIntervalMs: 10 });
      } catch (error) {
        workflowError = error;
      }
      assert.ok(workflowError);
      if (mode === 'body-error') assert.match(String(workflowError), /selected-native-primary-body-error/);
      await assert.rejects(escapedUsefulCall!());
    } finally {
      restoreClock?.();
      scenario.unblockQuery.resolve();
      currentScenario = undefined;
    }
  }
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
    await verifyProductionLifecycle('body-error');
    await verifyProductionLifecycle('cancel');
    await verifyProductionLifecycle('deadline');
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
