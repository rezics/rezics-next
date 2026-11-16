import { createHash } from 'node:crypto';
import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import { IdentityEpochStoreError } from './contract/identity-errors.ts';

// The previous slot's first fact recovers the language key without retaining language or term text.
// The active-head index serves one head. The fact PK and log_seq constraint bound its complete slot.
export const readIdentitySearchIndexTermSlotSql = `WITH prior AS MATERIALIZED (
 SELECT p.kind,p.language,p.slot_id
 FROM LATERAL (
   SELECT kind,language,slot_id FROM semantic.fact
   WHERE (route,subject_id,slot_id)=($1,$2,$3::uuid) ORDER BY log_seq LIMIT 1
 ) p
 JOIN semantic.term_head h ON (h.route,h.subject_id,h.kind,h.language)=($1,$2,p.kind,p.language)
  AND h.active AND h.slot_id=p.slot_id
), head AS MATERIALIZED (
 SELECT kind,language,slot_id,first_seq FROM semantic.term_head
 WHERE (route,subject_id)=($1,$2) AND active
  AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM prior))
  AND (kind,language)>(coalesce((SELECT kind FROM prior),''),coalesce((SELECT language FROM prior),''))
 ORDER BY kind,language LIMIT 1
)
SELECT ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM prior)) AS prior_current,
 h.slot_id::text,h.kind,encode(sha256(convert_to(h.language,'UTF8')),'hex') AS language_digest,f.terms
FROM (VALUES (1)) seed(n)
LEFT JOIN head h ON true
LEFT JOIN LATERAL (
 SELECT coalesce(jsonb_agg(CASE WHEN octet_length(body::text)<=2048 THEN body END ORDER BY log_seq)
   FILTER (WHERE operation='assert'),'[]'::jsonb) AS terms
 FROM (
   SELECT log_seq,operation,body FROM semantic.fact
   WHERE (route,subject_id,slot_id)=($1,$2,h.slot_id) AND log_seq BETWEEN h.first_seq AND 32
   ORDER BY log_seq LIMIT 32
 ) points
) f ON true`;

export const EMPTY_IDENTITY_SEARCH_TERMS_DIGEST = '0'.repeat(64);

type TermRow = {
  prior_current: boolean;
  slot_id: string | null;
  kind: 'label' | 'description' | 'alias' | null;
  language_digest: string | null;
  terms: unknown[];
};

/** One complete native term slot, in the order of its actual public Source facts. */
export async function readIdentitySearchIndexTermSlot(
  tx: CommandTransaction,
  subject: string,
  after: string | null,
  digest: string,
) {
  const { rows } = await tx.query<TermRow>(readIdentitySearchIndexTermSlotSql, [routeOf(subject), subject, after]);
  const first = rows[0];
  if (!first?.prior_current)
    throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Search writer term cursor changed');
  if (first.slot_id === null) return { state: 'complete' as const, after, digest };
  if (first.kind === null || first.language_digest === null)
    throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Search writer term key is unavailable');
  if (!Array.isArray(first.terms) || first.terms.length > 32 || first.terms.some((term) => typeof term !== 'string'))
    throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Search writer term body is unavailable');
  return {
    state: 'progress' as const,
    after: first.slot_id,
    digest: createHash('sha256')
      .update(JSON.stringify([digest, first.slot_id, first.kind, first.language_digest, first.terms]))
      .digest('hex'),
  };
}
