import { DBOS } from '@dbos-inc/dbos-sdk';
import { Pool } from 'pg';
import { workerTestEnv } from '../../support/worker-env.ts';

export const TERMINAL_ERASURE_BARRIER_TABLE = 'access.terminal_erasure_test_barrier';

/** Starts the complete production worker with a test gate at each real DBOS step boundary. */
export async function startTerminalErasureWorker(databaseUrl: string) {
  let output = '';
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const worker = Bun.spawn(
    [process.execPath, new URL('./terminal-erasure-worker-process.ts', import.meta.url).pathname],
    {
      env: workerTestEnv({
        ...process.env,
        DATABASE_URL: databaseUrl,
        KERNEL_EXECUTOR_ID: `terminal-erasure-${crypto.randomUUID()}`,
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output = (output + decoder.decode(chunk, { stream: true })).slice(-8192);
      if (output.includes('TERMINAL_ERASURE_WORKER_READY')) ready();
    }
  };
  const diagnostics = Promise.all([read(worker.stdout), read(worker.stderr)]);
  try {
    await Promise.race([
      readiness,
      worker.exited.then(async (code) => {
        await diagnostics;
        throw new Error(`Terminal erasure worker exited ${code}: ${output}`);
      }),
    ]);
  } catch (error) {
    if (worker.exitCode === null) worker.kill('SIGKILL');
    await worker.exited;
    await diagnostics;
    throw error;
  }

  let closed: Promise<void> | undefined;
  return {
    get output() {
      return output;
    },
    async hold(pool: Pick<Pool, 'query'>) {
      await pool.query(`UPDATE ${TERMINAL_ERASURE_BARRIER_TABLE} SET held=true WHERE singleton=true`);
      const deadline = Date.now() + 30_000;
      for (;;) {
        const result = await pool.query<{ active: number }>(
          `SELECT active FROM ${TERMINAL_ERASURE_BARRIER_TABLE} WHERE singleton=true`,
        );
        if (result.rows[0]!.active === 0) return;
        if (Date.now() >= deadline) throw new Error('Terminal erasure worker did not reach the held boundary');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async release(pool: Pick<Pool, 'query'>) {
      await pool.query(`UPDATE ${TERMINAL_ERASURE_BARRIER_TABLE} SET held=false WHERE singleton=true`);
    },
    close() {
      return (closed ??= (async () => {
        if (worker.exitCode === null) worker.kill('SIGKILL');
        await worker.exited;
        await diagnostics;
      })());
    },
  };
}
