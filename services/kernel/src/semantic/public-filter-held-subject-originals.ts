import type { PoolClient } from 'pg';
import { CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { routeOf, partitionOf } from '../route/route.ts';

export type HeldSubjectOriginal = Readonly<{ route: number; id: string }>;

/** Resolve the saved owner and its raw Subject keys in one primary snapshot.
 * A successful empty seek still returns the immutable cut's receipt.
 */
export async function readHeldSubjectOriginals(
  db: Pick<PoolClient, 'query'>,
  input: Readonly<{
    bootstrap: string;
    birth: string;
    partition: number;
    after: HeldSubjectOriginal | null;
    inputLimit: number;
  }>,
  context: Readonly<{ deadline: number }>,
  // Only Source's durable one-key repair step reopens a scan. The original
  // miss remains an exhausted cursor after a later creation in this home.
  retained?: Readonly<{ key: HeldSubjectOriginal | null; commandHead: string }>,
) {
  requireAccessDeadline(context.deadline);
  const { bootstrap, birth, partition, after, inputLimit } = input;
  if (
    !Number.isInteger(partition) ||
    partition < 0 ||
    partition >= 4096 ||
    !Number.isInteger(inputLimit) ||
    inputLimit < 1 ||
    inputLimit > 32 ||
    !/^[1-9][0-9]{0,18}$/.test(birth) ||
    (after !== null && (routeOf(after.id) !== after.route || partitionOf(after.route) !== partition))
  )
    throw new TypeError('Invalid held Subject inventory frontier');
  if (
    retained &&
    (inputLimit !== 1 ||
      !/^(0|[1-9][0-9]{0,18})$/.test(retained.commandHead) ||
      (retained.key &&
        (routeOf(retained.key.id) !== retained.key.route ||
          partitionOf(retained.key.route) !== partition ||
          (after &&
            (retained.key.route < after.route ||
              (retained.key.route === after.route && retained.key.id <= after.id))))))
  )
    throw new TypeError('Invalid retained Subject inventory');
  const { rows } = await db.query<{
    epoch: number;
    receipt: string;
    command_head: string;
    route: number | null;
    id: string | null;
  }>(
    `/* semantic.native-keyed:${89 + inputLimit}:${89 + inputLimit} */
     SELECT c.epoch,c.receipt,c.command_head::text,k.route,k.id
     FROM semantic.subject_access_cut_v1($1,$2) c
     LEFT JOIN LATERAL (
       SELECT s.route,s.subject_id::text AS id FROM semantic.subject s
       WHERE s.route >= c.home*16 AND s.route < (c.home+1)*16
         AND ${
           retained
             ? '(s.route,s.subject_id)=($4::integer,$5::uuid)'
             : `(s.route,s.subject_id)${after ? '>' : '>='}($4::integer,$5::uuid)`
         }
       ORDER BY s.route,s.subject_id LIMIT $6
     ) k ON true
     WHERE c.birth=$3::bigint ${retained ? 'AND $7::bigint BETWEEN c.command_base AND c.command_head' : ''} ORDER BY k.route,k.id COLLATE "C"`,
    [
      bootstrap,
      partition,
      birth,
      (retained ? retained.key : after)?.route ?? partition * 16,
      retained ? (retained.key?.id ?? null) : (after?.id ?? '00000000-0000-0000-0000-000000000000'),
      inputLimit,
      ...(retained ? [retained.commandHead] : []),
    ],
  );
  const cut = rows[0];
  if (!cut) throw new CommandUnavailableError('contention', partition);
  const originals: HeldSubjectOriginal[] = [];
  for (const { id, route } of rows) {
    if (id === null && route === null && rows.length === 1) break;
    if (id === null || route === null || routeOf(id) !== route || partitionOf(route) !== partition)
      throw new CommandUnavailableError('contention', partition);
    originals.push({ route, id });
  }
  if (retained?.key && originals.length !== 1) throw new CommandUnavailableError('contention', partition);
  return {
    epoch: cut.epoch,
    receipt: cut.receipt,
    commandHead: cut.command_head,
    originals,
    complete: originals.length < inputLimit,
  };
}

// A page shares one immutable Core/Access cut and one membership check. The
// remaining keyed inputs are placement, partition, privacy, Account, enqueue
// and cleanup for each home. Both producer and independent reader pay for them.
export const heldRepairHomes = 32;
export async function readHeldRepairHomes(
  db: Pick<PoolClient, 'query'>,
  input: Readonly<{
    bootstrap: string;
    birth: string;
    partition: number;
    limit: number;
    after: HeldSubjectOriginal | null;
    inventory: boolean;
  }>,
  context: Readonly<{ deadline: number }>,
  retained?: Readonly<{ heads: readonly string[]; key: HeldSubjectOriginal | null }>,
  meter?: { inputKeys: number; rows: number; dependencyPoints: number },
) {
  requireAccessDeadline(context.deadline);
  const { partition, limit, after, inventory } = input;
  const validKey = (key: HeldSubjectOriginal) => routeOf(key.id) === key.route;
  if (
    !Number.isInteger(partition) ||
    partition < 0 ||
    partition >= 4096 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > heldRepairHomes ||
    !/^[1-9][0-9]{0,18}$/.test(input.birth) ||
    (after && (!validKey(after) || partitionOf(after.route) !== partition)) ||
    (retained &&
      (retained.heads.length < 1 ||
        retained.heads.length > limit ||
        retained.heads.some((h) => !/^(0|[1-9][0-9]{0,18})$/.test(h)) ||
        (retained.key &&
          (!inventory ||
            !validKey(retained.key) ||
            partitionOf(retained.key.route) !== partition + retained.heads.length - 1 ||
            (after &&
              (retained.key.route < after.route ||
                (retained.key.route === after.route && retained.key.id <= after.id)))))))
  )
    throw new TypeError('Invalid held Subject page frontier');
  const width = retained?.heads.length ?? limit;
  const points = 97 + 6 * width;
  const { rows } = await db.query<{
    home: number;
    end_home: number;
    key_count: number;
    access_current: boolean;
    epoch: number;
    receipt: string;
    base: string;
    head: string;
    id: string | null;
    route: number | null;
  }>(
    `/* semantic.native-keyed:${points}:${points} */
    WITH page AS MATERIALIZED (
      SELECT p.first_home,m.key_count,stamp.current AS access_current,least(p.end_home,$2::integer+$4::integer) AS stop,p.cuts,c.cuts AS original,m.restore_generation
      FROM semantic.subject_access_cut_v1($1,$2) anchor
      JOIN core.subject_subscription_v1 m ON m.birth=anchor.birth
      CROSS JOIN LATERAL (SELECT * FROM semantic.subject_access_page_v1 p
        WHERE p.birth=m.birth AND p.first_home<=$2 ORDER BY p.first_home DESC LIMIT 1) p
      JOIN core.subject_retention_page_v1 c ON (c.birth,c.first_home,c.end_home)=(p.birth,p.first_home,p.end_home)
      CROSS JOIN LATERAL (SELECT p.access_revisions=semantic.subject_access_range_revisions_v1(p.first_home,p.end_home)
        AS current OFFSET 0) stamp
      WHERE anchor.birth=$3 AND p.end_home>$2
        AND (stamp.current OR semantic.subject_access_range_current_v1(p,$2,least(p.end_home,$2::integer+$4::integer)))
    ), frontier AS MATERIALIZED (
      SELECT page.*,k.route,k.id,coalesce(k.route/16+1,stop) AS end_home FROM page
      LEFT JOIN LATERAL (SELECT s.route,s.subject_id AS id FROM semantic.subject s
        WHERE $5::boolean AND s.route >= $2::integer*16 AND s.route < page.stop*16 AND
        (s.route,s.subject_id) ${retained ? '=' : after ? '>' : '>='} ($6::integer,$7::uuid)
        ORDER BY s.route,s.subject_id LIMIT 1) k ON true
    )
    SELECT i AS home,f.end_home,f.key_count,f.access_current,p.epoch,x.cut->>'receipt' AS receipt,x.cut->>'command' AS base,
      p.position::text AS head,CASE WHEN i=f.route/16 THEN f.id::text END AS id,
      CASE WHEN i=f.route/16 THEN f.route END AS route
    FROM frontier f CROSS JOIN LATERAL generate_series($2,f.end_home-1) i
    CROSS JOIN LATERAL (SELECT f.cuts->(i-f.first_home) AS cut) x
    CROSS JOIN LATERAL (SELECT epoch,position FROM core.partition WHERE partition_no=i AND write_state='active' LIMIT 1) p
    CROSS JOIN LATERAL (SELECT generation FROM core.publication_authority_epoch WHERE home_no=i LIMIT 1) g
    CROSS JOIN LATERAL (SELECT position FROM semantic.public_filter_privacy_head WHERE partition_no=i AND owner_epoch=p.epoch AND NOT population_fenced LIMIT 1) n
    LEFT JOIN LATERAL (SELECT * FROM core.subject_cleanup_v1 WHERE home=i LIMIT 1) permit ON true
    WHERE x.cut @> (f.original->(i-f.first_home))
      AND (x.cut->>'home',x.cut->>'epoch',x.cut->>'generation')=(i::text,p.epoch::text,g.generation::text)
      AND p.position >= (x.cut->>'command')::bigint AND n.position >= (x.cut->>'privacy')::bigint
      AND (permit.home IS NULL OR ((permit.owner_epoch,permit.home_generation,permit.restore_generation)=
        (p.epoch,g.generation,f.restore_generation) AND permit.command_through<=(x.cut->>'command')::bigint
        AND permit.privacy_through<=(x.cut->>'privacy')::bigint))
    ORDER BY i`,
    [
      input.bootstrap,
      partition,
      input.birth,
      width,
      inventory && (!retained || !!retained.key),
      (retained ? retained.key : after)?.route ?? partition * 16,
      (retained ? retained.key : after)?.id ?? '00000000-0000-0000-0000-000000000000',
    ],
  );
  if (
    !rows.length ||
    rows.length !== rows[0]!.end_home - partition ||
    (retained && (rows.length !== width || (retained.key && rows.at(-1)?.id !== retained.key.id)))
  )
    throw new CommandUnavailableError('contention', partition);
  if (meter) {
    // The anchor checked the exact original key closure (maximum 64). The
    // stamp proves that neither Account input has moved anywhere in the page.
    const unused = 64 - rows[0]!.key_count + (rows[0]!.access_current ? 2 * width : 0);
    meter.rows -= unused;
    meter.inputKeys -= unused;
    meter.dependencyPoints -= unused;
  }
  return rows.map((row, i) => {
    const head = retained?.heads[i] ?? row.head;
    if (
      row.home !== partition + i ||
      BigInt(head) < BigInt(row.base) ||
      BigInt(head) > BigInt(row.head) ||
      (row.id !== null && (row.route === null || routeOf(row.id) !== row.route || partitionOf(row.route) !== row.home))
    )
      throw new CommandUnavailableError('contention', partition + i);
    return {
      partition: row.home,
      epoch: row.epoch,
      receipt: row.receipt,
      base: row.base,
      head,
      route: row.route,
      id: row.id,
    };
  });
}
