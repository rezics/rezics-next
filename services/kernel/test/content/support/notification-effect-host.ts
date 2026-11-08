import { readTestRealmSubjectIdentityMappings } from '../realm-identity-reader.ts';
import { randomUUID } from 'node:crypto';
import type { KernelClock } from '../../../src/clock.ts';
import { configureReceiptKeys, readReceiptKeyRing } from '../../../src/command/receipt-key.ts';
import { workerTestEnv } from '../../support/worker-env.ts';

type WorkerMessage = { id: string; ok: boolean; error?: string };
type WorkerRequest = { id: string; command: string; consumer: string; partitions: number[]; at: string };
type Waiter = { matches(line: string): boolean; resolve(line: string): void; reject(error: Error): void };

/** Keep the production DBOS effect boundary in its own process: the native
 * Auth fixture already owns DBOS in the test process. */
export async function createNotificationEffectHost(
  databaseUrl: string,
  clock: KernelClock,
): Promise<{
  deliver(consumer: string, partitions: readonly number[]): Promise<void>;
  close(): Promise<void>;
}> {
  const child = Bun.spawn([process.execPath, import.meta.filename], {
    env: {
      ...process.env,
      ...workerTestEnv(),
      NOTIFICATION_EFFECT_DATABASE_URL: databaseUrl,
      NOTIFICATION_EFFECT_EXECUTOR: `notification-${randomUUID()}`,
      NOTIFICATION_EFFECT_WORKER: '1',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let output = '';
  let errorOutput = '';
  let pending = '';
  const lines: string[] = [];
  const waiters: Waiter[] = [];
  const accept = (line: string) => {
    output += `${line}\n`;
    const index = waiters.findIndex((waiter) => waiter.matches(line));
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(line);
    else lines.push(line);
  };
  const stdoutTask = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      pending += decoder.decode(result.value, { stream: true });
      const split = pending.split('\n');
      pending = split.pop() ?? '';
      for (const line of split) accept(line.replace(/\r$/, ''));
    }
  })();
  const stderrTask = (async () => {
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      errorOutput += decoder.decode(result.value, { stream: true });
    }
  })();

  const waitForLine = async (matches: (line: string) => boolean, timeoutMs: number): Promise<string> => {
    const cached = lines.findIndex(matches);
    if (cached >= 0) return lines.splice(cached, 1)[0]!;
    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = { matches, resolve, reject };
      waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for notification effect host; stdout=${output}; stderr=${errorOutput}`));
      }, timeoutMs);
      const originalResolve = waiter.resolve;
      const originalReject = waiter.reject;
      waiter.resolve = (line) => {
        clearTimeout(timer);
        originalResolve(line);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        originalReject(error);
      };
      void child.exited.then(async (status) => {
        await stdoutTask;
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
          waiter.reject(
            new Error(`Notification effect host exited ${status}; stdout=${output}; stderr=${errorOutput}`),
          );
        }
      });
    });
  };

  const waitForExit = async (timeoutMs: number): Promise<number> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out stopping notification effect host; stdout=${output}; stderr=${errorOutput}`)),
        timeoutMs,
      );
      void child.exited.then((status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
  };

  try {
    await waitForLine((line) => line === 'NOTIFICATION_EFFECT_READY', 120_000);
  } catch (error) {
    child.kill('SIGKILL');
    await child.exited;
    await Promise.allSettled([stdoutTask, stderrTask]);
    throw error;
  }

  let closed = false;
  let nextId = 0;
  return {
    async deliver(consumer, partitions) {
      if (closed) throw new Error('Notification effect host is closed');
      const id = `${++nextId}`;
      child.stdin.write(
        `${JSON.stringify({ id, command: 'deliver', consumer, partitions, at: clock().toISOString() })}\n`,
      );
      child.stdin.flush();
      const line = await waitForLine((item) => item.startsWith(`NOTIFICATION_EFFECT_RESULT ${id} `), 300_000);
      const result = JSON.parse(line.slice(`NOTIFICATION_EFFECT_RESULT ${id} `.length)) as WorkerMessage;
      if (!result.ok)
        throw new Error(`Notification effect delivery failed: ${result.error ?? 'unknown worker failure'}`);
    },
    async close() {
      if (closed) return;
      closed = true;
      child.stdin.write('stop\n');
      child.stdin.flush();
      try {
        await waitForLine((line) => line === 'NOTIFICATION_EFFECT_STOPPED', 30_000);
        child.stdin.end();
        const status = await waitForExit(30_000);
        await Promise.allSettled([stdoutTask, stderrTask]);
        if (status !== 0)
          throw new Error(`Notification effect host exited ${status}; stdout=${output}; stderr=${errorOutput}`);
      } catch (error) {
        child.kill('SIGKILL');
        await child.exited;
        await Promise.allSettled([stdoutTask, stderrTask]);
        throw error;
      }
    },
  };
}

async function runWorker(): Promise<void> {
  const [
    { DBOS },
    { Pool },
    { contentEffects, contentNoticeEffects },
    { createContentWorkAccess },
    { createWorkClient },
    { launchWork, shutdownWork },
    { registerEffects, effectWorkflowId },
    { readBatch },
    { installNativeHistory },
  ] = await Promise.all([
    import('@dbos-inc/dbos-sdk'),
    import('pg'),
    import('../../../src/content/relays.ts'),
    import('../../../src/content/register.ts'),
    import('../../../src/work/client.ts'),
    import('../../../src/events/effects.ts'),
    import('../../../src/events/effects.ts'),
    import('../../../src/events/log.ts'),
    import('../../../src/composition/history.ts'),
  ]);
  // This child is a plain bun process, not `bun test`, so bunfig test preloads
  // do not install History or bind receipt keys. Enqueue and effect.run both call
  // isIdentityOriginalEffect; command consumers fall back to KERNEL_RECEIPT_KEYS.
  installNativeHistory();
  const databaseUrl = process.env.NOTIFICATION_EFFECT_DATABASE_URL;
  if (!databaseUrl) throw new Error('NOTIFICATION_EFFECT_DATABASE_URL is required');
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  configureReceiptKeys(pool, readReceiptKeyRing());
  const workClient = await createWorkClient(databaseUrl, pool);
  let effectTime = new Date();
  const access = createContentWorkAccess(() => new Date(effectTime), pool);
  const effects = [
    ...contentEffects(pool, workClient, readTestRealmSubjectIdentityMappings),
    ...contentNoticeEffects(pool, access),
  ];
  const registered = registerEffects(effects, pool);
  await launchWork({
    databaseUrl,
    ...(process.env.NOTIFICATION_EFFECT_EXECUTOR === undefined
      ? {}
      : { executorId: process.env.NOTIFICATION_EFFECT_EXECUTOR }),
    systemDatabasePool: pool,
  });
  process.stdout.write('NOTIFICATION_EFFECT_READY\n');

  const { createInterface } = await import('node:readline');
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    if (line === 'stop') {
      await shutdownWork();
      await workClient.close();
      await pool.end();
      process.stdout.write('NOTIFICATION_EFFECT_STOPPED\n');
      return;
    }
    let request: WorkerRequest;
    try {
      request = JSON.parse(line) as typeof request;
      if (request.command !== 'deliver' || !Array.isArray(request.partitions) || typeof request.at !== 'string')
        throw new TypeError('Invalid request');
      const at = new Date(request.at);
      if (!Number.isFinite(at.getTime())) throw new TypeError('Invalid effect clock');
      effectTime = at;
      await deliver(request.consumer, request.partitions);
      process.stdout.write(
        `NOTIFICATION_EFFECT_RESULT ${request.id} ${JSON.stringify({ id: request.id, ok: true })}\n`,
      );
    } catch (error) {
      const id = (() => {
        try {
          return (JSON.parse(line) as { id?: string }).id ?? 'unknown';
        } catch {
          return 'unknown';
        }
      })();
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stdout.write(
        `NOTIFICATION_EFFECT_RESULT ${id} ${JSON.stringify({ id, ok: false, error: detail.replaceAll('\n', ' | ') })}\n`,
      );
    }
  }

  async function deliver(consumer: string, partitions: number[]): Promise<void> {
    const pending = new Set<string>();
    let hadWork: boolean;
    do {
      hadWork = false;
      for (const partition of [...new Set(partitions)].sort((left, right) => left - right)) {
        const result = await readBatch(pool, {
          consumer,
          partition,
          apply: async (envelopes) => {
            const workflowIds = envelopes.flatMap((envelope) =>
              envelope.events.flatMap((event, eventSeq) =>
                effects
                  .filter((effect) => effect.types.includes(event.type))
                  .map((effect) => effectWorkflowId(envelope, eventSeq, effect.name)),
              ),
            );
            await registered.enqueue(envelopes);
            workflowIds.forEach((id) => pending.add(id));
          },
        });
        if (result.status !== 'read') throw new Error(`Notification effect barrier stopped (${result.status})`);
        if (result.envelopes > 0) hadWork = true;
      }
      const current = [...pending];
      pending.clear();
      await Promise.all(current.map((id) => DBOS.retrieveWorkflow(id).getResult()));
    } while (hadWork);
  }
}

if (process.env.NOTIFICATION_EFFECT_WORKER === '1') {
  try {
    await runWorker();
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${detail}\n`);
    process.exitCode = 1;
  }
}
