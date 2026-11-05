import {
  isShelfEntryState,
  MAX_SHELF_PAGE_SIZE,
  type ShelfDateReader,
  type ShelfDateRows,
  type ShelfPageReader,
} from './shelf-contract.ts';
import { routeOf } from '../route/route.ts';
import { createShelfActiveReader } from './shelf-active.ts';
import { createShelfActivityAscReader } from './shelf-page-activity-asc.ts';
import { createShelfActivityDescReader } from './shelf-page-activity-desc.ts';
import { createShelfCreatedAscReader } from './shelf-page-created-asc.ts';
import { createShelfFinishedAscReader } from './shelf-page-finished-asc.ts';
import { createShelfFinishedDescReader } from './shelf-page-finished-desc.ts';
import { createShelfScoreReader } from './shelf-score.ts';
import { createShelfTitleReader } from './shelf-title-reader.ts';
import { createEntryPriorityReaders } from './entry-priority-page.ts';
import all from './shelf-reader-created-desc.sql';
import state from './shelf-reader-created-desc-state.sql';
import type from './shelf-reader-created-desc-type.sql';
import stateType from './shelf-reader-created-desc-state-type.sql';
import { ShelfReadUnavailableError } from './shelf-reader-unavailable.ts';

/** The sixth fixed native date shape, with the exact reverse tie/seek order of createdAt asc. */
export function createShelfCreatedDescReader(): ShelfDateReader {
  return {
    async page(client, route, accountId, query, after) {
      if (query.orderBy !== 'createdAt' || query.direction !== 'desc') throw new TypeError('Invalid shelf order');
      if (routeOf(accountId) !== route || !Number.isInteger(route) || route < 0 || route > 65535)
        throw new TypeError('Invalid shelf owner route');
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SHELF_PAGE_SIZE)
        throw new RangeError('Invalid shelf page limit');
      if (query.state !== null && !isShelfEntryState(query.state)) throw new TypeError('Invalid shelf state');
      if (query.typeId !== null && routeOf(query.typeId) !== route) throw new TypeError('Invalid private shelf type');
      if (
        after !== null &&
        (routeOf(after.subjectId) === null ||
          !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$(?![\s\S])/.test(
            after.key,
          ))
      )
        throw new TypeError('Invalid shelf seek');
      const statement =
        query.state === null ? (query.typeId === null ? all : type) : query.typeId === null ? state : stateType;
      const rows = await statement.run(
        { query: client.query.bind(client) },
        {
          route,
          account_id: accountId,
          state: query.state!,
          type_id: query.typeId!,
          has_after: after !== null,
          count: query.limit + 1,
          after_created_at: after?.key ?? '2000-01-01T00:00:00Z',
          after_subject_id: after?.subjectId ?? '00000000-0000-0000-0000-000000000000',
        },
      );
      const entries = rows.slice(0, query.limit).map((row) => {
        if (row.state === null || row.createdAt === null || row.updatedAt === null || row.lastActivityAt === null)
          throw new ShelfReadUnavailableError('native entry date backfill');
        return {
          ...row,
          state: row.state,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          lastActivityAt: row.lastActivityAt,
        };
      });
      return { entries, more: rows.length > query.limit };
    },
  };
}

/** One date page followed by exactly one native session batch for the selected entries. */
export function createShelfPageReader(): ShelfPageReader {
  const readers = {
    lastActivity: { asc: createShelfActivityAscReader(), desc: createShelfActivityDescReader() },
    createdAt: { asc: createShelfCreatedAscReader(), desc: createShelfCreatedDescReader() },
    finishedAt: { asc: createShelfFinishedAscReader(), desc: createShelfFinishedDescReader() },
  };
  const score = createShelfScoreReader();
  const title = createShelfTitleReader();
  const priority = createEntryPriorityReaders();
  const active = createShelfActiveReader();
  return {
    async page(client, route, accountId, query, after) {
      const reader =
        query.orderBy === 'title'
          ? title
          : query.orderBy === 'personalScore'
            ? score
            : query.orderBy === 'priority'
              ? priority[query.direction]
              : readers[query.orderBy][query.direction];
      const page: ShelfDateRows = await reader.page(client, route, accountId, query, after);
      const sessions = await active.sessions(
        client,
        route,
        accountId,
        page.entries.map((row) => row.subjectId),
      );
      return {
        entries: page.entries.map((row) => ({ ...row, activeProgressSession: sessions.get(row.subjectId) ?? null })),
        more: page.more,
        ...(page.after ? { after: page.after } : {}),
      };
    },
  };
}
