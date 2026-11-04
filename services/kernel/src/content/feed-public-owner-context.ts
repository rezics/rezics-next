import type { CollectionCurator } from '../library/collection-discovery-context.ts';
import type { AccountDiscoverySummary } from '../search/discovery.ts';
import { routeOf } from '../route/route.ts';
import type { FeedItem } from './feed-contract.ts';

export const FEED_PUBLIC_OWNER_PAGE_LIMIT = 20;

type FeedCollectionItem = Extract<FeedItem, { destination: { kind: 'collection' } }>;
type FeedFollowingCollectionItem = Extract<FeedItem, { source: 'following'; destination: { kind: 'collection' } }>;
type FeedPublicOwnerCoverage = Readonly<{ discovery: number; following: number }>;
type FeedPublicOwnerContext = Readonly<{
  curators: ReadonlyMap<FeedCollectionItem, CollectionCurator>;
  coverage: FeedPublicOwnerCoverage;
  items: readonly FeedItem[];
}>;

const curatorAccountIds = new WeakMap<FeedFollowingCollectionItem, string | null>();

function exactCollectionItem(item: FeedItem): item is FeedCollectionItem {
  if (
    item.destination.kind !== 'collection' ||
    item.key.kind !== 'collection' ||
    item.key.id !== item.destination.id ||
    item.key.route !== routeOf(item.key.id) ||
    !('id' in item.summary) ||
    !('title' in item.summary) ||
    item.summary.id !== item.key.id ||
    item.destination.title !== item.summary.title
  )
    return false;
  return (
    (item.source === 'discovery' && item.key.owner === 'commerce') ||
    (item.source === 'following' && item.key.owner === 'library')
  );
}

function followingCollectionItem(item: FeedItem): item is FeedFollowingCollectionItem {
  return item.source === 'following' && exactCollectionItem(item);
}

/** Keep Library's private owner operand attached to this exact occurrence, never in the Feed DTO. */
export function retainFeedCollectionCurator(item: FeedFollowingCollectionItem, curatorAccountId: string | null) {
  curatorAccountIds.set(item, curatorAccountId);
  return item;
}

/** Include the private Library owner operand in native currentness without serializing it to the reader. */
export function feedPublicOwnerWitness(item: FeedItem): string {
  if (followingCollectionItem(item) && curatorAccountIds.has(item))
    return JSON.stringify([item, curatorAccountIds.get(item)]);
  return JSON.stringify(item);
}

export function hasFeedPublicOwnerItems(items: readonly FeedItem[]): boolean {
  return items.some(exactCollectionItem);
}

export type FeedPublicOwnerAccountReader = (
  ids: readonly string[],
) => Promise<ReadonlyMap<string, AccountDiscoverySummary | null>>;

export async function prepareFeedPublicOwnerContext(
  items: readonly FeedItem[],
  readAccounts: FeedPublicOwnerAccountReader,
): Promise<Omit<FeedPublicOwnerContext, 'items'>> {
  if (items.length > FEED_PUBLIC_OWNER_PAGE_LIMIT)
    throw new RangeError('Feed public-owner context exceeds the selected page bound');

  const curators = new Map<FeedCollectionItem, CollectionCurator>();
  const following: Array<{ item: FeedFollowingCollectionItem; id: string }> = [];
  let discovery = 0;
  let followingCount = 0;
  for (const item of items) {
    if (!exactCollectionItem(item)) continue;
    if (item.source === 'discovery') {
      discovery++;
      curators.set(item, item.summary.curator);
      continue;
    }
    followingCount++;
    if (!followingCollectionItem(item) || !curatorAccountIds.has(item)) {
      curators.set(item, { state: 'unavailable', reason: 'native_projection' });
      continue;
    }
    const id = curatorAccountIds.get(item);
    if (id === null) {
      curators.set(item, { state: 'unavailable', reason: 'deidentified' });
      continue;
    }
    if (id === undefined || routeOf(id) === null) {
      curators.set(item, { state: 'unavailable', reason: 'native_projection' });
      continue;
    }
    following.push({ item, id });
  }

  const selectedIds = [...new Set(following.map(({ id }) => id))];
  let accounts: ReadonlyMap<string, AccountDiscoverySummary | null> = new Map();
  let accountsAvailable = true;
  if (selectedIds.length) {
    try {
      accounts = await readAccounts(selectedIds);
    } catch {
      // Curator context is optional. The native Collection row and its lane remain admitted.
      accountsAvailable = false;
    }
  }
  for (const { item, id } of following) {
    if (!accountsAvailable) {
      curators.set(item, { state: 'unavailable', reason: 'native_projection' });
      continue;
    }
    const account = accounts.get(id);
    if (!account || account.id !== id) {
      curators.set(item, { state: 'unavailable', reason: 'withheld' });
      continue;
    }
    const handle = account.handle && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(account.handle) ? account.handle : null;
    curators.set(item, {
      state: 'available',
      id,
      label: (account.displayName || (handle ? `@${handle}` : null))?.slice(0, 160) ?? null,
      destination: handle ? `/@${handle}` : null,
    });
  }
  return { curators, coverage: { discovery, following: followingCount } };
}

export async function finalizeFeedPublicOwnerContext(
  items: readonly FeedItem[],
  readAccounts: FeedPublicOwnerAccountReader,
  finalAdmission: () => Promise<readonly FeedItem[]>,
): Promise<FeedPublicOwnerContext> {
  const prepared = await prepareFeedPublicOwnerContext(items, readAccounts);
  const admitted = await finalAdmission();
  for (const item of admitted) {
    if (!exactCollectionItem(item)) continue;
    const curator = prepared.curators.get(item);
    if (curator) item.summary = { ...item.summary, curator };
  }
  return { ...prepared, items: admitted };
}
