import {
  isWorkAuthMessage,
  WORK_AUTH_CALL_MS,
  WORK_AUTH_CHANNEL,
  WORK_AUTH_MAX_PENDING,
  WORK_AUTH_STOP_MS,
  type WorkAuthMessage,
} from './composition/work-auth-host.ts';
import type { CommittedSessionRevocationWorkflow } from './access/session-revocation-work.ts';

/** Dedicated process entry. The ordinary worker remains usable without a parent;
 * this entry requires the private handle created by the existing Auth host. */
async function run() {
  if (!process.send || !process.connected) throw new Error('Trusted Auth worker channel is required');
  const pending = new Map<
    number,
    { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  let nextId = 0;
  let channelClosed = false;
  let exitCode = 0;
  let starting: Promise<Awaited<ReturnType<typeof import('./worker.ts').startWorker>> | undefined> | undefined;
  let stopping: Promise<void> | undefined;
  const rejectPending = () => {
    channelClosed = true;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error('Trusted Auth worker channel closed before delivery completed'));
    }
    pending.clear();
  };
  const lost = () => {
    rejectPending();
    void stop(1);
  };
  const send = (message: WorkAuthMessage) => {
    if (channelClosed || !process.connected || !process.send) return lost();
    try {
      process.send(message, (error: Error | null) => {
        if (error) lost();
      });
    } catch {
      lost();
    }
  };
  const sessionRevocation: CommittedSessionRevocationWorkflow = {
    resumeCommittedSessionRevocation(input) {
      if (channelClosed || !process.connected)
        return Promise.reject(new Error('Trusted Auth worker channel is unavailable'));
      // Saturation fails this durable attempt; DBOS owns its bounded retry. There
      // is no additional queue, polling loop or unbounded IPC callback population.
      if (pending.size >= WORK_AUTH_MAX_PENDING || nextId === Number.MAX_SAFE_INTEGER)
        return Promise.reject(new Error('Trusted Auth worker channel capacity exceeded'));
      const message: WorkAuthMessage = {
        channel: WORK_AUTH_CHANNEL,
        type: 'resume',
        id: ++nextId,
        accountId: input.accountId,
        operationKey: input.operationKey,
      };
      if (!isWorkAuthMessage(message)) return Promise.reject(new Error('Invalid session revocation input'));
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(lost, WORK_AUTH_CALL_MS);
        pending.set(message.id, { resolve, reject, timer });
        send(message);
      });
    },
  };
  process.on('message', (value: unknown) => {
    if (!isWorkAuthMessage(value)) return lost();
    if (value.type === 'stop') {
      void stop(0);
      return;
    }
    if (value.type !== 'result') return lost();
    const call = pending.get(value.id);
    if (!call) return lost();
    pending.delete(value.id);
    clearTimeout(call.timer);
    if (value.ok) call.resolve();
    else call.reject(new Error('Original Auth session revocation did not complete'));
  });
  process.once('disconnect', lost);
  process.once('SIGINT', () => void stop(0));
  process.once('SIGTERM', () => void stop(0));
  function stop(code: number): Promise<void> {
    exitCode = Math.max(exitCode, code);
    return (stopping ??= Promise.resolve().then(async () => {
      // A lost parent must not strand pools or a worker process during a stuck drain.
      const timer = setTimeout(() => {
        rejectPending();
        process.exit(1);
      }, WORK_AUTH_STOP_MS);
      try {
        const worker = await starting?.catch(() => undefined);
        // Keep IPC usable until relays, native services and running Work finish.
        await worker?.stop();
      } catch {
        exitCode = 1;
      } finally {
        clearTimeout(timer);
        rejectPending();
        process.removeListener('disconnect', lost);
        if (process.connected) process.disconnect?.();
        process.exit(exitCode);
      }
    }));
  }
  starting = (async () => {
    const { readWorkerConfig, startWorker } = await import('./worker.ts');
    if (stopping) return;
    return startWorker(
      { ...readWorkerConfig(process.env), sessionRevocation, handleSignals: false },
      undefined,
      process.env,
    );
  })();
  try {
    await starting;
    if (!stopping) send({ channel: WORK_AUTH_CHANNEL, type: 'ready' });
  } catch {
    if (!channelClosed) send({ channel: WORK_AUTH_CHANNEL, type: 'failed' });
    await stop(1);
  }
}

if (import.meta.main) {
  try {
    await run();
  } catch {
    console.error('Auth-bound Kernel worker startup failed');
    process.exitCode = 1;
  }
}
