import { DBOS } from '@dbos-inc/dbos-sdk';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for the terminal erasure worker');

const barrier = new Pool({ connectionString: databaseUrl, max: 2 });
const registerStep = DBOS.registerStep.bind(DBOS);
DBOS.registerStep = ((action: (...args: any[]) => any, configuration?: { name?: string; [key: string]: unknown }) => {
  const step = configuration?.name ?? action.name;
  const gated = async (...args: any[]) => {
    for (;;) {
      const entered = await barrier.query(
        `UPDATE access.terminal_erasure_test_barrier
         SET active=active+1,
             steps=jsonb_set(steps,ARRAY[$1::text],to_jsonb(COALESCE((steps->>$1)::integer,0)+1))
         WHERE singleton=true AND held=false RETURNING active`,
        [step],
      );
      if (entered.rowCount) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    try {
      return await action(...args);
    } finally {
      await barrier.query(
        `UPDATE access.terminal_erasure_test_barrier
         SET active=active-1,
             steps=CASE WHEN (steps->>$1)::integer=1 THEN steps-$1::text
               ELSE jsonb_set(steps,ARRAY[$1::text],to_jsonb((steps->>$1)::integer-1)) END
         WHERE singleton=true`,
        [step],
      );
    }
  };
  return registerStep(gated, configuration as never);
}) as typeof DBOS.registerStep;

const { readWorkerConfig, startWorker } = await import('../../../src/worker.ts');
await startWorker(readWorkerConfig(process.env));
console.info('TERMINAL_ERASURE_WORKER_READY');
