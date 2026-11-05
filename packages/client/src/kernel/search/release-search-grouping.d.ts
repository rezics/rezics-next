import type { FilterDocument } from '@rezics/filter';
import type { CalendarPhysicalIdentity } from './release-search-calendar.ts';
/** Complete current Global evidence, after the owner has checked each target and its canonical work. */
export type CurrentWorkLinkValue = {
    kind: 'work';
    id: string;
} | {
    kind: 'none' | 'unknown' | 'unavailable';
};
export type ReleaseWorkLink = {
    kind: 'linked';
    work: string;
} | {
    kind: 'missing' | 'unknown' | 'conflicting' | 'unavailable' | 'unproven';
};
/** A sampled relation preview cannot establish ownership, including when it contains just one work. */
export declare function releaseWorkLink(complete: boolean, values: readonly CurrentWorkLinkValue[]): ReleaseWorkLink;
export type ReleaseGroupingRequest = Readonly<{
    releaseDigest: string;
    /** Already admitted through buildReleaseSearchFilter and the active released catalogue. */
    filter: FilterDocument;
    text?: string;
    sort: 'name' | 'relevance';
    languages: readonly string[];
    spoilerThreshold: 0 | 1 | 2;
    properties?: readonly string[];
    groupLimit: number;
    childLimit: number;
    previewLimit: number;
}>;
export type ReleaseGroupingBasis = Readonly<{
    releaseDigest: string;
    physical: CalendarPhysicalIdentity;
    /** Includes disclosure, canonical redirects, dates, credits and grouping/order changes in every source pool. */
    epoch: string;
    /** Ready population evidence for this physical identity, never mapping compatibility alone. */
    calendarReadyFor: CalendarPhysicalIdentity | null;
}>;
type GroupCandidate = {
    kind: 'work' | 'release';
    id: string;
};
type NativePage<Key> = {
    keys: Key[];
    after: string;
    exhausted: boolean;
};
/** Minimal native seam. No implementation may derive these streams from finite hit/fact previews.
 * The group stream has distinct canonical works and individually ungroupable releases, in request order.
 * Both streams seek all required pools, accept at most `size` keys, and prove EOF explicitly.
 * Hydration omits invisible/nonmatching keys and checks current facts against the entire request,
 * including same-statement qualifiers, dates and producers. Cards include only the existing current
 * viewer state and permitted actions. Every method must honor the invocation's native work reservation;
 * the logical counters below are not measurements or substitutes for native accounting.
 */
export interface ReleaseGroupingSource<Work, Release> {
    observe(): Promise<ReleaseGroupingBasis>;
    groups(request: ReleaseGroupingRequest, after: string | null, size: number): Promise<NativePage<GroupCandidate>>;
    children(request: ReleaseGroupingRequest, work: string, after: string | null, size: number): Promise<NativePage<string>>;
    works(request: ReleaseGroupingRequest, ids: readonly string[]): Promise<ReadonlyMap<string, Work>>;
    releases(request: ReleaseGroupingRequest, ids: readonly string[]): Promise<ReadonlyMap<string, {
        card: Release;
        link: ReleaseWorkLink;
    }>>;
}
/** Private continuation payloads. HTTP integration must authenticate and encrypt them, bind the viewer,
 * and enforce expiry before calling this reader. They must never be serialized as public JSON cursors.
 */
type Continuation = {
    version: 1;
    binding: string;
    basis: ReleaseGroupingBasis;
    after: string | null;
};
export type ReleaseChildContinuation = Continuation & {
    work: string;
};
export type ReleaseGroupContinuation = Continuation & {
    pending?: {
        id: string;
        after: string | null;
    };
};
export type ReleaseGroup<Work, Release> = {
    kind: 'work';
    id: string;
    work: Work;
    releases: Release[];
    next: ReleaseChildContinuation | null;
} | {
    kind: 'release';
    id: string;
    release: Release;
    workLink: Exclude<ReleaseWorkLink['kind'], 'linked'>;
};
export declare class ReleaseGroupingUnavailable extends Error {
    constructor();
}
export declare class ReleaseGroupingRestartRequired extends Error {
    constructor();
}
export declare const RELEASE_GROUPING_LIMITS: Readonly<{
    groups: 20;
    children: 20;
    preview: 3;
    keys: 256;
    seeks: 64;
}>;
type Usage = {
    keys: number;
    seeks: number;
};
type Window<Value, Cursor> = {
    status: 'ready' | 'preparing';
    values: Value[];
    next: Cursor | null;
    usage: Usage;
};
/** Independent child paging. Only a complete native stream can end a group. */
export declare function readReleaseChildren<Work, Release>(source: ReleaseGroupingSource<Work, Release>, submitted: ReleaseGroupingRequest, work: string, continuation?: ReleaseChildContinuation): Promise<Window<Release, ReleaseChildContinuation>>;
/** Group and child progress are independent. A high-fanout work may prepare across bounded invocations. */
export declare function readReleaseGroups<Work, Release>(source: ReleaseGroupingSource<Work, Release>, submitted: ReleaseGroupingRequest, continuation?: ReleaseGroupContinuation): Promise<Window<ReleaseGroup<Work, Release>, ReleaseGroupContinuation>>;
export {};
