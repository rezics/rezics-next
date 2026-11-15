import { createContext, useMemo, type ReactNode } from 'react';
import { FollowControl } from '../../../library/follow-control';
import { setFollow } from '../../../library/follow-actions';
import { refreshFollowing } from '../../../library/mine-following-refresh';
import { useReaderAddress, useReaderCurrentOrigin } from '../../../session/reader';
import { sessionQuery } from '../../../session/query';
import type { Locale } from '../../../paraglide/runtime.js';
import {
  homeFeedViewer,
  type FeedInput,
  type FeedItem,
  type FeedPage,
  type FeedWindow,
  type HomeFeedResult,
} from '../../pages/home-feed-read';
import { homeFeedTitle } from '../../pages/home-feed-destination';

const operations = ['follow.put', 'follow.delete'] as const;
type OwnFollow = { targetType: 'collection' | 'space'; following: boolean; follow: boolean; unfollow: boolean };

function targetType(item: FeedItem) {
  const { destination, key, source, summary } = item;
  if (destination.id !== key.id || summary.id !== key.id || destination.kind !== key.kind) return;
  if (destination.kind === 'space' && source === 'discovery' && key.owner === 'content') return 'space';
  if (
    destination.kind === 'collection' &&
    ((source === 'discovery' && key.owner === 'commerce') || (source === 'following' && key.owner === 'library'))
  )
    return 'collection';
}

/** Accept only a complete batch for the exact disclosed page. The wire may arrive before client republication. */
function ownFollows(page: FeedPage | undefined): ReadonlyMap<string, OwnFollow> | undefined {
  if (!page || !('viewerFollows' in page)) return;
  const value = page.viewerFollows;
  if (!value || typeof value !== 'object' || !('state' in value) || value.state !== 'current' || !('rows' in value))
    return;
  const targets = new Map<string, 'collection' | 'space'>();
  for (const item of page.feedItems) {
    const type = targetType(item);
    if (!type) continue;
    if (targets.has(item.key.id)) return;
    targets.set(item.key.id, type);
  }
  if (!Array.isArray(value.rows) || value.rows.length !== targets.size) return;
  const own = new Map<string, OwnFollow>();
  for (const row of value.rows) {
    if (
      !row ||
      (row.targetType !== 'space' && row.targetType !== 'collection') ||
      targets.get(row.targetId) !== row.targetType ||
      own.has(row.targetId) ||
      typeof row.following !== 'boolean' ||
      typeof row.actions?.follow !== 'boolean' ||
      typeof row.actions?.unfollow !== 'boolean'
    )
      return;
    own.set(row.targetId, {
      targetType: row.targetType,
      following: row.following,
      follow: row.actions.follow,
      unfollow: row.actions.unfollow,
    });
  }
  return own;
}

export const HomeOwnerFollowsContext = createContext<((item: FeedItem) => ReactNode) | undefined>(undefined);

type OwnerFollowsProps = {
  snapshot: FeedWindow;
  reader: string;
  credentialEpoch: string;
  locale: string;
  read: (input: FeedInput, signal: AbortSignal) => Promise<HomeFeedResult>;
  retry: () => void;
  window: { snapshot: () => FeedWindow; subscribe: (listener: () => void) => () => void };
  children: ReactNode;
};

/** A single admission and a single batch for the page. Only deliberate recovery reads the page again. */
export function HomeOwnerFollows({
  snapshot,
  reader,
  credentialEpoch,
  locale,
  read,
  retry,
  window,
  children,
}: OwnerFollowsProps) {
  const address = useReaderAddress(null, undefined, locale);
  const lease = useMemo(
    () => ({ lifetime: {}, isCurrent: () => window.snapshot() === snapshot && !snapshot.busy }),
    [window, snapshot, credentialEpoch],
  );
  const origin = useReaderCurrentOrigin(address.key, operations, null, lease);
  const page = snapshot.result.state === 'ready' ? snapshot.result.page : undefined;
  const rows = useMemo(() => ownFollows(page), [page]);
  const session = origin.client.getQueryState(sessionQuery.queryKey);
  const bound =
    origin.subject === reader &&
    origin.authoritative &&
    !snapshot.busy &&
    session?.fetchStatus === 'idle' &&
    !session.isInvalidated &&
    homeFeedViewer(origin.session)?.scope === credentialEpoch;
  const current = () => {
    const session = origin.client.getQueryState(sessionQuery.queryKey);
    return (
      bound &&
      lease.isCurrent() &&
      address.isCurrent() &&
      origin.boundary.mounted &&
      origin.boundary.active &&
      session?.status === 'success' &&
      session.fetchStatus === 'idle' &&
      !session.isInvalidated &&
      !!session.data &&
      homeFeedViewer(session.data)?.scope === credentialEpoch
    );
  };

  const renderFollow = (item: FeedItem) => {
    const type = targetType(item);
    if (!type) return null;
    const targetId = item.key.id;
    const edge = bound ? rows?.get(targetId) : undefined;
    const canFollow = origin.allowed[0] === true && edge?.follow === true;
    const canRemove = origin.allowed[1] === true && edge?.unfollow === true;
    const isCurrent = (following: boolean) =>
      (following ? canFollow : canRemove) && current() && origin.current(following ? 0 : 1);
    return (
      <FollowControl
        key={origin.boundary.id}
        locale={locale as Locale}
        labelContext={homeFeedTitle(item, locale)}
        targetId={targetId}
        initial={edge ? { state: 'ready', following: edge.following } : { state: 'unavailable' }}
        canFollow={canFollow}
        canRemove={canRemove}
        ready={bound}
        readLifetime={origin.boundary.id}
        isCurrent={isCurrent}
        unavailableOnUnknownWrite
        {...(!edge && bound
          ? {
              onRetry: () => {
                if (current()) retry();
              },
            }
          : {})}
        onReview={async () => {
          if (!current()) return null;
          const controller = new AbortController();
          const unsubscribe = window.subscribe(() => {
            if (!current()) controller.abort();
          });
          try {
            const result = await read(snapshot.input, controller.signal);
            if (!current() || result.state !== 'ready') return null;
            const reviewed = ownFollows(result.page)?.get(targetId);
            return reviewed?.targetType === type ? { state: 'ready', following: reviewed.following } : null;
          } finally {
            unsubscribe();
          }
        }}
        write={(command) => {
          const token = isCurrent(command.following) && origin.credential(command.following ? 0 : 1);
          return token
            ? setFollow({ data: { ...command, expectedReader: reader }, headers: { 'X-CSRF-Token': token } })
            : Promise.resolve({ ok: false, reason: 'unavailable' });
        }}
        onAccepted={(_following, command) => {
          if (!isCurrent(command.following)) return false;
          refreshFollowing(origin.client, reader, false);
          return true;
        }}
      />
    );
  };
  return <HomeOwnerFollowsContext.Provider value={renderFollow}>{children}</HomeOwnerFollowsContext.Provider>;
}
