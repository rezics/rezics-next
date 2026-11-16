import { createHash } from 'node:crypto';
import type { Release } from '@rezics/definitions';
import { facetProperties, relationFacetProperty } from '@rezics/filter';
import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import type { IndexedStatement } from '../search/source.ts';
import { readRelease } from './definition-release-read.ts';
import { withoutFencedEntries } from './fences.ts';
import { indexedStatement } from './scope-leaf-selection.ts';
import { relationSource, type SelectedStatement } from './search-relations.ts';
import type { WorkHeader } from './credit-search-cut.ts';
import { GLOBAL_CONTEXT } from './contract/global-context.ts';

export const SEARCH_INDEX_STATEMENT_KEYS = 4;
export const SEARCH_INDEX_STATEMENT_BYTES = 65536;
export const SEARCH_INDEX_PROVENANCE_BYTES = 4096;

// The complete active window includes one lookahead key. Overflow must yield before assembly.
export const readCanonicalStatementCountSql = `SELECT count(*)::integer AS count
 FROM (SELECT 1 FROM semantic.search_selected
  WHERE (route,subject_id)=($1,$2) AND active LIMIT ${SEARCH_INDEX_STATEMENT_KEYS + 1}) selected`;

export const readCanonicalStatementPresenceSql = `SELECT 1 FROM semantic.search_selected
 WHERE (route,subject_id)=($1,$2) AND active LIMIT 1`;

// Compact statements and relation facets have different ordinary disclosure predicates.
export const readCanonicalStatementsSql = `WITH raw AS MATERIALIZED (
 SELECT route,subject_id,slot_id,candidate_id,property,rank,ordinal,body,release,revision,relation,compact,source
 FROM semantic.search_selected WHERE (route,subject_id)=($1,$2) AND active
 ORDER BY property,slot_id,candidate_id LIMIT ($3::integer+1)
), selected AS MATERIALIZED (
 SELECT raw.*,row_number() OVER (ORDER BY property,slot_id,candidate_id) AS ordinal_in_window FROM raw
), admitted AS MATERIALIZED (
 SELECT * FROM selected WHERE ordinal_in_window<=$3
), evidence AS MATERIALIZED (
 SELECT s.*,
   (h IS NOT NULL OR l IS NOT NULL OR (d.disclosed IS NOT NULL AND (NOT d.disclosed OR r IS NOT NULL))) AS concealed,
   (s.property=ANY($4::text[]) AND h IS NULL AND r IS NULL AND (d.disclosed IS NULL OR d.disclosed)
     AND (s.compact OR a.verdict='accept' OR (c.origin='compact' AND a.verdict IS NULL))) IS TRUE AS eligible
 FROM admitted s
 LEFT JOIN LATERAL (SELECT 1 FROM semantic.hidden_candidate h
  WHERE (h.route,h.subject_id,h.candidate_id)=(s.route,s.subject_id,s.candidate_id) LIMIT 1) h ON true
 LEFT JOIN LATERAL (SELECT 1 FROM semantic.record_lifecycle l
  WHERE (l.route,l.subject_id,l.candidate_id)=(s.route,s.subject_id,s.candidate_id)
  AND l.state IN ('deleted','purging','purged') LIMIT 1) l ON true
 LEFT JOIN LATERAL (SELECT disclosed FROM semantic.statement_disclosure d
  WHERE (d.route,d.subject_id,d.candidate_id)=(s.route,s.subject_id,s.candidate_id) LIMIT 1) d ON true
 LEFT JOIN LATERAL (SELECT 1 FROM semantic.retraction r
  WHERE (r.route,r.subject_id,r.candidate_id)=(s.route,s.subject_id,s.candidate_id) LIMIT 1) r ON true
 LEFT JOIN LATERAL (SELECT origin FROM semantic.candidate c WHERE s.property=ANY($4::text[])
  AND (c.route,c.subject_id,c.slot_id,c.candidate_id)=(s.route,s.subject_id,s.slot_id,s.candidate_id) LIMIT 1) c ON true
 LEFT JOIN LATERAL (SELECT verdict FROM semantic.acceptance_current a WHERE s.property=ANY($4::text[])
  AND (a.route,a.subject_id,a.context_id,a.candidate_id)=(s.route,s.subject_id,'${GLOBAL_CONTEXT}'::uuid,s.candidate_id)
  LIMIT 1) a ON true
)
SELECT route,subject_id::text,slot_id::text,candidate_id::text,property,rank,ordinal,release,revision,relation,ordinal_in_window,
 concealed,eligible,
 CASE WHEN ((NOT relation AND NOT concealed) OR eligible) AND octet_length(body::text)<=${SEARCH_INDEX_STATEMENT_BYTES}
  THEN body END AS body,
 CASE WHEN eligible AND octet_length(source::text)<=${SEARCH_INDEX_PROVENANCE_BYTES} THEN source END AS source,
 (eligible AND COALESCE(octet_length(source::text),0)>${SEARCH_INDEX_PROVENANCE_BYTES}) AS oversized_source
FROM evidence
UNION ALL
SELECT route,subject_id::text,slot_id::text,candidate_id::text,property,rank,ordinal,release,revision,relation,ordinal_in_window,
 true,false,NULL::jsonb,NULL::jsonb,false
FROM selected WHERE ordinal_in_window>$3
ORDER BY ordinal_in_window`;

export type CanonicalStatementInput = Readonly<{ keys: number; digest: string; release: string }>;
type Selected = SelectedStatement & {
  concealed: boolean;
  oversized_source: boolean;
};

export async function readCanonicalStatementCount(tx: CommandTransaction, subject: string) {
  const [row] = (await tx.query<{ count: number }>(readCanonicalStatementCountSql, [routeOf(subject), subject])).rows;
  return row && Number.isInteger(row.count) && row.count >= 0 && row.count <= SEARCH_INDEX_STATEMENT_KEYS
    ? row.count
    : null;
}

/** Complete admitted descriptive values and ordinary relation samples. Native releases, visibility, provenance and fences
 * all come from the same released physical-Pool snapshot as the root Subject. */
export async function readCanonicalIndexStatements(
  tx: CommandTransaction,
  pool: Pool,
  subject: WorkHeader,
  routeKey: Uint8Array,
  keys: number,
  release: Release,
  runtime: { digest: string; head: number; release: Release },
) {
  if (!Number.isInteger(keys) || keys < 1 || keys > SEARCH_INDEX_STATEMENT_KEYS) return null;
  const relationProperties = facetProperties(runtime.release, [subject.type]).filter((property) =>
    relationFacetProperty(runtime.release, property),
  );
  const { rows } = await tx.query<Selected>(readCanonicalStatementsSql, [
    subject.route,
    subject.id,
    keys,
    relationProperties,
  ]);
  const relationRows = rows.filter((row) => row.eligible === true);
  const descriptiveRows = rows.filter((row) => !row.relation && !row.concealed);
  if (
    !subject.currentRelease ||
    rows.length !== keys ||
    relationRows.some((row) => row.oversized_source || row.body === null) ||
    descriptiveRows.some((row) => row.body === null)
  )
    return null;
  const visible = await withoutFencedEntries(tx, routeKey, descriptiveRows, SEARCH_INDEX_PROVENANCE_BYTES);
  const releases = new Map<string, Release>([[subject.currentRelease, release]]);
  for (const digest of new Set([...visible, ...relationRows].map((row) => row.release))) {
    if (releases.has(digest)) continue;
    const rowRelease = await readRelease(tx, digest);
    if (!rowRelease) return null;
    releases.set(digest, rowRelease);
  }
  const properties = new Map<string, { ordinal: number; statement: IndexedStatement }[]>();
  for (const row of visible) {
    const statement = indexedStatement(row, releases.get(row.release)!);
    if (!statement) continue;
    const values = properties.get(row.property) ?? [];
    values.push({ ordinal: row.ordinal, statement });
    properties.set(row.property, values);
  }
  const order = release.types[subject.type]?.properties ?? [];
  const extra = [...properties.keys()].filter((property) => !order.includes(property)).sort();
  const statements = [...order, ...extra].flatMap((property) =>
    (properties.get(property) ?? [])
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(({ statement }) => statement),
  );
  if (relationRows.length)
    statements.push(
      ...(await relationSource(pool, routeKey).projectSelectedRelationsInSnapshot(
        tx,
        subject,
        relationRows,
        releases,
        runtime,
      )),
    );
  return {
    statements,
    properties: new Set(rows.map((row) => row.property)),
    proof: {
      keys,
      digest: createHash('sha256')
        .update(
          JSON.stringify([
            rows.map(({ slot_id, candidate_id, property }) => [slot_id, candidate_id, property]),
            statements,
          ]),
        )
        .digest('hex'),
      release: subject.currentRelease,
    } satisfies CanonicalStatementInput,
  };
}
