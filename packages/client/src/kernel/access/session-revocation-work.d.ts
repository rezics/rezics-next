import type { WorkContext } from '../work/registry.ts';
/** The trusted native Auth host, supplied by the Work composition. */
export type CommittedSessionRevocationWorkflow = {
    resumeCommittedSessionRevocation(input: {
        accountId: string;
        operationKey: string;
    }): Promise<void>;
};
/** Work's effect workflow keeps the committed event as its durable input. Its
 * stable event identity and bounded DBOS step retries survive worker restarts. */
export declare function registerSessionRevocationWork(context: WorkContext, auth: CommittedSessionRevocationWorkflow): void;
