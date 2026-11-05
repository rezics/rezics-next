import { type DiscoveryFilterDocument, type FilterDocument, type FilterRelease } from '@rezics/filter';
import type { DiscoveryCondition, DiscoveryRegistry, DiscoveryOwnerRegistry, DiscoveryConsumerCaptureInput } from './discovery.ts';
import type { PublicFilterDependencyKey, PublicFilterProjectionMeaning } from '../semantic/public-filter-source-contract.ts';
type Query = Record<string, unknown>;
/** Both polarities are compiled: NOT unknown must never become an Account complement. */
export declare function compileDiscoveryFilter(filter: DiscoveryFilterDocument, registry: DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>, release: FilterRelease): {
    query: Query;
    condition: DiscoveryCondition;
};
/** The unfiltered mixed population is registry bounded; it never includes unregistered producers. */
export declare function discoveryPopulation(registry: DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>): Query;
type CurrentPredicate = boolean | FilterDocument;
/** Specialize an admitted tree before the existing current catalogue matcher, retaining both truth polarities.
 * A false result is no proof of the complement: Account-unsupported leaves have neither polarity.
 */
export declare function currentDiscoveryFilter(filter: DiscoveryFilterDocument, registry: DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>, kind: string, release: FilterRelease): CurrentPredicate;
/** Derive native evidence from the exact admitted root. Size/frontier remain execution data. */
export declare function compileDiscoveryCapture(input: DiscoveryConsumerCaptureInput, registry: DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>, release: FilterRelease): DiscoveryConsumerCaptureInput;
/** Native consumer and custody derive identical dependencies from the immutable mixed root.
 * Custody can validate dependency coverage without a registry; native execution still requires the actual registry.
 */
export declare function compileDiscoveryConsumerCapture(input: DiscoveryConsumerCaptureInput, meaning: PublicFilterProjectionMeaning, registry: (DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>) | undefined): Readonly<{
    query: Query;
    dependencyKeys: readonly PublicFilterDependencyKey[];
}>;
export {};
