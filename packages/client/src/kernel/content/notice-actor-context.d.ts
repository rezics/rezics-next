import type { Pool } from 'pg';
import type { Static } from 'typebox';
import type { AvatarSummarySchema } from './schemas.ts';
export type NoticeActor = Readonly<{
    state: 'available';
    accountId: string;
    displayName: string;
    handle: string | null;
    avatar: Static<typeof AvatarSummarySchema>;
    /** Retained transport field; stored profile URLs are never admitted. */
    avatarUrl: null;
    automated: boolean;
}> | Readonly<{
    state: 'withheld';
    displayName: 'Former or unavailable account';
    handle: null;
    avatar: null;
    avatarUrl: null;
}> | Readonly<{
    state: 'system';
    displayName: 'Moderation team';
    handle: null;
    avatar: null;
    avatarUrl: null;
}>;
export declare function unavailableNoticeActor(): NoticeActor;
/** Two identical bounded Account observations surround Content's admitted Media read. */
export declare function readNoticeActors(pool: Pool, ids: readonly string[], deadline: number): Promise<ReadonlyMap<string, NoticeActor>>;
