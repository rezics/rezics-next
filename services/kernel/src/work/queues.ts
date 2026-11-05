import type { DBOS } from '@dbos-inc/dbos-sdk';

export type WorkQueueOptions = NonNullable<Parameters<typeof DBOS.registerQueue>[1]>;

export const LOCATOR_EFFECTS_QUEUE = 'locator-effects';

/** ADR-0033: governance has its own capacity; import enqueues must name their source partition. */
export const WORK_QUEUES = Object.freeze({
  governance: Object.freeze({ workerConcurrency: 2 }),
  effects: Object.freeze({ workerConcurrency: 8, partitionConcurrency: 1 }),
  [LOCATOR_EFFECTS_QUEUE]: Object.freeze({ workerConcurrency: 8, partitionConcurrency: 1 }),
  workflows: Object.freeze({ workerConcurrency: 8 }),
  delivery: Object.freeze({ workerConcurrency: 4 }),
  import: Object.freeze({ workerConcurrency: 2, partitionConcurrency: 1 }),
  maintenance: Object.freeze({ workerConcurrency: 2 }),
} satisfies Record<string, Readonly<WorkQueueOptions>>);

export type WorkQueueName = keyof typeof WORK_QUEUES;
