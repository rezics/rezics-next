/** Content-owned actor, clock and identity vocabulary. Time, IDs and facts arrive as values. */

export type ContentAccountActor = {
  readonly kind: 'account';
  readonly accountId: string;
};

export type ContentAnonymousActor = { readonly kind: 'anonymous' };

export type ContentActor = ContentAccountActor | ContentAnonymousActor;

export type ContentClock = () => Date;

export type ContentNow = () => number;

export type ContentIdFactory = () => string;

export type ContentFetch = (request: Request) => Promise<Response>;

/** Wall-clock budgets and domain time are distinct operands of the same ambient. */
export type ContentAmbient = Readonly<{
  clock: ContentClock;
  now: ContentNow;
  id: ContentIdFactory;
  fetch: ContentFetch;
}>;

export type ContentDeadline = number;

export type ContentResourceRef = {
  readonly route: number;
  readonly id: string;
};

export type ContentQueryResult<T = Record<string, unknown>> = {
  readonly rows: readonly T[];
  readonly rowCount: number;
};

export type ContentQueryClient = {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<ContentQueryResult<T>>;
};

export type ContentPool = {
  connect?(): Promise<ContentQueryClient>;
};

export const CONTENT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isContentUuid(value: unknown): value is string {
  return typeof value === 'string' && CONTENT_UUID_PATTERN.test(value);
}

export const CONTENT_UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;
