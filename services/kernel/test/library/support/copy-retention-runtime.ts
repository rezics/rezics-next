import assert from 'node:assert/strict';
import pg from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { startWorker } from '../../../src/worker.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import {
  COPY_RETENTION_EXACT_WORKFLOW,
  COPY_RETENTION_SCHEDULE,
  COPY_RETENTION_WORKFLOW,
  type DueCopy,
} from '../../../src/library/copy-retention.ts';

type Message = {
  id?: string;
  op?: string;
  event?: string;
  error?: string;
  value?: unknown;
  time?: number;
  copyId?: string;
  phase?: 'before' | 'committed';
  partition?: number;
  workflowId?: string;
  key?: DueCopy;
  checkpoint?: Pick<DueCopy, 'restoreUntil' | 'route' | 'copyId'>;
};

/** Owns one child, its IPC streams and its executor identity, including crash recovery. */
export async function copyRetentionRuntime(time: number, executor = `copy-retention-${Bun.randomUUIDv7()}`) {
  const messages: Message[] = [];
  const requests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let diagnostics = '';
  const child = Bun.spawn([process.execPath, import.meta.filename], {
    cwd: `${import.meta.dir}/../../..`,
    env: { ...process.env, KERNEL_EXECUTOR_ID: executor },
    stdout: 'pipe',
    stderr: 'pipe',
    ipc(message: Message) {
      if (message.id) {
        const request = requests.get(message.id);
        requests.delete(message.id);
        if (message.error) request?.reject(new Error(message.error));
        else request?.resolve(message.value);
      } else messages.push(message);
    },
  });
  const drains = [child.stdout, child.stderr].map(async (stream) => {
    for await (const bytes of stream) diagnostics += new TextDecoder().decode(bytes);
  });
  async function until(event: string) {
    const deadline = Date.now() + 60_000;
    while (!messages.some((message) => message.event === event)) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`Worker missing ${event}: ${diagnostics}`);
      await Bun.sleep(10);
    }
    messages.splice(
      messages.findIndex((message) => message.event === event),
      1,
    );
  }
  async function call(op: string, values: Omit<Message, 'op' | 'id'> = {}) {
    const id = Bun.randomUUIDv7();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error(`Worker ${op} timed out: ${diagnostics}`));
      }, 120_000);
      requests.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.send({ id, op, ...values });
    });
  }
  await until('ready');
  await call('start', { time });
  return {
    executor,
    child,
    call,
    until,
    async crash() {
      child.kill('SIGKILL');
      await child.exited;
      for (const request of requests.values()) request.reject(new Error('Owned worker crashed'));
      requests.clear();
      await Promise.all(drains);
    },
    async close() {
      if (child.exitCode === null) await call('stop');
      await child.exited;
      await Promise.all(drains);
      assert.equal(child.exitCode, 0, diagnostics);
    },
  };
}

if (import.meta.main) {
  // Pauses observe real physical transactions. They never manufacture a native
  // admission, receipt, scheduler checkpoint, provenance value or successful result.
  let now = Date.now();
  let park: { copyId: string; phase: 'before' | 'committed' } | undefined;
  let release: (() => void) | undefined;
  const pending = new WeakSet<object>();
  const query = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const sql = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string } | undefined)?.text ?? '');
    const values = args[1] ?? (args[0] as { values?: unknown[] } | undefined)?.values;
    const selected =
      park &&
      /DELETE FROM library\.copy/.test(sql) &&
      /restore_until/.test(sql) &&
      Array.isArray(values) &&
      values.includes(park.copyId);
    const connection = this;
    const run = () => Reflect.apply(query, connection, args);
    if (selected && park?.phase === 'before') {
      process.send?.({ event: 'parked' });
      return new Promise<void>((resolve) => {
        release = resolve;
      }).then(run);
    }
    if (selected && park?.phase === 'committed') pending.add(connection);
    const result = run();
    if (pending.has(connection) && sql === 'COMMIT') {
      pending.delete(connection);
      return Promise.resolve(result).then(async (value) => {
        process.send?.({ event: 'committed' });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return value;
      });
    }
    return result;
  } as typeof query;

  // Capture every pool the actual default worker constructs using the shared native
  // harness. This substitution is confined to this fixture process and its database.
  let db: GrowthDatabase | undefined;
  let instrument = false;
  const Pool = pg.Pool;
  pg.Pool = class extends Pool {
    constructor(config?: pg.PoolConfig) {
      super(config);
      if (instrument && db && config?.connectionString === db.url) {
        instrument = false;
        const pool = db.openPool(config);
        instrument = true;
        const end = pool.end.bind(pool);
        let ending: Promise<void> | undefined;
        pool.end = (() => (ending ??= end())) as typeof pool.end;
        return pool;
      }
    }
  };
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let client: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  process.on('message', async (message: Message) => {
    try {
      let value: unknown;
      if (message.op === 'start') {
        now = message.time!;
        db = await openGrowthDatabase();
        instrument = true;
        worker = await startWorker(
          {
            databaseUrl: process.env.DATABASE_URL!,
            poolSize: 8,
            executorId: process.env.KERNEL_EXECUTOR_ID!,
            clock: () => new Date(now),
          },
          undefined,
          workerTestEnv(),
        );
        client = await createWorkClient(db.url, db.pool);
        // This fixture explicitly triggers the installed schedule; wall-clock cron
        // must not consume the controlled episodes during its parked/crash cases.
        await client.pauseSchedule(COPY_RETENTION_SCHEDULE);
        for (const queue of await DBOS.listQueues()) await queue.setMinPollingIntervalMs(5);
      } else if (message.op === 'time') now = message.time!;
      else if (message.op === 'park') park = { copyId: message.copyId!, phase: message.phase! };
      else if (message.op === 'release') {
        park = undefined;
        release?.();
        release = undefined;
      } else if (message.op === 'sweep' || message.op === 'capture' || message.op === 'purge') {
        const operation = async () => {
          const handle = await client!.enqueue(
            {
              workflowName: message.op === 'purge' ? COPY_RETENTION_EXACT_WORKFLOW : COPY_RETENTION_WORKFLOW,
              queueName: 'maintenance',
              workflowID: message.workflowId!,
              workflowIDReusePolicy: 'return-existing',
            },
            ...(message.op === 'purge' ? [message.key!] : [message.partition!, undefined, message.checkpoint ?? null]),
          );
          await handle.getResult();
        };
        value = message.op === 'capture' ? (await capture(db!, operation)).capture : await operation();
      } else if (message.op === 'schedule') {
        const handle = await client!.triggerSchedule(COPY_RETENTION_SCHEDULE);
        await handle.getResult();
      } else if (message.op === 'stop') {
        park = undefined;
        release?.();
        await worker?.stop();
        await client?.close();
        await db?.close();
      }
      process.send?.({ id: message.id, value });
      if (message.op === 'stop') process.exit(0);
    } catch (error) {
      process.send?.({ id: message.id, error: String(error) });
    }
  });
  process.send?.({ event: 'ready' });
}
