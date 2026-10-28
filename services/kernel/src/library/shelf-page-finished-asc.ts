import { isLegacyEntryState, MAX_SHELF_PAGE_SIZE, type ShelfDateReader } from './shelf-contract.ts';
import { routeOf, ROUTES } from '../route/route.ts';
import unfiltered from './shelf-page-finished-asc.sql';
import byState from './shelf-page-finished-asc-state.sql';
import byType from './shelf-page-finished-asc-type.sql';
import byStateType from './shelf-page-finished-asc-state-type.sql';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Accept exact RFC 3339 timestamps without parsing through a millisecond Date.
function validKey(key: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(key);
  if (!m) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = m.slice(1).map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year! > 0 &&
    month! >= 1 &&
    month! <= 12 &&
    day! >= 1 &&
    day! <= days[month! - 1]! &&
    hour! < 24 &&
    minute! < 60 &&
    second! < 60 &&
    (Number.isNaN(offsetHour) || (offsetHour! < 16 && offsetMinute! < 60))
  );
}

/** Fixed private finished-date ascending adapter; admission and RR snapshot belong to the caller. */
export function createShelfFinishedAscReader(): ShelfDateReader {
  return {
    async page(client, route, accountId, query, after) {
      if (!Number.isInteger(route) || route < 0 || route >= ROUTES || routeOf(accountId) !== route)
        throw new RangeError('Invalid shelf owner route');
      if (query.orderBy !== 'finishedAt' || query.direction !== 'asc') throw new TypeError('Invalid shelf order');
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SHELF_PAGE_SIZE)
        throw new RangeError('Invalid shelf page limit');
      if (query.state !== null && !isLegacyEntryState(query.state)) throw new TypeError('Invalid shelf state');
      if (query.typeId !== null && (typeof query.typeId !== 'string' || !uuid.test(query.typeId)))
        throw new TypeError('Shelf type must be a private UUID');
      if (
        after !== null &&
        (typeof after !== 'object' ||
          typeof after.subjectId !== 'string' ||
          !uuid.test(after.subjectId) ||
          typeof after.key !== 'string' ||
          (after.key !== '' && !validKey(after.key)))
      )
        throw new TypeError('Invalid shelf seek');
      const parameters = {
        route,
        account_id: accountId,
        state: query.state!,
        type_id: query.typeId!,
        budget: query.limit + 1,
        has_after: after !== null,
        null_after: after?.key === '',
        after_key: after?.key || '2000-01-01T00:00:00.000000Z',
        after_subject_id: after?.subjectId ?? '00000000-0000-0000-0000-000000000000',
      };
      const statement =
        query.state === null
          ? query.typeId === null
            ? unfiltered
            : byType
          : query.typeId === null
            ? byState
            : byStateType;
      const rows = await statement.run({ query: client.query.bind(client) }, parameters);
      const entries = rows.slice(0, query.limit).map((row) => {
        if (row.state === null || row.createdAt === null || row.updatedAt === null || row.lastActivityAt === null)
          throw new Error('Shelf rollout invariant violated');
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
