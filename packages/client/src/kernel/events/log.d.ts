import type { Pool } from 'pg';
export { EVENT_TYPES } from './catalogue.ts';
export declare const BATCH_ENVELOPES = 64;
export type CloudEvent = {
    specversion: '1.0';
    id: string;
    source: string;
    type: string;
    subject?: string;
    time: string;
    datacontenttype: 'application/json';
    sequence: string;
    data: unknown;
};
export type Envelope = {
    partition: number;
    epoch: number;
    position: bigint;
    events: CloudEvent[];
};
export type StopReason = 'gap' | 'epoch' | 'unknown_type' | 'invalid_data';
export type BatchResult = {
    status: 'busy';
} | {
    status: 'read';
    envelopes: number;
    position: bigint;
} | {
    status: 'stopped';
    reason: StopReason;
    envelopes: number;
    position: bigint;
};
type LogRow = {
    head_epoch: number | null;
    position: bigint | null;
    event_seq: number | null;
    event_count: number | null;
    epoch: number | null;
    id: string | null;
    type: string | null;
    subject: string | null;
    data: unknown;
    time: string | null;
    payload_state: string | null;
};
declare function logPoint(row: LogRow): {
    epoch: number | null;
    position: string;
    eventSeq: number | null;
    eventId: string | null;
    type: string | null;
};
export type ProjectionProgress = {
    stage: 'read' | 'read_busy' | 'checkpoint' | 'checkpoint_busy' | 'checkpoint_advanced';
} | {
    stage: 'released';
    checkpoint: string;
    readThrough: string;
    validatedThrough: string;
    first?: ReturnType<typeof logPoint>;
    blocked?: ReturnType<typeof logPoint>;
    reason?: StopReason;
};
/**
 * Reads and applies one short transactional batch. `apply` runs inside the open transaction, whose
 * session becomes idle in a transaction after five seconds, so effects should only record or enqueue work.
 */
export declare function readBatch(pool: Pool, options: {
    consumer: string;
    partition: number;
    apply: (envelopes: readonly Envelope[]) => Promise<void>;
    envelopes?: number;
}): Promise<BatchResult>;
/** Reads a batch, releases the connection before applying it, then compare-and-sets its checkpoint. */
export declare function projectBatch(pool: Pool, options: {
    consumer: string;
    partition: number;
    apply: (envelopes: readonly Envelope[]) => Promise<void>;
    envelopes?: number;
    observe?: (progress: ProjectionProgress) => void;
}): Promise<BatchResult>;
