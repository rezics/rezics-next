import { WorkReadMoved, WorkReadMissing, WorkReadInvalid, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readAgent } from '../profiles/read.ts';
import { readShelfPage, type ShelfOptions } from './shelf-page.ts';
import { STATUS_SHELF_COST, type ReaderLibraryStatusStore, type ReadingStatus, type ShelfSort } from './status.ts';

export const PUBLIC_SHELF_COST = { candidateBatch: STATUS_SHELF_COST.candidateBatch,
  candidateBatches: STATUS_SHELF_COST.candidateBatches, pageSize: STATUS_SHELF_COST.pageSize,
  summaryShelves: 3, countScan: 'delivered cards only; resumable with the page cursor' } as const;

async function projection(session: WorkReadSession, agent: string, store: ReaderLibraryStatusStore, sort: ShelfSort = 'added') {
  await readAgent(session, agent);
  const owner = session.deps.profiles;
  if (!owner) throw new WorkReadUnavailable('Profile owner unavailable');
  const visibility = await owner.visibility.read(agent);
  if (visibility.visibility !== 'public') throw new WorkReadMissing('Shelf unavailable');
  return { sort, statusFence: await store.fence(agent, sort), visibilityVersion: visibility.version,
    agentFence: await owner.agentFence(agent) };
}

async function fenceProjection(session: WorkReadSession, agent: string, store: ReaderLibraryStatusStore,
  before: Awaited<ReturnType<typeof projection>>) {
  const owner = session.deps.profiles;
  const final = await owner?.visibility.read(agent);
  if (final?.visibility !== 'public' || final.version !== before.visibilityVersion
    || await store.fence(agent, before.sort) !== before.statusFence || await owner?.agentFence(agent) !== before.agentFence) {
    throw new WorkReadMoved('Public shelf changed');
  }
}

const projectionFence = (before: Awaited<ReturnType<typeof projection>>) =>
  `${before.statusFence}:${before.visibilityVersion}:${before.agentFence}`;

export async function readPublicShelves(session: WorkReadSession, agent: string, store: ReaderLibraryStatusStore) {
  const before = await projection(session, agent, store);
  const statusShelves = [];
  // Reuse the visible traversal instead of introducing a count projection that
  // would need invalidation for publication, names and audience policy changes.
  for (const status of ['want-to-read', 'reading', 'read'] as const) {
    const page = await readShelfPage(session, agent, store, status, {}, projectionFence(before), true);
    statusShelves.push({ status, count: page.statusCount!, countKind: page.statusCountKind!,
      changedAt: page.items[0]?.changedAt ?? null, nextCursor: page.nextCursor });
  }
  await fenceProjection(session, agent, store, before);
  return { profile: 'agent-status-shelves-v1' as const, agent, statusShelves, sourcePosition: session.position };
}

export async function readPublicStatusShelf(session: WorkReadSession, agent: string,
  store: ReaderLibraryStatusStore, status: ReadingStatus, options: ShelfOptions = {}) {
  // Sharing current shelf membership does not publish private rating or reading history.
  if (options.sort && !['added', 'title'].includes(options.sort)) {
    throw new WorkReadInvalid('This sort is private to the reader');
  }
  const before = await projection(session, agent, store, options.sort);
  const fence = projectionFence(before);
  const page = await readShelfPage(session, agent, store, status, options,
    fence, true);
  await fenceProjection(session, agent, store, before);
  return { profile: 'agent-status-shelf-v1' as const, agent, status,
    ...page, items: page.items.map(item => ({ work: item.work, card: item.card! })) };
}
