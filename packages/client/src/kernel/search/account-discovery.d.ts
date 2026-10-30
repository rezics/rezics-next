import type { Pool, PoolClient } from 'pg';
import type { DiscoveryKey, DiscoveryRegistry } from './discovery.ts';
import type { SubjectListingSource } from './source.ts';
import type { OpenSearch } from './opensearch.ts';
import { type AccountDiscoverySource, type AccountFrontier, type AccountPage, type AccountSnapshot } from './discovery.ts';
import type { SubjectSource } from './source.ts';
/** Admit the whole native chunk before sort preparation or engine I/O; omission means keyed deletion. */
export declare function validateAccountSnapshot(value: unknown, partition: number, ids: readonly string[], atLeast: bigint): AccountSnapshot;
/** Native keyset order/exhaustion is retained even when the exact claim produces a null handle. */
export declare function validateAccountPage(value: unknown, partition: number, after: AccountFrontier | null, limit: number): AccountPage;
/** One native bootstrap page. Persist next only after the existing writer settles all returned actions. */
export declare function prepareAccountPopulationPage(source: AccountDiscoverySource, partition: number, after: AccountFrontier | null, limit?: number): Promise<{
    snapshot: AccountPage;
    actions: import("./document.ts").IndexAction<import("./document.ts").AccountDocument>[];
}>;
/** Event keys only; reread current native rows, retaining every tail within the same checkpoint obligation. */
export declare function prepareAccountCatchup(source: AccountDiscoverySource, partition: number, ids: readonly string[], atLeast: bigint): AsyncGenerator<{
    snapshot: AccountSnapshot;
    actions: import("./document.ts").IndexAction<import("./document.ts").AccountDocument>[];
}, void, unknown>;
export type DiscoveryCensus = {
    partition: number;
    position: bigint;
    subjects: number;
    accounts: number;
};
/** Both owners must observe the same native cut. These values never supply KindCountEvidence. */
export declare function readDiscoveryCensus(subjects: SubjectSource, accounts: AccountDiscoverySource, partition: number): Promise<DiscoveryCensus>;
/** The production registry uses each owner's real current-summary reader. No summary is indexed. */
export declare function nativeDiscoveryRegistry(pool: Pool, routeKey: Uint8Array, subjects: SubjectSource): Promise<DiscoveryRegistry>;
export type DiscoveryTarget = {
    prefix: string;
    generation: number;
    uuid: string;
    incarnation: string;
};
export type DiscoveryProjection = ReturnType<typeof createDiscoveryProjection>;
/** Session custody spans the external effect, but no database transaction/row lock does. */
export declare function withDiscoveryTarget<T>(pool: Pool, search: OpenSearch, target: DiscoveryTarget, work: (client: PoolClient, index: string) => Promise<T>, purge?: boolean): Promise<T>;
export declare const copyLocator: (target: DiscoveryTarget) => string;
/** One writer for population, replay and repair, with durable native deletion high water. */
export declare function createDiscoveryProjection(options: {
    pool: Pool;
    search: OpenSearch;
    registry: DiscoveryRegistry;
    listing: SubjectListingSource;
    target: DiscoveryTarget;
}): {
    project: (partition: number, input: readonly DiscoveryKey[], atLeast?: bigint, repair?: boolean) => Promise<void>;
    registry: DiscoveryRegistry;
    target: DiscoveryTarget;
    listing: SubjectListingSource;
};
/** Terminal work is located from Search's own copy inventory, never inferred from a missing source. */
export declare function eraseDiscoveryAccount(pool: Pool, search: OpenSearch, registry: DiscoveryRegistry, accountId: string): Promise<void>;
/** A physically deleted generation may still own an open erasure locator. */
export declare function registerRetiredErasure(pool: Pool, target: DiscoveryTarget, accountId: string): Promise<import("../command/command.ts").CommandOutcome<boolean>>;
