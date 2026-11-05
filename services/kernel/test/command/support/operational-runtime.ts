import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { LifecycleDeniedError } from '../../../src/access/lifecycle-20261025094010-command.ts';
import { enqueueIntent, runOperationalTransaction } from '../../../src/command/operational.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';

const databaseUrl = process.env.DATABASE_URL!;
const pool = new pg.Pool({ connectionString: databaseUrl });
const client = await createWorkClient(databaseUrl, pool);
type Input = { key: string; partition: number; accounts: string[] };
if (process.argv[2] === 'produce') {
  const input = JSON.parse(process.env.OPERATIONAL_INPUT!) as Input;
  await runOperationalTransaction(
    pool,
    {
      mode: 'work-step',
      partition: input.partition,
      kind: 'test.crash-producer',
      accounts: input.accounts,
      workClient: client,
    },
    async (tx) => {
      await tx.query('INSERT INTO public.operational_derived(key) VALUES($1)', [input.key]);
      await enqueueIntent(tx, { queue: 'workflows', workflowName: 'test.operational', workflowId: input.key, input });
    },
  );
  console.log('committed');
  // The parent kills this producer after observing the commit, before any runtime exists.
  for await (const _line of console) {
    /* Wait for the producer crash barrier. */
  }
} else {
  const runtime = await composeWork(
    [
      {
        name: 'operational-test',
        register() {
          const apply = DBOS.registerStep(
            async (input: Input) => {
              try {
                await runOperationalTransaction(
                  pool,
                  {
                    mode: 'work-step',
                    partition: input.partition,
                    kind: 'test.derived-apply',
                    accounts: input.accounts,
                    workClient: client,
                  },
                  async (tx) => {
                    await tx.query('UPDATE public.operational_derived SET applied=true WHERE key=$1', [input.key]);
                  },
                );
                return 'applied';
              } catch (error) {
                if (error instanceof LifecycleDeniedError) return 'refused';
                throw error;
              }
            },
            { name: 'test.operational.apply' },
          );
          DBOS.registerWorkflow(async (input: Input) => apply(input), { name: 'test.operational' });
        },
      },
    ],
    { databaseUrl, pool, client, executorId: 'operational-test' },
  );
  await runtime.launch();
  console.log('ready');
  for await (const line of console) {
    if (line === 'stop') break;
  }
  await runtime.shutdown();
  await client.close();
  await pool.end();
}
