import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { NativeStepWork } from './identity-epoch-contract.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';
declare const identitySourceConsumerMaintenance: unique symbol;
export type IdentitySourceConsumerMaintenanceWork = Readonly<{
    [identitySourceConsumerMaintenance]: true;
}>;
export type IdentitySourceConsumerMaintenanceContext = Readonly<{
    deadline: number;
    identityConsumerWork: IdentitySourceConsumerMaintenanceWork;
}>;
/** Server-only liveness check. The frame says nothing about Source or permission truth. */
export declare function isLiveIdentitySourceConsumerMaintenance(pool: Pool, work: IdentitySourceConsumerMaintenanceWork | undefined, deadline?: number): boolean;
/** Charge a proved native operation before dispatch. Dispatched work is never refunded. */
export declare function reserveIdentitySourceConsumerNativeWork(pool: Pool, work: IdentitySourceConsumerMaintenanceWork | undefined, amount: NativeStepWork): boolean;
/** Planning snapshot of this invocation's existing native balance, never new funding. */
export declare function identitySourceConsumerNativeWork(pool: Pool, work: IdentitySourceConsumerMaintenanceWork | undefined, deadline: number): NativeStepWork | null;
/** Return the frame's existing Library ledger after validating pool, invocation and lifetime. */
export declare function identitySourceConsumerLibraryWork(pool: Pool, work: IdentitySourceConsumerMaintenanceWork | undefined, deadline: number): NativeCollectionWork | null;
/** Current frame for a same-command Source verification whose public signature cannot change. */
export declare function currentIdentitySourceConsumerMaintenance(pool: Pool, deadline: number): IdentitySourceConsumerMaintenanceWork | null;
/** The live invocation's own allocation and deadline for internal nested History work.
 * This does not mint a frame: it returns only the current async invocation's existing token. */
export declare function activeIdentitySourceConsumerMaintenance(pool: Pool): IdentitySourceConsumerMaintenanceContext | null;
/** Source owns one configured frame for the entire actual default-maintenance callback. */
export declare function withIdentitySourceConsumerMaintenance<T>(deps: Readonly<{
    pool: Pool;
    env: Readonly<Record<string, string | undefined>>;
    clock?: KernelClock;
}>, context: Readonly<{
    deadline: number;
}>, body: (funded: IdentitySourceConsumerMaintenanceContext) => Promise<T>): Promise<T>;
export {};
