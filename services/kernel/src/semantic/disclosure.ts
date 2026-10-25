import type { PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';

/** Point read for content. It reports disclosure and never authorizes. */
export async function readCandidateDisclosure(
  client: Pick<PoolClient, 'query'>,
  ref: { subject: string; candidate: string },
): Promise<{ disclosed: boolean; security_revision: number } | null> {
  const route = routeOf(ref.subject);
  if (route === null || routeOf(ref.candidate) !== route) return null;
  const result = await client.query<{
    visibility: string;
    security_revision: string;
    known: boolean;
    hidden: boolean;
  }>(
    `SELECT s.visibility,
            s.security_revision::text AS security_revision,
            (c.candidate_id IS NOT NULL OR f.statement_id IS NOT NULL) AS known,
            (h.candidate_id IS NOT NULL) AS hidden
     FROM semantic.subject s
     LEFT JOIN semantic.candidate c
       ON c.route = s.route AND c.subject_id = s.subject_id AND c.candidate_id = $3
     LEFT JOIN LATERAL (
       SELECT fact.statement_id
       FROM semantic.fact fact
       WHERE fact.route = s.route AND fact.subject_id = s.subject_id AND fact.statement_id = $3
         AND fact.kind = 'statement' AND fact.operation = 'assert'
         AND NOT EXISTS (
           SELECT 1 FROM semantic.fact newer
           WHERE newer.route = fact.route AND newer.subject_id = fact.subject_id
             AND newer.slot_id = fact.slot_id AND newer.statement_id = fact.statement_id
             AND newer.log_seq > fact.log_seq
         )
       LIMIT 1
     ) f ON true
     LEFT JOIN semantic.hidden_candidate h
       ON h.route = s.route AND h.subject_id = s.subject_id AND h.candidate_id = $3
     WHERE s.route = $1 AND s.subject_id = $2`,
    [route, ref.subject, ref.candidate],
  );
  const row = result.rows[0];
  if (!row?.known) return null;
  return {
    disclosed: row.visibility === 'visible' && !row.hidden,
    security_revision: Number(row.security_revision),
  };
}
