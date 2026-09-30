import { WorkReadMoved, WorkReadMissing, WorkReadInvalid, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readAgent, shelfWorks } from '../profiles/read.ts';
import { publishedWorks, readShelfPage, shelfPageBasis, type ShelfOptions } from './shelf-page.ts';
import { STATUS_SHELF_COST, type ReaderLibraryStatusStore, type ReadingStatus, type ShelfSort } from './status.ts';

export const PUBLIC_SHELF_COST = { candidateBatch: STATUS_SHELF_COST.candidateBatch,
  countBatch: STATUS_SHELF_COST.countBatch, pageSize: STATUS_SHELF_COST.pageSize,
  countScan: 'first page only, all candidates within the shared read deadline' } as const;

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

/** No SQL-only count may disclose unpublished Works. Scan bounded keyset batches
 * to completion, or fail explicitly on the shared deadline; there is no row cap. */
async function publishedCount(session: WorkReadSession, agent: string,
  store: ReaderLibraryStatusStore, status: ReadingStatus) {
  let after, count = 0, changedAt: string | null = null;
  while (true) {
    session.checkDeadline();
    const rows = await store.sortedPage(agent, status, PUBLIC_SHELF_COST.countBatch, 'added', 'desc', after);
    if (!rows.length) break;
    const published = await publishedWorks(session, rows.map(row => row.work));
    const cards = await shelfWorks(session, rows.filter(row => published.has(row.work)).map(row => row.work));
    for (const row of rows) if (cards.has(row.work)) { count++; changedAt ??= row.changedAt; }
    if (rows.length < PUBLIC_SHELF_COST.countBatch) break;
    const tail = rows.at(-1)!;
    after = { work: tail.work, value: tail.sortValue };
  }
  return { status, count, changedAt };
}

export async function readPublicShelves(session: WorkReadSession, agent: string, store: ReaderLibraryStatusStore) {
  const before = await projection(session, agent, store);
  const statusShelves = [];
  for (const status of ['want-to-read', 'reading', 'read'] as const) {
    statusShelves.push(await publishedCount(session, agent, store, status));
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
  const fence = `${before.statusFence}:${before.visibilityVersion}:${before.agentFence}`;
  const basis = shelfPageBasis(session, agent, status, options, fence, true);
  const statusCount = basis.statusCount ?? (await publishedCount(session, agent, store, status)).count;
  const page = await readShelfPage(session, agent, store, status, options,
    fence, true, statusCount);
  await fenceProjection(session, agent, store, before);
  return { profile: 'agent-status-shelf-v1' as const, agent, status, statusCount,
    ...page, items: page.items.map(item => ({ work: item.work, card: item.card! })) };
}
