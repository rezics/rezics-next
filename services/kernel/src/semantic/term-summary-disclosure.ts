import type { Pool } from 'pg';
import { privateSubjectReader } from '../access/private-subject-reader.ts';
import { accessEvidenceDeadline } from '../access/evidence-deadline.ts';
import { AccessUnavailableError, requireAccessDeadline, throwAccessUnavailable } from '../access/unavailable.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import { memoizedValue } from '../memoized.ts';
import type { Access, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { SubjectComponent } from './contract/subject-values.ts';
import disclosure from './private-subject-disclosure.sql';

export type TermDetailWitness = {
  id: string;
  component: SubjectComponent;
  revision: number | null;
  securityRevision: string;
};

export function termDisclosureSql() {
  return memoizedValue(termDisclosureSql, () => {
    // Each term read requests one Subject. Expose that cardinality to the planner
    // even on a generic plan, while using the same batched disclosure predicate.
    const source = disclosure.sql
      .trim()
      .replace(/;$/, '')
      .replace(/\$5\b/g, 'ARRAY[$5::integer]')
      .replace(/\$6\b/g, 'ARRAY[$6::uuid]')
      .replace(/\$[78]\b/g, 'transaction_timestamp()');
    return `SELECT d.id, d.visibility, d.target, d.denied, d.revision, d.security_revision,
                   d.epoch, p.position::text
            FROM (${source}) d
            JOIN core.partition p ON p.partition_no = $7::integer`;
  });
}

/** Revalidate the original terms on one fresh statement snapshot. Incomplete account,
 * resource or home evidence returns to the ordinary prepared summary reader. */
export async function termSummaryDisclosure(
  { pool, access, actor, deadline }: { pool: Pool; access: Access; actor: Actor; deadline: number },
  witness: TermDetailWitness,
): Promise<boolean | 'changed' | undefined> {
  if (actor.kind !== 'account') return;
  const reader = privateSubjectReader(access, actor, pool);
  if (!reader) return;
  const until = accessEvidenceDeadline(Math.min(reader.deadline, deadline));
  const { id, component, revision, securityRevision } = witness;
  const result = await withBoundedReadConnection(
    pool,
    until,
    (client) =>
      client.query<{
        id: string | null;
        visibility: string;
        target: string | null;
        denied: boolean;
        revision: number;
        security_revision: string;
        epoch: number;
        position: string;
      }>({
        name: 'subject-term-summary',
        text: termDisclosureSql(),
        values: [
          routeOf(actor.accountId),
          actor.accountId,
          reader.floor,
          reader.accountVersion,
          routeOf(id),
          id,
          component.partition,
        ],
      }),
    {
      deadlineError: () => new AccessUnavailableError('deadline'),
      mapError(error) {
        throwAccessUnavailable(error, until);
        return new AccessUnavailableError('overloaded');
      },
    },
  );
  requireAccessDeadline(until);
  const row = result.rows[0];
  if (row?.id !== id || typeof row.denied !== 'boolean') return;
  if (
    row.epoch !== component.epoch ||
    row.position !== String(component.position) ||
    row.revision !== revision ||
    row.security_revision !== securityRevision ||
    row.visibility !== 'visible' ||
    row.target !== null
  )
    return 'changed';
  return !row.denied;
}
