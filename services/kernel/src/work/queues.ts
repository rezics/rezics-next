import type { DBOS } from '@dbos-inc/dbos-sdk';

export type WorkQueueOptions = NonNullable<Parameters<typeof DBOS.registerQueue>[1]>;

/** ADR-0033: governance has its own capacity; import enqueues must name their source partition. */
export const WORK_QUEUES = Object.freeze({
  governance: Object.freeze({ workerConcurrency: 2 }),
  effects: Object.freeze({}),
  workflows: Object.freeze({}),
  delivery: Object.freeze({}),
  import: Object.freeze({ partitionConcurrency: 1 }),
  maintenance: Object.freeze({}),
} satisfies Record<string, Readonly<WorkQueueOptions>>);

export type WorkQueueName = keyof typeof WORK_QUEUES;
