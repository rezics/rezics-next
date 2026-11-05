import { routeOf } from '../route/route.ts';
import { ShelfReadUnavailableError } from './shelf-reader-unavailable.ts';
import {
  isShelfEntryState,
  MAX_SHELF_PAGE_SIZE,
  type ShelfDirection,
  type ShelfPriorityReader,
  type ShelfPriorityRows,
} from './shelf-contract.ts';
import ascPage from './entry-priority-page-asc.sql';
import descPage from './entry-priority-page-desc.sql';

const RANK = /^(?:[1-9]|[1-9][0-9]|100)$/;

export function validShelfPriorityKey(key: string): boolean {
  return key === '' || RANK.test(key);
}

function createReader(direction: ShelfDirection): ShelfPriorityReader {
  const statement = direction === 'asc' ? ascPage : descPage;
  return {
    async page(client, route, accountId, query, after) {
      if (
        query.orderBy !== 'priority' ||
        query.direction !== direction ||
        !Number.isInteger(route) ||
        route < 0 ||
        route > 65535 ||
        routeOf(accountId) !== route ||
        (query.state !== null && !isShelfEntryState(query.state)) ||
        (query.typeId !== null && (typeof query.typeId !== 'string' || routeOf(query.typeId) !== route))
      )
        throw new TypeError('Invalid priority shelf query');
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_SHELF_PAGE_SIZE)
        throw new RangeError('Invalid shelf page limit');
      if (
        after !== null &&
        (!validShelfPriorityKey(after.key) || typeof after.subjectId !== 'string' || routeOf(after.subjectId) === null)
      )
        throw new TypeError('Invalid priority shelf seek');

      const rows = await statement.run(
        { query: client.query.bind(client) },
        {
          route,
          account_id: accountId,
          state: query.state,
          type_id: query.typeId,
          has_after: after !== null,
          after_priority: after?.key ? Number(after.key) : null,
          after_subject_id: after?.subjectId ?? accountId,
          limit: query.limit + 1,
        },
      );
      const entries: ShelfPriorityRows['entries'] = rows.slice(0, query.limit).map((row) => {
        if (
          row.state === null ||
          row.createdAt === null ||
          row.updatedAt === null ||
          row.lastActivityAt === null ||
          row.revision === null ||
          (row.priority !== null && (!Number.isInteger(row.priority) || row.priority < 1 || row.priority > 100))
        )
          throw new (ShelfReadUnavailableError())('native priority shelf projection');
        return {
          subjectId: row.subjectId,
          incarnationId: row.incarnationId,
          state: row.state,
          revision: row.revision,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          lastActivityAt: row.lastActivityAt,
          finishedAt: row.finishedAt,
          priority: row.priority,
        };
      });
      return { entries, more: rows.length > query.limit };
    },
  };
}

export function createEntryPriorityReaders(): Readonly<Record<ShelfDirection, ShelfPriorityReader>> {
  return { asc: createReader('asc'), desc: createReader('desc') };
}
