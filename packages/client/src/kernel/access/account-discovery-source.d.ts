import type { Pool, PoolClient } from 'pg';
import { type AccountDiscoveryReductionHead } from './account-discovery-reduction.ts';
import type { AccountDiscoverySource, AccountDiscoverySummary } from '../search/discovery.ts';
import { type SummaryReaderDependencies } from '../semantic/summaries.ts';
/** Native source only; neither routing text keys nor caller policy belong in this factory. */
export declare function accountDiscoverySource(pool: Pool): AccountDiscoverySource;
/** Current writer witness only. Immutable query admission must retain the complete
 * native reduction binding in its registered Source, including ownership epochs.
 */
export declare function readAccountDiscoveryWitness(pool: Pool, partitions: readonly number[]): Promise<Map<number, {
    revision: bigint;
    claimRevision: bigint;
}>>;
/** Source bindings for the index writer. An unconsumed exact claim is never
 * certified for publication: redrive its native intent, then resnapshot.
 */
export declare function readAccountDiscoveryBindings(pool: Pool, partition: number, ids: readonly string[], snapshotClient?: PoolClient): Promise<Map<string, {
    revision: bigint;
    handle: string | null;
    agent: {
        subjectId: string;
        receiptId: string;
    } | null;
    claim: {
        route: number;
        revision: bigint;
    } | null;
    consumedClaimRevision: bigint;
}>>;
/** Original Account repair input. The core snapshot position is a writer floor;
 * revision and claimRevision remain independent native Account domains. None of
 * these fields is a Semantic privacy-log position or a population ACK.
 */
export type AccountDiscoveryRepairObservation = Readonly<{
    id: string;
    head: AccountDiscoveryReductionHead;
    claimHead: AccountDiscoveryReductionHead | null;
    position: bigint;
    account: Awaited<ReturnType<AccountDiscoverySource['read']>>['accounts'][number] | null;
    binding: Awaited<ReturnType<typeof readAccountDiscoveryBindings>> extends Map<string, infer B> ? B | null : never;
}>;
/** Release every owner read before the next phase and revalidate both the local
 * native head and the exact current-handle/claim cursor after foreign reads.
 * Missing/fenced rows are retained as keyed deletion inputs, never Subjects.
 */
export declare function readAccountDiscoveryRepairObservation(pool: Pool, id: string, context: Readonly<{
    deadline: number;
}>): Promise<AccountDiscoveryRepairObservation>;
/** Current owner hydration; linked Subject disclosure is exclusively Semantic's. */
export declare function readAccountDiscoverySummaries(deps: SummaryReaderDependencies, ids: readonly string[], options?: {
    languages?: readonly string[];
}): Promise<Map<string, AccountDiscoverySummary | null>>;
