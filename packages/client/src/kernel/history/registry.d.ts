import type { CommandTransaction } from '../command/command.ts';
import type { AccountReference, HistoryLocator } from './locator.ts';
import { type HistoryArtifactType } from './contracts.ts';
export type HistoryBarrier = Readonly<{
    accountId: string;
    accountRoute: number;
    version: number;
    at: string;
}>;
export type HistoryArtifact = Readonly<{
    partition: number;
    locator: HistoryLocator;
    accounts: readonly AccountReference[];
}>;
export type HistoryReadiness = Readonly<{
    ready: true;
}> | Readonly<{
    ready: false;
    gap: string;
}>;
export type HistoryOwner = Readonly<{
    name: string;
    artifactType: HistoryArtifactType;
    version: 1;
    /** Reads exact native consumer obligations in the source transaction. Never a workflow-status test. */
    readiness(tx: CommandTransaction, artifact: HistoryArtifact, barrier: HistoryBarrier): Promise<HistoryReadiness>;
}>;
/** Required producer families, independently of which ones happen to have artifacts today. */
export declare const HISTORY_PRODUCER_FAMILIES: readonly ["access", "commerce", "community", "content", "library", "rating", "semantic", "zones", "imports"];
export type HistoryProducerFamily = (typeof HISTORY_PRODUCER_FAMILIES)[number];
/** A registration is an owner declaration of conversion, never an absence proof. Local sealed
 * prefixes, native consumers and Auth completion are checked separately by the receiving runtime. */
export declare class HistoryRegistry {
    private readonly owners;
    private readonly coverage;
    private closed;
    registerOwner(owner: HistoryOwner): void;
    registerCoverage(family: HistoryProducerFamily, types: readonly HistoryArtifactType[]): void;
    owner(type: HistoryArtifactType, name: string): HistoryOwner | undefined;
    gaps(): readonly string[];
    familyGaps(family: HistoryProducerFamily): readonly string[];
    /** Stable across registration order; a changed owner/version/coverage invalidates old progress. */
    digest(): string;
    seal(): void;
}
