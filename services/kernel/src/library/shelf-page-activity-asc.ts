import { routeOf } from '../route/route.ts';
import { isLegacyEntryState, MAX_SHELF_PAGE_SIZE, type ShelfDateReader, type ShelfDateRows } from './shelf-contract.ts';
import page from './shelf-page-activity-asc.sql';
import statePage from './shelf-page-activity-asc-state.sql';
import typePage from './shelf-page-activity-asc-type.sql';
import stateTypePage from './shelf-page-activity-asc-state-type.sql';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Accept the stored PostgreSQL spelling as well as RFC 3339, without rounding through Date.
function timestamp(key: string): boolean {
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)$/.exec(key);
  if (!parts) return false;
  const [year, month, day, hour, minute, second, zoneHour, zoneMinute] = parts.slice(1).map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month! - 1];
  return (
    year! > 0 &&
    days !== undefined &&
    day! >= 1 &&
    day! <= days &&
    hour! < 24 &&
    minute! < 60 &&
    second! < 60 &&
    (Number.isNaN(zoneHour) || zoneHour! <= 15) &&
    (Number.isNaN(zoneMinute) || zoneMinute! < 60)
  );
}

/** Candidates only; the owner supplies its admitted RR client and enriches emitted rows separately. */
export function createShelfActivityAscReader(): ShelfDateReader {
  return {
    async page(client, route, accountId, query, after) {
      if (!Number.isInteger(route) || route < 0 || route > 65535 || routeOf(accountId) !== route)
        throw new TypeError('Invalid shelf owner route');
      if (
        query.orderBy !== 'lastActivity' ||
        query.direction !== 'asc' ||
        (query.state !== null && !isLegacyEntryState(query.state)) ||
        (query.typeId !== null && (typeof query.typeId !== 'string' || !UUID.test(query.typeId)))
      )
        throw new TypeError('Invalid activity ascending shelf query');
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_SHELF_PAGE_SIZE)
        throw new RangeError('Invalid shelf page limit');
      if (
        after !== null &&
        (typeof after !== 'object' ||
          typeof after.key !== 'string' ||
          !timestamp(after.key) ||
          typeof after.subjectId !== 'string' ||
          routeOf(after.subjectId) === null)
      )
        throw new TypeError('Invalid activity shelf seek');
      // Parameterize seek bounds once; covered candidates precede bounded primary-key hydration.
      const parameters = {
        route,
        account_id: accountId,
        row_route: route,
        row_account_id: accountId,
        after_key: after?.key ?? null,
        after_subject_id: after?.subjectId ?? accountId,
        limit: query.limit + 1,
        first_limit: query.limit + 1,
        later_limit: query.limit + 1,
        tie_limit: query.limit + 1,
      };
      const rows =
        query.state === null
          ? query.typeId === null
            ? await page.run(client, parameters)
            : await typePage.run(client, { ...parameters, type_id: query.typeId })
          : query.typeId === null
            ? await statePage.run(client, { ...parameters, state: query.state })
            : await stateTypePage.run(client, { ...parameters, state: query.state, type_id: query.typeId });
      const entries: ShelfDateRows['entries'] = rows.slice(0, query.limit).map((row) => {
        const { subjectId, state, revision, createdAt, updatedAt, lastActivityAt, finishedAt } = row;
        if (
          createdAt === null ||
          updatedAt === null ||
          lastActivityAt === null ||
          revision === null ||
          state === null
        )
          throw new Error('Shelf activity backfill is incomplete');
        return { subjectId, state, revision, createdAt, updatedAt, lastActivityAt, finishedAt };
      });
      return {
        entries,
        more: rows.length > query.limit,
      };
    },
  };
}
