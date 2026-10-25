import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { EVENT_TYPES, readBatch, type CloudEvent, type Envelope } from './log.ts';

export const DBOS_SCHEMA = 'dbos';
export const EFFECTS_QUEUE = 'effects';
export const EFFECTS_CONSUMER = 'effects';

export type Effect = {
  name: string;
  types: string[];
  run(event: CloudEvent): Promise<void>;
};

type WorkOptions = { databaseUrl: string; executorId?: string };

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
      if (!Object.hasOwn(EVENT_TYPES, type))
        throw new RangeError(`Unknown event type for effect ${effect.name}: ${type}`);
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
      const starts: Promise<unknown>[] = [];
      for (const envelope of envelopes) {
        for (const [eventSeq, event] of envelope.events.entries()) {
          for (const effect of effects) {
            if (effect.types.includes(event.type)) {
              starts.push(
                DBOS.startWorkflow(workflow, {
                  workflowID: effectWorkflowId(envelope, eventSeq, effect.name),
                  workflowIDReusePolicy: 'return-existing',
                  queueName: EFFECTS_QUEUE,
                })(effect.name, event),
              );
            }
          }
        }
      }
      await Promise.all(starts);
    },
  };
}

export async function launchWork({ databaseUrl, executorId }: WorkOptions): Promise<void> {
  DBOS.setConfig({
    name: 'rezics-kernel',
    systemDatabaseUrl: databaseUrl,
    systemDatabaseSchemaName: DBOS_SCHEMA,
    runMigrations: false,
    logLevel: 'warn',
    ...(executorId === undefined ? {} : { executorID: executorId }),
  });
  await DBOS.launch();
  await DBOS.registerQueue(EFFECTS_QUEUE);
}

export async function shutdownWork(): Promise<void> {
  await DBOS.shutdown();
}

/** A batch failing after enqueuing is read again and finds the workflows it started. */
export function relayEffects(pool: Pool, effects: ReturnType<typeof registerEffects>, partition: number) {
  return readBatch(pool, { consumer: EFFECTS_CONSUMER, partition, apply: effects.enqueue });
}
