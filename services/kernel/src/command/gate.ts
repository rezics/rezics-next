import type { Pool } from 'pg';

const MAX_WAITERS_PER_GATE = 64;

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

type GateKey = number | symbol;
const gates = new WeakMap<Pool, Map<GateKey, GateState>>();

function cleanup(pool: Pool, key: GateKey, state: GateState): void {
  if (state.active || state.waiters.length > 0) return;
  const byKey = gates.get(pool);
  if (byKey?.get(key) !== state) return;
  byKey.delete(key);
}

function releaseFor(pool: Pool, key: GateKey, state: GateState): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = state.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve({ status: 'acquired', release: releaseFor(pool, key, state) });
      return;
    }
    state.active = false;
    cleanup(pool, key, state);
  };
}

function acquireGate(pool: Pool, key: GateKey, deadline: number): Promise<CommandGateAdmission> {
  if (Date.now() >= deadline) return Promise.resolve({ status: 'deadline' });

  let byKey = gates.get(pool);
  if (!byKey) {
    byKey = new Map();
    gates.set(pool, byKey);
  }

  let state = byKey.get(key);
  if (!state) {
    state = { active: true, waiters: [] };
    byKey.set(key, state);
    return Promise.resolve({ status: 'acquired', release: releaseFor(pool, key, state) });
  }

  if (!state.active) {
    state.active = true;
    return Promise.resolve({ status: 'acquired', release: releaseFor(pool, key, state) });
  }
  if (state.waiters.length >= MAX_WAITERS_PER_GATE) return Promise.resolve({ status: 'overloaded' });

  return new Promise((resolve) => {
    const waiter = {} as Waiter;
    waiter.resolve = resolve;
    waiter.timer = setTimeout(
      () => {
        const index = state!.waiters.indexOf(waiter);
        if (index >= 0) state!.waiters.splice(index, 1);
        resolve({ status: 'deadline' });
        cleanup(pool, key, state!);
      },
      Math.max(0, deadline - Date.now()),
    );
    state!.waiters.push(waiter);
  });
}

/** First attempts share only their home gate. A producer can also coordinate its
 * serialization retries across homes whose writes touch the same index pages. */
export async function enterCommandGate(
  pool: Pool,
  partition: number,
  deadline: number,
  retryGroup?: symbol,
): Promise<CommandGateAdmission> {
  const home = await acquireGate(pool, partition, deadline);
  if (!retryGroup || home.status !== 'acquired') return home;
  const retry = await acquireGate(pool, retryGroup, deadline).catch((error: unknown) => {
    home.release();
    throw error;
  });
  if (retry.status !== 'acquired') {
    home.release();
    return retry;
  }
  return {
    status: 'acquired',
    release() {
      retry.release();
      home.release();
    },
  };
}
