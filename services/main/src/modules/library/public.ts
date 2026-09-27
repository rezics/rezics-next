import { iri } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork, WorkReadMoved,
  WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readAgent, shelfWorks } from '../profiles/read.ts';
import type { ReaderLibraryStatusStore, ReadingStatus, StatusState } from './status.ts';

export const PUBLIC_SHELF_COST = { candidates: 240, disclosureBatch: 24,
  disclosureQueries: 10, summaryBatches: 2, pageSize: 20 } as const;

async function projection(session: WorkReadSession, agent: string, store: ReaderLibraryStatusStore) {
  await readAgent(session, agent);
  const owner = session.deps.profiles;
  if (!owner) throw new WorkReadUnavailable('Profile owner unavailable');
  const visibility = await owner.visibility.read(agent);
  if (visibility.visibility !== 'public') throw new WorkReadMissing('Shelf unavailable');
  const agentFence = await owner.agentFence(agent);
  const statusFence = await store.fence(agent);
  const candidates = await store.publicCandidates(agent);
  const published = new Set<string>();
  for (let offset = 0; offset < candidates.length; offset += PUBLIC_SHELF_COST.disclosureBatch) {
    const batch = candidates.slice(offset, offset + PUBLIC_SHELF_COST.disclosureBatch);
    const rows = await session.query(`SELECT DISTINCT ?id WHERE {
      VALUES ?id { ${batch.map(row => iri(row.work)).join(' ')} }
      ${publicWork('?id', '?main')}
    } LIMIT ${PUBLIC_SHELF_COST.disclosureBatch + 1}`, PUBLIC_SHELF_COST.disclosureBatch + 1);
    for (const row of rows) if (row.id?.value) published.add(row.id.value);
  }
  const visible = candidates.filter(row => published.has(row.work));
  const counts = (['want-to-read', 'reading', 'read'] as const).map(status => {
    const items = visible.filter(item => item.status === status);
    return { status, count: items.length, changedAt: items[0]?.changedAt ?? null };
  });
  if (await store.fence(agent) !== statusFence || await owner.agentFence(agent) !== agentFence
    || (await owner.visibility.read(agent)).version !== visibility.version) {
    throw new WorkReadMoved('Public shelf changed');
  }
  return { visible, counts, fence: `${statusFence}:${visibility.version}`,
    statusFence, visibilityVersion: visibility.version, agentFence };
}

/** Work publication is checked for every candidate before either IDs or counts leave the server.
 * A 240-row ceiling makes exact counts explicit; larger shelves fail closed. */
export async function readPublicShelves(session: WorkReadSession, agent: string,
  store: ReaderLibraryStatusStore) {
  const result = await projection(session, agent, store);
  return { profile: 'agent-status-shelves-v1' as const, agent,
    statusShelves: result.counts, sourcePosition: session.position };
}

export async function readPublicStatusShelf(session: WorkReadSession, agent: string,
  store: ReaderLibraryStatusStore, status: ReadingStatus) {
  const result = await projection(session, agent, store);
  const binding = ['agent-status-shelf-v1', agent, status];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  if (cursor && cursor.order !== result.fence) throw new WorkReadMoved('Public shelf changed');
  const entries: StatusState[] = result.visible.filter(item => item.status === status);
  const start = cursor ? entries.findIndex(item => item.work === cursor.after) + 1 : 0;
  if (cursor && !start) throw new WorkReadMoved('Public shelf changed');
  const limit = session.options.limit ?? 20;
  const page = entries.slice(start, start + limit);
  const cards = await shelfWorks(session, page.map(item => item.work));
  if (cards.size !== page.length) throw new WorkReadMoved('Work disclosure changed');
  const owner = session.deps.profiles;
  const final = await owner?.visibility.read(agent);
  if (final?.visibility !== 'public' || final.version !== result.visibilityVersion
    || await store.fence(agent) !== result.statusFence
    || await owner?.agentFence(agent) !== result.agentFence) {
    throw new WorkReadMoved('Public shelf changed');
  }
  return { profile: 'agent-status-shelf-v1' as const, agent, status,
    statusCount: entries.length,
    ...pageResult(session, page.map(item => ({ work: item.work, card: cards.get(item.work)! })),
      start + limit < entries.length
        ? encodeReadCursor(binding, session.position, page.at(-1)!.work, result.fence) : null) };
}
