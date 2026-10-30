import { type OperationalTransaction } from '../command/operational.ts';
import { type CommandTransaction } from '../command/command.ts';
import { type WorkClient } from '../work/client.ts';
import { type ShelfMaintenanceBinding, type ShelfMaintenanceCursor, type ShelfMaintenanceDependencies, type ShelfMaintenanceDerivedPorts, type ShelfMaintenanceOps, type ShelfOwner } from './shelf-maintenance-ops-contract.ts';
export declare const SHELF_MAINTENANCE_WORKFLOW = "library.shelfMaintenance";
export declare const SHELF_MAINTENANCE_EVENT = "com.rezics.library.shelf-maintenance.advanced.v1";
export declare function validateShelfMaintenanceCursor(cursor: ShelfMaintenanceCursor): void;
export declare function validateShelfMaintenanceBinding(binding: ShelfMaintenanceBinding): void;
/** Every ordinary input writer holds this lock through its own commit, including all late writers. */
export declare function enterShelfWrite(tx: CommandTransaction, owner: ShelfOwner): Promise<{
    ready: boolean;
    epoch: bigint;
    generationId: string | null;
}>;
/** Technical input repairs retain their existing operational authority. They can
 * create an uninitialized gate, but cannot declare readiness or mint derived pages. */
export declare function fenceShelfTechnicalWrite(tx: OperationalTransaction, owner: ShelfOwner): Promise<void>;
/** No public mint operation. Copied/serialized branded objects cannot reach the allocator. */
export declare function createShelfMaintenanceDerivedPorts(): ShelfMaintenanceDerivedPorts;
export declare function createShelfMaintenanceOps(deps: ShelfMaintenanceDependencies): ShelfMaintenanceOps;
export declare function enqueueShelfMaintenance(client: WorkClient, binding: ShelfMaintenanceBinding, attempt?: string): Promise<void>;
/** Installed exactly once by the existing Library WorkModule. */
export declare function registerShelfMaintenanceWork(context: import('../work/registry.ts').WorkContext): Promise<ShelfMaintenanceOps>;
