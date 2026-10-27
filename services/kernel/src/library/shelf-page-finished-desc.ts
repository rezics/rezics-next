import all from './shelf-page-finished-desc.sql';
import state from './shelf-page-finished-desc-state.sql';
import type from './shelf-page-finished-desc-type.sql';
import stateType from './shelf-page-finished-desc-state-type.sql';
import { ENTRY_STATES, MAX_SHELF_PAGE_SIZE, type ShelfDateReader, type ShelfDateRows } from './shelf-contract.ts';
import { routeOf } from '../route/route.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validate without ever converting the seek timestamp through Date or losing fractional digits.
function timestamp(key: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)$/.exec(key);
  if (!match) return false;
  const [, y, m, d, h, min, s, , oh, om] = match;
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days &&
    Number(h) < 24 &&
    Number(min) < 60 &&
    Number(s) < 60 &&
    Number(oh ?? 0) < 16 &&
    Number(om ?? 0) < 60
  );
}

export function createShelfFinishedDescReader(): ShelfDateReader {
  return {
    async page(client, route, accountId, query, after) {
      if (!Number.isInteger(route) || route < 0 || route > 65535 || routeOf(accountId) !== route)
        throw new TypeError('Invalid shelf owner route');
      if (
        !query ||
        query.orderBy !== 'finishedAt' ||
        query.direction !== 'desc' ||
        (query.state !== null && !ENTRY_STATES.includes(query.state)) ||
        (query.typeId !== null && (typeof query.typeId !== 'string' || !uuid.test(query.typeId)))
      )
        throw new TypeError('Invalid finished descending shelf query');
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SHELF_PAGE_SIZE)
        throw new RangeError('Invalid shelf page limit');
      if (
        after !== null &&
        (!after ||
          typeof after.subjectId !== 'string' ||
          !uuid.test(after.subjectId) ||
          typeof after.key !== 'string' ||
          (after.key !== '' && !timestamp(after.key)))
      )
        throw new TypeError('Invalid shelf seek');
      const parameters = {
        route,
        account_id: accountId,
        has_after: after !== null,
        seek_key: after?.key || null,
        subject_id: after?.subjectId ?? accountId,
        take: query.limit + 1,
      };
      const bound = { query: client.query.bind(client) };
      const rows =
        query.state === null
          ? query.typeId === null
            ? await all.run(bound, parameters)
            : await type.run(bound, { ...parameters, type_id: query.typeId })
          : query.typeId === null
            ? await state.run(bound, { ...parameters, state: query.state })
            : await stateType.run(bound, { ...parameters, state: query.state, type_id: query.typeId });
      const entries: ShelfDateRows['entries'] = rows.slice(0, query.limit).map((row) => {
        if (row.createdAt === null || row.updatedAt === null || row.lastActivityAt === null)
          throw new Error('Shelf dates must be backfilled before serving');
        if (!ENTRY_STATES.includes(row.state as (typeof ENTRY_STATES)[number]))
          throw new Error('Unknown library entry state');
        return {
          ...row,
          state: row.state as (typeof ENTRY_STATES)[number],
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          lastActivityAt: row.lastActivityAt,
        };
      });
      return { entries, more: rows.length > query.limit };
    },
  };
}
