import type { Pool } from 'pg';
import { systemClock, type KernelClock } from '../clock.ts';
import type { WorkClient } from './client.ts';
import { registerEffects, type Effect, type NativeEffect } from '../events/effects.ts';
import { WORK_QUEUES } from './queues.ts';
import type { HistoryRegistry } from '../history/contract/index.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkerAuthorization } from './authorization.ts';
import type { KindConsentParticipant } from '@rezics/auth-contract';
import type { SelectedRuntime } from './selected-runtime.ts';
import { ensureNativeWorkApplication } from './adapters/index.ts';
import type { WorkModule as ContractModule, WorkComposeOptions } from './contract/index.ts';

export type WorkService = { stop(): Promise<void> };

export type WorkContext = {
  readonly pool: Pool;
  readonly queues: typeof WORK_QUEUES;
  readonly client: WorkClient;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: KernelClock;
  readonly history?: HistoryRegistry;
  getAuthorization(): WorkerAuthorization;
  getSelectedRuntime?(): SelectedRuntime;
  getKindConsentParticipant?(deadline: number): KindConsentParticipant | undefined;
  addEffects(effects: Effect[]): void;
  addNativeEffects?(effects: NativeEffect[]): void;
  addService(start: () => WorkService | Promise<WorkService>): void;
};
export type WorkModule = { name: string; register(context: WorkContext): void | Promise<void> };
export type WorkOptions = {
  databaseUrl: string;
  executorId?: string;
  pool: Pool;
  client: WorkClient;
  env?: Readonly<Record<string, string | undefined>>;
  clock?: KernelClock;
  receiptKeys?: KeyRing;
};
export type ComposedWork = {
  effects: ReturnType<typeof registerEffects>;
  launch(): Promise<void>;
  shutdown(): Promise<void>;
};

/** Registration owns the process-global SDK once. Pools and clients belong to the caller. */
export async function composeWork(modules: readonly WorkModule[], options: WorkOptions): Promise<ComposedWork> {
  return (await ensureNativeWorkApplication().compose(modules as unknown as readonly ContractModule[], {
    databaseUrl: options.databaseUrl,
    pool: options.pool,
    client: options.client,
    env: options.env ?? process.env,
    clock: options.clock ?? systemClock,
    ...(options.executorId === undefined ? {} : { executorId: options.executorId }),
    ...(options.receiptKeys === undefined ? {} : { receiptKeys: options.receiptKeys }),
  } satisfies WorkComposeOptions)) as ComposedWork;
}
