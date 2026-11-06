/** Finite Kind raw-original input. Values describe work only and never grant Type or catalogue admission. */
import { type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './collection-source.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
export declare const COLLECTION_KIND_INPUT_RAW_LIMIT = 100;
export declare const COLLECTION_KIND_INPUT_BYTE_LIMIT = 4096;
/** One raw original. An exact-limit page is not EOF; the next charged seek establishes exhaustion. */
export declare const COLLECTION_KIND_INPUT_QUANTUM = 1;
export declare function COLLECTION_KIND_INPUT_TERMS(): Readonly<{
    admissionEpisode: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    admissionSource: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    custody: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    state: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    read: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    collisionReads: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    sourceMetadata: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    sourcePage: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    source: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    insert: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    retire: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    admission: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
}>;
export declare function COLLECTION_KIND_PREPARATION_TERMS(): Readonly<{
    scope: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    observation: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    retired: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    clock: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    custody: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
}>;
/** Complete one-attempt sequence: admission, state, two reads, source observations, insert fence, retirement. */
export declare function COLLECTION_KIND_INPUT_COST(): Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
export declare function COLLECTION_KIND_PREPARATION_OBSERVATION(): Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
export declare function COLLECTION_KIND_PREPARATION_RETIREMENT(): Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
export declare const COLLECTION_KIND_INPUT_PATHS: Readonly<{
    quantum: 1;
    rawCeiling: 100;
    envelopeBytes: 4096;
    escapedBodyMultiplier: 6;
    collisionReads: 2;
    predecessorRetirements: 1;
    custodyStatements: 7;
    nativeAttempts: 3;
}>;
export declare function COLLECTION_KIND_INPUT_DECLARATION(): Readonly<{
    status: 'complete';
    axes: readonly ["candidateKeys", "nativeRows", "identityMetadataRows", "emptySeeks", "nativePoints", "witnessKeys", "statements", "bytes", "engineRequests"];
    cost: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    terms: Readonly<{
        admissionEpisode: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        admissionSource: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        custody: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        state: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        read: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        collisionReads: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        sourceMetadata: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        sourcePage: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        source: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        insert: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        retire: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        admission: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    }>;
    paths: Readonly<{
        quantum: 1;
        rawCeiling: 100;
        envelopeBytes: 4096;
        escapedBodyMultiplier: 6;
        collisionReads: 2;
        predecessorRetirements: 1;
        custodyStatements: 7;
        nativeAttempts: 3;
    }>;
}>;
/** Adapter edge for the existing eight-axis native observer. Kind input declares zero engine requests. */
export declare function collectionKindInputWorkDimensions(bound: Bound): WorkDimensions;
export declare function collectionKindInputWork(): WorkDimensions;
export declare function collectionKindInputAdmissionWork(): WorkDimensions;
export declare function collectionKindInputRemaining(work: NativeCollectionWork): Bound;
export declare function collectionKindInputAdmitted(work: NativeCollectionWork, bound?: Bound): boolean;
/** One named Bound, one reserve. SQL identity is not looked up again at the receipt boundary. */
export declare function invokeCollectionKindInput<T>(work: NativeCollectionWork, bound: Bound, run: () => Promise<T>): Promise<T>;
