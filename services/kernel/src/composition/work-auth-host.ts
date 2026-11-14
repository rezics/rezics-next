import { fork } from 'node:child_process';
import type { CommittedSessionRevocationWorkflow } from '../access/session-revocation-work.ts';

// This protocol carries one capability and lifecycle control, never an Auth service,
// credential, receipt, database address or a caller-selected method. Its authority is
// the inherited IPC handle of the child created by the existing application host.
export const WORK_AUTH_CHANNEL = 'kernel-work-auth-v1';
export const WORK_AUTH_MAX_PENDING = 4;
export const WORK_AUTH_CALL_MS = 15_000;
export const WORK_AUTH_STOP_MS = 20_000;

export type WorkAuthMessage =
  | { channel: typeof WORK_AUTH_CHANNEL; type: 'ready' | 'stop' | 'failed' }
  | {
      channel: typeof WORK_AUTH_CHANNEL;
      type: 'resume';
      id: number;
      accountId: string;
      operationKey: string;
    }
  | { channel: typeof WORK_AUTH_CHANNEL; type: 'result'; id: number; ok: boolean };

export type AuthBoundKernelWorker = { stop(): Promise<void>; failed: Promise<never> };

export function isWorkAuthMessage(value: unknown): value is WorkAuthMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.channel !== WORK_AUTH_CHANNEL) return false;
  const keys = Object.keys(message).sort().join(',');
  if (message.type === 'ready' || message.type === 'stop' || message.type === 'failed')
    return keys === 'channel,type';
  if (!Number.isSafeInteger(message.id) || (message.id as number) < 1) return false;
  if (message.type === 'result') return keys === 'channel,id,ok,type' && typeof message.ok === 'boolean';
  const bounded = (item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 128;
  return (
    message.type === 'resume' &&
    keys === 'accountId,channel,id,operationKey,type' &&
    bounded(message.accountId) &&
    bounded(message.operationKey)
  );
}

/** Auth has already started in the caller. Only this child configures Kernel's
 * process-global DBOS SDK; both owners retain their native databases and schemas. */
export async function startAuthBoundKernelWorker(options: {
  sessionRevocation: CommittedSessionRevocationWorkflow;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<AuthBoundKernelWorker> {
  if (typeof options.sessionRevocation?.resumeCommittedSessionRevocation !== 'function')
    throw new Error('Trusted Auth session revocation workflow is unavailable');
  if (options.signal?.aborted) throw new Error('Auth-bound Kernel worker startup cancelled');
  const child = fork(new URL('../work-auth-worker.ts', import.meta.url), [], {
    execPath: process.execPath,
    execArgv: [],
    cwd: new URL('../../', import.meta.url),
    env: options.env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    serialization: 'json',
    // The application host owns termination, including terminal process-group signals.
    detached: true,
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => {});
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const calls = new Map<number, Promise<void>>();
  let lastCall = 0;
  let isReady = false;
  let isClosed = false;
  let failure: Error | undefined;
  let stopping: Promise<void> | undefined;
  const kill = () => {
    if (!isClosed) child.kill('SIGKILL');
  };
  // An abrupt parent exit cannot leave a detached publisher behind. IPC disconnect
  // also makes the child reject its pending calls and drain when the parent crashes.
  process.once('exit', kill);
  const fail = () => {
    if (failure) return;
    failure = new Error('Auth-bound Kernel worker unavailable');
    rejectReady(failure);
    rejectFailure(failure);
    void stop().catch(() => {});
  };
  const send = (message: WorkAuthMessage) => {
    if (!child.connected) {
      fail();
      return;
    }
    try {
      child.send(message, (error) => {
        if (error) fail();
      });
    } catch {
      fail();
    }
  };
  child.on('message', (value: unknown) => {
    if (!isWorkAuthMessage(value)) return fail();
    if (value.type === 'ready') {
      if (isReady) return fail();
      isReady = true;
      resolveReady();
      return;
    }
    // Recovery can call Auth while Kernel is still launching, before its ready message.
    if (value.type !== 'resume' || failure || value.id <= lastCall || calls.size >= WORK_AUTH_MAX_PENDING)
      return fail();
    lastCall = value.id;
    const call = Promise.resolve()
      .then(() =>
        options.sessionRevocation.resumeCommittedSessionRevocation({
          accountId: value.accountId,
          operationKey: value.operationKey,
        }),
      )
      .then(
        () => {
          // The owner's void result means its original native receipt committed or
          // was replayed. Nothing here creates or substitutes terminal evidence.
          if (child.connected) send({ channel: WORK_AUTH_CHANNEL, type: 'result', id: value.id, ok: true });
        },
        () => {
          if (child.connected) send({ channel: WORK_AUTH_CHANNEL, type: 'result', id: value.id, ok: false });
        },
      )
      .finally(() => calls.delete(value.id));
    calls.set(value.id, call);
  });
  child.once('error', fail);
  child.once('disconnect', () => {
    if (!stopping) fail();
  });
  child.once('close', (code) => {
    isClosed = true;
    process.off('exit', kill);
    resolveClosed();
    if (!stopping || code !== 0) fail();
  });
  function stop(): Promise<void> {
    return (stopping ??= Promise.resolve().then(async () => {
      rejectReady(new Error('Auth-bound Kernel worker stopped before readiness'));
      if (child.connected) send({ channel: WORK_AUTH_CHANNEL, type: 'stop' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let forced = false;
      try {
        await Promise.race([
          closed,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              forced = true;
              kill();
              resolve();
            }, WORK_AUTH_STOP_MS);
          }),
        ]);
        await closed;
        // The child's exit settles its callers, but an Auth call might already
        // have committed. Keep Auth and its pools alive until every call settles.
        await Promise.allSettled([...calls.values()]);
      } finally {
        clearTimeout(timer);
        process.off('exit', kill);
        options.signal?.removeEventListener('abort', abort);
      }
      if (forced) throw new Error('Auth-bound Kernel worker drain timed out');
      if (failure) throw failure;
    }));
  }
  const abort = () => void stop().catch(() => {});
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const startupTimer = setTimeout(fail, 600_000);
  try {
    await ready;
    if (failure || stopping) throw failure ?? new Error('Auth-bound Kernel worker stopped during startup');
    return { stop, failed };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
}
