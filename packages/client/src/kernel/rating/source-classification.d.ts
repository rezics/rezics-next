import type { RatingCapabilities } from './contract/capabilities.ts';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type Access, type Actor } from '../request/access.ts';
import { type ClassificationAssociation, type ClassificationObservation, type ClassificationClear, type ImmutableClassificationObservation, type SourceClassificationRead } from './source-classification-contract.ts';
/** Reuses the existing bulk/governance authority. It grants no native ballot or public fence access. */
export declare const SOURCE_CLASSIFICATION_WRITE_ACTION = "source_statistic:write";
export type SourceClassificationConfig = {
    pool: Pool;
    access: Access;
    routeKey: Uint8Array;
    capabilities?: RatingCapabilities;
    clock?: KernelClock;
};
type CommonCommand = {
    actor: Actor;
    association: ClassificationAssociation;
    expectedObservation: string | null;
    idempotencyKey: string;
    deadline: number;
};
export type PutSourceClassification = CommonCommand & {
    value: ClassificationObservation;
};
export type ClearSourceClassification = CommonCommand & {
    value: ClassificationClear;
};
export type ReadSourceClassificationBatch = {
    actor: Actor;
    subjectId: string;
    associations: readonly ClassificationAssociation[];
    limit: number;
    deadline: number;
};
export type SourceClassificationMutation = {
    observationDigest: string;
    state: 'published' | 'cleared';
};
/** An identical immutable payload is already satisfied. Every other change requires
 * explicit CAS; even correct CAS cannot let an older observation replace a tombstone.
 */
export declare function admitClassificationObservation(next: ImmutableClassificationObservation, current: ImmutableClassificationObservation | null, expectedObservation: string | null): 'identical' | 'changed';
/** The producer consumes admitted aggregate observations. It never fetches a provider,
 * creates an external voter, or reads/writes native ballot or enjoyment tables.
 */
export declare function createSourceClassificationProducer(config: SourceClassificationConfig): {
    put: (input: PutSourceClassification) => Promise<{
        value: {
            observationDigest: string;
            state: 'published' | 'cleared';
            figure: Readonly<{
                provider: 'vndb';
                association: ClassificationAssociation;
                observation: {
                    digest: string;
                    sourceVersion: ClassificationObservation['sourceVersion'];
                };
                sourceAlias: string;
                sourceRecordId: string;
                sourceAssociationId: string;
                confidence: {
                    state: 'available';
                    value: number;
                    unit: 'vndb-tag-rating';
                    minExclusive: 0;
                    max: 3;
                } | {
                    state: 'unavailable';
                    reason: 'not_supplied';
                };
                lie: {
                    state: 'available';
                    value: boolean;
                    unit: 'boolean';
                } | {
                    state: 'unavailable';
                    reason: 'not_supplied';
                };
                confidenceCount?: number;
                lieCount?: number;
                asOf: string;
                ageSeconds: number;
                attribution: string;
                licence: string;
            }>;
        };
        partition: number;
        epoch: number;
        position: bigint;
        transactionId: string;
        replayed: boolean;
    }>;
    clear: (input: ClearSourceClassification) => Promise<import("../command/command.ts").CommandOutcome<SourceClassificationMutation>>;
    readExact: (input: Omit<ReadSourceClassificationBatch, 'associations' | 'limit'> & {
        association: ClassificationAssociation;
    }) => Promise<SourceClassificationRead>;
    readBatch: (input: ReadSourceClassificationBatch) => Promise<readonly SourceClassificationRead[]>;
};
export type SourceClassificationProducer = ReturnType<typeof createSourceClassificationProducer>;
export {};
