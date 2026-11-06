import type { WorkApplicationPorts, WorkEnqueueCapture, WorkIntent, WorkQueryClient, WorkSdkClient } from '../contract/index.ts';
export declare function createEnqueue(ports: Pick<WorkApplicationPorts, 'sdkEnqueue' | 'sql'>): {
    enqueue(client: WorkSdkClient, tx: WorkQueryClient, intent: WorkIntent, capture?: WorkEnqueueCapture): Promise<void>;
    hasRetainedCopies(client: WorkQueryClient, workflowId: string): Promise<boolean>;
};
