import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import read from './account-erasure-custody-read.sql';
import { readSubjectErasureSourceProof } from './account-erasure-source.ts';
import { readHistoryOwnerCoverage } from '../history/application/index.ts';

/** A pending observation, never a receiving receipt or permission to acknowledge. */
export type SemanticErasureCustody = Readonly<{
  state: 'pending';
  reason: 'local-cleanup' | 'late-locator' | 'producer-contract-unavailable';
}>;

/** Inspect only this participant's native home, without a global-completion dependency.
 * Provisional: the agreed receiving API's registry types and implementation are not delivered here.
 * Even an empty local inbox therefore remains pending, including accounts with no discovered payload.
 */
export async function readSemanticErasureCustody(pool: Pool, accountId: string): Promise<SemanticErasureCustody> {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Erasure requires a routed account id');
  const current = await withConnection(pool, async (client) => {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query('SET LOCAL enable_seqscan=off');
      const value = await read.run(client, { route, account_id: accountId });
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  if (!current) throw new TypeError('No committed account erasure obligation');
  if (current.version !== 1 || !current.sameObligation || !current.localPagesComplete)
    return { state: 'pending', reason: 'local-cleanup' };
  if (current.unsettledLocator) return { state: 'pending', reason: 'late-locator' };
  // The last account checkpoint follows a separate source-home commit. Read that actual receipt,
  // not just its account-home cursor. Release this connection before any eventual receiving call.
  const terminal = await withConnection(pool, async (client) => {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query('SET LOCAL enable_seqscan=off');
      const result = await client.query<{ complete: boolean }>(
        `SELECT state='complete' AND at=$2::timestamptz AS complete
        FROM semantic.erasure_home WHERE partition_no=4095 AND account_id=$1`,
        [accountId, current.at],
      );
      await client.query('COMMIT');
      return result.rows[0]?.complete === true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  if (!terminal) return { state: 'pending', reason: 'local-cleanup' };
  // These are separate native owner proofs, never inferred from local discovery or empty local rows.
  // Their agreed declarations are provisionally unavailable until the producer implementations land.
  const barrier = { accountId, accountRoute: route, version: current.version, at: current.at } as const;
  const context = { deadline: Date.now() + 5_000 } as const;
  const source = await readSubjectErasureSourceProof({ pool }, barrier, context);
  if (!source) return { state: 'pending', reason: 'producer-contract-unavailable' };
  const semantic = await readHistoryOwnerCoverage({ pool }, barrier, 'semantic', context);
  if (semantic.state !== 'complete') return { state: 'pending', reason: 'producer-contract-unavailable' };
  const zones = await readHistoryOwnerCoverage({ pool }, barrier, 'zones', context);
  if (zones.state !== 'complete') return { state: 'pending', reason: 'producer-contract-unavailable' };
  // Coverage alone does not prove that each original receipt/outbox/work artifact and its receiving
  // copies were minimized. The exact artifact list is an Accounts-owned producer output not present
  // in this checkout; remain pending until that port is delivered.
  return { state: 'pending', reason: 'producer-contract-unavailable' };
}
