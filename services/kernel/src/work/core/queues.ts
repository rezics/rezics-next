import { LOCATOR_EFFECTS_QUEUE, type WorkQueueName, type WorkQueueOptions } from '../contract/vocabulary.ts';

/** ADR-0033: governance has its own capacity; import enqueues must name their source partition. */
export const WORK_QUEUES = Object.freeze({
  governance: Object.freeze({ workerConcurrency: 2 }),
  effects: Object.freeze({ workerConcurrency: 8, partitionConcurrency: 1 }),
  [LOCATOR_EFFECTS_QUEUE]: Object.freeze({ workerConcurrency: 8, partitionConcurrency: 1 }),
  workflows: Object.freeze({ workerConcurrency: 8 }),
  delivery: Object.freeze({ workerConcurrency: 4 }),
  import: Object.freeze({ workerConcurrency: 2, partitionConcurrency: 1 }),
  maintenance: Object.freeze({ workerConcurrency: 2 }),
} satisfies Record<WorkQueueName, Readonly<WorkQueueOptions>>);

export function isWorkQueueName(value: string): value is WorkQueueName {
  return Object.hasOwn(WORK_QUEUES, value);
}
