import type { DBOS } from '@dbos-inc/dbos-sdk';
export type WorkQueueOptions = NonNullable<Parameters<typeof DBOS.registerQueue>[1]>;
export declare const LOCATOR_EFFECTS_QUEUE = "locator-effects";
/** ADR-0033: governance has its own capacity; import enqueues must name their source partition. */
export declare const WORK_QUEUES: Readonly<{
    governance: Readonly<{
        workerConcurrency: 2;
    }>;
    effects: Readonly<{
        workerConcurrency: 8;
        partitionConcurrency: 1;
    }>;
    "locator-effects": Readonly<{
        workerConcurrency: 8;
        partitionConcurrency: 1;
    }>;
    workflows: Readonly<{
        workerConcurrency: 8;
    }>;
    delivery: Readonly<{
        workerConcurrency: 4;
    }>;
    import: Readonly<{
        workerConcurrency: 2;
        partitionConcurrency: 1;
    }>;
    maintenance: Readonly<{
        workerConcurrency: 2;
    }>;
}>;
export type WorkQueueName = keyof typeof WORK_QUEUES;
