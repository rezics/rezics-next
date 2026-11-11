import type { ReadContext } from './model.ts';
import { type HostedDependencies, type HostedOwnerInventoryInput, type HostedOwnerInventoryEntry, type HostedOwnerInventoryScope } from './hosted-chapters-model.ts';
/** <=21 actual owned catalogue records from one source route, <=20 native
 * disclosures. Denied or changed records consume their slots; never refill. */
export declare function listOwnHostedCatalogues(deps: HostedDependencies, accountId: string, context: ReadContext, input?: HostedOwnerInventoryInput): Promise<{
    value: Readonly<{
        scope: HostedOwnerInventoryScope;
        viewer: Readonly<{
            accountId: string;
            authnEpoch: number;
        }>;
        items: readonly HostedOwnerInventoryEntry[];
        nextCursor: string | null;
    }>;
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
/** Resolve one inventory entry within its declared scope, without a supplied
 * thread or ownership claim. Existing hosted reads still accept known remote IDs;
 * this directory never infers cross-home coverage from those exact reads. */
export declare function readOwnHostedCatalogue(deps: HostedDependencies, accountId: string, catalogueId: string, context: ReadContext): Promise<{
    value: {
        scope: Readonly<{
            kind: 'same-home';
            route: number;
            crossHome: 'unavailable';
        }>;
        viewer: {
            accountId: string;
            authnEpoch: number;
        };
        item: Readonly<{
            catalogueId: string;
            threadId: string;
            createdAt: string;
            postRevisionId: string;
            postVisibility: 'draft' | 'published' | 'protected';
            headRevisionId: string;
            publicationId: string | null;
        }>;
    };
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
