import type { FilterDocument } from '@rezics/filter';
import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import { type AuthoritativeTime } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import { type WorkAllowance, type WorkDimensions, type WorkReceipt } from './contract/work-dimensions.ts';
import { type SearchPreparationCapability } from './contract/index.ts';
import { CollectionWorkLedger, type OrdinaryCollectionPagePlan } from './core/index.ts';
export type OwnerQueryDependencies = {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
    routeKey?: Uint8Array;
    search?: unknown;
    searchPreparation?: SearchPreparationCapability;
};
declare class OwnerQueryWorkLedger {
    readonly plan: OrdinaryCollectionPagePlan;
    private readonly ledger;
    constructor(plan: OrdinaryCollectionPagePlan);
    remaining(): WorkAllowance;
    receipt(): WorkReceipt;
    private settle;
    consume(used: WorkDimensions): void;
    native(receipt: WorkReceipt): void;
}
/** Canonical and Search work settle into the same request reservation, including failed dispatches. */
export declare function ownerQueryWork(limit: number, view?: 'BASIC' | 'FULL'): OwnerQueryWorkLedger;
/** One current native Source and the registered Search service. No owner/client impersonation or GET work. */
export declare function openOwnerQuery(deps: OwnerQueryDependencies, input: {
    actor: Actor;
    collectionId: string;
    deadline: number;
    work: Pick<CollectionWorkLedger, 'remaining' | 'receipt' | 'native'>;
    logical?: boolean;
    at?: AuthoritativeTime;
}): Promise<{
    source: import("./collection-source.ts").PreparedCollectionSource;
    native: import("./collection-source.ts").CollectionSource;
    context: {
        actor: Actor;
        at: AuthoritativeTime;
        deadline: number;
    };
    close(): void;
    originals(subjectId: string): Promise<string[]>;
    filter(filter: FilterDocument, releaseDigest: string): Promise<{
        scope: {
            sourcePrefix(prepared: unknown, input: Readonly<{
                afterSubjectId: string | null;
                allowance: WorkAllowance;
                candidateLimit?: number;
            }>): Promise<Readonly<{
                candidates: readonly import("./collection-source.ts").CanonicalCollectionCandidate[];
                observation: import("./collection-source.ts").CollectionSourceObservation;
                exhausted: boolean;
                coveredThrough: string | null;
                work: WorkReceipt;
            }>>;
            evaluate(prepared: unknown, subjects: readonly string[], input: unknown): Promise<Readonly<{
                values: readonly unknown[];
            }>>;
            work(result: unknown): WorkReceipt;
        };
        prepared: Readonly<{
            basis: unknown;
        }>;
    }>;
}>;
export {};
