import { type FeedItem, type FeedLane, type FeedLaneCandidate, type FeedPosition, type FeedSourceState, type FeedStream } from '../contract/index.ts';
export declare function feedCandidateBound(discovery: number, following: number, continued: boolean): number;
export declare function feedLaneWidths(input: Readonly<{
    stream: FeedStream;
    personal: boolean;
    limit: number;
}>): Readonly<{
    discovery: number;
    following: number;
    continued: boolean;
}>;
export declare function admitFeedCandidateReservation(input: Readonly<{
    discovery: number;
    following: number;
    continued: boolean;
    spaceSelected: boolean;
}>): number;
export declare function canonicalFeedObject(item: FeedItem): string;
export declare function initialFeedPosition(input: Readonly<{
    stream: FeedStream;
    personal: boolean;
    boundary: string;
}>): FeedPosition;
export declare function initialFeedSources(input: Readonly<{
    stream: FeedStream;
    personal: boolean;
}>): Readonly<{
    discovery: FeedSourceState;
    following: FeedSourceState;
    continue: FeedSourceState;
}>;
export declare function rejectFeedKindMismatches(lanes: Record<FeedLane, FeedLaneCandidate[]>, kind: string | undefined): Record<FeedLane, FeedLaneCandidate[]>;
export declare function mergeFeedLanes(input: Readonly<{
    lanes: Record<FeedLane, readonly FeedLaneCandidate[]>;
    turn: number;
    limit: number;
}>): Readonly<{
    items: FeedItem[];
    offsets: Record<FeedLane, number>;
    turn: number;
}>;
export declare function advanceFeedFrontier(input: Readonly<{
    position: FeedPosition;
    lanes: Record<FeedLane, readonly FeedLaneCandidate[]>;
    offsets: Record<FeedLane, number>;
    turn: number;
    continueFingerprint: string;
}>): FeedPosition;
export declare function rewindFeedLanes(items: FeedItem[], affected: ReadonlySet<FeedLane>): FeedItem[];
export declare function feedHasReadyFrontier(next: FeedPosition, sources: Readonly<{
    discovery: FeedSourceState;
    following: FeedSourceState;
    continue: FeedSourceState;
}>): boolean;
export declare function admitFeedPageLimit(limit: number | undefined): number;
export declare function isDiscoveryReview(item: FeedItem): item is Extract<FeedItem, {
    source: 'discovery';
    key: {
        owner: 'content';
        kind: 'review';
    };
}>;
export declare function isFollowingThread(item: FeedItem): item is Extract<FeedItem, {
    source: 'following';
    key: {
        owner: 'content';
        kind: 'thread';
    };
}>;
export declare function isFollowingPost(item: FeedItem): item is Extract<FeedItem, {
    source: 'following';
    key: {
        owner: 'content';
        kind: 'post';
    };
}>;
