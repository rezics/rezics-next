import type { ContentAmbient, ContentDeadline, ContentPool, ContentQueryClient } from './vocabulary.ts';
import type { ContentBoardSort, ContentRankSort, ContentReactionKind, ContentRealmVotes } from './bounds.ts';
export type ContentDocumentAvailability = 'available' | 'erased';
export type ContentDocumentReadInput = Readonly<{
    id: string;
    deadline: ContentDeadline;
    maxSourceBytes?: number;
}>;
export type ContentDocumentReadResult = Readonly<{
    availability: ContentDocumentAvailability;
    origin: 'import' | 'account';
    subject: string;
    candidate: string;
}>;
export type ContentDocumentPort = {
    read(client: ContentQueryClient, route: number, id: string, maxSourceBytes?: number): Promise<ContentDocumentReadResult | null>;
};
export type ContentAuthoredFieldInput = Readonly<{
    subject: string;
    candidate: string;
    revision: number;
    language: string;
    document: unknown;
}>;
export type ContentAuthoredFieldPort = {
    erase(id: string, deadline: ContentDeadline): Promise<{
        id: string;
        subject: string;
        authorId: string;
    } | null>;
};
export type ContentBoardCursorKey = Readonly<{
    createdAt: string;
    threadId: string;
}>;
export type ContentBoardRankCursorKey = Readonly<{
    rank: number;
    threadId: string;
}>;
export type ContentBoardCursorBinding = Readonly<{
    boardId: string;
    query: string;
    sort: ContentBoardSort;
    pinRevision: string;
    viewer: {
        kind: 'account';
        accountId: string;
    } | {
        kind: 'anonymous';
    };
}>;
export type ContentRankingCandidate = Readonly<{
    route: number;
    boardId: string;
    threadId: string;
    createdAt: string;
    lastActivityAt: string;
    realmId: string | null;
}>;
export type ContentRankingTotal = Readonly<{
    threadId: string;
    kind: ContentReactionKind;
    count: number;
}>;
export type ContentRankingPort = {
    refreshBatch(pool: ContentPool, at: Date, partitions: readonly number[]): Promise<number>;
    readRealmVotes(client: ContentQueryClient, realmIds: readonly string[]): Promise<ReadonlyMap<string, ContentRealmVotes>>;
};
export type ContentPublicationPort = {
    createThread(deadline: ContentDeadline): Promise<unknown>;
};
export type ContentWorkRegistrationPort = {
    register(context: unknown): Promise<void>;
};
export type ContentEffectPort = {
    effects(pool: ContentPool): readonly unknown[];
};
export type ContentConfigPort = {
    read(env: Readonly<Record<string, string | undefined>>): Readonly<{
        fetchConfig?: {
            readonly allowedHosts: readonly string[];
        };
    }>;
};
export type ContentApplicationPorts = {
    readonly documents: ContentDocumentPort;
    readonly authoredFields: ContentAuthoredFieldPort;
    readonly ranking: ContentRankingPort;
    readonly publication?: ContentPublicationPort;
    readonly work?: ContentWorkRegistrationPort;
    readonly effects?: ContentEffectPort;
    readonly config?: ContentConfigPort;
    readonly ambient: ContentAmbient;
};
export type ContentWorkModule = Readonly<{
    name: string;
    register(context: unknown): Promise<void> | void;
}>;
export type ContentDeclaredEffects = (pool: ContentPool, client: unknown, access: unknown) => readonly unknown[];
export type ContentSurfaceDeclaration = Readonly<{
    name: 'content';
    events: () => Readonly<Record<string, unknown>>;
    operations: readonly unknown[];
    permissions: Iterable<readonly [string, unknown]>;
    work: (ambient: Pick<ContentAmbient, 'fetch' | 'now' | 'id'>) => ContentWorkModule;
    effects: ContentDeclaredEffects;
}>;
export type AdmitDocumentReadInput = Readonly<{
    route: number | null;
    deadline: ContentDeadline;
    now: number;
    maxSourceBytes?: number;
    maxBytes: number;
}>;
export type RankScoreInput = Readonly<{
    score: number;
    activityAt: Date;
    at: Date;
}>;
export type ContentCursorAdmission = Readonly<{
    sort: ContentBoardSort;
    expectedEpoch: number;
}>;
export type ContentRankCursorAdmission = Readonly<{
    sort: ContentRankSort;
    expectedEpoch: number;
}>;
export type ContentHttpRequestContext = Readonly<{
    idempotencyKey?: string | null;
    deadline: ContentDeadline;
    requestId: string;
}>;
export type ContentApplication = {
    readonly ports: ContentApplicationPorts;
    readonly ambient: ContentAmbient;
    elapsed(deadline: ContentDeadline): boolean;
    admitsDocumentRead(route: number | null, deadline: ContentDeadline, maxSourceBytes?: number): boolean;
    activeRank(score: number, activityAt: Date): number;
    refreshRanks(pool: ContentPool, partitions?: readonly number[]): Promise<number>;
    admitAuthoredField(input: ContentAuthoredFieldInput): void;
    nextAuthoredFieldId(): string;
    eraseAuthoredField(id: string, deadline: ContentDeadline): Promise<{
        id: string;
        subject: string;
        authorId: string;
    } | null>;
    normalizeBoardQuery(query: string): string;
    workerStepDeadline(): number;
    workerLongStepDeadline(): number;
    requestContext(deadline: ContentDeadline, idempotencyKey?: string | null): ContentHttpRequestContext;
    createThread(deadline: ContentDeadline): Promise<unknown | null>;
};
