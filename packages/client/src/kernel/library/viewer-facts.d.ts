import type { Pool, PoolClient } from 'pg';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import type { IdentityMapping } from '../semantic/identity-epoch-contract.ts';
export declare const MAX_VIEWER_FACTS_ROWS = 100;
export declare const MAX_VIEWER_FACTS_INPUT_BYTES = 16384;
export declare const MAX_VIEWER_FACTS_RESPONSE_BYTES = 65536;
export declare const VIEWER_FACTS_SCOPE = "library_entry:read";
type Dependencies = {
    pool: Pool;
    access: Access;
};
export type ViewerFactInput = Readonly<{
    rowKey: string;
    subjectId: string;
}>;
export type ViewerQuestion = Readonly<{
    id: string;
    revision: number;
    grain: string;
    scale: Readonly<{
        min: number;
        max: number;
        displayStep: number;
    }>;
    meaning: string;
}>;
export type ViewerEntryFact = Readonly<{
    state: 'present';
    incarnationId: string | null;
    entryState: string | null;
    revision: number;
}> | Readonly<{
    state: 'absent';
}> | Readonly<{
    state: 'unavailable';
    reason: 'scope';
}>;
export type ViewerVoteFact = Readonly<{
    state: 'present';
    questionId: string;
    questionRevision: number;
    units: number;
    revision: number;
}> | Readonly<{
    state: 'absent';
    questionId: string;
    questionRevision: number;
}> | Readonly<{
    state: 'unavailable';
    reason: 'scope' | 'question';
}>;
export type ViewerFact = Readonly<{
    rowKey: string;
    subjectId: string;
    entry: ViewerEntryFact;
    vote: ViewerVoteFact;
}>;
export type ViewerFactsPage = Readonly<{
    state: 'current';
    question: ViewerQuestion | null;
    rows: readonly ViewerFact[];
}> | Readonly<{
    state: 'unavailable';
    reason: 'identity' | 'currentness' | 'response_limit';
    retryable: boolean;
}>;
/** Wire type for admitted Library and Collection rows; unavailable authority remains explicit and value-free. */
export declare const viewerFactsResponseSchema: import("typebox").TUnion<[import("typebox").TObject<{
    state: import("typebox").TLiteral<"current">;
    question: import("typebox").TUnion<[import("typebox").TObject<{
        id: import("typebox").TString;
        revision: import("typebox").TInteger;
        grain: import("typebox").TString;
        scale: import("typebox").TObject<{
            min: import("typebox").TInteger;
            max: import("typebox").TInteger;
            displayStep: import("typebox").TInteger;
        }>;
        meaning: import("typebox").TString;
    }>, import("typebox").TNull]>;
    rows: import("typebox").TArray<import("typebox").TObject<{
        rowKey: import("typebox").TString;
        subjectId: import("typebox").TString;
        entry: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"present">;
            incarnationId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            entryState: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            revision: import("typebox").TInteger;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"absent">;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
            reason: import("typebox").TLiteral<"scope">;
        }>]>;
        vote: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"present">;
            questionId: import("typebox").TString;
            questionRevision: import("typebox").TInteger;
            units: import("typebox").TInteger;
            revision: import("typebox").TInteger;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"absent">;
            questionId: import("typebox").TString;
            questionRevision: import("typebox").TInteger;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
            reason: import("typebox").TUnion<[import("typebox").TLiteral<"scope">, import("typebox").TLiteral<"question">]>;
        }>]>;
    }>>;
}>, import("typebox").TObject<{
    state: import("typebox").TLiteral<"unavailable">;
    reason: import("typebox").TUnion<[import("typebox").TLiteral<"identity">, import("typebox").TLiteral<"currentness">, import("typebox").TLiteral<"response_limit">]>;
    retryable: import("typebox").TBoolean;
}>]>;
type MappingRecord = Readonly<{
    subjectId: string;
    mapping: IdentityMapping;
}>;
export type PreparedViewerFacts = Readonly<{
    accountId: string;
    actorIdentity: string;
    questionId: string;
    question: ViewerQuestion | null;
    mappings: readonly MappingRecord[];
    rows: readonly ViewerFactInput[];
    canReadEntries: boolean;
    canReadVotes: boolean;
}>;
/** Capture bounded Content identity and question meaning before the consumer checks out its read client. */
export declare function prepareViewerFacts(dependencies: Dependencies, actor: Actor, inputRows: readonly ViewerFactInput[], questionId: string, deadline: number): Promise<PreparedViewerFacts>;
/** Read all private facts on the consumer's already-owned repeatable-read client. */
export declare function readViewerFacts(client: Pick<PoolClient, 'query'>, actor: AccountActor, prepared: PreparedViewerFacts): Promise<ViewerFactsPage>;
/** Recheck every authority term after the caller releases its account-home snapshot. */
export declare function viewerFactsCurrent(dependencies: Dependencies, actor: Actor, prepared: PreparedViewerFacts, deadline: number): Promise<boolean>;
/** Convenience for Library and Collection consumers; Search can use the staged API above. */
export declare function readViewerFactsPage(dependencies: Dependencies, actor: Actor, rows: readonly ViewerFactInput[], questionId: string, deadline: number): Promise<ViewerFactsPage>;
export {};
