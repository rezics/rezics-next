import type { KeyRing } from '../tokens/seal.ts';
import { type ReleaseGroup, type ReleaseGroupingRequest, type ReleaseGroupingSource } from './release-search-grouping.ts';
export type ReleaseSearchPrincipal = 'anonymous' | `account:${string}`;
export declare class ReleaseSearchCursorInvalid extends Error {
    constructor();
}
/** Public groups retain cards and public identities, with sealed child progress only. */
export type ReleaseSearchGroup<Work, Release> = Extract<ReleaseGroup<Work, Release>, {
    kind: 'release';
}> | (Omit<Extract<ReleaseGroup<Work, Release>, {
    kind: 'work';
}>, 'next'> & {
    next: string | null;
});
export type ReleaseGroupsPage<Work, Release> = {
    status: 'ready' | 'preparing';
    groups: ReleaseSearchGroup<Work, Release>[];
    next: string | null;
};
export type ReleaseChildrenPage<Release> = {
    status: 'ready' | 'preparing';
    children: Release[];
    next: string | null;
};
/** Wraps the grouping policy's private state in the existing viewer-bound, expiring cursor lifecycle. */
export declare function readReleaseGroupsPage<Work, Release>(input: {
    source: ReleaseGroupingSource<Work, Release>;
    request: ReleaseGroupingRequest;
    principal: ReleaseSearchPrincipal;
    cursors: KeyRing;
    cursor?: string;
    now?: number;
}): Promise<ReleaseGroupsPage<Work, Release>>;
/** Child progress has its own request binding and cursor, independent from the group stream. */
export declare function readReleaseChildrenPage<Work, Release>(input: {
    source: ReleaseGroupingSource<Work, Release>;
    request: ReleaseGroupingRequest;
    principal: ReleaseSearchPrincipal;
    work: string;
    cursors: KeyRing;
    cursor?: string;
    now?: number;
}): Promise<ReleaseChildrenPage<Release>>;
