import type { Pool, PoolClient } from 'pg';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import type { IdentityMapping } from '../semantic/identity-epoch-contract.ts';
export { MAX_VIEWER_FACTS_ROWS, MAX_VIEWER_FACTS_INPUT_BYTES, MAX_VIEWER_FACTS_RESPONSE_BYTES, viewerFactsResponseSchema, } from './viewer-facts-schema.ts';
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
