import { afterAll, beforeAll, expect, test } from 'bun:test';
import { enqueueIntent, runOperationalTransaction } from '../../src/command/operational.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, seed, type Population } from '../support/growth.ts';
import { operationalFixture, workflowName } from './support/operational-fixture.ts';

let native: Awaited<ReturnType<typeof operationalFixture>>;
const partition = 3101;
beforeAll(async () => {
  native = await operationalFixture(partition);
  await native.db.admin.query(
    'CREATE TABLE public.operational_growth(key text PRIMARY KEY, generation integer NOT NULL)',
  );
});
afterAll(async () => {
  await native?.close();
});

for (const mode of ['request', 'work-step'] as const) {
  test(`${mode} operational attempts keep statements and examined rows constant and buffers logarithmic as unrelated workflows, receipts and accounts grow`, async () => {
    const id = `operational-growth:${mode}`;
    await native.db.admin.query('INSERT INTO public.operational_growth VALUES($1,1)', [id]);
    const population: Population = {
      name: `operational-${mode}`,
      hotPartition: partition,
      hotShare: 1,
      rows({ ordinal, route }) {
        const workflowId = `${id}:unrelated:${ordinal}`;
        return {
          'access.account': [
            { route, account_id: newId(route), kind: 'actor', state: 'active', transaction_id: newId(route) },
          ],
          'core.receipt': [
            {
              partition_no: partition,
              principal_kind: 'account',
              principal_id: native.actor.accountId,
              command_kind: `unrelated.${mode}`,
              idempotency_key: String(ordinal),
              request_digest: new Uint8Array(32),
              epoch: 1,
              position: 0,
              transaction_id: newId(route),
              response: {},
            },
          ],
          'dbos.workflow_status': [
            {
              workflow_uuid: workflowId,
              name: 'test.unrelated',
              status: 'SUCCESS',
              queue_name: 'workflows',
              class_name: null,
              config_name: null,
              completed_at: 1,
            },
          ],
          'dbos.workflow_input': [
            { workflow_uuid: workflowId, inputs: JSON.stringify([{ accounts: native.accounts, key: workflowId }]) },
          ],
        };
      },
    };
    const report = await checkGrowth(native.db, {
      name: `${mode} operational transaction`,
      scales: [512, 4096, 32768],
      bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
      async grow(db, scale, previous) {
        await seed(db, population, { from: previous, to: scale });
      },
      async operation() {
        const options = mode === 'request' ? await native.request() : native.step;
        await runOperationalTransaction(native.db.pool, options, async (tx) => {
          await tx.query('UPDATE public.operational_growth SET generation=1 WHERE key=$1', [id]);
          await enqueueIntent(tx, {
            queue: 'workflows',
            workflowName,
            workflowId: id,
            input: { accounts: native.accounts, key: id, partition },
          });
        });
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([512, 4096, 32768]);
    expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
    expect(new Set(report.samples.map(({ cost }) => cost.rows)).size).toBe(1);
    for (const { cost } of report.samples) {
      for (const relation of ['dbos.workflow_status', 'core.receipt', 'access.account'])
        expect(cost.relations[relation]?.sequentialScans ?? 0).toBe(0);
      expect(cost.relations['core.receipt']?.rows ?? 0).toBe(0);
      expect(cost.relations['access.account']!.rows).toBeGreaterThanOrEqual(2);
      expect(cost.statements).toBeGreaterThan(0);
    }
    console.log(JSON.stringify({ name: report.name, samples: report.samples }));
  }, 120_000);
}
