import type { Pool } from 'pg';
export declare const SPACE_DISCOVERY_DEPENDENCY_PAGE = 50;
export declare const SPACE_DISCOVERY_DEPENDENCY_BASIS: {
    actorAccountId: string;
    clientId: string;
    requestedBy: null;
};
type SourceFenceCapability = 'preparing' | 'unavailable' | 'connected';
type DependencyCapabilities<T extends SourceFenceCapability> = Readonly<{
    context: 'connected';
    media: 'connected';
    exposure: 'connected';
    'source-fence': T;
}>;
export type SpaceDiscoveryDependencyReadiness = Readonly<{
    state: 'preparing';
    generation?: string;
    cut?: string | null;
    capabilities: DependencyCapabilities<'preparing' | 'unavailable'>;
}> | Readonly<{
    state: 'unavailable';
    generation?: string;
    cut?: string | null;
    reason?: 'source-tuple-producer-missing' | 'source-tuple-coverage-incomplete';
    capabilities: DependencyCapabilities<'unavailable'>;
}> | Readonly<{
    state: 'ready';
    generation: string;
    cut: string;
    capabilities: DependencyCapabilities<'connected'>;
}>;
/** A ready result is issued only for an explicit source census plus a current
 * exact witness for every retained Space. Empty pages and empty inverse ranges
 * never supply either proof. Generation/cut are opaque equality witnesses over
 * the captured native installation and the current tuple coverage frontier.
 */
export declare function spaceDiscoveryDependencyReadiness(pool: Pool): Promise<SpaceDiscoveryDependencyReadiness>;
export declare function dependencyPageLimit(limit: number): void;
/** The deployment census is independent of eligibility. Native deferred writer
 * triggers maintain changes on both sides of the captured installation cut.
 * A page locks each exact retained owner before reading its current Realm head.
 */
export declare function initializeSpaceDiscoveryDependencies(pool: Pool, partition: number, limit?: number): Promise<boolean>;
/** Only the indexed unfinished installation keys are visited by maintenance;
 * a scope never enumerates the 4096 partitions, even when its inverse is empty.
 */
export declare function nextSpaceDiscoveryDependencyInstall(pool: Pool): Promise<number | null>;
export {};
