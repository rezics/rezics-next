import type { DiscoveryProjection } from './account-discovery.ts';
import type { Pool } from 'pg';
import { type Envelope } from '../events/log.ts';
import type { Relay } from '../events/relays.ts';
import { type SearchWriterGuard } from './writer-guard.ts';
import type { OpenSearch } from './opensearch.ts';
import { type SubjectListingSource, type SubjectSource } from './source.ts';
export { IndexWriteError } from './write-actions.ts';
/** Internal composition only: admission must reject or await the same real apply exactly once. */
export type SubjectApplyGuard = (partition: number, envelopes: readonly Envelope[], apply: () => Promise<void>) => Promise<void>;
export { validateIndexObservation as validateObservation } from './document.ts';
export declare function createSubjectIndexer(options: {
    pool: Pool;
    search: OpenSearch;
    source: SubjectSource;
    listing: SubjectListingSource;
    index: string;
    consumer: string;
    aroundApply?: SubjectApplyGuard;
    /** Trusted native runner composition; independent of aroundApply/privacy repair. */
    writer?: SearchWriterGuard;
    envelopes?: number;
}): Relay;
/** The shared relay captures both owners in one 64-envelope checkpoint obligation. */
export declare function createDiscoveryIndexer(pool: Pool, projection: DiscoveryProjection, consumer: string): Relay;
/** The sole ordinary writer path, shared by finite cold population and event replay. */
export declare function applySubjectKeys(options: Pick<Parameters<typeof createSubjectIndexer>[0], 'search' | 'source' | 'listing' | 'index' | 'writer'>, partition: number, ids: readonly string[], obligation: bigint, guard?: SubjectApplyGuard): Promise<void>;
