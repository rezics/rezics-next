import type { Pool } from 'pg';
import type { WorkClient } from '../../../src/work/client.ts';
import {
  OWNER_INDEX_WORKFLOW,
  observeOwnerPinCapture,
  type OwnerPinCapture,
} from '../../../src/library/owner-index-work.ts';

const channel = 'library-state-reference-repair';
type Message = {
  channel: typeof channel;
  kind: 'arm' | 'armed' | 'captured' | 'release';
  workflowId: string;
  accountId: string;
  capture?: OwnerPinCapture;
};
function message(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && 'channel' in value && value.channel === channel;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // close/error may precede the scenario awaiting its observation.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
export type StateReferenceRepairLatch = {
  reached: Promise<void>;
  captured: Promise<OwnerPinCapture>;
  resume(): void;
};

/** Installed only in this world's actual executor, never a second metadata writer. */
export function installStateReferenceRepairLatch(pool: Pool, send: (value: Message) => void) {
  let held: { message: Message; release: ReturnType<typeof deferred<void>> } | undefined;
  const remove = observeOwnerPinCapture(pool, async (capture) => {
    const current = held;
    if (
      !current ||
      current.message.workflowId !== capture.workflowId ||
      current.message.accountId !== capture.accountId
    )
      return;
    send({ ...current.message, kind: 'captured', capture });
    await current.release.promise;
  });
  return {
    receive(value: unknown) {
      if (!message(value)) return;
      if (value.kind === 'release' && value.workflowId === held?.message.workflowId) {
        held.release.resolve();
        held = undefined;
      } else if (value.kind === 'arm') {
        if (held) throw new Error('State reference repair latch already armed');
        held = { message: value, release: deferred<void>() };
        send({ ...value, kind: 'armed' });
      }
    },
    close() {
      held?.release.resolve();
      held = undefined;
      remove();
    },
  };
}

/** One bounded installed metadata page. Ready pins are deliberately not made pending by fixture SQL. */
export function createStateReferenceRepair(input: {
  accountId: string;
  client: WorkClient;
  resume(): Promise<void>;
  send(value: Message): void;
}) {
  let closed = false;
  let active = false;
  let latch:
    | {
        workflowId: string;
        armed: ReturnType<typeof deferred<void>>;
        captured: ReturnType<typeof deferred<OwnerPinCapture>>;
        observed: boolean;
        released: boolean;
      }
    | undefined;
  function release(current: NonNullable<typeof latch>) {
    current.released = true;
    try {
      input.send({ channel, kind: 'release', workflowId: current.workflowId, accountId: input.accountId });
    } catch {
      // A disconnected executor cannot retain this process's latch; preserve the original failure.
    }
  }
  return {
    receive(value: unknown) {
      if (!message(value) || !latch || value.workflowId !== latch.workflowId || value.accountId !== input.accountId)
        return;
      if (value.kind === 'armed') {
        latch.armed.resolve();
        if (latch.released) release(latch);
      }
      if (value.kind === 'captured' && value.capture) {
        if (value.capture.workflowId !== latch.workflowId || value.capture.accountId !== input.accountId)
          throw new Error('State reference capture identity differs from the native run');
        if (!value.capture.meaning.states.length) {
          latch.captured.reject(
            new Error('Native Library dependency_unavailable: pending pin has no accepted state references'),
          );
          release(latch);
          return;
        }
        latch.observed = true;
        latch.captured.resolve(value.capture);
      }
    },
    async hold(): Promise<StateReferenceRepairLatch> {
      if (closed || active || latch) throw new Error('State reference repair world is closed or busy');
      const current = {
        workflowId: `${OWNER_INDEX_WORKFLOW}:native:${Bun.randomUUIDv7()}`,
        armed: deferred<void>(),
        captured: deferred<OwnerPinCapture>(),
        observed: false,
        released: false,
      };
      latch = current;
      const reached = current.captured.promise.then(() => undefined);
      void reached.catch(() => undefined);
      return {
        reached,
        captured: current.captured.promise,
        resume: () => release(current),
      };
    },
    async start() {
      if (closed || active) throw new Error('State reference repair world is closed or busy');
      active = true;
      const current = latch;
      const workflowId = current?.workflowId ?? `${OWNER_INDEX_WORKFLOW}:native:${Bun.randomUUIDv7()}`;
      try {
        await input.resume();
        if (closed) throw new Error('State reference repair world closed');
        if (current) {
          input.send({ channel, kind: 'arm', workflowId, accountId: input.accountId });
          await current.armed.promise;
        }
        const handle = await input.client.enqueue(
          { workflowName: OWNER_INDEX_WORKFLOW, queueName: 'maintenance', workflowID: workflowId },
          { accounts: [input.accountId], frontier: null, metadata: true },
        );
        const result = (async () => {
          try {
            await handle.getResult();
            if (current && !current.observed)
              throw new Error(
                'Native Library dependency_unavailable: library.ownerIndex({accounts:[accountId],frontier:null,metadata:true}) ' +
                  'captured no pending pin; bounded accepted ready-pin state-reference recapture producer is absent',
              );
          } catch (error) {
            current?.captured.reject(error);
            throw error;
          } finally {
            if (current) release(current);
            if (latch === current) latch = undefined;
            active = false;
          }
        })();
        void result.catch(() => undefined);
        return { workflowId, handle, result };
      } catch (error) {
        if (current) {
          release(current);
          current.captured.reject(error);
        }
        if (latch === current) latch = undefined;
        active = false;
        throw error;
      }
    },
    close() {
      closed = true;
      if (latch) {
        release(latch);
        const error = new Error('State reference repair world closed');
        latch.armed.reject(error);
        latch.captured.reject(error);
      }
      latch = undefined;
    },
  };
}
