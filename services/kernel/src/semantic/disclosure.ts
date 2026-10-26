import type { PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import readCandidateDisclosureStatement from './disclosure-read-candidate.sql';

/** Point read for content. It reports disclosure and never authorizes. */
export async function readCandidateDisclosure(
  client: Pick<PoolClient, 'query'>,
  ref: { subject: string; candidate: string },
): Promise<{ disclosed: boolean; security_revision: number } | null> {
  const route = routeOf(ref.subject);
  if (route === null || routeOf(ref.candidate) !== route) return null;
  const result = await readCandidateDisclosureStatement.run(client, {
    route,
    subject_id: ref.subject,
    candidate_id: ref.candidate,
  });
  const row = Array.isArray(result) ? result[0] : result;
  if (!row?.known) return null;
  return {
    disclosed: row.visibility === 'visible' && !row.hidden,
    security_revision: Number(row.security_revision),
  };
}
