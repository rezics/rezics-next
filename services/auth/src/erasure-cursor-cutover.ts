import { Pool, type PoolClient } from 'pg';

export const AUTH_CURSOR_VERSION = 2;

/** New workers and writers start together, after the deployment marker commits. */
export async function requireErasureCursorVersion(
  connection: PoolClient,
  version = AUTH_CURSOR_VERSION,
  clientId?: string,
) {
  // Share the marker probe with the existing client lock statement. The lock's
  // key and transaction lifetime stay the same, without another query per owner.
  const lock = clientId === undefined ? '' : ',pg_advisory_xact_lock(hashtextextended($2,0))';
  const marker = await connection.query(
    `SELECT set_config('auth.cursor_worker','2',true)${lock} FROM auth_erasure_cursor_cutover
     WHERE singleton AND writer_version=$1 AND completed_at IS NOT NULL`,
    clientId === undefined ? [version] : [version, `auth-client:${clientId}`],
  );
  if (!marker.rowCount) throw new Error('Auth cursor worker version refused or cutover incomplete');
}

/** One deployment transaction, never part of an account's erasure budget.
 * 99 native keys plus one checkpoint write keeps even checkpoint writes within 100.
 * Recreate the caller after any commit: the singleton is the only resume authority.
 */
export async function backfillErasureCursorPage(pool: Pool) {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const state = (
      await connection.query<{ phase: string; after_key: string | null; after_client: string | null }>(
        'SELECT * FROM auth_erasure_cursor_cutover WHERE singleton FOR UPDATE',
      )
    ).rows[0]!;
    if (state.phase === 'done') {
      await connection.query('COMMIT');
      return { done: true, keys: 0 };
    }
    await connection.query("SELECT set_config('auth.cursor_backfill','2',true)");
    // Small heaps can otherwise turn each tuple update into a full scan. This
    // deployment transaction must use the native key/tuple seeks at every scale.
    await connection.query('SET LOCAL enable_seqscan = off');
    await connection.query('SET LOCAL enable_sort = off');
    let keys = 0;
    let phase = state.phase;
    let after = state.after_key;
    let client = state.after_client;
    if (phase === 'users' || phase === 'consents') {
      const users = phase === 'users';
      const rows = users
        ? (
            await connection.query<{ id: string; locator: string }>(
              'SELECT id,ctid::text AS locator FROM "user" WHERE id>$1 ORDER BY id LIMIT 99 FOR UPDATE',
              [after ?? ''],
            )
          ).rows.map(({ id, locator }) => ({ id, locator, client_id: '' }))
        : (
            await connection.query<{ id: string; client_id: string; locator: string }>(
              `SELECT account_id AS id,client_id,ctid::text AS locator FROM auth_consent
               WHERE (client_id,account_id)>($1,$2) ORDER BY client_id,account_id LIMIT 99 FOR UPDATE`,
              [client ?? '', after ?? ''],
            )
          ).rows;
      keys = rows.length;
      // The page is sorted before allocating sequence values, independent of UPDATE plan order. Locked tuple locators
      // bound writes to this page without making Postgres search unrelated rows to join a values list.
      if (keys) {
        for (const row of rows) {
          if (users)
            await connection.query(
              `UPDATE "user" SET traversal_ordinal=nextval('auth_traversal_ordinal') WHERE ctid=$1::tid`,
              [row.locator],
            );
          else
            await connection.query(
              `UPDATE auth_consent SET traversal_ordinal=nextval('auth_traversal_ordinal')
               WHERE ctid=$1::tid`,
              [row.locator],
            );
        }
        after = rows.at(-1)!.id;
        client = rows.at(-1)!.client_id;
      } else {
        phase = users ? 'consents' : 'coverage';
        after = client = null;
      }
    } else {
      const coverage = phase === 'coverage';
      const table = coverage ? 'auth_client_coverage' : 'auth_client_reduction_progress';
      const key = coverage ? 'client_id' : 'operation_id';
      const row = (
        await connection.query<Record<string, string | null>>(
          `SELECT * FROM ${table} WHERE ${key}>$1 ORDER BY ${key} LIMIT 1 FOR UPDATE`,
          [after ?? ''],
        )
      ).rows[0];
      if (row) {
        keys = 1;
        const predecessor = async (boundary: string | null) => {
          if (boundary === null) return null;
          if (boundary === '') return '0';
          const result = coverage
            ? await connection.query('SELECT traversal_ordinal FROM "user" WHERE id<=$1 ORDER BY id DESC LIMIT 1', [
                boundary,
              ])
            : await connection.query(
                `SELECT traversal_ordinal FROM auth_consent WHERE client_id=$1 AND account_id<=$2
                 ORDER BY account_id DESC LIMIT 1`,
                [row.client_id, boundary],
              );
          return (result.rows[0]?.traversal_ordinal as string | undefined) ?? '0';
        };
        const ordinal = await predecessor(row.legacy_after_account!);
        if (coverage)
          await connection.query(
            `UPDATE auth_client_coverage SET after_ordinal=$2,legacy_after_account=NULL WHERE client_id=$1`,
            [row.client_id, ordinal],
          );
        else
          await connection.query(
            `UPDATE auth_client_reduction_progress SET after_ordinal=$2,page_after=$3,terminal_ordinal=$4,
             cutover_after=CASE WHEN completed THEN NULL ELSE $2::bigint END,
             legacy_after_account=NULL,legacy_page_after=NULL,legacy_terminal_account=NULL WHERE operation_id=$1`,
            [
              row.operation_id,
              ordinal,
              await predecessor(row.legacy_page_after!),
              await predecessor(row.legacy_terminal_account!),
            ],
          );
        after = row[key]!;
      } else {
        phase = coverage ? 'reduction' : 'done';
        after = client = null;
      }
    }
    await connection.query(
      `UPDATE auth_erasure_cursor_cutover SET phase=$1,after_key=$2,after_client=$3,
       completed_at=CASE WHEN $1='done' THEN clock_timestamp() END WHERE singleton`,
      [phase, after, client],
    );
    await connection.query('COMMIT');
    return { done: phase === 'done', keys };
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

if (import.meta.main) {
  const url = process.env.AUTH_DATABASE_URL;
  if (!url) throw new Error('Set AUTH_DATABASE_URL to the separate Auth database');
  const pool = new Pool({ connectionString: url });
  try {
    console.info(await backfillErasureCursorPage(pool));
  } finally {
    await pool.end();
  }
}
