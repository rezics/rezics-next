import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { routeOf } from '../../src/route/route.ts';

/** Installs identity grants on one exact resource as trusted fixture authority, the same way the bootstrap
 * setup writes its rows: no command, receipt or outbox. Ordinary commands still run their own Access checks.
 * Rows already present for an action are left unchanged.
 */
export async function installIdentityGrants(
  pool: Pool,
  resourceId: string,
  accountId: string,
  actions: readonly string[],
): Promise<void> {
  const route = routeOf(resourceId);
  if (route === null) throw new TypeError('A trusted grant resource id must carry a route');
  await pool.query(
    `INSERT INTO access.resource_grant
       (route,resource_id,subject_id,subject_role,action,valid,transaction_id,subject_kind)
     SELECT $1,$2,$3,'',candidate.action,'(,)'::tstzrange,$4,'identity'
     FROM unnest($5::text[]) AS candidate(action)
     WHERE NOT EXISTS (
       SELECT 1 FROM access.resource_grant existing
       WHERE existing.route=$1 AND existing.resource_id=$2 AND existing.subject_id=$3
         AND existing.subject_role='' AND existing.action=candidate.action
         AND existing.subject_kind='identity' AND existing.valid @> $6::timestamptz
     )`,
    [route, resourceId, accountId, randomUUID(), [...actions], new Date().toISOString()],
  );
}
