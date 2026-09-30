import { shelfWorks } from '../profiles/read.ts';
import { iri } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork, WorkReadInvalid,
  WorkReadMoved, type WorkReadSession } from '../work/read-session.ts';
import { STATUS_SHELF_COST, type ReaderLibraryStatusStore, type ReadingStatus,
  type ShelfAfter, type ShelfOrder, type ShelfRow, type ShelfSort } from './status.ts';

export interface ShelfOptions { sort?: ShelfSort; order?: ShelfOrder }

/** Only published Work identities can leave a public shelf, including its count. */
export async function publishedWorks(session: WorkReadSession, works: string[]) {
  if (!works.length) return new Set<string>();
  const rows = await session.query(`SELECT DISTINCT ?id WHERE {
    VALUES ?id { ${works.map(iri).join(' ')} } ${publicWork('?id', '?main')}
  } LIMIT ${works.length + 1}`, works.length);
  return new Set(rows.map(row => row.id!.value));
}

/** SQL reads stay page-sized. A missing card advances the candidate keyset,
 * never ending traversal; exhausting the read budget fails the whole request.
 * Each continuation is fenced against every status/sort-key write. */
export async function readShelfPage(session: WorkReadSession, agent: string,
  store: ReaderLibraryStatusStore, status: ReadingStatus, options: ShelfOptions,
  fence: string, publishedOnly: boolean) {
  const sort = options.sort ?? 'added', order = options.order ?? (sort === 'title' ? 'asc' : 'desc');
  if (sort === 'finished' && status !== 'read') throw new WorkReadInvalid('Finished sort requires the read shelf');
  const binding = [publishedOnly ? 'agent-status-shelf-v2' : 'reader-status-shelf-v2', agent, status, sort, order];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  let after: ShelfAfter | undefined;
  if (cursor) {
    let value: unknown;
    try { value = JSON.parse(cursor.order); } catch { throw new WorkReadInvalid('Invalid shelf cursor'); }
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string'
      || value[1] !== null && typeof value[1] !== 'string') throw new WorkReadInvalid('Invalid shelf cursor');
    if (value[0] !== fence) throw new WorkReadMoved('Status shelf changed');
    after = { work: cursor.after, value: value[1] as string | null };
  }
  const limit = session.options.limit ?? STATUS_SHELF_COST.pageSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > STATUS_SHELF_COST.pageSize) {
    throw new WorkReadInvalid('Invalid shelf page size');
  }
  const items: Array<Omit<ShelfRow, 'sortValue'> & { card: NonNullable<Awaited<ReturnType<typeof shelfWorks>> extends Map<string, infer T> ? T : never> }> = [];
  let last: ShelfAfter | undefined;
  let hasMore = false;
  while (true) {
    session.checkDeadline();
    const rows = await store.sortedPage(agent, status, STATUS_SHELF_COST.candidateBatch, sort, order, after);
    if (!rows.length) break;
    const published = publishedOnly ? await publishedWorks(session, rows.map(row => row.work)) : null;
    const cards = await shelfWorks(session, rows.filter(row => !published || published.has(row.work)).map(row => row.work));
    for (const row of rows) {
      const card = cards.get(row.work);
      if (!card) continue;
      if (items.length === limit) { hasMore = true; break; }
      const { sortValue, ...state } = row;
      items.push({ ...state, card });
      last = { work: row.work, value: sortValue };
    }
    if (hasMore || rows.length < STATUS_SHELF_COST.candidateBatch) break;
    const tail = rows.at(-1)!;
    after = { work: tail.work, value: tail.sortValue };
  }
  return pageResult(session, items, hasMore
    ? encodeReadCursor(binding, session.position, last!.work, JSON.stringify([fence, last!.value])) : null);
}
