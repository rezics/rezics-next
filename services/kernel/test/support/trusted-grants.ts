import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { routeOf } from '../../src/route/route.ts';

const ACTIVE_ACCOUNTS_ID = '00000000-0000-0000-0000-000000000000';

/** Installs grants on one exact resource as trusted fixture authority, the same way
 * bootstrap writes its rows: no command, receipt or outbox. Ordinary commands still
 * run their own Access checks. Rows already present for an action are left unchanged.
 */
export async function installResourceGrants(
  pool: Pool,
  resourceId: string,
  subject: Readonly<{ kind: 'identity' | 'active_accounts'; id: string }>,
  actions: readonly string[],
): Promise<void> {
  const route = routeOf(resourceId);
  if (route === null) throw new TypeError('A trusted grant resource id must carry a route');
  if (subject.kind === 'identity' && routeOf(subject.id) === null)
    throw new TypeError('A trusted identity grant subject id must carry a route');
  const subjectId = subject.kind === 'active_accounts' ? ACTIVE_ACCOUNTS_ID : subject.id;
  await pool.query(
    `INSERT INTO access.resource_grant
       (route,resource_id,subject_id,subject_role,action,valid,transaction_id,subject_kind)
     SELECT $1,$2,$3,'',candidate.action,'(,)'::tstzrange,$4,$5
     FROM unnest($6::text[]) AS candidate(action)
     WHERE NOT EXISTS (
       SELECT 1 FROM access.resource_grant existing
       WHERE existing.route=$1 AND existing.resource_id=$2 AND existing.subject_id=$3
         AND existing.subject_role='' AND existing.action=candidate.action
         AND existing.subject_kind=$5 AND existing.valid @> $7::timestamptz
     )`,
    [route, resourceId, subjectId, randomUUID(), subject.kind, [...actions], new Date().toISOString()],
  );
}

export async function installIdentityGrants(
  pool: Pool,
  resourceId: string,
  accountId: string,
  actions: readonly string[],
): Promise<void> {
  await installResourceGrants(pool, resourceId, { kind: 'identity', id: accountId }, actions);
}
