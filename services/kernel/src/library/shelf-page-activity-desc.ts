import { routeOf } from '../route/route.ts';
import { isLegacyEntryState, MAX_SHELF_PAGE_SIZE, type ShelfDateReader } from './shelf-contract.ts';
import all from './shelf-page-activity-desc.sql';
import state from './shelf-page-activity-desc-state.sql';
import type from './shelf-page-activity-desc-type.sql';
import stateType from './shelf-page-activity-desc-state-type.sql';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Accept exact UTC/RFC 3339 and PostgreSQL timestamp text without rounding a seek through Date.
function validKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)$/.exec(key);
  if (!match) return false;
  const [, y, m, d, h, min, s, zoneH, zoneM] = match;
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]! &&
    Number(h) < 24 &&
    Number(min) < 60 &&
    Number(s) < 60 &&
    Number(zoneH ?? 0) < 16 &&
    Number(zoneM ?? 0) < 60
  );
}

export function createShelfActivityDescReader(): ShelfDateReader {
  return {
    async page(client, route, accountId, query, after) {
      if (!Number.isInteger(route) || route < 0 || route > 65535 || routeOf(accountId) !== route)
        throw new TypeError('Shelf owner and route must match');
      if (
        !query ||
        query.orderBy !== 'lastActivity' ||
        query.direction !== 'desc' ||
        (query.state !== null && !isLegacyEntryState(query.state)) ||
        (query.typeId !== null && (typeof query.typeId !== 'string' || !UUID.test(query.typeId)))
      )
        throw new TypeError('Invalid activity descending shelf query');
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SHELF_PAGE_SIZE)
        throw new RangeError('Invalid shelf page limit');
      if (after !== null && (!after || !validKey(after.key) || routeOf(after.subjectId) === null))
        throw new TypeError('Invalid activity shelf seek');
      const statement =
        query.state === null ? (query.typeId === null ? all : type) : query.typeId === null ? state : stateType;
      const rows = await statement.run(
        { query: client.query.bind(client) },
        {
          route,
          account_id: accountId,
          state: query.state,
          type_id: query.typeId,
          after_key: after?.key ?? null,
          after_subject_id: after?.subjectId ?? null,
          take: query.limit + 1,
        },
      );
      const entries = rows.slice(0, query.limit).map((row) => {
        if (row.state === null || row.createdAt === null || row.updatedAt === null || row.lastActivityAt === null)
          throw new Error('Shelf date storage is not ready');
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
