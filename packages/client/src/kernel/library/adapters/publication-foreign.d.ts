/** Content publication adapter. Classifies private working versus activated public output and cover facts. */
import type { ContentPublicationCapability, LibraryCoverSummary } from '../contract/index.ts';
export type ContentPublicationAdapterPorts = Readonly<{
    readableCover(input: {
        actor: Parameters<ContentPublicationCapability['readableCover']>[0]['actor'];
        mediaId: string;
        deadline: number;
        routeKey?: Uint8Array;
        clock?: () => Date;
    }): Promise<LibraryCoverSummary | null>;
}>;
export declare function createContentPublicationAdapter(ports?: ContentPublicationAdapterPorts): ContentPublicationCapability;
