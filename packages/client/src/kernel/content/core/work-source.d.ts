export type ContentWorkSourceIdentity = Readonly<{
    partition: number;
    epoch: number;
    position: bigint;
}>;
/** Envelope identity is a value. Route/partition matching stays with the adapter that owns routing. */
export declare function parseWorkSourceUrn(source: string): {
    partition: number;
    epoch: number;
} | null;
export declare function admitWorkEventEnvelope(input: {
    source: string;
    id: string;
    sequence: string;
    specversion: string;
    datacontenttype: string;
}): ContentWorkSourceIdentity | null;
export declare function admitWorkSource(input: {
    partition: number;
    epoch: number;
    eventIndex: number;
    position: string;
}): boolean;
export declare function workerDeadline(now: number, budgetMs: number): number;
export declare function admitCollectionPartitions(partitions: readonly number[], partitionCount: number): boolean;
