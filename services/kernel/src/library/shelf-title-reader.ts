import type { PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import type { ShelfDateReader, ShelfEntry, ShelfSeek } from './shelf-contract.ts';
import { isShelfEntryState, MAX_SHELF_PAGE_SIZE } from './shelf-contract.ts';
import { shelfTitlePolicy, titleLanguages } from './shelf-title-source.ts';
import { SHELF_TITLE_KEY_POLICY } from './shelf-title-key.ts';
import { ShelfReadUnavailableError } from './shelf-reader-unavailable.ts';

type Client = Pick<PoolClient, 'query'>;

/** Same native RR snapshot as the ordered page; source observations have already been released. */
export async function shelfTitleBinding(
  client: Client, route: number, accountId: string, languages: readonly string[], sourceBasis: string,
) {
  const policy = shelfTitlePolicy(languages);
  const { rows } = await client.query<{ generation: string; population: string }>(
    `SELECT h.generation,h.population::text FROM library.shelf_title_head h
     JOIN library.shelf_title_owner o USING(route,account_id)
     WHERE h.route=$1 AND h.account_id=$2::uuid AND h.policy=$3 AND h.source_basis=$4
       AND h.phase='ready' AND h.population=o.population`,
    [route, accountId, policy, sourceBasis],
  );
  if (!rows[0]) throw new ShelfReadUnavailableError('complete current native title generation');
  return {
    titleGeneration: rows[0].generation, titlePopulation: rows[0].population,
    titlePolicy: policy, titleKeyPolicy: SHELF_TITLE_KEY_POLICY, titleSourceBasis: sourceBasis,
    titleLanguages: JSON.stringify(titleLanguages(languages)),
  };
}

export function validShelfTitleSeek(key: string): boolean {
  if (key === 'm:') return true;
  if (!/^l:[A-Za-z0-9_-]*$/.test(key) || key.length > 1368) return false;
  const bytes = Buffer.from(key.slice(2), 'base64url');
  return bytes.length <= 1024 && bytes.toString('base64url') === key.slice(2);
}

/** Two disjoint, independently limited native ranges; missing titles stay last in both directions. */
export function createShelfTitleReader(): ShelfDateReader {
  return {
    async page(client, route, accountId, query, after) {
      if (query.orderBy !== 'title' || !['asc', 'desc'].includes(query.direction))
        throw new TypeError('Invalid shelf title order');
      if (routeOf(accountId) !== route) throw new TypeError('Invalid shelf owner route');
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SHELF_PAGE_SIZE)
        throw new RangeError('Invalid shelf page limit');
      if (query.state !== null && !isShelfEntryState(query.state)) throw new TypeError('Invalid shelf state');
      if (query.typeId !== null && routeOf(query.typeId) !== route) throw new TypeError('Invalid private shelf type');
      if (!query.titleGeneration || (after && (routeOf(after.subjectId) === null || !validShelfTitleSeek(after.key))))
        throw new TypeError('Invalid shelf title seek or generation');
      const order = query.direction === 'asc' ? 'ASC' : 'DESC';
      const comparison = query.direction === 'asc' ? '>' : '<';
      const args: unknown[] = [route, accountId, query.titleGeneration];
      let predicate = 'route=$1 AND account_id=$2::uuid AND generation=$3::uuid';
      for (const [column, value, type] of [
        ['state', query.state, 'text'], ['type_id', query.typeId, 'uuid'],
      ] as const) if (value !== null) {
        args.push(value);
        predicate += ` AND ${column}=$${args.length}::${type}`;
      }
      let labelled = `${predicate} AND NOT missing`;
      let missing = `${predicate} AND missing`;
      if (after) {
        args.push(after.subjectId);
        const subject = `$${args.length}::uuid`;
        if (after.key === 'm:') {
          labelled += ' AND FALSE';
          missing += ` AND subject_id${comparison}${subject}`;
        } else {
          args.push(Buffer.from(after.key.slice(2), 'base64url'));
          labelled += ` AND (key,subject_id)${comparison}($${args.length}::bytea,${subject})`;
        }
      }
      args.push(query.limit + 1);
      const count = `$${args.length}::integer`;
      type Row = Omit<ShelfEntry, 'activeProgressSession'> & { key: Buffer; missing: boolean; current: boolean };
      const { rows } = await client.query<Row>(
        `WITH selected AS MATERIALIZED (
           SELECT * FROM (
             (SELECT * FROM library.shelf_title_key WHERE ${labelled}
               ORDER BY key ${order},subject_id ${order} LIMIT ${count})
             UNION ALL
             (SELECT * FROM library.shelf_title_key WHERE ${missing}
               ORDER BY key ${order},subject_id ${order} LIMIT ${count})
           ) candidates ORDER BY missing,key ${order},subject_id ${order} LIMIT ${count}
         ) SELECT s.subject_id AS "subjectId",e.incarnation_id AS "incarnationId",e.state,e.revision,
           e.created_at::text AS "createdAt",e.updated_at::text AS "updatedAt",
           e.activity_at::text AS "lastActivityAt",e.finished_at::text AS "finishedAt",s.key,s.missing,
           (e.subject_id IS NOT NULL AND e.incarnation_id=s.incarnation_id AND e.transaction_id=s.transaction_id
             AND e.state=s.state AND e.type_id=s.type_id) AS current
         FROM selected s LEFT JOIN library.entry e USING(route,account_id,subject_id)
         ORDER BY s.missing,s.key ${order},s.subject_id ${order}`,
        args,
      );
      if (rows.some((row) => row.current !== true || row.lastActivityAt === null))
        throw new ShelfReadUnavailableError('current complete title Entry basis');
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      const position: ShelfSeek | undefined = last ? {
        key: last.missing ? 'm:' : `l:${last.key.toString('base64url')}`, subjectId: last.subjectId,
      } : undefined;
      return {
        entries: page.map(({ key: _key, missing, current: _current, ...entry }) => ({
          ...entry, titleCoverage: missing ? 'missing' as const : 'labelled' as const,
        })),
        more: rows.length > query.limit,
        ...(position ? { after: position } : {}),
      };
    },
  };
}
