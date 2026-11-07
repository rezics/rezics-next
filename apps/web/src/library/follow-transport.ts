import type { KernelClient } from '@rezics/client';

/**
 * Eden types `follows` as a callable point client intersected with collection GET.
 * List recovery always uses the handle's `get`; point read/write always call the
 * function with `{ targetId }` so a list binding cannot steal a private edge.
 */
type FollowsHandle = KernelClient['follows'];
export type FollowsPointClient = ReturnType<FollowsHandle>;
export type FollowsListGet = FollowsHandle extends { get: infer Get } ? Get : never;

type ListCall = Awaited<ReturnType<FollowsListGet>>;
type PointGetCall = Awaited<ReturnType<FollowsPointClient['get']>>;
type PointPutCall = Awaited<ReturnType<FollowsPointClient['put']>>;
type PointDeleteCall = Awaited<ReturnType<FollowsPointClient['delete']>>;

export type FollowListQuery = NonNullable<Parameters<FollowsListGet>[0]>['query'];
/** The overloaded `/follows` handle also exposes its point GET; select the page arm explicitly. */
export type FollowListPage = Extract<NonNullable<ListCall['data']>, { follows: readonly unknown[] }>;
export type FollowEdge = FollowListPage['follows'][number];
export type FollowPointPage = NonNullable<PointGetCall['data']>;
export type FollowWritePage = NonNullable<PointPutCall['data']> | NonNullable<PointDeleteCall['data']>;
export type FollowTargetType = FollowEdge['targetType'];
export type FollowView = NonNullable<NonNullable<FollowListQuery>['view']>;

export type FollowWriteHeaders = {
  authorization: string;
  'idempotency-key': string;
};

const noStore = { cache: 'no-store' as const, redirect: 'manual' as const };

/** The collection handle, never `follows({ targetId })`. */
export function followsList(client: KernelClient): FollowsHandle {
  return client.follows;
}

/** The callable point client for one own-edge identity. */
export function followsPoint(client: KernelClient, targetId: string): FollowsPointClient {
  return client.follows({ targetId });
}

export function followWriteHeaders(authorization: string, idempotencyKey: string): FollowWriteHeaders {
  return { authorization, 'idempotency-key': idempotencyKey };
}

export function followListQuery(
  cursor?: string,
  limit = 20,
  targetType?: FollowTargetType,
): NonNullable<FollowListQuery> {
  return {
    view: 'FULL',
    limit,
    ...(cursor === undefined ? {} : { cursor }),
    ...(targetType === undefined ? {} : { targetType }),
  };
}

export function getFollowList(
  client: KernelClient,
  authorization: string,
  query: NonNullable<FollowListQuery>,
): Promise<ListCall> {
  return followsList(client).get({
    query,
    headers: { authorization },
    fetch: noStore,
  });
}

export function getFollowPoint(
  client: KernelClient,
  targetId: string,
  authorization: string,
  view: FollowView = 'BASIC',
): Promise<PointGetCall> {
  return followsPoint(client, targetId).get({
    query: { view },
    headers: { authorization },
    fetch: noStore,
  });
}

export function putFollow(client: KernelClient, targetId: string, headers: FollowWriteHeaders): Promise<PointPutCall> {
  return followsPoint(client, targetId).put(null, { headers });
}

export function deleteFollow(
  client: KernelClient,
  targetId: string,
  headers: FollowWriteHeaders,
): Promise<PointDeleteCall> {
  return followsPoint(client, targetId).delete(undefined, { headers });
}

export function followStateOf(
  page: FollowPointPage | FollowWritePage | null | undefined,
  targetId: string,
): 'following' | 'unfollowed' | null {
  const follow = page?.follow;
  if (
    !follow ||
    (follow.targetId !== undefined && follow.targetId !== targetId) ||
    (follow.state !== 'following' && follow.state !== 'unfollowed')
  )
    return null;
  return follow.state;
}
