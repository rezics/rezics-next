import type { WorkApplicationPorts, WorkPool, WorkQueryClient, WorkScopedRequest, WorkSdkClient } from '../contract/index.ts';
export declare function createHistoryWork(ports: Pick<WorkApplicationPorts, 'history' | 'sdkEnqueue' | 'sql'>): {
    stageHistoryWork(tx: WorkQueryClient, input: WorkScopedRequest): Promise<void>;
    receiveMappedHistoryWork(tx: WorkQueryClient, _client: WorkSdkClient, custodyId: string, source: {
        partition: number;
        transactionId: string;
    }, request: WorkScopedRequest): Promise<'admitted' | 'retired'>;
    receiveHistoryWork(pool: WorkPool, _client: WorkSdkClient, sourcePartition: number, workId: string): Promise<'admitted' | 'retired'>;
    settleHistoryWork(tx: WorkQueryClient, input: {
        partition: number;
        workId: string;
        digest: Uint8Array;
        owner: string;
    }): Promise<void>;
};
