import { type OperationalTransaction } from '../command/operational.ts';
import { type CommandTransaction } from '../command/command.ts';
import { type ShelfMaintenanceKind, type ShelfMaintenanceCursor, type ShelfOwner } from './contract/index.ts';
import type { ShelfMaintenanceBinding } from './shelf-maintenance-ops-contract.ts';
export declare function gateEnsure(): Readonly<{
    sql: string;
    params: readonly string[];
    run(client: import("reylo").PostgresClient, input: {
        route: number;
        account_id: string;
    }): Promise<void>;
}>;
export declare function gateRead(): Readonly<{
    sql: string;
    params: readonly string[];
    run(client: import("reylo").PostgresClient, input: {
        route: number;
        account_id: string;
    }): Promise<{
        initialized: boolean;
        mode: "open" | "rebuilding" | "purging" | "purged";
        ready: boolean;
        epoch: bigint;
        activeGeneration: string | null;
        runId: string | null;
    } | null>;
}>;
export declare function gateLock(): Readonly<{
    sql: string;
    params: readonly string[];
    run(client: import("reylo").PostgresClient, input: {
        route: number;
        account_id: string;
    }): Promise<{
        initialized: boolean;
        mode: "open" | "rebuilding" | "purging" | "purged";
        ready: boolean;
        epoch: bigint;
        activeGeneration: string | null;
        runId: string | null;
    } | null>;
}>;
export declare function gateShare(): Readonly<{
    sql: string;
    params: readonly string[];
    run(client: import("reylo").PostgresClient, input: {
        route: number;
        account_id: string;
    }): Promise<{
        initialized: boolean;
        mode: "open" | "rebuilding" | "purging" | "purged";
        ready: boolean;
        epoch: bigint;
        activeGeneration: string | null;
        runId: string | null;
    } | null>;
}>;
export declare function gateSave(): Readonly<{
    sql: string;
    params: readonly string[];
    run(client: import("reylo").PostgresClient, input: {
        mode: string;
        ready: boolean;
        epoch: number | bigint | string;
        active_generation?: string | null;
        run_id?: string | null;
        route: number;
        account_id: string;
    }): Promise<void>;
}>;
export declare function inputs(): Readonly<{
    sql: string;
    params: readonly string[];
    run(client: import("reylo").PostgresClient, input: {
        route: number;
        account_id: string;
    }): Promise<{
        entries: boolean;
        collections: boolean;
        sessions: boolean;
    }>;
}>;
export declare function runRead(): Readonly<{
    sql: string;
    params: readonly string[];
    run(client: import("reylo").PostgresClient, input: {
        route: number;
        account_id: string;
        run_id: string;
    }): Promise<{
        runId: string;
        epoch: bigint;
        sequence: bigint;
        segment: number;
        kind: "backfill" | "counters" | "purge";
        phase: string;
        cursor: import("reylo").Json;
        buildGeneration: string | null;
        enqueuePending: boolean;
        cancelled: boolean;
    } | null>;
}>;
export declare function runCreate(): Readonly<{
    sql: string;
    params: readonly string[];
    run(client: import("reylo").PostgresClient, input: {
        route: number;
        account_id: string;
        run_id: string;
        epoch: number | bigint | string;
        kind: string;
        phase: string;
        build_generation?: string | null;
    }): Promise<void>;
}>;
export declare function stepSave(): Readonly<{
    sql: string;
    params: readonly string[];
    run(client: import("reylo").PostgresClient, input: {
        route: number;
        account_id: string;
        run_id: string;
    }): Promise<void>;
}>;
export declare function authorizedCollection(): Readonly<{
    sql: string;
    params: readonly string[];
    run(client: import("reylo").PostgresClient, input: {
        route: number;
        collection_id: string;
        account_id: string;
    }): Promise<{
        collection_id: string;
    } | null>;
}>;
export declare const uuid: RegExp;
export declare const decimal: RegExp;
export type Run = NonNullable<Awaited<ReturnType<ReturnType<typeof runRead>['run']>>>;
export type Gate = NonNullable<Awaited<ReturnType<ReturnType<typeof gateRead>['run']>>>;
export declare const ownerArgs: (owner: ShelfOwner) => {
    route: number;
    account_id: string;
};
export declare const runArgs: (owner: ShelfOwner, runId: string) => {
    route: number;
    account_id: string;
    run_id: string;
};
export declare function unavailable(owner: ShelfOwner): never;
export declare function ownerCheck(owner: ShelfOwner): void;
export declare function closed(input: object, keys: readonly string[]): void;
export declare function validateShelfMaintenanceCursor(cursor: ShelfMaintenanceCursor): void;
export declare function validateShelfMaintenanceBinding(binding: ShelfMaintenanceBinding): void;
export declare function bindingFor(owner: ShelfOwner, run: Run): ShelfMaintenanceBinding;
export declare function live(tx: CommandTransaction, owner: ShelfOwner): import("../command/command.ts").CurrentCommand;
export declare function shareShelfAccount(tx: CommandTransaction, accountId: string): Promise<"active">;
export declare function ownerAuthority(tx: CommandTransaction, owner: ShelfOwner): Promise<void>;
export declare function saveGate(tx: CommandTransaction, owner: ShelfOwner, gate: Gate): Promise<void>;
export declare function createRun(tx: CommandTransaction, owner: ShelfOwner, gate: Gate, kind: ShelfMaintenanceKind): Promise<ShelfMaintenanceBinding>;
/** Called only in an already admitted live owner command. No absent-row empty inference. */
export declare function initialize(tx: CommandTransaction, owner: ShelfOwner): Promise<{
    initializedNow: boolean;
    readiness: "backfill" | "ready";
    generationId: string | null;
    requested: ShelfMaintenanceBinding | null;
}>;
/** Every ordinary input writer holds this lock through its own commit, including all late writers. */
export declare function enterShelfWrite(tx: CommandTransaction, owner: ShelfOwner): Promise<{
    ready: boolean;
    epoch: bigint;
    generationId: string | null;
}>;
/** Technical input repairs retain their existing operational authority. They can
 * create an uninitialized gate, but cannot declare readiness or mint derived pages. */
export declare function fenceShelfTechnicalWrite(tx: OperationalTransaction, owner: ShelfOwner): Promise<void>;
