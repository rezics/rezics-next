import { createHash } from 'node:crypto';
import type { Release } from '@rezics/definitions';
import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import type { IndexedStatement } from '../search/source.ts';
import { readRelease } from './definition-release-read.ts';
import { withoutFencedEntries } from './fences.ts';
import { indexedStatement, type SourceStatementRow } from './scope-leaf-selection.ts';

export const SEARCH_INDEX_STATEMENT_KEYS = 4;
export const SEARCH_INDEX_STATEMENT_BYTES = 65536;
export const SEARCH_INDEX_PROVENANCE_BYTES = 4096;

// Complete ordered active inputs, including a sentinel. A relation or overflow must yield
// before any document can omit those inputs. The active index begins with this exact Subject.
export const readCanonicalStatementCountSql = `SELECT count(*)::integer AS count,coalesce(bool_or(relation),false) AS relations
 FROM (SELECT relation FROM semantic.search_selected
  WHERE (route,subject_id)=($1,$2) AND active LIMIT ${SEARCH_INDEX_STATEMENT_KEYS + 1}) selected`;

export const readCanonicalStatementPresenceSql = `SELECT 1 FROM semantic.search_selected
 WHERE (route,subject_id)=($1,$2) AND active LIMIT 1`;

// The concealed predicate is the ordinary compact statement projection's predicate.
export const readCanonicalStatementsSql = `WITH raw AS MATERIALIZED (
 SELECT route,subject_id,slot_id,candidate_id,property,rank,ordinal,body,release,relation
 FROM semantic.search_selected WHERE (route,subject_id)=($1,$2) AND active
 ORDER BY property,slot_id,candidate_id LIMIT ($3::integer+1)
), selected AS MATERIALIZED (
 SELECT raw.*,row_number() OVER (ORDER BY property,slot_id,candidate_id) AS ordinal_in_window FROM raw
), admitted AS MATERIALIZED (
 SELECT * FROM selected WHERE ordinal_in_window<=$3 AND NOT relation
)
SELECT s.route,s.subject_id::text,s.slot_id::text,s.candidate_id::text,s.property,s.rank,s.ordinal,s.release,s.relation,s.ordinal_in_window,
 (concealed IS NOT NULL) AS concealed,
 CASE WHEN concealed IS NULL
  AND octet_length(s.body::text)<=${SEARCH_INDEX_STATEMENT_BYTES} THEN s.body END AS body
FROM admitted s
LEFT JOIN LATERAL (
 SELECT 1 FROM semantic.hidden_candidate h WHERE (h.route,h.subject_id,h.candidate_id)=(s.route,s.subject_id,s.candidate_id)
 UNION ALL
 SELECT 1 FROM semantic.record_lifecycle l WHERE (l.route,l.subject_id,l.candidate_id)=(s.route,s.subject_id,s.candidate_id)
  AND l.state IN ('deleted','purging','purged')
 UNION ALL
 SELECT 1 FROM semantic.statement_disclosure d WHERE (d.route,d.subject_id,d.candidate_id)=(s.route,s.subject_id,s.candidate_id)
  AND (NOT d.disclosed OR EXISTS (SELECT 1 FROM semantic.retraction r
   WHERE (r.route,r.subject_id,r.candidate_id)=(d.route,d.subject_id,d.candidate_id) LIMIT 1))
 LIMIT 1
) concealed ON true
UNION ALL
SELECT route,subject_id::text,slot_id::text,candidate_id::text,property,rank,ordinal,release,true,ordinal_in_window,true,NULL::jsonb
FROM selected WHERE ordinal_in_window>$3 OR relation
ORDER BY ordinal_in_window`;

export type CanonicalStatementInput = Readonly<{ keys: number; digest: string; release: string }>;
type Selected = SourceStatementRow & {
  route: number;
  slot_id: string;
  candidate_id: string;
  relation: boolean;
  concealed: boolean;
};

export async function readCanonicalStatementCount(tx: CommandTransaction, subject: string) {
  const [row] = (
    await tx.query<{ count: number; relations: boolean }>(readCanonicalStatementCountSql, [routeOf(subject), subject])
  ).rows;
  return row &&
    !row.relations &&
    Number.isInteger(row.count) &&
    row.count >= 0 &&
    row.count <= SEARCH_INDEX_STATEMENT_KEYS
    ? row.count
    : null;
}

/** Complete adopted descriptive values. Native releases, visibility, provenance and fences
 * all come from the same released physical-Pool snapshot as the root Subject. */
export async function readCanonicalIndexStatements(
  tx: CommandTransaction,
  subject: string,
  routeKey: Uint8Array,
  keys: number,
  header: { type: string; digest: string; release: Release },
) {
  if (!Number.isInteger(keys) || keys < 1 || keys > SEARCH_INDEX_STATEMENT_KEYS) return null;
  const { rows } = await tx.query<Selected>(readCanonicalStatementsSql, [routeOf(subject), subject, keys]);
  if (rows.length !== keys || rows.some((row) => row.relation || (!row.concealed && row.body === null))) return null;
  const visible = await withoutFencedEntries(
    tx,
    routeKey,
    rows.filter((row) => !row.concealed),
    SEARCH_INDEX_PROVENANCE_BYTES,
  );
  const releases = new Map<string, Release>([[header.digest, header.release]]);
  const properties = new Map<string, { ordinal: number; statement: IndexedStatement }[]>();
  for (const row of visible) {
    let release = releases.get(row.release);
    if (!release) {
      release = (await readRelease(tx, row.release)) ?? undefined;
      if (!release) return null;
      releases.set(row.release, release);
    }
    const statement = indexedStatement(row, release);
    if (!statement) continue;
    const values = properties.get(row.property) ?? [];
    values.push({ ordinal: row.ordinal, statement });
    properties.set(row.property, values);
  }
  const order = header.release.types[header.type]?.properties ?? [];
  const extra = [...properties.keys()].filter((property) => !order.includes(property)).sort();
  const statements = [...order, ...extra].flatMap((property) =>
    (properties.get(property) ?? [])
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(({ statement }) => statement),
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
      release: header.digest,
    } satisfies CanonicalStatementInput,
  };
}
