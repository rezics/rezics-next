import type { FilterRelease } from '@rezics/filter';
import type { PublicFilterSource } from '../semantic/public-filter-source-contract.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type MixedDiscoveryRequest } from './discovery-request.ts';
import type { DiscoveryPage, DiscoveryReadContext, DiscoveryRegistry, DiscoveryKey } from './discovery.ts';
import type { PublicFilterConsumerJob, PublicDiscoveryConsumerOperations, PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';
type Principal = 'anonymous' | `account:${string}`;
export type DiscoverySearch = (principal: Principal, request: MixedDiscoveryRequest, context: DiscoveryReadContext) => Promise<DiscoveryPage>;
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
        registry: DiscoveryRegistry;
        release: FilterRelease;
        digest: string;
    }>;
    now(): number;
    asOf(queried: PublicFilterQueriedObservation): Promise<string>;
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
export {};
