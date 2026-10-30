import type { FilterRelease } from '@rezics/filter';
import type { PublicFilterSource } from '../semantic/public-filter-source-contract.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type MixedDiscoveryRequest } from './discovery-request.ts';
import type { DiscoveryPage, DiscoveryReadContext, DiscoveryRegistry } from './discovery.ts';
import type { PublicDiscoveryConsumerOperations, PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';
type Principal = 'anonymous' | `account:${string}`;
export type DiscoverySearch = (principal: Principal, request: MixedDiscoveryRequest, context: DiscoveryReadContext) => Promise<DiscoveryPage>;
/** Actual retained consumer and Source are mandatory here. The mounted route may omit this provider while
 * native owner integration is absent, in which case it returns readiness before enumeration.
 */
export declare function createDiscoverySearch(config: {
    consumer: PublicDiscoveryConsumerOperations;
    source: PublicFilterSource;
    keys: KeyRing;
    /** Pins the actual release and request-language owner hydration for the entire operation. */
    resolve(request: MixedDiscoveryRequest): Promise<{
        registry: DiscoveryRegistry;
        release: FilterRelease;
        digest: string;
    }>;
    now(): number;
    asOf(queried: PublicFilterQueriedObservation): Promise<string>;
}): DiscoverySearch;
export {};
