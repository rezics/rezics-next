import type { Pool } from 'pg';

const MAX_WAITERS_PER_PARTITION = 64;

type GateState = {
  active: boolean;
  waiters: Waiter[];
};

type Waiter = {
  resolve: (admission: CommandGateAdmission) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type CommandGateAdmission =
  | { readonly status: 'acquired'; readonly release: () => void }
  | { readonly status: 'deadline' | 'overloaded' };

const gates = new WeakMap<Pool, Map<number, GateState>>();

function cleanup(pool: Pool, partition: number, state: GateState): void {
  if (state.active || state.waiters.length > 0) return;
  const partitions = gates.get(pool);
  if (partitions?.get(partition) !== state) return;
  partitions.delete(partition);
}

function releaseFor(pool: Pool, partition: number, state: GateState): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = state.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve({ status: 'acquired', release: releaseFor(pool, partition, state) });
      return;
    }
    state.active = false;
    cleanup(pool, partition, state);
  };
}

/** FIFO admission for serializable transactions sharing a process-local pool and partition. */
export function enterCommandGate(pool: Pool, partition: number, deadline: number): Promise<CommandGateAdmission> {
  if (Date.now() >= deadline) return Promise.resolve({ status: 'deadline' });

  let partitions = gates.get(pool);
  if (!partitions) {
    partitions = new Map();
    gates.set(pool, partitions);
  }

  let state = partitions.get(partition);
  if (!state) {
    state = { active: true, waiters: [] };
    partitions.set(partition, state);
    return Promise.resolve({ status: 'acquired', release: releaseFor(pool, partition, state) });
  }

  if (!state.active) {
    state.active = true;
    return Promise.resolve({ status: 'acquired', release: releaseFor(pool, partition, state) });
  }
  if (state.waiters.length >= MAX_WAITERS_PER_PARTITION) return Promise.resolve({ status: 'overloaded' });

  return new Promise((resolve) => {
    const waiter = {} as Waiter;
    waiter.resolve = resolve;
    waiter.timer = setTimeout(
      () => {
        const index = state!.waiters.indexOf(waiter);
        if (index >= 0) state!.waiters.splice(index, 1);
        resolve({ status: 'deadline' });
        cleanup(pool, partition, state!);
      },
      Math.max(0, deadline - Date.now()),
    );
    state!.waiters.push(waiter);
  });
}
