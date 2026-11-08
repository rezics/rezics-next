import { type Bound } from '@rezics/bounds';
/** Selected Members Source declarations use the shared finite work dimensions. */
export declare function MEMBERS_PREPARATION_SOURCE_AXES(): readonly ["candidateKeys", "nativeRows", "identityMetadataRows", "emptySeeks", "nativePoints", "witnessKeys", "statements", "bytes", "engineRequests"];
export type MembersPreparationSourceCost = Bound;
export declare function MEMBERS_PREPARATION_SOURCE_PATHS(): Readonly<{
    id: Readonly<{
        definitionGetters: 15;
        membersSnapshots: 8;
        orderCurrentnessReads: 4;
        sourcePrepare: 1;
        sourcePrefix: 1;
        evaluatedSubjects: 1;
        candidatePrefixMaximum: 2;
        sourceSeekQueriesMaximum: 2;
        sourceGroupQueriesMaximum: 2;
        sourceGroupRowsPerQueryMaximum: number;
        closurePasses: 2;
        distinctGroupQueries: 1;
        terminalQueriesPerClosureMaximum: 49;
        factQueriesPerClosureMaximum: 50;
        ownerFactReadsPerClosureMaximum: 98;
        pinnedReleaseReadsPerClosureMaximum: 98;
        ownerCandidateReads: 2;
    }>;
    ordinal: Readonly<{
        definitionGetters: 11;
        membersSnapshots: 4;
        orderCurrentnessReads: 2;
        sourcePrepare: 1;
        ordinalPrefix: 1;
        rawOrdinalRowsMaximum: 1;
        terminalQueriesBeforeEvaluationMaximum: 1;
        distinctGroupQueries: 1;
        earliestOrdinalProbesMaximum: 99;
        evaluatedSubjectsMaximum: 1;
        closurePasses: 2;
        terminalQueriesPerClosureMaximum: 49;
        factQueriesPerClosureMaximum: 50;
        ownerFactReadsPerClosureMaximum: 98;
        pinnedReleaseReadsPerClosureMaximum: 98;
        ownerCandidateReads: 2;
    }>;
    common: Readonly<{
        initialStepRead: 1;
        releasedOperationalTransaction: 1;
        searchPreparationReleaseReads: 1;
        preparationScopeReads: 2;
        ownerFenceReads: 2;
        sourceTransactionFinish: Readonly<{
            commit: 1;
            rollback: 1;
            mutuallyExclusive: true;
        }>;
        failureAssociation: 1;
        failureWrite: 1;
        restartDrain: 1;
        restartReset: 1;
        restartRepair: 1;
    }>;
}>;
export declare function MEMBERS_PREPARATION_SOURCE_TERMS(): Readonly<{
    metadataPrefix: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    searchBody: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    collectionState: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    collectionPrefix: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    sourceTransaction: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
}>;
export declare function MEMBERS_PREPARATION_SOURCE_COST(): Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
export declare function MEMBERS_PREPARATION_SOURCE_DECLARATION(): Readonly<{
    status: 'complete';
    axes: readonly ["candidateKeys", "nativeRows", "identityMetadataRows", "emptySeeks", "nativePoints", "witnessKeys", "statements", "bytes", "engineRequests"];
    cost: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    terms: Readonly<{
        metadataPrefix: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        searchBody: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        collectionState: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        collectionPrefix: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        sourceTransaction: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    }>;
    paths: Readonly<{
        id: Readonly<{
            definitionGetters: 15;
            membersSnapshots: 8;
            orderCurrentnessReads: 4;
            sourcePrepare: 1;
            sourcePrefix: 1;
            evaluatedSubjects: 1;
            candidatePrefixMaximum: 2;
            sourceSeekQueriesMaximum: 2;
            sourceGroupQueriesMaximum: 2;
            sourceGroupRowsPerQueryMaximum: number;
            closurePasses: 2;
            distinctGroupQueries: 1;
            terminalQueriesPerClosureMaximum: 49;
            factQueriesPerClosureMaximum: 50;
            ownerFactReadsPerClosureMaximum: 98;
            pinnedReleaseReadsPerClosureMaximum: 98;
            ownerCandidateReads: 2;
        }>;
        ordinal: Readonly<{
            definitionGetters: 11;
            membersSnapshots: 4;
            orderCurrentnessReads: 2;
            sourcePrepare: 1;
            ordinalPrefix: 1;
            rawOrdinalRowsMaximum: 1;
            terminalQueriesBeforeEvaluationMaximum: 1;
            distinctGroupQueries: 1;
            earliestOrdinalProbesMaximum: 99;
            evaluatedSubjectsMaximum: 1;
            closurePasses: 2;
            terminalQueriesPerClosureMaximum: 49;
            factQueriesPerClosureMaximum: 50;
            ownerFactReadsPerClosureMaximum: 98;
            pinnedReleaseReadsPerClosureMaximum: 98;
            ownerCandidateReads: 2;
        }>;
        common: Readonly<{
            initialStepRead: 1;
            releasedOperationalTransaction: 1;
            searchPreparationReleaseReads: 1;
            preparationScopeReads: 2;
            ownerFenceReads: 2;
            sourceTransactionFinish: Readonly<{
                commit: 1;
                rollback: 1;
                mutuallyExclusive: true;
            }>;
            failureAssociation: 1;
            failureWrite: 1;
            restartDrain: 1;
            restartReset: 1;
            restartRepair: 1;
        }>;
    }>;
}>;
