import type { PoolClient } from 'pg';
import type { ShelfOwner } from './shelf-maintenance-ops-contract.ts';
type Client = Pick<PoolClient, 'query'>;

/** Also used by the existing account maintenance purge; each transaction removes at most 100 keys. */
export async function cleanupShelfTitleKeys(client: Client, owner: ShelfOwner): Promise<number> {
  const result = await client.query(
    `WITH selected AS MATERIALIZED (SELECT subject_id FROM library.shelf_title_key
       WHERE route=$1 AND account_id=$2::uuid ORDER BY subject_id LIMIT 100)
     DELETE FROM library.shelf_title_key k USING selected s
       WHERE k.route=$1 AND k.account_id=$2::uuid AND k.subject_id=s.subject_id RETURNING k.subject_id`,
    [owner.route, owner.accountId],
  );
  return result.rows.length;
}
