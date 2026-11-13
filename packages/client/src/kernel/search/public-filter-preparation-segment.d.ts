import type { QueryResult, QueryResultRow } from 'pg';
/** One raw native candidate and the owner witness that was checked before retention. */
export type PublicFilterPreparationSegmentEntry = Readonly<{
    rawOrdinal: number;
    outputOrdinal: number | null;
    payload: Readonly<{
        hit: unknown;
        owner: Readonly<{
            original: string;
            terminal: string;
        }>;
    }>;
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
export type PreparedSegmentQuery = <Row extends QueryResultRow = QueryResultRow>(statement: string, values?: unknown[]) => Promise<QueryResult<Row>>;
export declare const appendSql: string;
export declare const readSql: string;
export declare const replaySql: string;
export declare const retireSql: string;
export declare function appendPayload(entries: readonly PublicFilterPreparationSegmentEntry[]): string;
export declare function insertSegmentRows(query: PreparedSegmentQuery, key: PublicFilterPreparationSegmentKey, entries: readonly PublicFilterPreparationSegmentEntry[]): Promise<number>;
export declare function readSegmentWindow(query: PreparedSegmentQuery, key: PublicFilterPreparationSegmentKey, afterOutputOrdinal: number, size: number): Promise<QueryResult<{
    segment_state: PublicFilterPreparationSegmentFrontier['state'];
    raw_count: number;
    output_count: number;
    raw_exhausted: boolean;
    raw_ordinal: number | null;
    output_ordinal: number | null;
    payload: PublicFilterPreparationSegmentEntry['payload'] | null;
}>>;
export declare function readSegmentReplay(query: PreparedSegmentQuery, key: PublicFilterPreparationSegmentKey, fromRawOrdinal: number, toRawOrdinal: number): Promise<QueryResult<{
    raw_ordinal: number;
    output_ordinal: number | null;
    payload: PublicFilterPreparationSegmentEntry['payload'];
}>>;
export declare function retireSegmentRows(query: PreparedSegmentQuery, key: PublicFilterPreparationSegmentKey, limit: number): Promise<number>;
