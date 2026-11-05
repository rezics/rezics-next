import type { AnchoredPosition, ReadContext } from './model.ts';
import { type ContentReadDependencies, type NativeDraftMetadata, type PostEntry } from './reads.ts';
export type OwnDraftActions = Readonly<{
    resume: string;
    edit: string | null;
    publish: string | null;
    erase: string | null;
}>;
export type OwnDraftEntry = NativeDraftMetadata & Readonly<{
    language: string | null;
    actions: OwnDraftActions;
}>;
export type OwnDraftInput = Readonly<{
    cursor?: string;
    limit?: number;
}>;
export type OwnDraftPage = Readonly<{
    state: 'ready' | 'preparing';
    entries: readonly OwnDraftEntry[];
    nextCursor: string | null;
    viewer: {
        accountId: string;
        authnEpoch: number;
    };
    anchors: readonly AnchoredPosition[];
}>;
/** One actor-home partial range, raw <=20. Withheld/stale candidates consume
 * their slots; failure throws without publishing a continuation past that slot.
 */
export declare function listOwnDrafts(deps: ContentReadDependencies, accountId: string, context: ReadContext, input?: OwnDraftInput): Promise<OwnDraftPage>;
/** Exact selection uses native body/revision disclosure after private and Subject
 * admission. The existing If-Match save/publish and own-erase commands own writes.
 */
export declare function resumeOwnDraft(deps: ContentReadDependencies, accountId: string, threadId: string, postId: string, context: ReadContext): Promise<Readonly<{
    value: PostEntry | null;
    anchor: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>;
}>>;
