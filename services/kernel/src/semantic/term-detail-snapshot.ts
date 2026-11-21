import type { Pool } from 'pg';
import { accessEvidenceDeadline } from '../access/evidence-deadline.ts';
import { privateSubjectReader } from '../access/private-subject-reader.ts';
import { AccessUnavailableError, requireAccessDeadline, throwAccessUnavailable } from '../access/unavailable.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import { memoizedValue } from '../memoized.ts';
import type { Access, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { GLOBAL_SUBJECT_CONTEXT, type SubjectComponent } from './contract/subject-values.ts';
import { verifiedBaseRelease } from './definition-release-read.ts';
import type { SubjectReadRow } from './subject-reading-application.ts';
import { termDisclosureSql } from './term-summary-disclosure.ts';
import detailSources from './read-subject-detail-sources.sql';
import subjectTerms from './read-subject.sql';

/** Bind the ordinary owner's named operands to columns of this statement. */
function correlate(statement: { sql: string; params: readonly string[] }, columns: Record<string, string>) {
  return statement.sql
    .trim()
    .replace(/;$/, '')
    .replace(/\$(\d+)\b/g, (_, index: string) => {
      const name = statement.params[Number(index) - 1]!;
      if (!Object.hasOwn(columns, name)) throw new TypeError('Unknown subject detail operand: ' + name);
      return columns[name]!;
    });
}

export function termDetailSql() {
  return memoizedValue(termDetailSql, () => {
    const terms = correlate(subjectTerms, { route: 'eligible.route', subject_id: 'eligible.subject_id' });
    const sources = correlate(detailSources, {
      route: 'k.route',
      subject_id: 'k.subject_id',
      global_context: 'true',
      include_members: 'false',
    });
    // Each active head has one slot with at most 33 log positions. Both the head
    // sentinel and the output sentinel hand wide subjects back to the ordinary reader.
    return `WITH disclosure AS MATERIALIZED (${termDisclosureSql()}),
      eligible AS MATERIALIZED (
        SELECT k.route, k.subject_id, d.epoch, d.position, active.digest
        FROM disclosure d
        CROSS JOIN LATERAL (SELECT ($5::integer[])[1] AS route, d.id::uuid AS subject_id) k
        CROSS JOIN LATERAL (SELECT digest FROM semantic.definition_activation
                            WHERE route=0 ORDER BY head DESC LIMIT 1) active
        WHERE d.id IS NOT NULL AND d.visibility='visible' AND d.target IS NULL AND d.denied IS FALSE
          AND EXISTS (SELECT 1 FROM core.consumer_checkpoint
                      WHERE consumer='semantic_links' AND partition_no=$7
                        AND (epoch,position)>=(d.epoch,d.position::bigint))
          AND NOT EXISTS (
            SELECT 1 FROM unnest($8::integer[], $9::integer[], $10::bigint[]) seen(partition_no,epoch,position)
            WHERE NOT EXISTS (SELECT 1 FROM core.consumer_checkpoint c
              WHERE c.consumer='semantic_links' AND c.partition_no=seen.partition_no
                AND (c.epoch,c.position)>=(seen.epoch,seen.position)))
          AND NOT EXISTS (SELECT 1 FROM semantic.context_extension_head(0,$11::uuid))
          AND NOT EXISTS (SELECT 1 FROM semantic.merge_member WHERE route=k.route AND subject_id=k.subject_id)
          AND (SELECT sources.terms_only FROM (${sources}) sources)
          AND NOT EXISTS (SELECT 1 FROM semantic.term_head WHERE route=k.route AND subject_id=k.subject_id AND active OFFSET 32)
      )
      SELECT terms.*, eligible.epoch, eligible.position, eligible.digest,
             terms.slot_id IS NULL OR (support.revision IS NOT NULL AND (support.source IS NULL OR support.source='null'::jsonb)) AS supported
      FROM eligible
      CROSS JOIN LATERAL (${terms}) terms
      LEFT JOIN semantic.revision support ON support.route=eligible.route AND support.subject_id=eligible.subject_id
                                        AND support.revision=terms.fact_revision
      ORDER BY terms.slot_id, terms.log_seq LIMIT 33`;
  });
}

/** One fresh native statement can prove a small Global term detail. A missed shape
 * or incomplete witness leaves all disclosure, redirect and wait decisions to the full reader. */
export async function readTermDetailSnapshot(
  runtime: { pool: Pool; access: Access; actor: Actor; deadline: number },
  id: string,
  seen: readonly SubjectComponent[],
) {
  const { pool, access, actor, deadline } = runtime;
  if (actor.kind !== 'account') return;
  const reader = privateSubjectReader(access, actor, pool);
  const route = routeOf(id);
  if (!reader || route === null) return;
  const partition = partitionOf(route);
  const until = accessEvidenceDeadline(Math.min(deadline, reader.deadline));
  const { rows } = await withBoundedReadConnection(
    pool,
    until,
    (client) =>
      client.query<SubjectReadRow & { epoch: number; position: string; digest: string; supported: boolean }>({
        name: 'subject-term-detail',
        text: termDetailSql(),
        values: [
          routeOf(actor.accountId),
          actor.accountId,
          reader.floor,
          reader.accountVersion,
          [route],
          [id],
          partition,
          seen.map((c) => c.partition),
          seen.map((c) => c.epoch),
          seen.map((c) => String(c.position)),
          GLOBAL_SUBJECT_CONTEXT,
        ],
      }),
    {
      deadlineError: () => new AccessUnavailableError('deadline'),
      mapError(error) {
        throwAccessUnavailable(error);
        return error;
      },
    },
  );
  requireAccessDeadline(until);
  const first = rows[0];
  if (!first || rows.length > 32 || !rows.every((row) => row.supported) || first.release !== first.digest) return;
  const release = verifiedBaseRelease(first.digest);
  if (!release) return;
  return { rows, release, component: { partition, epoch: first.epoch, position: BigInt(first.position) } };
}
