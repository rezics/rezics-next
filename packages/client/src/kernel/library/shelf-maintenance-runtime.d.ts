export { enterShelfWrite, fenceShelfTechnicalWrite, validateShelfMaintenanceCursor, validateShelfMaintenanceBinding, } from './shelf-maintenance-owner.ts';
import { type CommandTransaction } from '../command/command.ts';
import { type WorkClient } from '../work/client.ts';
import { type ShelfDerivedPage, type ShelfMaintenanceBinding, type ShelfMaintenanceDependencies, type ShelfMaintenanceDerivedPorts, type ShelfMaintenanceOps } from './shelf-maintenance-ops-contract.ts';
export declare const SHELF_MAINTENANCE_WORKFLOW = "library.shelfMaintenance";
export declare const SHELF_MAINTENANCE_EVENT = "com.rezics.library.shelf-maintenance.advanced.v1";
/** Allocator integration reads actual same-tx/run/build authority; this never mints a page. */
export declare function readShelfDerivedAllocation(tx: CommandTransaction, page: ShelfDerivedPage): Promise<{
    owner: Readonly<{
        route: number;
        accountId: string;
    }>;
    runId: string;
    epoch: bigint;
    generationId: string;
}>;
/** No public mint operation. Copied/serialized branded objects cannot reach the allocator. */
export declare function createShelfMaintenanceDerivedPorts(): ShelfMaintenanceDerivedPorts;
export declare function createShelfMaintenanceOps(dependencies: ShelfMaintenanceDependencies): ShelfMaintenanceOps;
export declare function enqueueShelfMaintenance(client: WorkClient, binding: ShelfMaintenanceBinding, attempt?: string): Promise<void>;
/** Installed exactly once by the existing Library WorkModule. */
export declare function registerShelfMaintenanceWork(context: import('../work/registry.ts').WorkContext): Promise<ShelfMaintenanceOps>;
