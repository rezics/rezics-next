import { DBOS } from '@dbos-inc/dbos-sdk';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for the terminal erasure worker');

const barrier = new Pool({ connectionString: databaseUrl, max: 2 });
const registerStep = DBOS.registerStep.bind(DBOS);
DBOS.registerStep = ((action: (...args: any[]) => any, configuration?: { name?: string; [key: string]: unknown }) => {
  const gated = async (...args: any[]) => {
    for (;;) {
      const entered = await barrier.query(
        `UPDATE access.terminal_erasure_test_barrier SET active=active+1
         WHERE singleton=true AND held=false RETURNING active`,
      );
      if (entered.rowCount) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    try {
      return await action(...args);
    } finally {
      await barrier.query(`UPDATE access.terminal_erasure_test_barrier SET active=active-1 WHERE singleton=true`);
    }
  };
  return registerStep(gated, configuration as never);
}) as typeof DBOS.registerStep;

const { readWorkerConfig, startWorker } = await import('../../../src/worker.ts');
await startWorker(readWorkerConfig(process.env));
console.info('TERMINAL_ERASURE_WORKER_READY');
