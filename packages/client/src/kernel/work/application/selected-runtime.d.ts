import type { WorkApplicationPorts, WorkIntent, WorkPool, WorkQueryClient, WorkSdkClient, WorkSelectedIdentity, WorkSelectedRuntime } from '../contract/index.ts';
export declare class SelectedRuntimeUnavailable extends Error {
    readonly gap: string;
    constructor(gap: string);
}
export declare function createSelectedRuntime(ports: WorkApplicationPorts): ((pool: WorkPool, client: WorkSdkClient) => WorkSelectedRuntime) & {
    selectedOperationalEnqueue: (tx: WorkQueryClient, intent: WorkIntent) => ((created: boolean) => void) | undefined;
    assertSelectedOperationalTransaction: (tx: WorkQueryClient, expected: WorkSelectedIdentity) => void;
    selectedLocalQuery: (tx: WorkQueryClient, expected: WorkSelectedIdentity, sql: string, values?: unknown[]) => Promise<import("../contract/vocabulary.ts").WorkQueryResult<Record<string, unknown>>>;
    assertSelectedContinuation: (tx: WorkQueryClient, expected: WorkSelectedIdentity, workflow: string) => void;
    openSelectedOperationalPhase: (pool: WorkPool, options: {
        selectedRuntime?: object;
        workClient: WorkSdkClient;
        mode: string;
        operationalHistory?: unknown;
        partition: number;
        kind: string;
        accounts: readonly string[];
        deadline?: number;
    }) => {
        deadline: number;
        assertLive(): void;
        query(sql: unknown): void;
        hold(tx: WorkQueryClient, raw: WorkQueryClient): Promise<void>;
        guardBody(): void;
        finish(): void;
    };
};
