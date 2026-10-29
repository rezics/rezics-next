import type { PoolClient } from 'pg';

type Client = Pick<PoolClient, 'query'>;
export type PinPreference = { ids: string[]; revision: number };

/** One owner point, bounded by the table's 100-ID constraint. Empty reads never initialize storage. */
export async function readPins(client: Client, route: number, accountId: string): Promise<PinPreference> {
  const result = await client.query<{ ids: string[]; revision: string }>(
    'SELECT collection_ids AS ids, revision::text AS revision FROM library.collection_pins WHERE route=$1 AND account_id=$2',
    [route, accountId],
  );
  const row = result.rows[0];
  return row ? { ids: row.ids, revision: Number(row.revision) } : { ids: [], revision: 0 };
}

/** CAS includes absent-row arbitration; caller supplies the native owner transaction. */
export async function writePins(client: Client, route: number, accountId: string, before: number, ids: string[]) {
  const result = await client.query(
    `INSERT INTO library.collection_pins (route, account_id, collection_ids, revision)
     SELECT $1, $2, $3::uuid[], 1 WHERE $4::bigint=0
     ON CONFLICT (route, account_id) DO NOTHING RETURNING revision`,
    [route, accountId, ids, before],
  );
  if (result.rowCount) return true;
  const updated = await client.query(
    `UPDATE library.collection_pins SET collection_ids=$3::uuid[], revision=revision+1
     WHERE route=$1 AND account_id=$2 AND revision=$4::bigint RETURNING revision`,
    [route, accountId, ids, before],
  );
  return updated.rowCount === 1;
}
