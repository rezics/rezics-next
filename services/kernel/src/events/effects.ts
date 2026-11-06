import { DBOS } from '@dbos-inc/dbos-sdk';
import pg, { type Pool, type PoolClient } from 'pg';
import { DBOS_SCHEMA, WORK_APPLICATION } from '../work/client.ts';
import { createWorkClient } from '../work/client.ts';
import { ERASURE_LOCATOR_EFFECTS } from '../access/erasure.ts';
import { LOCATOR_EFFECTS_QUEUE, WORK_QUEUES } from '../work/queues.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { Relay } from './relays.ts';
import { lookupEventType } from './catalogue.ts';
import { projectBatch, type CloudEvent, type Envelope } from './log.ts';
import { associateIdentityFxOriginal, isIdentityOriginalEffect, requireIdentityFxOriginalDispatch } from '../history/application/index.ts';

export { DBOS_SCHEMA } from '../work/client.ts';
export const EFFECTS_QUEUE = 'effects';
export const EFFECTS_CONSUMER = 'effects';

export type Effect = {
  name: string;
  types: string[];
  delivery?: undefined;
  run(event: CloudEvent): Promise<void>;
  admit?: (client: PoolClient, event: CloudEvent) => Promise<void>;
};
export type NativeEffect = {
  name: string;
  types: string[];
  delivery: 'native';
  admit(client: PoolClient, event: CloudEvent): Promise<void>;
};
type RegisteredEffect = Effect | NativeEffect;

type RegisteredEffects = {
  enqueue(envelopes: readonly Envelope[]): Promise<void>;
  admit?: (client: PoolClient, envelopes: readonly Envelope[]) => Promise<void>;
};
const identityOriginalPreparations = new WeakMap<
  RegisteredEffects,
  (envelopes: readonly Envelope[]) => Promise<void>
>();

type WorkOptions = { databaseUrl: string; executorId?: string; systemDatabasePool?: Pool };

export function effectWorkflowId(envelope: Envelope, eventSeq: number, name: string): string {
  return `fx:${envelope.epoch}:${envelope.partition}:${envelope.position}:${eventSeq}:${name}`;
}

let compatibilityPool: Pool | undefined;

export function registerEffects(effects: RegisteredEffect[], pool?: Pool): RegisteredEffects {
  const names = new Set<string>();
  for (const effect of effects) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(effect.name)) throw new RangeError(`Invalid effect name: ${effect.name}`);
    if (names.has(effect.name)) throw new RangeError(`Duplicate effect name: ${effect.name}`);
    names.add(effect.name);
    for (const type of effect.types) {
      if (type === 'com.rezics.history.minimized.v1') throw new TypeError('A minimized marker has no effect consumers');
      if (!lookupEventType(type)) throw new RangeError(`Unknown event type for effect ${effect.name}: ${type}`);
    }
  }
  const fanout = new Map<string, number>();
  for (const effect of effects)
    for (const type of new Set(effect.types)) {
      const count = (fanout.get(type) ?? 0) + 1;
      if (count > 32) throw new TypeError('History effect fanout exceeds 32 consumers');
      fanout.set(type, count);
    }

  const byName = new Map(effects.map((effect) => [effect.name, effect]));
  const runEffect = DBOS.registerStep(
    async (name: string, event: CloudEvent) => {
      const effect = byName.get(name);
      if (!effect || effect.delivery === 'native') throw new Error('Unknown durable effect');
      if (isIdentityOriginalEffect(effect, event)) {
        const selected = pool ?? compatibilityPool;
        if (!selected) throw new Error('Identity original requires the actual work Pool');
        requireIdentityFxOriginalDispatch(effect, selected);
      }
      await effect.run(event);
      const selected = pool ?? compatibilityPool;
      if (selected)
        await selected.query(
          "UPDATE core.history_event_consumer SET state='completed' WHERE workflow_id=$1 AND state='open'",
          [DBOS.workflowID],
        );
    },
    { name: 'effect.run', retriesAllowed: true, intervalSeconds: 1, backoffRate: 2, maxAttempts: 10 },
  );
  const locatorPool = () => {
    const selected = pool ?? compatibilityPool;
    if (!selected) throw new Error('Locator effects require the work database pool');
    return selected;
  };
  const done = DBOS.registerStep(
    async (workflowId: string) => {
      await locatorPool().query(
        "UPDATE access.erasure_locator_work SET state='done' WHERE workflow_id=$1 AND state='open'",
        [workflowId],
      );
    },
    { name: 'effect.locator.done', retriesAllowed: true, maxAttempts: 10 },
  );
  const workflow = DBOS.registerWorkflow(
    async (name: string, event: CloudEvent) => {
      await runEffect(name, event);
      if (ERASURE_LOCATOR_EFFECTS.has(name)) await done(DBOS.workflowID!);
    },
    { name: 'effect' },
  );

  const admit = async (client: PoolClient, envelopes: readonly Envelope[]) => {
    const orderedEnvelopes = envelopes
      .map((envelope, index) => ({ envelope, index }))
      .sort((left, right) => {
        if (left.envelope.position < right.envelope.position) return -1;
        if (left.envelope.position > right.envelope.position) return 1;
        return left.index - right.index;
      });
    for (const { envelope } of orderedEnvelopes) {
      for (const [eventSeq, event] of envelope.events.entries()) {
        for (const effect of effects) {
          if (!effect.types.includes(event.type)) continue;
          await client.query(
            `INSERT INTO core.history_event_consumer(partition_no,position,event_seq,consumer,workflow_id)
                 VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [
              envelope.partition,
              envelope.position.toString(),
              eventSeq,
              effect.name,
              effectWorkflowId(envelope, eventSeq, effect.name),
            ],
          );
          if (effect.admit) await effect.admit(client, event);
          if (effect.delivery === 'native')
            await client.query(
              `UPDATE core.history_event_consumer SET state='transferred'
                 WHERE partition_no=$1 AND position=$2 AND event_seq=$3 AND consumer=$4 AND state='open'`,
              [envelope.partition, envelope.position.toString(), eventSeq, effect.name],
            );
        }
      }
    }
  };

  // Independent native source and receiving commands finish before the generic consumer
  // transaction opens. Neither a consumer state nor a child receipt issues this association.
  const prepareIdentityOriginals = async (envelopes: readonly Envelope[]) => {
    for (const envelope of envelopes)
      for (const [eventSeq, event] of envelope.events.entries()) {
        for (const effect of effects)
          if (effect.delivery !== 'native' && isIdentityOriginalEffect(effect, event)) {
            await associateIdentityFxOriginal(
              effect,
              locatorPool(),
              envelope,
              eventSeq,
              effectWorkflowId(envelope, eventSeq, effect.name),
            );
          }
      }
  };

  const registered: RegisteredEffects = {
    ...(admit === undefined ? {} : { admit }),
    async enqueue(envelopes) {
      // Direct enqueuers converge on the same durable original too.
      await prepareIdentityOriginals(envelopes);
      const partitions = new Map<
        number,
        Array<{ envelope: Envelope; eventSeq: number; event: CloudEvent; effect: RegisteredEffect }>
      >();
      for (const envelope of envelopes) {
        for (const [eventSeq, event] of envelope.events.entries()) {
          for (const effect of effects) {
            if (effect.delivery !== 'native' && effect.types.includes(event.type)) {
              const jobs = partitions.get(envelope.partition) ?? [];
              jobs.push({ envelope, eventSeq, event, effect });
              partitions.set(envelope.partition, jobs);
            }
          }
        }
      }
      const locatorRows = [...partitions.values()].flatMap((jobs) =>
        jobs
          .filter(({ effect }) => ERASURE_LOCATOR_EFFECTS.has(effect.name))
          .map(({ envelope, eventSeq, effect }) => ({
            workflow_id: effectWorkflowId(envelope, eventSeq, effect.name),
            effect: effect.name,
          })),
      );
      if (locatorRows.length > 0) {
        // A separate autocommit transaction precedes every enqueue, including partial batch failure.
        await locatorPool().query(
          `INSERT INTO access.erasure_locator_work(workflow_id,effect,opened_at)
           SELECT workflow_id,effect,ceil(extract(epoch FROM clock_timestamp()) * 1000)::bigint
           FROM jsonb_to_recordset($1::jsonb) AS x(workflow_id text,effect text)
           ON CONFLICT (workflow_id) DO NOTHING`,
          [JSON.stringify(locatorRows)],
        );
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
            if (isIdentityOriginalEffect(effect, event))
              requireIdentityFxOriginalDispatch(effect as Effect, locatorPool());
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
  identityOriginalPreparations.set(registered, prepareIdentityOriginals);
  return registered;
}

let worker: { stop(): Promise<void> } | undefined;

/** Compatibility for tests that register effects before launching the shared executor. */
export async function launchWork(options: WorkOptions): Promise<void> {
  const pool = options.systemDatabasePool ?? new pg.Pool({ connectionString: options.databaseUrl, max: 10 });
  compatibilityPool = pool;
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
  return projectBatch(pool, {
    consumer: EFFECTS_CONSUMER,
    partition,
    apply: async (envelopes) => {
      await identityOriginalPreparations.get(effects)?.(envelopes);
      if (effects.admit) {
        await withConnection(pool, async (client) => {
          await client.query('BEGIN');
          try {
            await effects.admit!(client, envelopes);
            await client.query('COMMIT');
          } catch (error) {
            try {
              await client.query('ROLLBACK');
            } catch (rollbackError) {
              discardConnection(
                client,
                rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
              );
            }
            throw error;
          }
        });
      }
      await effects.enqueue(envelopes);
    },
  });
}

export function effectsRelay(pool: Pool, effects: ReturnType<typeof registerEffects>): Relay {
  return {
    consumer: EFFECTS_CONSUMER,
    run: (partition) => relayEffects(pool, effects, partition),
  };
}
