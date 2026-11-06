import type { Pool, PoolClient } from 'pg';
import type { Release } from '@rezics/definitions';
import type { DiscoveryIndexAction, DiscoveryKey, DiscoveryOwnerAdapterSlots, DiscoveryRegistry } from './discovery.ts';
import type { SubjectListingSource } from './source.ts';
import type { OpenSearch } from './opensearch.ts';
import { type AnyDiscoveryIndexAction, type SecondScopeDiscoveryIndexAction } from './discovery-documents.ts';
import { type AccountDiscoverySource, type AccountFrontier, type AccountPage, type AccountSnapshot } from './discovery.ts';
import type { DiscoveryMetadataKind, DiscoveryMetadataProducers, DiscoveryOmittedKind } from './index.ts';
import type { ReviewDiscoveryRefresh } from '../content/index.ts';
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
export declare function nativeDiscoveryRegistry(pool: Pool, routeKey: Uint8Array, subjects: SubjectSource, options?: {
    release?: Release;
    languages?: readonly string[];
    ownerAdapters?: DiscoveryOwnerAdapterSlots;
    accounts?: AccountDiscoverySource;
    omittedKinds?: readonly DiscoveryOmittedKind[];
}): Promise<DiscoveryRegistry & import("./discovery.ts").DiscoveryOwnerRegistry>;
export type DiscoveryTarget = {
    prefix: string;
    generation: number;
    uuid: string;
    incarnation: string;
};
export type DiscoveryProjection = ReturnType<typeof createDiscoveryProjection>;
/** Native mixed identity is its allocation incarnation AND engine UUID, never a Subject writer alias. */
export declare function readDiscoveryWriterPhysicalTarget(pool: Pick<Pool, 'query'>, search: OpenSearch, index: string): Promise<{
    incarnation: string;
    allocation: string;
    writeAlias: string;
}>;
export type DiscoveryRepairEffect = Readonly<{
    key: DiscoveryKey;
    action: DiscoveryIndexAction;
    winner: unknown;
    evidence: Readonly<{
        kind: 'bulk';
        bulk: unknown;
    }> | Readonly<{
        kind: 'recovered';
        refresh: unknown;
    }>;
}>;
/** Search visibility belongs to the exact keyed winner; copy settlement is insufficient. */
export declare function readDiscoveryRepairWinner(search: OpenSearch, index: string, action: AnyDiscoveryIndexAction): Promise<unknown>;
/** The original search-visible winner remains part of the retained native repair provenance. */
export declare function validateDiscoveryRepairWinner(index: string, action: AnyDiscoveryIndexAction, body: unknown): void;
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
    metadataProducers?: DiscoveryMetadataProducers;
}): {
    project: (partition: number, input: readonly DiscoveryKey[], atLeast?: bigint, repair?: boolean) => Promise<void>;
    prepareRepair: (id: string, obligation: bigint, owner?: DiscoveryKey['owner']) => Promise<DiscoveryIndexAction[]>;
    applyRepair: (actions: readonly DiscoveryIndexAction[]) => Promise<Readonly<{
        key: DiscoveryKey;
        action: DiscoveryIndexAction;
        winner: unknown;
        evidence: Readonly<{
            kind: 'bulk';
            bulk: unknown;
        }> | Readonly<{
            kind: 'recovered';
            refresh: unknown;
        }>;
    }>[]>;
    prepareReviews: (refresh: ReviewDiscoveryRefresh, ids: readonly string[]) => Promise<SecondScopeDiscoveryIndexAction[]>;
    applyReviews: (actions: readonly SecondScopeDiscoveryIndexAction[], held: {
        client: PoolClient;
        index: string;
        acknowledge(): Promise<void>;
    }) => Promise<void>;
    applyNativeActions: (actions: readonly AnyDiscoveryIndexAction[]) => Promise<Readonly<{
        key: DiscoveryKey;
        action: DiscoveryIndexAction;
        winner: unknown;
        evidence: Readonly<{
            kind: 'bulk';
            bulk: unknown;
        }> | Readonly<{
            kind: 'recovered';
            refresh: unknown;
        }>;
    }>[]>;
    hasMetadataPopulation: (kind: DiscoveryMetadataKind) => Promise<boolean>;
    prepareOwnerPageActions: (kind: DiscoveryMetadataKind, partition: number, snapshot: {
        position: bigint;
        keys: readonly import('./discovery-documents.ts').SecondScopeDiscoveryKey[];
        records: readonly import('./discovery-documents.ts').SecondScopeDiscoveryRecord[];
    }) => SecondScopeDiscoveryIndexAction[];
    prepareOwnerActions: (kind: DiscoveryMetadataKind, partition: number, ids: readonly string[]) => Promise<{
        position: bigint;
        keys: any[];
        records: readonly Readonly<{
            key: import("./discovery-api.ts").DiscoveryOwnerKey;
            revision: bigint;
            sourceVersion: string | null;
            names: readonly string[];
            descriptions: readonly string[];
            nameSort: string | null;
        }>[];
        actions: SecondScopeDiscoveryIndexAction[];
    }>;
    projectOwner: (kind: DiscoveryMetadataKind, partition: number, ids: readonly string[]) => Promise<Readonly<{
        key: DiscoveryKey;
        action: DiscoveryIndexAction;
        winner: unknown;
        evidence: Readonly<{
            kind: 'bulk';
            bulk: unknown;
        }> | Readonly<{
            kind: 'recovered';
            refresh: unknown;
        }>;
    }>[] | undefined>;
    ownerPosition: (kind: DiscoveryMetadataKind, partition: number) => Promise<bigint>;
    metadataProducers: Readonly<Partial<Record<import("./discovery-api.ts").DiscoveryOwnerKind, Readonly<{
        kind: DiscoveryMetadataKind;
        owner: 'commerce' | 'content';
        readiness(): Promise<'ready' | 'preparing' | 'unavailable' | import("../community/space-discovery-dependencies.ts").SpaceDiscoveryDependencyReadiness>;
        page(partition: number, after: Readonly<{
            route: number;
            id: string;
        }> | null, continuation: string | null, limit: number): Promise<Readonly<{
            position: bigint;
            epoch?: number;
            next: Readonly<{
                route: number;
                id: string;
            }> | null;
            continuation: string | null;
            keys: readonly import("./discovery-api.ts").DiscoveryOwnerKey[];
            records: readonly import("./discovery-api.ts").DiscoveryMetadataRecord[];
        }>>;
        read(partition: number, ids: readonly string[]): Promise<Readonly<{
            position: bigint;
            epoch?: number;
            keys: readonly import("./discovery-api.ts").DiscoveryOwnerKey[];
            records: readonly import("./discovery-api.ts").DiscoveryMetadataRecord[];
        }>>;
        position(partition: number): Promise<bigint>;
    }>>>>;
    registry: DiscoveryRegistry;
    target: DiscoveryTarget;
    listing: SubjectListingSource;
};
/** Terminal work is located from Search's own copy inventory, never inferred from a missing source. */
export declare function eraseDiscoveryAccount(pool: Pool, search: OpenSearch, registry: DiscoveryRegistry, accountId: string, inputLimit?: number): Promise<void>;
/** A physically deleted generation may still own an open erasure locator. */
export declare function registerRetiredErasure(pool: Pool, target: DiscoveryTarget, accountId: string): Promise<import("../command/command.ts").CommandOutcome<boolean>>;
