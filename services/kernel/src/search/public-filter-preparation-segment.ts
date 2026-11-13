import { readFileSync } from 'node:fs';
import type { QueryResult, QueryResultRow } from 'pg';

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
