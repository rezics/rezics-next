import type { DiscoveryOwnerHit, DiscoveryOwnerKey, DiscoveryOwnerKind, DiscoveryOwnerMetadataSummary, DiscoveryReadContext, AccountDiscoverySummary } from '../discovery.ts';
export type DiscoveryOwnerCandidate = Readonly<{
    key: DiscoveryOwnerKey;
    sourcePosition: string;
    revision: string;
    sourceVersion?: string | null;
}>;
export type OwnerCurrentAccepted<Candidate> = Readonly<{
    candidate: Candidate;
    kind: DiscoveryOwnerKind;
    id: string;
    value: DiscoveryOwnerMetadataSummary;
}>;
/** Owner reads retain the caller's reader, request and identity epoch by identity. */
export type OwnerCurrentPorts = Readonly<{
    readCurrent(kind: DiscoveryOwnerKind, ids: readonly string[], context: DiscoveryReadContext): Promise<ReadonlyMap<string, DiscoveryOwnerMetadataSummary>>;
}>;
export type OwnerDisclosurePorts = OwnerCurrentPorts & Readonly<{
    ownerKey(key: DiscoveryOwnerKey): DiscoveryOwnerKey;
    hydrateAccounts(ids: readonly string[], context: DiscoveryReadContext): Promise<ReadonlyMap<string, AccountDiscoverySummary>>;
    hydrateSubjects(ids: readonly string[], context: DiscoveryReadContext): Promise<ReadonlyMap<string, {
        id: string;
        label?: {
            value: string;
        } | null;
    }>>;
}>;
export { OwnerCurrentRestartRequired } from '../operation-outcomes.ts';
export declare function readOwnerBatches<T>(ids: readonly string[], read: (ids: readonly string[]) => Promise<ReadonlyMap<string, T>>): Promise<Map<string, T>>;
export declare function ownerSummaryUnchanged(kind: DiscoveryOwnerKind, before: DiscoveryOwnerMetadataSummary, after: DiscoveryOwnerMetadataSummary | undefined): boolean;
export declare function revalidateOwnerCurrentSummaries<Candidate>(ports: OwnerCurrentPorts, accepted: readonly (OwnerCurrentAccepted<Candidate> | undefined)[], context: DiscoveryReadContext): Promise<readonly (OwnerCurrentAccepted<Candidate> | undefined)[]>;
export declare function readOwnerCandidates(ports: OwnerDisclosurePorts, candidates: readonly DiscoveryOwnerCandidate[], context: DiscoveryReadContext): Promise<({
    candidate: {
        sourcePosition: string;
        revision: string;
        sourceVersion?: string | null;
        key: DiscoveryOwnerKey;
    };
    kind: "collection" | "review" | "space";
    id: string;
    value: DiscoveryOwnerMetadataSummary;
} | undefined)[]>;
export declare function projectOwnerHits(accepted: readonly (OwnerCurrentAccepted<DiscoveryOwnerCandidate> | undefined)[], accountSummaries: ReadonlyMap<string, AccountDiscoverySummary>, subjectSummaries: ReadonlyMap<string, {
    id: string;
    label?: {
        value: string;
    } | null;
}>): readonly (DiscoveryOwnerHit | undefined)[];
