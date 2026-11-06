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

export const COMMUNITY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCommunityUuid(value: unknown): value is string {
  return typeof value === 'string' && COMMUNITY_UUID_PATTERN.test(value);
}
