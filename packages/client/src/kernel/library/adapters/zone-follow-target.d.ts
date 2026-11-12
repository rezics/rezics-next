import type { LibraryActor } from '../contract/index.ts';
import type { NativeFollowTargetAdapter } from '../contract/index.ts';
/** The producer supplies only the current public Zone shell, after native read authorization. */
export type FollowableZone = Readonly<{
    id: string;
    revision: string;
    visibility: 'public' | 'unlisted' | 'private';
    label: string;
}>;
export type ReadFollowableZone = (actor: LibraryActor, id: string, deadline: number) => Promise<FollowableZone | null>;
/** One current owner read per observation, plus a final read before FULL disclosure. */
export declare function createZoneFollowTargetAdapter(read: ReadFollowableZone): NativeFollowTargetAdapter;
