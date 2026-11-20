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
