import type { WorkApplicationPorts, WorkDispatchCost, WorkPool, WorkQueryClient, WorkRetirementInvocation, WorkSdkClient, WorkWriterState } from '../contract/index.ts';
export declare function createRetirement(ports: Pick<WorkApplicationPorts, 'sdkRetirement' | 'history'>): {
    retireWriters(actualWorkflowId: string): Promise<Readonly<{
        workflowID: string;
        generation: string;
        closureID: string;
        closedAt: number;
    }>>;
    invokeRetirement(actualWorkflowId: string, client: WorkSdkClient, invocation: WorkRetirementInvocation): Promise<Readonly<{
        fence: import("../contract/vocabulary.ts").WorkRetirementFence;
        attempts: number;
        failedWork: readonly import("../contract/vocabulary.ts").WorkRetirementFailedWork[];
    }>>;
    readRetirement(actualWorkflowId: string): Promise<Readonly<{
        workflowID: string;
        generation: string;
        closureID: string;
        closedAt: number;
    }> | null>;
    readWriterState(actualWorkflowId: string, client: WorkSdkClient): Promise<Readonly<{
        workflowID: string;
        generation: string;
        restoreGeneration: string;
        closureID: string | null;
        closedAt: number | null;
    }> | null>;
    lockWriterState(tx: WorkQueryClient, expected: WorkWriterState, client: WorkSdkClient): Promise<Readonly<{
        workflowID: string;
        generation: string;
        restoreGeneration: string;
        closureID: string | null;
        closedAt: number | null;
    }>>;
    maintainOnce(pool: WorkPool, client: WorkSdkClient, expected: WorkWriterState, action: 'retire' | 'delete', deadline: number, reserve: (cost: WorkDispatchCost) => Promise<void>): Promise<Readonly<{
        workflowID: string;
        generation: string;
        closureID: string;
        closedAt: number;
    }> | null>;
};
