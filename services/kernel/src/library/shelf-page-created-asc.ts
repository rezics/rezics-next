import { routeOf } from '../route/route.ts';
import { ENTRY_STATES, MAX_SHELF_PAGE_SIZE, type ShelfDateReader } from './shelf-contract.ts';
import unfiltered from './shelf-page-created-asc.sql';
import stateOnly from './shelf-page-created-asc-state.sql';
import typeOnly from './shelf-page-created-asc-type.sql';
import stateType from './shelf-page-created-asc-state-type.sql';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Accept both RFC 3339 and PostgreSQL's stored timestamp text, without rounding through Date.
const timestamp = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)$/;

function validTime(key: string): boolean {
  const match = timestamp.exec(key);
  if (!match) return false;
  const [year, month, day, hour, minute, second, zoneHour, zoneMinute] = match.slice(1).map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year! > 0 &&
    month! >= 1 &&
    month! <= 12 &&
    day! >= 1 &&
    day! <= days[month! - 1]! &&
    hour! <= 23 &&
    minute! <= 59 &&
    second! <= 59 &&
    (Number.isNaN(zoneHour) || zoneHour! <= 15) &&
    (Number.isNaN(zoneMinute) || zoneMinute! <= 59)
  );
}

export function createShelfCreatedAscReader(): ShelfDateReader {
  return {
    async page(client, route, accountId, query, after) {
      if (!Number.isInteger(route) || route < 0 || route > 65535 || routeOf(accountId) !== route)
        throw new TypeError('Invalid shelf owner route');
      if (query.orderBy !== 'createdAt' || query.direction !== 'asc')
        throw new TypeError('This shelf reader requires createdAt asc');
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SHELF_PAGE_SIZE)
        throw new RangeError('Invalid shelf page limit');
      if (query.state !== null && !ENTRY_STATES.includes(query.state)) throw new TypeError('Invalid shelf state');
      if (query.typeId !== null && (typeof query.typeId !== 'string' || !uuid.test(query.typeId)))
        throw new TypeError('Shelf type must be a private UUID');
      if (
        after !== null &&
        (typeof after.key !== 'string' ||
          !validTime(after.key) ||
          typeof after.subjectId !== 'string' ||
          !uuid.test(after.subjectId))
      )
        throw new TypeError('Invalid shelf seek');
      const parameters = {
        route,
        account_id: accountId,
        has_after: after !== null,
        count: query.limit + 1,
        after_created_at: after?.key ?? '2000-01-01T00:00:00Z',
        after_subject_id: after?.subjectId ?? '00000000-0000-0000-0000-000000000000',
      };
      const connection = { query: client.query.bind(client) };
      const rows =
        query.state === null
          ? query.typeId === null
            ? await unfiltered.run(connection, parameters)
            : await typeOnly.run(connection, { ...parameters, type_id: query.typeId })
          : query.typeId === null
            ? await stateOnly.run(connection, { ...parameters, state: query.state })
            : await stateType.run(connection, { ...parameters, state: query.state, type_id: query.typeId });
      const entries = rows.slice(0, query.limit).map((row) => {
        if (
          !ENTRY_STATES.includes(row.state as (typeof ENTRY_STATES)[number]) ||
          row.createdAt === null ||
          row.lastActivityAt === null
        )
          throw new Error('Shelf rollout invariant violated');
        return {
          ...row,
          state: row.state as (typeof ENTRY_STATES)[number],
          createdAt: row.createdAt,
          lastActivityAt: row.lastActivityAt,
        };
      });
      return { entries, more: rows.length > query.limit };
    },
  };
}
