import assert from 'node:assert/strict';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { readWorkerConfig, startWorker } from '../../../src/worker.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { WORK_QUEUES } from '../../../src/work/queues.ts';
import { composeWork, type WorkContext, type WorkModule } from '../../../src/work/registry.ts';

const databaseUrl = process.env.DATABASE_URL!;
const mode = process.argv[2];
if (mode === 'registry') {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await createWorkClient(databaseUrl);
  await pool.query(`CREATE TABLE public.queue_registrations (name text);
    CREATE FUNCTION public.record_queue_registration() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO public.queue_registrations VALUES (NEW.name); RETURN NEW; END $$;
    CREATE TRIGGER record_registration AFTER INSERT OR UPDATE ON dbos.queues
    FOR EACH ROW EXECUTE FUNCTION public.record_queue_registration()`);
  const order: string[] = [];
  const modules: WorkModule[] = ['first', 'second'].map((name) => ({
    name,
    async register(context) {
      assert.equal(DBOS.isInitialized(), false);
      assert.equal(context.pool, pool);
      assert.equal(context.client, client);
      assert.equal(context.queues, WORK_QUEUES);
      assert.deepEqual((await client.listQueues()).map((q) => q.name).sort(), Object.keys(WORK_QUEUES).sort());
      order.push(name);
      const step = DBOS.registerStep(async () => name, { name: `${name}.step` });
      DBOS.registerWorkflow(async () => step(), { name: `${name}.workflow` });
    },
  }));
  const options = { pool, client, databaseUrl };
  try {
    await assert.rejects(composeWork([modules[0]!, modules[0]!], options), /[Dd]uplicate.*first/);
    assert.deepEqual(order, []);
    const work = await composeWork(modules, options);
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(DBOS.isInitialized(), false);
    const launch = work.launch();
    assert.equal(work.launch(), launch);
    await launch;
    assert.equal(DBOS.isInitialized(), true);
    await assert.rejects(composeWork([{ name: 'late', register() {} }], options), /launch|compos|registration/i);
    assert.throws(() => DBOS.registerWorkflow(async () => {}, { name: 'late.workflow' }));
    assert.throws(() => DBOS.registerStep(async () => {}, { name: 'late.step' }));
    const rows = (
      await pool.query(
        'SELECT name, count(*)::int AS count FROM public.queue_registrations GROUP BY name ORDER BY name',
      )
    ).rows;
    assert.deepEqual(
      rows,
      Object.keys(WORK_QUEUES)
        .sort()
        .map((name) => ({ name, count: 1 })),
    );
    for (const name of order) {
      assert.equal(
        await (await client.enqueue({ workflowName: `${name}.workflow`, queueName: 'workflows' })).getResult(),
        name,
      );
    }
    const shutdown = work.shutdown();
    assert.equal(work.shutdown(), shutdown);
    await shutdown;
    await assert.rejects(composeWork([], options), /launch|compos|registration/i);
    console.log('registry-ok');
  } finally {
    await DBOS.shutdown();
    await client.close();
    await pool.end();
  }
} else {
  let context: WorkContext | undefined;
  const modules: WorkModule[] = [
    {
      name: 'fixture',
      register(value) {
        context = value;
        const step = DBOS.registerStep(
          async (id: string, destination?: string) => {
            console.log(`started:${id}`);
            await Bun.sleep(1_000);
            console.log(`finished:${id}`);
            if (destination) await DBOS.send(destination, id);
            return id;
          },
          { name: 'fixture.step' },
        );
        DBOS.registerWorkflow(async (id: string, destination?: string) => step(id, destination), {
          name: 'fixture.work',
        });
      },
    },
  ];
  const worker = await startWorker(readWorkerConfig(process.env), modules);
  console.log('worker-ready');
  if (mode === 'stop') {
    const stop = worker.stop();
    assert.equal(worker.stop(), stop);
    await stop;
    assert.equal(context!.pool.ended, true);
    console.log('stop-ok');
  }
}
