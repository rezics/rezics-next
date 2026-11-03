import type { CommandTransaction } from '../command/command.ts';
import type { AccountReference, HistoryLocator } from './locator.ts';
import { type HistoryArtifactType } from './contracts.ts';
import type { HistoryReceivingContext } from './receiving.ts';
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
    readiness(tx: CommandTransaction, artifact: HistoryArtifact, barrier: HistoryBarrier, context?: HistoryReceivingContext): Promise<HistoryReadiness>;
}>;
/** Required producer families, independently of which ones happen to have artifacts today. */
export declare const HISTORY_PRODUCER_FAMILIES: readonly ["access", "commerce", "community", "content", "library", "rating", "semantic", "zones", "imports"];
export type HistoryProducerFamily = (typeof HISTORY_PRODUCER_FAMILIES)[number];
/** The owner's complete current AND former native producer inventory. This declaration does
 * not enroll historical data. Each configured home needs separate native source enrollment. */
export type HistoryFamilySource = Readonly<{
    artifactType: HistoryArtifactType;
    producer: string;
    version: number;
}>;
export type HistoryFamilyDefinition = Readonly<{
    family: HistoryProducerFamily;
    version: number;
    sources: readonly HistoryFamilySource[];
    digest: string;
}>;
/** Native producer namespaces with unambiguous ownership. Other names require the owner's
 * explicit manifest; they never acquire a Semantic family merely by elimination. */
export declare function nativeHistoryProducerFamily(producer: string): HistoryProducerFamily | undefined;
/** A registration is an owner declaration of conversion, never an absence proof. Local sealed
 * prefixes, native consumers and Auth completion are checked separately by the receiving runtime. */
export declare class HistoryRegistry {
    private readonly owners;
    private readonly coverage;
    private readonly families;
    private closed;
    registerOwner(owner: HistoryOwner): void;
    registerCoverage(family: HistoryProducerFamily, types: readonly HistoryArtifactType[]): void;
    owner(type: HistoryArtifactType, name: string): HistoryOwner | undefined;
    registerFamilySources(family: HistoryProducerFamily, version: number, sources: readonly HistoryFamilySource[]): void;
    familyDefinitions(): readonly HistoryFamilyDefinition[];
    gaps(): readonly string[];
    familyGaps(family: HistoryProducerFamily): readonly string[];
    /** Stable across registration order; a changed owner/version/coverage invalidates old progress. */
    digest(): string;
    seal(): void;
}
