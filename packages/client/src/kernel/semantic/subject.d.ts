import { type SelectedSynopsisInput, type SelectedSynopsisResult } from './selected-synopsis.ts';
import { type ReviewedPersonEndpoint, type ReviewedPersonSource } from './reviewed-person-identity.ts';
import { type SubjectSummary, type SummaryDependencies } from './summaries.ts';
import type { Source } from '@rezics/definitions/bulk';
import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import type { AccessCheck, AccountActor, Resource } from '../request/access.ts';
import { type AgentSelfSource as CandidateAgentSelfSource } from './fences.ts';
import { type Item } from './item.ts';
export { writeFacts } from './write-facts.ts';
export declare const CREATE_SUBJECT = "subject.create";
/** Retries reach the partition holding their receipt while each attempt gets a new subject id. */
export declare function subjectTarget(routeKey: Uint8Array, accountId: string, idempotencyKey: string): Resource;
export declare class SubjectAccessDeniedError extends Error {
    constructor();
}
export type SubjectComponent = {
    partition: number;
    epoch: number;
    position: bigint;
};
export type CreateSubjectResult = {
    subject: Item;
    component: SubjectComponent;
    replayed: boolean;
};
export type AgentSelfSource = CandidateAgentSelfSource;
export declare function createSubject(pool: Pool, options: {
    actor: AccountActor;
    target: Resource;
    idempotencyKey: string;
    digest: Uint8Array;
    item: unknown;
    release: {
        digest: string;
        release: Release;
    };
    authorize?: AccessCheck;
    authorization?: CommandAuthorization;
    deadline?: number;
    clock?: () => Date;
}): Promise<CreateSubjectResult>;
/** The same creation work for individual writes and imported records. */
export declare function writeSubject(tx: CommandTransaction, transactionId: string, options: Pick<Parameters<typeof createSubject>[1], 'target' | 'item' | 'release'> & {
    source?: Source | AgentSelfSource;
    routeKey?: Uint8Array;
}): Promise<{
    value: Item;
    events: {
        type: string;
        subject: string;
        data: unknown;
    }[];
}>;
export declare function readSubject(pool: Pool, id: string, authorize: (client: PoolClient) => Promise<boolean>, context: string | undefined, routeKey: Uint8Array, summaries?: {
    reviewIdentity?: ReviewedPersonSource;
    selectedSynopsis?: {
        input: SelectedSynopsisInput;
        admit: () => Promise<boolean>;
    };
    languages?: readonly string[];
    authorize?: SummaryDependencies['authorize'];
    seen?: readonly {
        partition: number;
        epoch: number;
        position: bigint;
    }[];
    deadline?: number;
    prepareAuthorization?: () => Promise<AccessCheck>;
    prepareAuthorize?: (id: string) => Promise<AccessCheck>;
    readAs?: <T>(read: () => Promise<T>) => Promise<T>;
}): Promise<{
    selectedSynopsis?: SelectedSynopsisResult;
    reviewedIdentity?: ReviewedPersonEndpoint | null;
    subject: Item;
    account: {
        id: string;
    } | null;
    summary: SubjectSummary | null;
    component: SubjectComponent;
} | null>;
type Queryable = Pick<PoolClient, 'query'>;
export type ItemTypeDetails = {
    type: string;
    agentAccountId: string | null;
    agentVerified: boolean;
};
export declare function accountSource(tx: CommandTransaction, statementSubjects: readonly string[]): AgentSelfSource | null;
export declare function assertAgentStatementAccess(tx: CommandTransaction, ids: readonly string[], details: ReadonlyMap<string, ItemTypeDetails>): void;
/** Item targets of one write, one primary-key probe per id and one statement per partition. */
export declare function readItemDetails(client: Queryable, ids: readonly string[]): Promise<Map<string, ItemTypeDetails>>;
export declare function readItemTypes(client: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
export declare function readLabels(pool: Pool | CommandTransaction, ids: readonly string[]): Promise<Map<string, Item['labels']>>;
/** Chosen-label inputs use one statement per partition, including the original-language slot. */
export declare function readLabelChoices(pool: Pool, ids: readonly string[]): Promise<Map<string, {
    labels: Item['labels'];
    original: string | null;
}>>;
export type RelatedState = {
    id: string;
    visibility: string;
    security_revision: string;
    redirect: string | null;
    labels: Item['labels'];
};
/** Loads current related state; callers may reuse it only within their bounded read episode. */
export declare function loadRelated(client: object, ids: readonly string[]): Promise<Map<string, RelatedState>>;
/** Labels of the requested ids, following one redirect, from this related-read episode. */
export declare function readRelated(db: Pool | PoolClient, ids: readonly string[]): Promise<Record<string, {
    labels: Item['labels'];
    redirect?: string;
}>>;
/** Identity writers share this command so every outbound projection follows label and type changes. */
export declare function updateSubjectIdentity(pool: Pool, options: {
    subject: string;
    labels?: Record<string, string>;
    type?: string;
    release: {
        digest: string;
        release: Release;
    };
    authorize: AccessCheck;
    deadline?: number;
    clock?: () => Date;
}): Promise<import("../command/command.ts").CommandOutcome<{
    revision: number;
}>>;
