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
 h.slot_id::text,h.kind,encode(sha256(convert_to(h.language,'UTF8')),'hex') AS language_digest,f.terms,f.fact_count
FROM (VALUES (1)) seed(n)
LEFT JOIN head h ON true
LEFT JOIN LATERAL (
 SELECT coalesce(jsonb_agg(CASE WHEN octet_length(body::text)<=2048 THEN body END ORDER BY log_seq)
   FILTER (WHERE operation='assert'),'[]'::jsonb) AS terms,count(*)::integer AS fact_count
 FROM (
   SELECT log_seq,operation,body FROM semantic.fact
   WHERE (route,subject_id,slot_id)=($1,$2,h.slot_id) AND log_seq BETWEEN h.first_seq AND 32
   ORDER BY log_seq LIMIT 32
 ) points
) f ON true`;

// Materialize only as many physical keys as the caller has reserved. Each step pays for the
// head seek, the slot seek and all visited facts before it can advance to the next head.
export const readIdentitySearchIndexTermsSql = `WITH RECURSIVE term_input AS (
 SELECT 0 AS ordinal,''::text AS kind,''::text AS language,NULL::uuid AS slot_id,
   '[]'::jsonb AS terms,$3::integer AS remaining,'progress'::text AS state
 UNION ALL
 SELECT a.ordinal+1,h.kind,h.language,h.slot_id,f.terms,
   a.remaining-1-CASE WHEN h.slot_id IS NULL OR a.remaining=1 THEN 0 ELSE f.fact_count+1 END,
   CASE WHEN h.slot_id IS NULL THEN 'complete'
        WHEN a.remaining=1 OR (a.remaining<34 AND f.fact_count=a.remaining-2) THEN 'pending'
        ELSE 'progress' END
 FROM term_input a
 LEFT JOIN LATERAL (
   SELECT kind,language,slot_id,first_seq FROM semantic.term_head
   WHERE (route,subject_id)=($1,$2) AND active AND (kind,language)>(a.kind,a.language)
   ORDER BY kind,language LIMIT 1
 ) h ON true
 LEFT JOIN LATERAL (
   SELECT coalesce(jsonb_agg(CASE WHEN octet_length(body::text)<=2048 THEN body END ORDER BY log_seq)
       FILTER (WHERE operation='assert'),'[]'::jsonb) AS terms,count(*)::integer AS fact_count
   FROM (
     SELECT log_seq,operation,body FROM semantic.fact
     WHERE (route,subject_id,slot_id)=($1,$2,h.slot_id) AND log_seq BETWEEN h.first_seq AND 32
     ORDER BY log_seq LIMIT greatest(0,least(32,a.remaining-2))
   ) points
 ) f ON true
 WHERE a.state='progress' AND a.remaining>0
)
SELECT kind,CASE WHEN octet_length(language)<=8192 THEN language END AS language,slot_id::text,terms,state,remaining
FROM term_input WHERE ordinal>0 ORDER BY ordinal`;

export const EMPTY_IDENTITY_SEARCH_TERMS_DIGEST = '0'.repeat(64);
export const SEARCH_INDEX_TERM_REPLAY_POINTS = 64;

type IndexTermSlot = {
  kind: 'label' | 'description' | 'alias' | null;
  language: string | null;
  slot_id: string | null;
  terms: unknown;
  state: 'progress' | 'pending' | 'complete';
  remaining: number;
};

/** Live, complete term head window. The caller supplies its native point reservation. */
export async function readIdentitySearchIndexTermSlots(tx: CommandTransaction, subject: string, points: number) {
  if (!Number.isSafeInteger(points) || points < 1 || points > SEARCH_INDEX_TERM_REPLAY_POINTS) return null;
  const { rows } = await tx.query<IndexTermSlot>(readIdentitySearchIndexTermsSql, [routeOf(subject), subject, points]);
  const end = rows.at(-1);
  return end?.state === 'complete' ? { slots: rows.slice(0, -1), remaining: end.remaining } : null;
}

type TermRow = {
  prior_current: boolean;
  slot_id: string | null;
  kind: 'label' | 'description' | 'alias' | null;
  language_digest: string | null;
  terms: unknown[];
  fact_count: number;
};

export function indexTermTexts(values: unknown): string[] {
  if (
    !Array.isArray(values) ||
    values.length > 32 ||
    !values.every((value): value is string => typeof value === 'string')
  )
    throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Search writer term body is unavailable');
  return values;
}

function appendDigest(previous: string, slot: string, kind: string, language: string, terms: readonly string[]) {
  return createHash('sha256')
    .update(JSON.stringify([previous, slot, kind, language, terms]))
    .digest('hex');
}

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
  if (first.slot_id === null) return { state: 'complete' as const, after, digest, points: 1 };
  if (first.kind === null || first.language_digest === null)
    throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Search writer term key is unavailable');
  const terms = indexTermTexts(first.terms);
  if (!Number.isInteger(first.fact_count) || first.fact_count < terms.length || first.fact_count > 32)
    throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Search writer term count is unavailable');
  return {
    state: 'progress' as const,
    after: first.slot_id,
    digest: appendDigest(digest, first.slot_id, first.kind, first.language_digest, terms),
    points: 2 + first.fact_count,
  };
}

export async function readIdentitySearchIndexTerms(
  tx: CommandTransaction,
  subject: string,
  completed: Readonly<{ points: number; digest: string }>,
) {
  const current = await readIdentitySearchIndexTermSlots(tx, subject, completed.points);
  if (current?.remaining !== 0) return null;
  let digest = EMPTY_IDENTITY_SEARCH_TERMS_DIGEST;
  const terms = {
    label: [] as { language: string; value: string }[],
    description: [] as { language: string; value: string }[],
    alias: [] as { language: string; value: string }[],
  };
  for (const row of current.slots) {
    if (row.kind === null || row.language === null || row.slot_id === null || row.state !== 'progress') return null;
    const values = indexTermTexts(row.terms);
    const language = createHash('sha256').update(row.language).digest('hex');
    digest = appendDigest(digest, row.slot_id, row.kind, language, values);
    const current = row.kind === 'alias' ? [...new Set(values)] : values.slice(-1);
    terms[row.kind].push(...current.map((value) => ({ language: row.language!, value })));
  }
  if (digest !== completed.digest) return null;
  for (const values of Object.values(terms))
    values.sort((a, b) => (a.language < b.language ? -1 : a.language > b.language ? 1 : 0));
  return { labels: terms.label, descriptions: terms.description, aliases: terms.alias };
}
