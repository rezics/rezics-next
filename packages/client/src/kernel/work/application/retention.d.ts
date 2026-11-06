import type { WorkApplicationPorts, WorkPool, WorkQueueOptions, WorkSdkClient } from '../contract/index.ts';
type Selector = (input: Readonly<{
    applicationName: string;
    statuses: readonly ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'];
    completedBefore: number;
    limit: number;
}>) => Promise<readonly string[]>;
type Deleter = (ids: readonly string[], descendants: false) => Promise<void>;
export declare function createRetention(ports: Pick<WorkApplicationPorts, 'sdkRuntime' | 'retentionSelector' | 'now'>): {
    runRetentionBatch: (retentionDays: number, now: Date, select: Selector, applicationName: string, deleter?: Deleter) => Promise<number>;
    runRetentionSweep: (retentionDays: number, now: Date, step: (batch: () => Promise<number>) => Promise<number>, select: Selector, applicationName: string, deleter?: Deleter) => Promise<number>;
    registerRetention(context: {
        client: WorkSdkClient;
        env: Readonly<Record<string, string | undefined>>;
        queues: Readonly<Record<string, WorkQueueOptions>>;
        pool: WorkPool;
    }): Promise<void>;
};
export {};
