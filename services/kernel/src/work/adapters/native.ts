import canonicalize from 'canonicalize';
import { DBOS, DBOSClient, type WorkflowWriterFence, type WorkflowWriterState } from '@dbos-inc/dbos-sdk';
import { isBound } from '@rezics/bounds';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { systemClock } from '../../clock.ts';
import type { OperationalOptions, OperationalTransaction } from '../../command/operational.ts';
import { HistoryRegistry, IDENTITY_FX_EFFECT } from '../../history/contract/index.ts';
import {
  associateSelectedEpisode,
  bindIdentityOriginalEffect,
  finishSelectedEpisode,
} from '../../history/application/index.ts';
import { partitionOf, routeOf } from '../../route/route.ts';
import { assertSelectedWorkClient } from './client-binding.ts';
import type { HistoryAssociationPort } from '../contract/index.ts';
import type {
  WorkApplicationPorts,
  WorkEffect,
  WorkPool,
  WorkQueryClient,
  WorkRegisteredEffects,
  WorkSdkClient,
  WorkSdkConfig,
  WorkSelectedIdentity,
  WorkSelectedLocator,
  WorkWriterState,
} from '../contract/index.ts';

type BoundedSdk = DBOSClient & {
  maintainWorkflowOnce(
    pool: Pool,
    expected: WorkflowWriterState,
    action: 'retire' | 'delete',
    deadline: number,
    reserve: (dispatch: string) => Promise<void>,
  ): Promise<WorkflowWriterFence | null>;
  selectedExecutionIdentity(claim: object, pool: Pool): WorkSelectedIdentity;
  consumeSelectedExecutionAdmission(claim: object, pool: Pool): Promise<boolean>;
  checkSelectedExecutionInTransaction(tx: Pick<PoolClient, 'query'>, pool: Pool, claim: object): Promise<void>;
};

type RuntimeSdk = typeof DBOS & {
  registerSelectedStep<A extends unknown[], R>(
    body: (...args: A) => Promise<R>,
    config: { name: string },
    lifecycle: object,
  ): (...args: A) => Promise<R>;
  getSelectedExecution(): object | undefined;
};

function asPool(pool: WorkPool): Pool {
  return pool as Pool;
}

function asSdk(client: WorkSdkClient): DBOSClient {
  if (!(client instanceof DBOSClient)) throw new TypeError('An actual SDK owner client is required');
  return client;
}

function asBounded(client: WorkSdkClient): BoundedSdk {
  return asSdk(client) as BoundedSdk;
}

function load<T>(specifier: string): T {
  return require(specifier) as T;
}

const RETAINED_TABLES = [
  ['workflow_status', 'workflow_uuid'],
  ['workflow_input', 'workflow_uuid'],
  ['workflow_output', 'workflow_uuid'],
  ['operation_outputs', 'workflow_uuid'],
  ['workflow_events', 'workflow_uuid'],
  ['workflow_events_history', 'workflow_uuid'],
  ['notifications', 'destination_uuid'],
  ['streams', 'workflow_uuid'],
] as const;

/** Native SDK, SQL, clock, authorization, receipt and selected-admission ports. */
export function createNativeWorkPorts(): WorkApplicationPorts {
  let history: HistoryAssociationPort | undefined;
  return {
    sdkEnqueue: {
      async enqueueInTransaction(sdk, tx, intent, capture) {
        const work = asSdk(sdk);
        const client = tx as PoolClient;
        const checked = new Proxy(client, {
          get(target, property) {
            if (property !== 'query') return Reflect.get(target, property, target);
            return async (sql: string, values: unknown[]) => {
              const result: QueryResult = await target.query(sql, values);
              if (result.fields.some(({ name }) => name === 'queue_name')) {
                const row = result.rows[0];
                if (capture && row) capture(row.creator_xid === values[22]);
                if (row && (row.name !== intent.workflowName || row.queue_name !== intent.queue))
                  throw new TypeError(`Conflicting workflow name or queue for ${intent.workflowId}`);
              }
              if (capture && sql.includes('.workflow_input ') && values[0] === intent.workflowId) {
                const stored = (
                  await target.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [
                    intent.workflowId,
                  ])
                ).rows[0];
                if (!stored || canonicalize(JSON.parse(stored.inputs)) !== canonicalize(JSON.parse(String(values[1]))))
                  throw new TypeError('Original identity SDK arguments differ from native custody');
              }
              return result;
            };
          },
        });
        await work.enqueueInTransaction(
          checked,
          {
            queueName: intent.queue,
            workflowName: intent.workflowName,
            workflowIDReusePolicy: 'return-existing',
            workflowID: intent.workflowId,
            ...(intent.queuePartitionKey === undefined ? {} : { queuePartitionKey: intent.queuePartitionKey }),
            ...(intent.deduplicationID === undefined ? {} : { deduplicationID: intent.deduplicationID }),
            ...(intent.priority === undefined ? {} : { priority: intent.priority }),
            ...(intent.delaySeconds === undefined ? {} : { delaySeconds: intent.delaySeconds }),
          },
          ...(intent.arguments ?? [intent.input]),
        );
      },
      assertClient(client, pool) {
        assertSelectedWorkClient(client, pool);
      },
    },
    sdkRuntime: {
      isInitialized() {
        return DBOS.isInitialized();
      },
      setConfig(config: WorkSdkConfig) {
        DBOS.setConfig({
          name: config.name,
          systemDatabaseUrl: config.systemDatabaseUrl,
          systemDatabaseSchemaName: config.systemDatabaseSchemaName,
          systemDatabasePool: asPool(config.systemDatabasePool),
          runMigrations: config.runMigrations,
          logLevel: config.logLevel as 'warn',
          ...(config.executorID === undefined ? {} : { executorID: config.executorID }),
        });
      },
      async registerQueue(client, name, options) {
        await asSdk(client).registerQueue(name, options);
      },
      launch() {
        return DBOS.launch();
      },
      shutdown(options) {
        return DBOS.shutdown(options);
      },
      registerWorkflow(body, config) {
        DBOS.registerWorkflow(body, config);
      },
      runStep(body, config) {
        return DBOS.runStep(body, config);
      },
      applySchedules(client, schedules) {
        return asSdk(client).applySchedules([...schedules]);
      },
      deleteWorkflows(ids, descendants) {
        return DBOS.deleteWorkflows([...ids], descendants);
      },
    },
    sdkRetirement: {
      retireWorkflow(actualWorkflowId) {
        return DBOS.retireWorkflow(actualWorkflowId);
      },
      readFence(actualWorkflowId) {
        return DBOS.getWorkflowWriterFence(actualWorkflowId);
      },
      readWriterState(actualWorkflowId, client) {
        return asSdk(client).getWorkflowWriterState(actualWorkflowId);
      },
      lockWriterState(tx, pool, expected, client) {
        return asSdk(client).checkWorkflowWriterStateInTransaction(
          tx as PoolClient,
          asPool(pool),
          expected as WorkflowWriterState,
        );
      },
      supportsBoundedMaintenance(client) {
        return (
          client instanceof DBOSClient &&
          'maintainWorkflowOnce' in client &&
          typeof (client as BoundedSdk).maintainWorkflowOnce === 'function'
        );
      },
      maintainOnce(pool, client, expected, action, deadline, reserve) {
        return asBounded(client).maintainWorkflowOnce(
          asPool(pool),
          expected as WorkflowWriterState,
          action,
          deadline,
          reserve,
        );
      },
    },
    sdkSelected: {
      registerSelectedStep(body, config, lifecycle) {
        return (DBOS as RuntimeSdk).registerSelectedStep(
          body as (locator: WorkSelectedLocator) => Promise<unknown>,
          config,
          lifecycle,
        ) as never;
      },
      getSelectedExecution() {
        return (DBOS as RuntimeSdk).getSelectedExecution();
      },
      selectedExecutionIdentity(claim, pool, client) {
        return asBounded(client).selectedExecutionIdentity(claim, asPool(pool));
      },
      consumeSelectedExecutionAdmission(claim, pool, client) {
        return asBounded(client).consumeSelectedExecutionAdmission(claim, asPool(pool));
      },
      checkSelectedExecutionInTransaction(tx, pool, claim, client) {
        return asBounded(client).checkSelectedExecutionInTransaction(tx as PoolClient, asPool(pool), claim);
      },
      isSelectedClient(client) {
        return client instanceof DBOSClient;
      },
    },
    sql: {
      async hasRetainedCopies(client, workflowId) {
        for (const [table, key] of RETAINED_TABLES) {
          if ((await client.query(`SELECT 1 FROM dbos.${table} WHERE ${key}=$1 LIMIT 1`, [workflowId])).rows.length)
            return true;
        }
        return false;
      },
    },
    get history() {
      return (history ??=
        load<typeof import('./history-store.ts')>('./history-store.ts').createNativeHistoryAssociation());
    },
    operational: {
      runTransaction(pool, options, body) {
        const operational = load<typeof import('../../command/operational.ts')>('../../command/operational.ts');
        return operational.runOperationalTransaction(asPool(pool), options as OperationalOptions, (tx) =>
          body(tx as WorkQueryClient),
        );
      },
      currentResources(tx) {
        const operational = load<typeof import('../../command/operational.ts')>('../../command/operational.ts');
        return operational.currentOperationalResources(tx as OperationalTransaction);
      },
    },
    selectedAssociation: {
      async associateEpisode(tx, identity, locator, fresh) {
        return associateSelectedEpisode(tx as never, identity as never, locator as never, fresh);
      },
      finishEpisode(tx, identity, episode, phase, body) {
        return finishSelectedEpisode(tx as never, identity as never, episode as never, phase, (inner) =>
          body(inner as WorkQueryClient),
        );
      },
    },
    route: { routeOf, partitionOf },
    authorization: {
      create(deps) {
        const { createWorkerAuthorization } = load<typeof import('../authorization.ts')>('../authorization.ts');
        return createWorkerAuthorization({
          pool: asPool(deps.pool),
          client: deps.client as never,
          env: deps.env,
          clock: deps.clock,
          ...(deps.receiptKeys === undefined ? {} : { receiptKeys: deps.receiptKeys as never }),
        });
      },
    },
    effects: {
      get identityFxName() {
        return IDENTITY_FX_EFFECT;
      },
      bindIdentityOriginal(effect, deps) {
        return bindIdentityOriginalEffect(effect as never, {
          pool: asPool(deps.pool),
          client: deps.client as never,
        }) as unknown as WorkEffect;
      },
      register(effects, pool) {
        const { registerEffects } = load<typeof import('../../events/effects.ts')>('../../events/effects.ts');
        return registerEffects(effects as never, asPool(pool)) as WorkRegisteredEffects;
      },
    },
    historyRegistry: {
      create() {
        return new HistoryRegistry();
      },
    },
    kindConsent: {
      readConfig(env) {
        const { readAuthConsentConfig } = load<typeof import('../authorization.ts')>('../authorization.ts');
        return readAuthConsentConfig(env);
      },
      createParticipant(config, deadline) {
        const { createKindConsentParticipantTransport } =
          load<typeof import('../kind-consent-transport.ts')>('../kind-consent-transport.ts');
        return createKindConsentParticipantTransport(config as never, deadline);
      },
    },
    retentionSelector: {
      create(pool) {
        const { createWorkflowRetentionSelector } =
          load<typeof import('../retention-selector.ts')>('../retention-selector.ts');
        return createWorkflowRetentionSelector(asPool(pool));
      },
    },
    cost: { isBound },
    clock: systemClock,
    now: () => Date.now(),
  };
}
