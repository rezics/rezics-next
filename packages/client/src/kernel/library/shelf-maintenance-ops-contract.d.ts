/** Native shelf maintenance contracts. Locators are never capabilities. */
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { CommandTransaction } from '../command/command.ts';
import type { CloudEvent } from '../events/log.ts';
import type { Access, Actor } from '../request/access.ts';
import type { ShelfSourceStamp, ShelfTypeKeys } from './shelf-contract.ts';
import type { ShelfTypeDigest } from './shelf-type-keys.ts';
import type { WorkClient } from '../work/client.ts';
import type { TypePreparationDependencies, TypePreparationIdentity } from './type-preparation-contract.ts';
export interface InitialShelfInputs {
    readonly hasEntries: boolean;
    readonly hasCollections: boolean;
    readonly hasSessions: boolean;
}
/** Inputs are exact-owner EXISTS results obtained under account share and serialized gate initialization. */
export declare function initialShelfReadiness(inputs: InitialShelfInputs): 'ready' | 'backfill';
/** Incomplete history cannot support even a negative delta. This does not grant writer admission. */
export declare function counterWriteMode(ready: boolean): 'active' | 'defer';
export declare const SHELF_MAINTENANCE_LIMITS: Readonly<{
    page: 100;
    segment: 100;
    commandDeadlineMs: 5000;
    cursorScalars: 8;
    cursorBytes: 2048;
    workflowBytes: 4096;
    edgeBytes: 256;
    stagingBytes: 25600;
}>;
export declare const EMPTY_SHELF_GENERATION = "00000000-0000-0000-0000-000000000000";
export declare const SHELF_BACKFILL_PHASES: readonly ['drain', 'session-changes', 'sessions', 'head-inputs', 'heads', 'entries', 'types', 'count-entries', 'count-collections', 'validate', 'publish', 'retire-counts', 'retire-reservations', 'complete'];
export declare const SHELF_COUNTER_PHASES: readonly ['drain', 'count-entries', 'count-collections', 'validate', 'publish', 'retire-counts', 'retire-reservations', 'complete'];
export declare const SHELF_PURGE_PHASES: readonly ['cancel-work', 'bulk-evidence', 'reservations', 'type-sources', 'progress-changes', 'progress-units', 'sessions', 'heads', 'copies', 'entries', 'follows', 'collection-members', 'collections', 'published-logs', 'counts', 'type-nodes', 'type-roots', 'type-values', 'complete'];
export type ShelfMaintenancePhase = (typeof SHELF_BACKFILL_PHASES)[number] | (typeof SHELF_PURGE_PHASES)[number];
export type ShelfMaintenanceKind = 'backfill' | 'counters' | 'purge';
export type ShelfOwner = Readonly<{
    route: number;
    accountId: string;
}>;
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
    /** Expected entry CAS transaction; identity.transactionId is the independent source version. */
    readonly transactionId: string;
    readonly sourceId: string;
    readonly stamp: ShelfSourceStamp;
    readonly identity: TypePreparationIdentity;
    readonly originIdentity: TypePreparationIdentity;
    readonly fullType: string;
}
/** Private allocator integration seam, installed only in the native runner's closure. No personal effects. */
export interface ShelfMaintenanceDerivedPorts {
    /** One reservation/root transaction; same source/incarnation expectation is stored natively. */
    reserve(tx: CommandTransaction, page: ShelfDerivedPage, source: ShelfMaintenanceTypeObservation): ReturnType<ShelfTypeKeys['reserve']>;
    /** Same-run, same-build, <=100 edges after fresh identity-only checks; no source client held here. */
    continue(tx: CommandTransaction, page: ShelfDerivedPage, reservationId: string): ReturnType<ShelfTypeKeys['continue']>;
}
export interface ShelfMaintenanceOps {
    /** Called by first read/write in its live owner command. Commits initial backfill intent with unready gate. */
    initialize(tx: CommandTransaction, owner: ShelfOwner): Promise<{
        readiness: 'ready' | 'backfill';
        generationId: string | null;
        requested: ShelfMaintenanceBinding | null;
        /** True only for the transaction that installed the original guarded owner intent. */
        initializedNow?: boolean;
    }>;
    /** Trusted operator surface: real Access account:manage check, commit request/intent before asynchronous drain. */
    requestRebuild(actor: Actor, input: {
        owner: ShelfOwner;
        kind: 'backfill' | 'counters';
        requestKey: string;
    }): Promise<ShelfMaintenanceBinding>;
    /** Internal effect only: verifies actual committed tombstone envelope against native account state. */
    requestPurge(event: CloudEvent): Promise<ShelfMaintenanceBinding>;
    /** Internal runner: native row is authority, locator is not. One command/page, replay-safe core receipt. */
    page(binding: ShelfMaintenanceBinding): Promise<ShelfMaintenanceReceipt>;
    /** Indexed runnable-intent keyset, not an account scan; at most100 intents, enqueue before conditional ack. */
    recover(input: {
        after: readonly [number, string, string] | null;
        limit: number;
    }): Promise<{
        enqueued: readonly ShelfMaintenanceBinding[];
        next: readonly [number, string, string] | null;
    }>;
}
export interface ShelfMaintenanceDependencies {
    readonly pool: Pool;
    readonly access: Access;
    readonly clock?: KernelClock;
    readonly client?: WorkClient | (() => Promise<WorkClient>);
    readonly shelfTypeDigest?: ShelfTypeDigest;
    /** Released source adapter only; absent identity evidence leaves the exact native frontier pending. */
    readonly sources?: Pick<TypePreparationDependencies, 'observe' | 'observeIdentity'>;
    /** The allocator owner supplies its native derived composition with the existing exact key ABI. */
    readonly derivedKeys?: ShelfTypeKeys;
}
export { createShelfMaintenanceOps, createShelfMaintenanceDerivedPorts } from './shelf-maintenance-runtime.ts';
