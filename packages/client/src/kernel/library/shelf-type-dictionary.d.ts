import { type CommandTransaction } from '../command/command.ts';
import type { ShelfDerivedPage } from './shelf-maintenance-ops-contract.ts';
import type { ShelfTypeKeys, ShelfWrite } from './shelf-contract.ts';
import type { TypePreparationEvidence } from './type-preparation-contract.ts';
export type ShelfTypeDigest = (bytes: Buffer) => Buffer;
export type ShelfTypeKeysOptions = Readonly<{
    digest?: ShelfTypeDigest;
}>;
export declare const SHELF_TYPE_DIGEST_ENV = "KERNEL_LIBRARY_SHELF_TYPE_DIGEST";
export declare const sha256ShelfTypeDigest: ShelfTypeDigest;
export declare function applyShelfTypeDigest(bytes: Buffer, digest?: ShelfTypeDigest): Buffer;
/** A child worker may receive one fixed digest value as its per-world dictionary configuration. */
export declare function shelfTypeDigestFromEnvironment(env: Readonly<Record<string, string | undefined>>): ShelfTypeDigest | undefined;
/** The maintenance producer owns same-transaction page authority; the dictionary only consumes it. */
export type ShelfDerivedAllocationReader = (tx: CommandTransaction, page: ShelfDerivedPage) => Promise<{
    owner: {
        route: number;
        accountId: string;
    };
    runId: string;
    epoch: bigint;
    generationId: string;
}>;
/** Internal producer seam. The producer has already released current source observations and holds native evidence.
 * The token is scoped to this callback and exact live command, never carried in workflow JSON.
 */
export declare function withShelfTypePreparation<T>(write: ShelfWrite, evidence: TypePreparationEvidence, body: () => Promise<T>): Promise<T>;
/** Only the native runner's live WeakMap page can enter the shared dictionary core during rebuilding. */
export declare function withShelfDerivedTypePreparation<T>(tx: CommandTransaction, page: ShelfDerivedPage, reservationId: string | null, body: () => Promise<T>, readAllocation: ShelfDerivedAllocationReader): Promise<T>;
export declare function createShelfTypeKeys(options?: ShelfTypeKeysOptions): ShelfTypeKeys;
