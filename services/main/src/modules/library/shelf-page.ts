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

/** The public lower bound counts only delivered cards. Its encrypted continuation
 * binds that count to the candidate keyset and the graph/owner source fences. */
export function shelfPageBasis(session: WorkReadSession, agent: string,
  status: ReadingStatus, options: ShelfOptions,
  fence: string, publishedOnly: boolean) {
  const sort = options.sort ?? 'added', order = options.order ?? (sort === 'title' ? 'asc' : 'desc');
  if (sort === 'finished' && status !== 'read') throw new WorkReadInvalid('Finished sort requires the read shelf');
  const binding = [publishedOnly ? 'agent-status-shelf-v4' : 'reader-status-shelf-v3', agent, status, sort, order,
    publishedOnly ? [session.principal?.issuer ?? null, session.principal?.subject ?? null,
      session.options.actingSubject ?? null, session.viewer] : null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  let after: ShelfAfter | undefined;
  let statusCount: number | undefined;
  if (cursor) {
    let value: unknown;
    try { value = JSON.parse(cursor.order); } catch { throw new WorkReadInvalid('Invalid shelf cursor'); }
    if (!Array.isArray(value) || value.length !== (publishedOnly ? 3 : 2) || typeof value[0] !== 'string'
      || value[1] !== null && typeof value[1] !== 'string'
      || publishedOnly && (!Number.isSafeInteger(value[2]) || value[2] < 0)) throw new WorkReadInvalid('Invalid shelf cursor');
    if (value[0] !== fence) throw new WorkReadMoved('Status shelf changed');
    after = { work: cursor.after, value: value[1] as string | null };
    if (publishedOnly) statusCount = value[2] as number;
  }
  return { binding, sort, order, after, statusCount };
}

/** Public refill examines at most two batches, advancing over invisible rows.
 * An empty page can have a continuation: callers must follow the cursor, rather
 * than treating a bounded candidate window as the end of the shelf. */
export async function readShelfPage(session: WorkReadSession, agent: string,
  store: ReaderLibraryStatusStore, status: ReadingStatus, options: ShelfOptions,
  fence: string, publishedOnly: boolean) {
  const basis = shelfPageBasis(session, agent, status, options, fence, publishedOnly);
  const { binding, sort, order } = basis;
  let after = basis.after;
  const limit = session.options.limit ?? STATUS_SHELF_COST.pageSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > STATUS_SHELF_COST.pageSize) {
    throw new WorkReadInvalid('Invalid shelf page size');
  }
  const items: Array<Omit<ShelfRow, 'sortValue'> & { card: (Awaited<ReturnType<typeof shelfWorks>> extends Map<string, infer T> ? T : never) | null }> = [];
  let last: ShelfAfter | undefined;
  let hasMore = false;
  for (let batch = 0; batch < STATUS_SHELF_COST.candidateBatches; batch++) {
    session.checkDeadline();
    const rows = await store.sortedPage(agent, status, STATUS_SHELF_COST.candidateBatch, sort, order, after);
    if (!rows.length) break;
    const published = publishedOnly ? await publishedWorks(session, rows.map(row => row.work)) : null;
    const cards = await shelfWorks(session, rows.filter(row => !published || published.has(row.work)).map(row => row.work));
    for (const row of rows) {
      const card = cards.get(row.work) ?? null;
      if (publishedOnly && !card) { last = { work: row.work, value: row.sortValue }; continue; }
      if (items.length === limit) { hasMore = true; break; }
      const { sortValue, ...state } = row;
      items.push({ ...state, card });
      last = { work: row.work, value: sortValue };
    }
    if (hasMore || rows.length < STATUS_SHELF_COST.candidateBatch) break;
    const tail = rows.at(-1)!;
    after = { work: tail.work, value: tail.sortValue };
    // A full final candidate batch may have a successor, even when none of its
    // cards can be shown. The next bounded read resolves that uncertainty.
    if (batch + 1 === STATUS_SHELF_COST.candidateBatches) hasMore = true;
  }
  const statusCount = (basis.statusCount ?? 0) + items.length;
  return { ...pageResult(session, items, hasMore
    ? encodeReadCursor(binding, session.position, last!.work,
      JSON.stringify(publishedOnly ? [fence, last!.value, statusCount] : [fence, last!.value])) : null),
    ...(publishedOnly ? { statusCount, statusCountKind: hasMore ? 'lower-bound' as const : 'exact' as const } : {}) };
}
