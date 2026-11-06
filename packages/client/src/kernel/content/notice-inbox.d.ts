import type { Pool } from 'pg';
import { type Access, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type NoticeActor, type NoticeCandidate, type NoticeOpenAction, type NoticeTarget } from './notice-disclosure.ts';
export type InboxDependencies = Readonly<{
    pool: Pool;
    tokens: KeyRing;
    access: Access;
    actor: Actor;
    routeKey: Uint8Array;
    deadline?: number;
    now: () => Date;
}>;
export declare const INBOX_SELECTIONS: readonly ['all', 'unread'];
export type InboxSelection = (typeof INBOX_SELECTIONS)[number];
export declare const DEFAULT_INBOX_SELECTION: InboxSelection;
export type InboxItem = Readonly<{
    id: string;
    kind: NoticeCandidate['kind'];
    createdAt: string;
    actorId: string | null;
    actor: NoticeActor;
    threadId: string | null;
    postId: string | null;
    decisionId: string | null;
    reportId: string | null;
    target: NoticeTarget;
    summary: string;
    actions: Readonly<{
        open: NoticeOpenAction;
        markSeen: Readonly<{
            method: 'POST';
            path: string;
        }>;
    }>;
    unread: boolean;
}>;
export type InboxNoticeDetail = Readonly<{
    viewer: Readonly<{
        state: 'current';
    }>;
    notice: InboxItem;
}>;
export type InboxPageMarkSeen = Readonly<{
    method: 'POST';
    path: string;
    through: string;
}>;
export type InboxListPage = Readonly<{
    items: InboxItem[];
    next: string | null;
    viewer: Readonly<{
        accountId: string;
    }>;
    selection: InboxSelection;
    actions: Readonly<{
        markSeen: InboxPageMarkSeen | null;
    }>;
}>;
export type UnreadNoticeSummary = Readonly<{
    count: number;
    capped: boolean;
    basis: 'current-visible-unread' | 'current-visible-lower-bound';
    witness: Readonly<{
        kind: 'current-disclosure';
        at: string;
    }>;
}>;
export declare const INBOX_CANDIDATE_FACTOR = 4;
export declare const INBOX_CANDIDATE_SCAN_CEILING = 200;
export declare function inboxCandidateScanLimit(pageSize: number): number;
export declare class InvalidInboxCursorError extends Error {
}
export declare class InboxViewerUnavailableError extends Error {
}
/** Recheck account status, authn epoch and account:read after source hydration. */
export declare function assertCurrentInboxViewer(dependencies: InboxDependencies, accountId: string): Promise<void>;
export declare function listNoticeInbox(dependencies: InboxDependencies, accountId: string, input: {
    limit: number;
    cursor?: string;
    selection?: InboxSelection;
}): Promise<InboxListPage>;
/** Read one owned identity without scanning the rolling page or changing its read state. */
export declare function readNoticeInboxItem(dependencies: InboxDependencies, accountId: string, noticeId: string): Promise<InboxNoticeDetail>;
export declare function countUnreadNotices(dependencies: InboxDependencies, accountId: string): Promise<UnreadNoticeSummary>;
export declare function markNoticesSeen(pool: Pool, accountId: string, noticeId: string, at?: Date): Promise<void>;
/** Exact one-item acknowledgement, independent from the monotonic bulk frontier. */
export declare function acknowledgeNotice(pool: Pool, accountId: string, noticeId: string, at?: Date): Promise<void>;
