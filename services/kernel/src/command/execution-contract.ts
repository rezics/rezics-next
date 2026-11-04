import type { Pool, PoolClient } from 'pg';
import type { WorkClient, WorkIntent } from '../work/client.ts';

declare const executionOriginal: unique symbol;
declare const selectedPhase: unique symbol;

/** An in-process Work authority token. Serializable data cannot construct one. */
export type WorkExecutionOriginal = Readonly<{ readonly [executionOriginal]: true }>;
export type ExecutionTransaction = Pick<PoolClient, 'query'>;
export type EnqueueCapture = (created: boolean) => void;
export type SelectedExecutionPhase = Readonly<{
  readonly [selectedPhase]: true;
  deadline: number;
  assertLive(): void;
  query(sql: unknown): void;
  hold(tx: ExecutionTransaction, raw: PoolClient): Promise<void>;
  guardBody(): void;
  finish(): void;
}>;

export type WorkExecutionPort = Readonly<{
  openOriginal(pool: Pool, deadline: number, client: WorkClient): WorkExecutionOriginal;
  claimOriginal(
    original: WorkExecutionOriginal,
    pool: Pool,
    client: WorkClient,
    deadline: number,
  ): WorkExecutionOriginal;
  debitAttempt(original: WorkExecutionOriginal): void;
  bindOriginal(tx: ExecutionTransaction, original: WorkExecutionOriginal): void;
  finishTransaction(tx: ExecutionTransaction): void;
  openSelectedPhase(pool: Pool, options: unknown): SelectedExecutionPhase | undefined;
  selectedEnqueue(tx: ExecutionTransaction, intent: WorkIntent): EnqueueCapture | undefined;
  enqueue(
    client: WorkClient,
    rawClient: PoolClient,
    intent: WorkIntent,
    capture?: EnqueueCapture,
  ): Promise<void>;
}>;

export type HistoryExecutionPort = Readonly<{
  begin(tx: ExecutionTransaction, original: WorkExecutionOriginal): void;
  finalize(tx: ExecutionTransaction): Promise<void>;
  finish(tx: ExecutionTransaction, committed: boolean): void;
  enqueueCapture(tx: ExecutionTransaction, intent: WorkIntent): EnqueueCapture | undefined;
}>;

export type KernelExecutionContract = Readonly<{
  work: WorkExecutionPort;
  history: HistoryExecutionPort;
}>;

/** Bind owner adapters to this one native client; no process-global registration is used. */
export function bindExecutionContract<T extends object>(
  client: T,
  work: WorkExecutionPort,
  history: HistoryExecutionPort,
): T & { readonly executionContract: KernelExecutionContract } {
  const current = (client as T & { readonly executionContract?: KernelExecutionContract }).executionContract;
  if (current) {
    if (current.work !== work || current.history !== history)
      throw new TypeError('WorkClient already has a different Kernel execution contract');
    return client as T & { readonly executionContract: KernelExecutionContract };
  }
  const contract = Object.freeze({ work, history });
  Object.defineProperty(client, 'executionContract', {
    configurable: false,
    enumerable: false,
    value: contract,
    writable: false,
  });
  return client as T & { readonly executionContract: KernelExecutionContract };
}
