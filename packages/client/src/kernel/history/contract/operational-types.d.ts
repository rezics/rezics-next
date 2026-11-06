declare const registration: unique symbol;
declare const committedOrigin: unique symbol;
export type OperationalEpisode = Readonly<{
    collectionId: string;
    episodeId: string;
}>;
export type OperationalMembersBinding = Readonly<{
    route: number;
    ownerAccountId: string;
    collectionId: string;
    /** Exact NEW reservations; reuse with intent:null never enters this API. */
    episodes: readonly Readonly<OperationalEpisode & {
        reservedIncarnation: string;
        reservedGeneration: string;
        canonicalBasis: string;
        basisDigest: string;
    }>[];
    retired: readonly OperationalEpisode[];
}>;
/** A serializable lookup key, NOT a receipt or evidence that COMMIT happened. */
export type OperationalWorkRegistration = Readonly<{
    partition: number;
    custodyId: string;
    readonly [registration]: true;
}>;
export type OperationalWorkDomain = 'operational-work/v1' | 'legacy-unpositioned';
/** Distinct from the canonical event Stamp. Positions compare ONLY within this domain/partition.
 * Decimal strings preserve the entire positive PostgreSQL bigint range across JSON/SDK ports. */
export type OperationalWorkStamp = Readonly<{
    domain: 'operational-work/v1';
    partition: number;
    epoch: number;
    generation: string;
    position: string;
}>;
export type CommittedOperationalWork = {
    readonly [committedOrigin]: true;
};
declare const transfer: unique symbol;
export type OperationalWorkTransfer = {
    readonly [transfer]: true;
};
export type OperationalWorkPhase = 'resolve' | 'verify' | 'receive' | 'replay' | 'retirement';
declare const selectedEpisode: unique symbol;
export type SelectedLocator = Readonly<{
    route: number;
    ownerAccountId: string;
    collectionId: string;
    episodeId: string;
}>;
export type SelectedOutcome = Readonly<{
    kind: 'complete' | 'continue' | 'failure' | 'obsolete';
    version: string;
    continuation?: string;
}>;
/** Result is durable data for replay. This object itself is usable only inside its original invocation. */
export type SelectedEpisode = Readonly<{
    result: SelectedOutcome | null;
    readonly [selectedEpisode]: true;
}>;
export {};
