import type { ReadContext } from './model.ts';
import { type HostedDependencies, type HostedOwnerInventoryInput, type HostedOwnerInventoryEntry, type HostedOwnerInventoryScope } from './hosted-chapters-model.ts';
/** <=21 indexed raw candidates, <=20 native disclosures. Hidden or changed
 * sources consume their slots. The raw encrypted boundary continues sparse pages. */
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
/** An exact owner selection needs no locator coverage claim. Native membership,
 * author and revise authority are proved in the catalogue's own current home. */
export declare function readOwnHostedCatalogue(deps: HostedDependencies, accountId: string, catalogueId: string, context: ReadContext): Promise<{
    value: {
        scope: Readonly<{
            kind: 'same-home' | 'all-homes';
            route: number;
            crossHome: 'unavailable' | 'partial' | 'complete';
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
