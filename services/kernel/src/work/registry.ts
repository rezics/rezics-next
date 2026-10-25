import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { systemClock, type KernelClock } from '../clock.ts';
import { DBOS_SCHEMA, WORK_APPLICATION, type WorkClient } from './client.ts';
import { registerEffects, type Effect } from '../events/effects.ts';
import { WORK_QUEUES } from './queues.ts';

export type WorkContext = {
  readonly pool: Pool;
  readonly queues: typeof WORK_QUEUES;
  readonly client: WorkClient;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: KernelClock;
  addEffects(effects: Effect[]): void;
};
export type WorkModule = { name: string; register(context: WorkContext): void | Promise<void> };
export type WorkOptions = {
  databaseUrl: string;
  executorId?: string;
  pool: Pool;
  client: WorkClient;
  env?: Readonly<Record<string, string | undefined>>;
  /** Trusted service composition only. */
  clock?: KernelClock;
};

let composed = false;

/** Registration owns the process-global SDK once. Pools and clients belong to the caller. */
export async function composeWork(modules: readonly WorkModule[], options: WorkOptions) {
  if (composed || DBOS.isInitialized()) throw new Error('Work registration is already composed or launched');
  const registrations = [...modules];
  const names = new Set<string>();
  for (const module of registrations) {
    if (names.has(module.name)) throw new Error(`Duplicate work module: ${module.name}`);
    names.add(module.name);
  }
  const clock = options.clock ?? systemClock;
  composed = true;
  DBOS.setConfig({
    name: WORK_APPLICATION,
    systemDatabaseUrl: options.databaseUrl,
    systemDatabaseSchemaName: DBOS_SCHEMA,
    systemDatabasePool: options.pool,
    runMigrations: false,
    logLevel: 'warn',
    ...(options.executorId === undefined ? {} : { executorID: options.executorId }),
  });
  // DBOS.registerQueue requires a launched executor in this SDK. The client persists
  // queues first; launch discovers them before dispatching any workflow.
  for (const [name, parameters] of Object.entries(WORK_QUEUES)) {
    await options.client.registerQueue(name, parameters);
  }
  const collectedEffects: Effect[] = [];
  let acceptingEffects = true;
  const context: WorkContext = Object.freeze({
    pool: options.pool,
    queues: WORK_QUEUES,
    client: options.client,
    env: options.env ?? process.env,
    clock,
    addEffects(effects) {
      if (!acceptingEffects) throw new Error('Cannot add effects after work composition');
      collectedEffects.push(...effects);
    },
  });
  try {
    for (const module of registrations) await module.register(context);
  } finally {
    acceptingEffects = false;
  }
  const effects = registerEffects(collectedEffects);

  let launching: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  return {
    effects,
    launch(): Promise<void> {
      if (stopping) return Promise.reject(new Error('Work launch refused after shutdown'));
      return (launching ??= DBOS.launch());
    },
    shutdown(): Promise<void> {
      return (stopping ??= (async () => {
        try {
          await launching;
        } finally {
          // SDK stops receivers and queue dispatch before draining, then disconnects.
          await DBOS.shutdown({ workflowCompletionTimeoutMS: 2_147_483_647 });
        }
      })());
    },
  };
}
