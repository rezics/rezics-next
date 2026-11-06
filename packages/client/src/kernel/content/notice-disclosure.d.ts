import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
export type NoticeCandidate = Readonly<{
    notice_id: string;
    kind: 'reply' | 'mention' | 'thread_watch' | 'board_activity' | 'moderation_decision';
    created_at: Date | string;
    created_at_key: string;
    source_id: string | null;
    actor_id: string | null;
    thread_id: string | null;
    post_id: string | null;
    decision_id: string | null;
    report_id: string | null;
    unread: boolean;
}>;
import { type NoticeActor } from './notice-actor-context.ts';
export type { NoticeActor } from './notice-actor-context.ts';
export type NoticeTarget = Readonly<{
    state: 'available' | 'withheld';
    threadId: string | null;
    postId: string | null;
    boardId: string | null;
    threadTitle: string | null;
    boardTitle: string | null;
}>;
export type NoticeOpenAction = Readonly<{
    kind: 'board';
    boardId: string;
}> | Readonly<{
    kind: 'thread';
    threadId: string;
}> | Readonly<{
    kind: 'thread_post';
    threadId: string;
    postId: string;
}> | Readonly<{
    kind: 'moderation_decision';
    decisionId: string;
}> | Readonly<{
    kind: 'report_outcome';
    reportId: string;
}> | null;
export type NoticeProjection = Readonly<{
    actor: NoticeActor;
    actorId: string | null;
    target: NoticeTarget;
    summary: string;
    open: NoticeOpenAction;
    decisionId: string | null;
    reportId: string | null;
}>;
export type NoticeDisclosureDependencies = Readonly<{
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    routeKey: Uint8Array;
    clock: () => Date;
    actor: Actor;
    deadline: number;
}>;
/** Applies the closed, current per-kind disclosure table to one bounded candidate range. */
export declare function discloseNoticeCandidates(dependencies: NoticeDisclosureDependencies, accountId: string, candidates: readonly NoticeCandidate[], options?: Readonly<{
    includeActors?: boolean;
    actorLimit?: number;
}>): Promise<ReadonlyMap<string, NoticeProjection>>;
