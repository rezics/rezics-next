import type { CommandTransaction } from '../command/command.ts';
import type { FactRow } from './item.ts';
export type CurrentRelationCandidate = {
    subject: string;
    property: string;
    candidate: string;
    target: string | null;
    external?: string | null;
    value?: 'value' | 'somevalue' | 'novalue';
    anyResolvedTarget?: boolean;
    context?: string;
    defaults?: Readonly<Record<string, 'inherit' | 'suppress'>>;
    slot?: string;
    filter?: string;
    filterProperties?: readonly string[];
    requireRelation?: boolean;
};
export declare function currentRelationKey(candidate: Pick<CurrentRelationCandidate, 'subject' | 'property' | 'candidate'>): string;
/**
 * Resolve only the supplied candidate keys in the caller's repeatable-read snapshot.
 * The caller releases this snapshot before preparing foreign Access evidence.
 */
export declare function currentRelationFacts(client: CommandTransaction, routeKey: Uint8Array | undefined, candidates: readonly CurrentRelationCandidate[], options?: {
    sourceFences?: 'caller';
}): Promise<Map<string, FactRow>>;
