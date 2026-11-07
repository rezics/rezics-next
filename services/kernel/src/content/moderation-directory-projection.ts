import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { deadlineClient, within } from './access-port.ts';
import type { Effect } from '../events/effects.ts';
import { routeOf } from '../route/route.ts';

export const MODERATION_DIRECTORY_BOOTSTRAP_PAGE = 64;
export const MODERATION_DIRECTORY_RAW_PAGE = 20;
const zero = '00000000-0000-0000-0000-000000000000';
export type ModerationDirectoryReference = Readonly<{
  route: number;
  boardId: string;
  realmId: string | null;
}>;
export type ModerationDirectoryCoverage = Readonly<{
  generation: string;
  complete: boolean;
}>;
type Install = ModerationDirectoryCoverage & {
  cut_route: number;
  cut_id: string;
  after_route: number;
  after_id: string;
};

/** Only maintenance advances this durable finite-cut cursor. A transaction locks
 * installation before source rows, matching the live registration writer. Replay
 * inserts exact current references; removed/replaced rows cannot be resurrected.
 * No request invokes this function and no foreign history is read or repaired.
 */
export async function maintainModerationDirectoryPage(pool: Pool, deadline = Date.now() + 30_000) {
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN');
        const install = (
          await client.query<Install>(`SELECT generation::text,complete,cut_route,cut_id,after_route,after_id
            FROM content.moderation_directory_install WHERE singleton FOR UPDATE`)
        ).rows[0];
        if (!install) {
          await client.query('COMMIT');
          return { state: 'unavailable' as const, examined: 0 };
        }
        if (install.complete) {
          await client.query('COMMIT');
          return { state: 'complete' as const, examined: 0 };
        }
        const rows = (
          await client.query<{
            route: number;
            board_id: string;
            realm_id: string | null;
          }>(
            `SELECT route,board_id,realm_id FROM content.board
             WHERE ROW(route,board_id)>ROW($1::integer,$2::uuid)
               AND ROW(route,board_id)<=ROW($3::integer,$4::uuid)
             ORDER BY route,board_id LIMIT $5`,
            [
              install.after_route,
              install.after_id,
              install.cut_route,
              install.cut_id,
              MODERATION_DIRECTORY_BOOTSTRAP_PAGE,
            ],
          )
        ).rows;
        // The source and receiving table share this native Content home. Locking
        // installation excludes concurrent registration mutations until commit.
        for (const row of rows)
          await client.query(
            `INSERT INTO content.moderation_directory_reference(route,board_id,realm_id)
             VALUES($1,$2,$3) ON CONFLICT(route,board_id) DO UPDATE SET realm_id=EXCLUDED.realm_id`,
            [row.route, row.board_id, row.realm_id],
          );
        const last = rows.at(-1);
        const complete = rows.length < MODERATION_DIRECTORY_BOOTSTRAP_PAGE;
        await client.query(
          `UPDATE content.moderation_directory_install SET
             after_route=$1,after_id=$2,complete=$3,generation=generation+1 WHERE singleton`,
          [last?.route ?? install.after_route, last?.board_id ?? install.after_id, complete],
        );
        await client.query('COMMIT');
        return {
          state: complete ? ('complete' as const) : ('progress' as const),
          examined: rows.length,
        };
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    }),
  );
}

/** One released snapshot. LIMIT bounds the index range before any foreign work.
 * Realm filtering uses its own leading-key index; pages never refill denials.
 */
export async function readModerationDirectoryReferences(
  pool: Pool,
  input: Readonly<{
    realmId?: string;
    after?: readonly [number, string];
    limit: number;
    deadline: number;
  }>,
): Promise<
  Readonly<{
    coverage: ModerationDirectoryCoverage | null;
    references: readonly ModerationDirectoryReference[];
  }>
> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MODERATION_DIRECTORY_RAW_PAGE)
    throw new RangeError('Invalid moderation candidate budget');
  return within(input.deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, input.deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const coverage = await readModerationDirectoryCoverage(client);
        const references = !coverage?.complete
          ? []
          : (
              await client.query<ModerationDirectoryReference>(
                `SELECT route,board_id AS "boardId",realm_id AS "realmId"
                 FROM content.moderation_directory_reference
                 WHERE ${input.realmId === undefined ? '' : 'realm_id=$4::uuid AND '}
                   ROW(route,board_id)>ROW($1::integer,$2::uuid)
                 ORDER BY route,board_id LIMIT $3`,
                [
                  input.after?.[0] ?? -1,
                  input.after?.[1] ?? zero,
                  input.limit,
                  ...(input.realmId === undefined ? [] : [input.realmId]),
                ],
              )
            ).rows;
        await client.query('COMMIT');
        return { coverage, references };
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    }),
  );
}

/** Request-local coverage observation uses the same bounded checkout as the raw page. */
export async function observeModerationDirectoryCoverage(pool: Pool, deadline: number) {
  return within(deadline, () =>
    withConnection(pool, (connection) => readModerationDirectoryCoverage(deadlineClient(connection, deadline))),
  );
}

export async function readModerationDirectoryCoverage(
  client: Pick<Pool, 'query'>,
): Promise<ModerationDirectoryCoverage | null> {
  return (
    (
      await client.query<ModerationDirectoryCoverage>(
        'SELECT generation::text,complete FROM content.moderation_directory_install WHERE singleton',
      )
    ).rows[0] ?? null
  );
}

/** Existing registered owner events request an exact current resource projection,
 * rather than trusting the event's historical parent or positive authority flags.
 * Live registration already made the source complete; duplicate delivery writes
 * no generation and restart can safely repeat any acknowledged event.
 */
export function createModerationDirectoryProjectionEffect(pool: Pool): Effect {
  return {
    name: 'content_moderation_directory',
    types: ['com.rezics.content.board.created.v1'],
    async run(event) {
      const data: unknown = event.data;
      if (!data || typeof data !== 'object' || !('boardId' in data) || typeof data.boardId !== 'string')
        throw new TypeError('Invalid moderation directory resource event');
      const route = routeOf(data.boardId);
      if (route === null) throw new TypeError('Invalid moderation directory Board');
      // The registered native writer is the producer. An event is a wakeup, not
      // authorization to synthesize a resource or repair source history.
      await pool.query(
        `INSERT INTO content.moderation_directory_reference(route,board_id,realm_id)
         SELECT route,board_id,realm_id FROM content.board WHERE route=$1 AND board_id=$2
         ON CONFLICT(route,board_id) DO NOTHING`,
        [route, data.boardId],
      );
    },
  };
}
