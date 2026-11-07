/** Community-owned clock, deadline and identity vocabulary. Time and facts arrive as values. */
export type CommunityClock = () => Date;
export type CommunityDeadlineNow = () => number;
export type CommunityDeadline = number;
/** Wall-clock budgets for request and evidence deadlines. Domain time stays a separate clock. */
export type CommunityAmbient = Readonly<{
    deadlineNow: CommunityDeadlineNow;
}>;
export type CommunityQueryResult<T = Record<string, unknown>> = {
    readonly rows: readonly T[];
    readonly rowCount: number;
};
export type CommunityQueryClient = {
    query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<CommunityQueryResult<T>>;
};
export type CommunityPool = {
    connect?(): Promise<CommunityQueryClient>;
};
/** Opaque Access handle. Native adapters cast at the boundary; contract and application never import Access. */
export type CommunityAccess = object;
/** Log event identity. The outbox stores any RFC 4122 version the command executor assigned. */
export declare const COMMUNITY_UUID_PATTERN: RegExp;
/** Routed Space, Realm, Context and media identities. Version 7 or 8, RFC 4122 variant. */
export declare const COMMUNITY_ROUTED_UUID_PATTERN: RegExp;
/** Native log and partition positions, including the empty-head zero. */
export declare const COMMUNITY_LOG_POSITION_PATTERN: RegExp;
export declare const COMMUNITY_UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
export declare const COMMUNITY_ROUTED_UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export declare const COMMUNITY_LOG_POSITION = "^(0|[1-9][0-9]{0,18})$";
export declare function isCommunityUuid(value: unknown): value is string;
export declare function isCommunityRoutedUuid(value: unknown): value is string;
