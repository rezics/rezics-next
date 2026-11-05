import type { FilterRelease } from '@rezics/filter';
import { type TextNode } from './text.ts';
import type { PublicFilterSource } from '../semantic/public-filter-source-contract.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { ConceptFilterExecution } from './concept-browse-statements.ts';
import { type MixedDiscoveryRequest } from './discovery-request.ts';
import type { DiscoveryPage, DiscoveryReadContext, DiscoveryRegistry, DiscoveryOwnerRegistry, DiscoveryKey } from './discovery.ts';
import type { DiscoverySearch } from './discovery-api.ts';
import type { IndexedSubject } from './source.ts';
import type { PublicFilterConsumerJob, PublicDiscoveryConsumerOperations, PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';
type Principal = 'anonymous' | `account:${string}`;
export type { DiscoverySearch } from './discovery-api.ts';
export type RetainedDiscoveryRead = Readonly<{
    search(): Promise<DiscoveryPage>;
    currentPrimaryCandidates(keys: readonly DiscoveryKey[]): Promise<readonly boolean[]>;
    finish(): Promise<void>;
    close(): Promise<void>;
}>;
export type RetainedDiscoverySearch = (principal: Principal, request: MixedDiscoveryRequest, context: DiscoveryReadContext) => Promise<RetainedDiscoveryRead>;
type DiscoveryConfiguration = {
    consumer: PublicDiscoveryConsumerOperations;
    source: PublicFilterSource;
    keys: KeyRing;
    resolve(request: MixedDiscoveryRequest): Promise<{
        registry: DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>;
        release: FilterRelease;
        digest: string;
    }>;
    now(): number;
    asOf(queried: PublicFilterQueriedObservation): Promise<string | import('./search-context.ts').SearchObservation>;
    prepareConceptFilter?(input: Readonly<{
        principal: string;
        request: unknown;
        filter: import('@rezics/filter').DiscoveryFilterDocument;
        limit: number;
        countCandidateLimit: number;
    }>): Promise<ConceptFilterExecution | undefined>;
    currentTextMatches?: (physicalTarget: string, subject: IndexedSubject, query: TextNode) => Promise<boolean>;
    prepare?(job: PublicFilterConsumerJob): Promise<void>;
};
/** The public completed search and retained readers use the same native execution. The
 * rendezvous is after projection and cursor construction and BEFORE its terminal observation.
 * No capture, ledger or original cut is copied into the retaining caller.
 */
export declare function createRetainedDiscoverySearch(config: DiscoveryConfiguration): RetainedDiscoverySearch;
/** Actual retained consumer and Source are mandatory here. The mounted route may omit this provider while
 * native owner integration is absent, in which case it returns readiness before enumeration.
 */
export declare function createDiscoverySearch(config: DiscoveryConfiguration): DiscoverySearch;
