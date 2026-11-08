/** Composition-owned Library operations that need the native Source and durable preparation seam. */
import type { KernelClock } from '../clock.ts';
import type { Access } from '../request/access.ts';
import type { Pool } from 'pg';
import type { WorkClient } from '../work/client.ts';
import type { LibraryDomain } from './contract/index.ts';
import type { MembersPreparation, PreparationDefinition, PreparationLocator, PreparedMembersReadDependencies, PreparedMembersReadInput, PreparedMembersReadOperation, PreparedMembersRead, PreparationStepState } from './members-preparation.ts';
import type { OwnerFilterNativeOperations, OwnerFilterPlan, OwnerFilterPlanDependencies, OwnerFilterReservation } from './owner-filter-plan.ts';
import type { OperationalTransaction } from '../command/operational.ts';
export type MembersPreparationStoreDependencies = Readonly<{
    pool: Pool;
    workClient: WorkClient;
    access: Access;
    clock?: KernelClock;
}>;
export type LibraryMembersPreparationRuntime = Readonly<{
    native: OwnerFilterNativeOperations;
    reservation: OwnerFilterReservation;
    createPreparation(dependencies: MembersPreparationStoreDependencies): MembersPreparation;
    createPlan(dependencies: OwnerFilterPlanDependencies): OwnerFilterPlan;
    readPreparedMembers: PreparedMembersReadOperation;
    checkCompletion(tx: OperationalTransaction, locator: PreparationLocator): Promise<Readonly<{
        status: 'obsolete';
    } | {
        status: 'current';
    } | {
        status: 'unavailable';
    }>>;
    readOwnerFence(tx: OperationalTransaction, locator: PreparationLocator, definition: PreparationDefinition): Promise<string | null>;
}>;
export type MembersPreparationCapabilities = Pick<LibraryDomain, 'authorization' | 'identityDisclosure' | 'searchPreparation' | 'memberPreparation'>;
export type MembersPreparationReaderInput = Readonly<{
    dependencies: PreparedMembersReadDependencies;
    input: PreparedMembersReadInput;
    options?: {
        limit?: number;
        cursor?: string | null;
    };
}>;
export type MembersPreparationReaderResult = PreparedMembersRead;
export type MembersPreparationState = PreparationStepState;
