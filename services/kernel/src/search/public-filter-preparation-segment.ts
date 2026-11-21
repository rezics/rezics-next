import { readFileSync } from 'node:fs';
import type { QueryResult, QueryResultRow } from 'pg';
import type {
  PublicFilterProjectionFrontier,
  PublicFilterProjectionRequest,
  PublicFilterSource,
} from '../semantic/index.ts';

/** One raw native candidate and the owner witness that was checked before retention. */
export type PublicFilterPreparationSegmentEntry = Readonly<{
  rawOrdinal: number;
  outputOrdinal: number | null;
  payload: Readonly<{ hit: unknown; owner: Readonly<{ original: string; terminal: string }> }>;
}>;

export type PublicFilterPreparationSegmentKey = Readonly<{
  partition: number;
  registration: string;
  build: string;
  generation: bigint;
}>;

export type PublicFilterPreparationSegmentFrontier = Readonly<{
  rawCount: number;
  outputCount: number;
  after: readonly (string | number | null)[] | undefined;
  rawExhausted: boolean;
  populationVerified?: boolean;
  state: 'missing' | 'building' | 'complete' | 'legacy' | 'erasing';
}>;

export type PreparedSegmentQuery = <Row extends QueryResultRow = QueryResultRow>(
  statement: string,
  values?: unknown[],
) => Promise<QueryResult<Row>>;

export const appendSql = readFileSync(
  new URL('./public-filter-preparation-segment-append.sql', import.meta.url),
  'utf8',
);
export const readSql = readFileSync(new URL('./public-filter-preparation-segment-read.sql', import.meta.url), 'utf8');
export const replaySql = readFileSync(
  new URL('./public-filter-preparation-segment-replay.sql', import.meta.url),
  'utf8',
);
export const retireSql = readFileSync(
  new URL('./public-filter-preparation-segment-retire.sql', import.meta.url),
  'utf8',
);

export function appendPayload(entries: readonly PublicFilterPreparationSegmentEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      raw_ordinal: entry.rawOrdinal,
      output_ordinal: entry.outputOrdinal,
      payload: entry.payload,
    })),
  );
}

export async function insertSegmentRows(
  query: PreparedSegmentQuery,
  key: PublicFilterPreparationSegmentKey,
  entries: readonly PublicFilterPreparationSegmentEntry[],
): Promise<number> {
  if (!entries.length) return 0;
  const result = await query(appendSql, [
    key.partition,
    key.registration,
    key.build,
    key.generation.toString(),
    appendPayload(entries),
  ]);
  return result.rowCount ?? 0;
}

export type SubjectPopulationProjection = Readonly<{
  ordinal: number;
  subject: string;
  frontier: PublicFilterProjectionFrontier;
}>;

/** Resume only the Source-issued frontier for this exact physical candidate and ordinal. */
export async function readPopulationProjection(
  source: PublicFilterSource,
  request: Omit<PublicFilterProjectionRequest, 'frontier'>,
  ordinal: number,
  retained?: SubjectPopulationProjection,
) {
  if (retained && (ordinal !== retained.ordinal || request.subject !== retained.subject)) return null;
  const page = await source.readPublicFilterProjectionPage({ ...request, frontier: retained?.frontier ?? null });
  return {
    page,
    next: page.status === 'progress' ? { ordinal, subject: request.subject, frontier: page.frontier } : undefined,
  };
}

/** Resume duplicate reduction inside the original native window after a partial checkpoint. */
export async function readPopulationTerminals(
  query: PreparedSegmentQuery,
  key: PublicFilterPreparationSegmentKey,
  first: number,
  end: number,
): Promise<string[] | null> {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(end) || first < 0 || end < first || end - first >= 100)
    return null;
  if (first === end) return [];
  const result = await query<{ raw_ordinal: number; terminal: string | null }>(
    `SELECT raw_ordinal,payload #>> '{owner,terminal}' AS terminal
     FROM search.public_filter_preparation_segment
     WHERE (partition_no,registration,build,generation)=($1,$2,$3,$4::numeric)
       AND raw_ordinal >= $5 AND raw_ordinal < $6 ORDER BY raw_ordinal LIMIT 100`,
    [key.partition, key.registration, key.build, key.generation.toString(), first, end],
  );
  if (result.rows.length !== end - first) return null;
  const terminals: string[] = [];
  for (const [offset, row] of result.rows.entries()) {
    if (row.raw_ordinal !== first + offset || !row.terminal) return null;
    terminals.push(row.terminal);
  }
  return terminals;
}

export async function readSegmentWindow(
  query: PreparedSegmentQuery,
  key: PublicFilterPreparationSegmentKey,
  afterOutputOrdinal: number,
  size: number,
) {
  return query<{
    segment_state: PublicFilterPreparationSegmentFrontier['state'];
    raw_count: number;
    output_count: number;
    raw_exhausted: boolean;
    raw_ordinal: number | null;
    output_ordinal: number | null;
    payload: PublicFilterPreparationSegmentEntry['payload'] | null;
  }>(readSql, [key.partition, key.registration, key.build, key.generation.toString(), afterOutputOrdinal, size]);
}

export async function readSegmentReplay(
  query: PreparedSegmentQuery,
  key: PublicFilterPreparationSegmentKey,
  fromRawOrdinal: number,
  toRawOrdinal: number,
) {
  return query<{
    raw_ordinal: number;
    output_ordinal: number | null;
    payload: PublicFilterPreparationSegmentEntry['payload'];
  }>(replaySql, [key.partition, key.registration, key.build, key.generation.toString(), fromRawOrdinal, toRawOrdinal]);
}

export async function retireSegmentRows(
  query: PreparedSegmentQuery,
  key: PublicFilterPreparationSegmentKey,
  limit: number,
): Promise<number> {
  const result = await query(retireSql, [key.partition, key.registration, key.build, key.generation.toString(), limit]);
  return result.rowCount ?? 0;
}
