import { DBOS } from '@dbos-inc/dbos-sdk';
import pg, { type Pool } from 'pg';
import { DBOS_SCHEMA, WORK_APPLICATION } from '../work/client.ts';
import { createWorkClient } from '../work/client.ts';
import { ERASURE_LOCATOR_EFFECTS } from '../access/erasure.ts';
import { LOCATOR_EFFECTS_QUEUE, WORK_QUEUES } from '../work/queues.ts';
import type { Relay } from './relays.ts';
import { lookupEventType } from './catalogue.ts';
import { readBatch, type CloudEvent, type Envelope } from './log.ts';

export { DBOS_SCHEMA } from '../work/client.ts';
export const EFFECTS_QUEUE = 'effects';
export const EFFECTS_CONSUMER = 'effects';

export type Effect = {
  name: string;
  types: string[];
  run(event: CloudEvent): Promise<void>;
};

type WorkOptions = { databaseUrl: string; executorId?: string; systemDatabasePool?: Pool };

export function effectWorkflowId(envelope: Envelope, eventSeq: number, name: string): string {
  return `fx:${envelope.epoch}:${envelope.partition}:${envelope.position}:${eventSeq}:${name}`;
}

export function registerEffects(effects: Effect[]): { enqueue(envelopes: readonly Envelope[]): Promise<void> } {
  const names = new Set<string>();
  for (const effect of effects) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(effect.name)) throw new RangeError(`Invalid effect name: ${effect.name}`);
    if (names.has(effect.name)) throw new RangeError(`Duplicate effect name: ${effect.name}`);
    names.add(effect.name);
    for (const type of effect.types) {
      if (!lookupEventType(type)) throw new RangeError(`Unknown event type for effect ${effect.name}: ${type}`);
    }
  }

  const byName = new Map(effects.map((effect) => [effect.name, effect]));
  const runEffect = DBOS.registerStep(
    async (name: string, event: CloudEvent) => {
      const effect = byName.get(name);
      if (!effect) throw new Error(`Unknown registered effect: ${name}`);
      await effect.run(event);
    },
    { name: 'effect.run', retriesAllowed: true, intervalSeconds: 1, backoffRate: 2, maxAttempts: 10 },
  );
  const workflow = DBOS.registerWorkflow(async (name: string, event: CloudEvent) => runEffect(name, event), {
    name: 'effect',
  });

  return {
    async enqueue(envelopes) {
      const partitions = new Map<
        number,
        Array<{ envelope: Envelope; eventSeq: number; event: CloudEvent; effect: Effect }>
      >();
      for (const envelope of envelopes) {
        for (const [eventSeq, event] of envelope.events.entries()) {
          for (const effect of effects) {
            if (effect.types.includes(event.type)) {
              const jobs = partitions.get(envelope.partition) ?? [];
              jobs.push({ envelope, eventSeq, event, effect });
              partitions.set(envelope.partition, jobs);
            }
          }
        }
      }
      await Promise.all(
        [...partitions.entries()].map(async ([partition, jobs]) => {
          jobs.sort((left, right) =>
            left.envelope.position === right.envelope.position
              ? left.eventSeq - right.eventSeq
              : left.envelope.position < right.envelope.position
                ? -1
                : 1,
          );
          for (const { envelope, eventSeq, event, effect } of jobs) {
            await DBOS.startWorkflow(workflow, {
              workflowID: effectWorkflowId(envelope, eventSeq, effect.name),
              workflowIDReusePolicy: 'return-existing',
              queueName: ERASURE_LOCATOR_EFFECTS.has(effect.name) ? LOCATOR_EFFECTS_QUEUE : EFFECTS_QUEUE,
              enqueueOptions: { queuePartitionKey: `${effect.name}:${partition}` },
            })(effect.name, event);
          }
        }),
      );
    },
  };
}

let worker: { stop(): Promise<void> } | undefined;

/** Compatibility for tests that register effects before launching the shared executor. */
export async function launchWork(options: WorkOptions): Promise<void> {
  const pool = options.systemDatabasePool ?? new pg.Pool({ connectionString: options.databaseUrl, max: 10 });
  const client = await createWorkClient(options.databaseUrl, pool);
  try {
    DBOS.setConfig({
      name: WORK_APPLICATION,
      systemDatabaseUrl: options.databaseUrl,
      systemDatabaseSchemaName: DBOS_SCHEMA,
      systemDatabasePool: pool,
      runMigrations: false,
      logLevel: 'warn',
      ...(options.executorId === undefined ? {} : { executorID: options.executorId }),
    });
    for (const [name, parameters] of Object.entries(WORK_QUEUES)) {
      await client.registerQueue(name, parameters);
    }
    await DBOS.launch();
    worker = {
      async stop() {
        try {
          await DBOS.shutdown({ workflowCompletionTimeoutMS: 2_147_483_647 });
        } finally {
          await client.close();
          if (options.systemDatabasePool === undefined) await pool.end();
        }
      },
    };
  } catch (error) {
    try {
      if (DBOS.isInitialized()) await DBOS.shutdown({ workflowCompletionTimeoutMS: 2_147_483_647 });
    } finally {
      await client.close();
      if (options.systemDatabasePool === undefined) await pool.end();
    }
    throw error;
  }
}

export async function shutdownWork(): Promise<void> {
  await worker?.stop();
}

/** A batch failing after enqueuing is read again and finds the workflows it started. */
export function relayEffects(pool: Pool, effects: ReturnType<typeof registerEffects>, partition: number) {
  return readBatch(pool, { consumer: EFFECTS_CONSUMER, partition, apply: effects.enqueue });
}

export function effectsRelay(pool: Pool, effects: ReturnType<typeof registerEffects>): Relay {
  return {
    consumer: EFFECTS_CONSUMER,
    run: (partition) => relayEffects(pool, effects, partition),
  };
}
