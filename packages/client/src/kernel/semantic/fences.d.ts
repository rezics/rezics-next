import type { Source } from '@rezics/definitions/bulk';
import type { Pool, PoolClient } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { ContentQueryClient } from './contract/domain-ports.ts';
import { type SourceFence, type SourceFenceTuple } from '../content/source-fences.ts';
/** Account-agent provenance is a current native identity, not an imported source tuple. */
export type AgentSelfSource = Readonly<{
    kind: 'agent';
    subject: string;
}>;
export type CandidateSource = Source | AgentSelfSource;
/** A source tuple is taken down. The command must not read its receipt or write. */
export declare class SourceFencedError extends Error {
    constructor();
}
/** The tuple's home is read by another command in this batch and is not published yet. */
export declare class FencePending extends Error {
    constructor();
}
export type SourceFencePlan = {
    cache: Map<string, boolean>;
    inside: Map<number, SourceFenceTuple[]>;
    ready: Map<number, Promise<void>>;
    release: Map<number, () => void>;
    reject: Map<number, (error: Error) => void>;
    failed: Map<number, Error>;
    done: Set<number>;
};
export declare function fenceKey(tuple: Pick<SourceFenceTuple, 'route' | 'source' | 'external_id' | 'field_group'>): string;
/** Subject summary cover custody uses the exact same Content fence reader as other Semantic consumers. */
export declare function readCurrentSourceFences(client: ContentQueryClient, tuples: readonly SourceFenceTuple[]): Promise<readonly SourceFence[]>;
export declare function sourceTuple(routeKey: Uint8Array, source: Source): SourceFenceTuple;
/** One read per tuple partition. Same-partition tuples are read inside a command; the rest are anchored first. */
export declare function prepareFencePlan(routeKey: Uint8Array, commands: readonly {
    route: number;
    source: Source;
}[]): {
    plan: SourceFencePlan;
    outside: Map<number, SourceFenceTuple[]>;
};
export declare function readAnchoredFences(pool: Pool, partition: number, tuples: readonly SourceFenceTuple[], deadline?: number): Promise<readonly SourceFence[]>;
export declare function rememberFences(plan: SourceFencePlan, fences: readonly SourceFence[]): void;
/** Read this command's tuple before the receipt. Same-partition batches share one statement.
 * A command never waits inside its transaction for another partition: the caller retries once
 * that partition's own command has published the read.
 */
export declare function enforceSourceFence(tx: CommandTransaction, plan: SourceFencePlan, commandPartition: number, tuple: SourceFenceTuple): Promise<void>;
/** Drop ids whose source tuple is taken down. One fence read per tuple partition, capped at 100 tuples. */
export declare function fencedIds(client: Pick<PoolClient, 'query'>, routeKey: Uint8Array, rows: readonly {
    id: string;
    source: CandidateSource | null;
}[]): Promise<Set<string>>;
type ProvenanceRow = {
    route: number;
    subject_id: string;
    candidate_id: string;
    slot_id?: string;
};
/** Point probes for the proposing source of each shown candidate, then the recording revision of a compact fact. */
export declare function candidateSources(client: Pick<PoolClient, 'query'>, entries: readonly ProvenanceRow[]): Promise<Map<string, CandidateSource | null>>;
export declare function withoutFencedEntries<T extends ProvenanceRow>(client: Pick<PoolClient, 'query'>, routeKey: Uint8Array, entries: readonly T[]): Promise<T[]>;
export {};
