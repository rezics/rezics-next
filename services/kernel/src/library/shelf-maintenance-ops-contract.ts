/** Specification ports only; effectful operations deliberately throw. See the adjacent prose contract. */
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { CommandTransaction } from '../command/command.ts';
import type { CloudEvent } from '../events/log.ts';
import type { Access, Actor } from '../request/access.ts';
import type { ShelfSourceStamp, ShelfTypeKeys } from './shelf-contract.ts';

export interface InitialShelfInputs {
  readonly hasEntries: boolean;
  readonly hasCollections: boolean;
  readonly hasSessions: boolean;
}

/** Inputs are exact-owner EXISTS results obtained under account share and serialized gate initialization. */
export function initialShelfReadiness(inputs: InitialShelfInputs): 'ready' | 'backfill' {
  return inputs.hasEntries || inputs.hasCollections || inputs.hasSessions ? 'backfill' : 'ready';
}

/** Incomplete history cannot support even a negative delta. This does not grant writer admission. */
export function counterWriteMode(ready: boolean): 'active' | 'defer' {
  return ready ? 'active' : 'defer';
}

export const SHELF_MAINTENANCE_LIMITS = Object.freeze({
  page: 100,
  segment: 100,
  commandDeadlineMs: 5_000,
  cursorScalars: 8,
  cursorBytes: 2_048,
  workflowBytes: 4_096,
  edgeBytes: 256,
  stagingBytes: 25_600,
});
export const EMPTY_SHELF_GENERATION = '00000000-0000-0000-0000-000000000000';
export const SHELF_BACKFILL_PHASES = [
  'drain',
  'session-changes',
  'sessions',
  'head-inputs',
  'heads',
  'entries',
  'types',
  'count-entries',
  'count-collections',
  'validate',
  'publish',
  'retire-counts',
  'retire-reservations',
  'complete',
] as const;
export const SHELF_COUNTER_PHASES = [
  'drain',
  'count-entries',
  'count-collections',
  'validate',
  'publish',
  'retire-counts',
  'retire-reservations',
  'complete',
] as const;
export const SHELF_PURGE_PHASES = [
  'cancel-work',
  'bulk-evidence',
  'reservations',
  'type-sources',
  'progress-changes',
  'progress-units',
  'sessions',
  'heads',
  'copies',
  'entries',
  'follows',
  'collection-members',
  'collections',
  'published-logs',
  'counts',
  'type-nodes',
  'type-roots',
  'type-values',
  'complete',
] as const;
export type ShelfMaintenancePhase = (typeof SHELF_BACKFILL_PHASES)[number] | (typeof SHELF_PURGE_PHASES)[number];
export type ShelfMaintenanceKind = 'backfill' | 'counters' | 'purge';
export type ShelfOwner = Readonly<{ route: number; accountId: string }>;
export type ShelfMaintenanceCursor = readonly (string | number | boolean | null)[];

/** JSON locator only. Decimal epoch/sequence never cross Number; this object grants no authority. */
export interface ShelfMaintenanceBinding extends ShelfOwner {
  readonly runId: string;
  readonly epoch: string;
  readonly sequence: string;
  readonly segment: number;
}

export interface ShelfMaintenanceCheckpoint {
  readonly owner: ShelfOwner;
  readonly runId: string;
  readonly epoch: bigint;
  readonly sequence: bigint;
  readonly segment: number;
  readonly kind: ShelfMaintenanceKind;
  readonly phase: ShelfMaintenancePhase;
  readonly cursor: ShelfMaintenanceCursor;
  readonly activeGeneration: string | null;
  readonly buildGeneration: string | null;
  readonly enqueuePending: boolean;
}

export interface ShelfMaintenanceReceipt {
  readonly binding: ShelfMaintenanceBinding;
  readonly phase: ShelfMaintenancePhase;
  readonly next: ShelfMaintenanceBinding | null;
  readonly transactionId: string;
  readonly receiptKey: string;
  readonly terminal: boolean;
  /** Private native domain completion does not assert shared/public projection cleanup. */
  readonly sharedEvidence: 'separate-contract';
}

declare const derivedPage: unique symbol;
/** Runtime provenance must be a private WeakMap binding to the SAME live tx/run/epoch, never this brand alone. */
export interface ShelfDerivedPage {
  readonly [derivedPage]: true;
  readonly owner: ShelfOwner;
  readonly runId: string;
  readonly epoch: bigint;
  readonly generationId: string;
}

/** Released authoritative source observation. Full exact input is used once natively, never checkpointed. */
export interface ShelfMaintenanceTypeObservation {
  readonly subjectId: string;
  readonly incarnationId: string;
  readonly transactionId: string;
  readonly sourceId: string;
  readonly stamp: ShelfSourceStamp;
  readonly fullType: string;
}

/** Private allocator integration seam, installed only in the native runner's closure. No personal effects. */
export interface ShelfMaintenanceDerivedPorts {
  /** One reservation/root transaction; same source/incarnation expectation is stored natively. */
  reserve(
    tx: CommandTransaction,
    page: ShelfDerivedPage,
    source: ShelfMaintenanceTypeObservation,
  ): ReturnType<ShelfTypeKeys['reserve']>;
  /** Same-run, same-build, <=100 edges; no source connection held here. */
  continue(
    tx: CommandTransaction,
    page: ShelfDerivedPage,
    reservationId: string,
  ): ReturnType<ShelfTypeKeys['continue']>;
}

export interface ShelfMaintenanceOps {
  /** Called by first read/write in its live owner command. Commits initial backfill intent with unready gate. */
  initialize(
    tx: CommandTransaction,
    owner: ShelfOwner,
  ): Promise<{
    readiness: 'ready' | 'backfill';
    generationId: string | null;
    requested: ShelfMaintenanceBinding | null;
  }>;
  /** Trusted operator surface: real Access account:manage check, commit request/intent before asynchronous drain. */
  requestRebuild(
    actor: Actor,
    input: {
      owner: ShelfOwner;
      kind: 'backfill' | 'counters';
      requestKey: string;
    },
  ): Promise<ShelfMaintenanceBinding>;
  /** Internal effect only: verifies actual committed tombstone envelope against native account state. */
  requestPurge(event: CloudEvent): Promise<ShelfMaintenanceBinding>;
  /** Internal runner: native row is authority, locator is not. One command/page, replay-safe core receipt. */
  page(binding: ShelfMaintenanceBinding): Promise<ShelfMaintenanceReceipt>;
  /** Indexed runnable-intent keyset, not an account scan; at most100 intents, enqueue before conditional ack. */
  recover(input: { after: readonly [number, string, string] | null; limit: number }): Promise<{
    enqueued: readonly ShelfMaintenanceBinding[];
    next: readonly [number, string, string] | null;
  }>;
}

export interface ShelfMaintenanceDependencies {
  readonly pool: Pool;
  readonly access: Access;
  readonly clock?: KernelClock;
}

export function createShelfMaintenanceOps(_dependencies: ShelfMaintenanceDependencies): ShelfMaintenanceOps {
  const missing = (operation: string): never => {
    throw new Error(`Library shelf maintenance is not implemented: ${operation}`);
  };
  return {
    initialize: async () => missing('initialize'),
    requestRebuild: async () => missing('requestRebuild'),
    requestPurge: async () => missing('requestPurge'),
    page: async () => missing('page'),
    recover: async () => missing('recover'),
  };
}

/** Only the future native runner may compose this; factory does not accept an allow-maintenance flag. */
export function createShelfMaintenanceDerivedPorts(): ShelfMaintenanceDerivedPorts {
  const missing = (): never => {
    throw new Error('Library shelf maintenance derived guard is not implemented');
  };
  return { reserve: async () => missing(), continue: async () => missing() };
}
