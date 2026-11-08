import type { Release } from '@rezics/definitions';
import { type CurrentContentDocumentRuntime } from '../content/adapters/index.ts';
import { type PublicDocumentView } from '../content/document-public.ts';
import type { Actor } from '../request/access.ts';
import type { Item } from './item.ts';
export { globalReadEligibility, relatedReadEligibility } from './eligibility.ts';
export { readItemDetails, readItemTypes, readSubjectPageStates } from './public-subject-facts.ts';
export type { ItemTypeDetails, SubjectPageState } from './public-subject-facts.ts';
type AnchoredPosition = {
    partition: {
        partitionNo: number;
    };
    epoch: number;
    position: bigint;
};
type ReadContext = {
    actor: Actor;
    deadline: number;
};
/** Preview limits apply before body transfer and again to the complete retained DTO. */
export declare function characterDocumentBounds(): {
    readonly documents: 15;
    readonly sourceBytes: 262144;
    readonly responseBytes: 1048576;
};
export type CharacterDocumentRelease = {
    types?: Record<string, {
        bases?: readonly string[];
        properties?: readonly string[];
    }>;
    properties?: Record<string, {
        datatype?: string;
    }>;
};
/** Only current released document fields on this Character can select a body. */
export declare function characterDocumentProperties(release: CharacterDocumentRelease | undefined, type: string, available: readonly string[]): string[];
/**
 * Read immutable bodies from the existing document authority under this caller.
 * A missing, erased, oversized or mismatched body stays absent from the map:
 * CandidateValue then exposes its existing unavailable state and read retry.
 * This does not read an editor or grant any editorial operation.
 */
export declare function readCharacterPublicDocuments(dependencies: CurrentContentDocumentRuntime, subject: Item, release: Release, context: ReadContext, locale: string): Promise<{
    documents: Record<string, PublicDocumentView>;
    anchors: AnchoredPosition[];
} | undefined>;
