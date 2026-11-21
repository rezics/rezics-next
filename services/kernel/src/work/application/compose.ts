import { DBOS_SCHEMA, WORK_APPLICATION } from '../contract/vocabulary.ts';
import type {
  WorkApplicationPorts,
  WorkComposedRuntime,
  WorkComposeOptions,
  WorkEffect,
  WorkModule,
  WorkRegistrationContext,
  WorkSelectedRuntime,
  WorkService,
} from '../contract/index.ts';
import { WORK_QUEUES } from '../core/index.ts';

export class WorkCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkCompositionError';
  }
}

export function createComposer(
  ports: WorkApplicationPorts,
  composeSelectedRuntime: (
    pool: WorkComposeOptions['pool'],
    client: WorkComposeOptions['client'],
  ) => WorkSelectedRuntime,
) {
  let composed = false;

  return {
    async compose(modules: readonly WorkModule[], options: WorkComposeOptions): Promise<WorkComposedRuntime> {
      if (composed || ports.sdkRuntime.isInitialized())
        throw new WorkCompositionError('Work registration is already composed or launched');
      const names = new Set<string>();
      for (const module of modules) {
        if (names.has(module.name)) throw new WorkCompositionError(`Duplicate work module: ${module.name}`);
        names.add(module.name);
      }
      const clock = options.clock ?? ports.clock;
      const env = options.env ?? {};
      composed = true;
      ports.sdkRuntime.setConfig({
        name: WORK_APPLICATION,
        systemDatabaseUrl: options.databaseUrl,
        systemDatabaseSchemaName: DBOS_SCHEMA,
        systemDatabasePool: options.pool,
        runMigrations: false,
        logLevel: 'warn',
        ...(options.drainOriginals ? { drainOriginals: true } : {}),
        ...(options.executorId === undefined ? {} : { executorID: options.executorId }),
      });
      if (!options.drainOriginals) {
        for (const [name, parameters] of Object.entries(WORK_QUEUES)) {
          await ports.sdkRuntime.registerQueue(options.client, name, parameters);
        }
      }
      const collectedEffects: WorkEffect[] = [];
      const history = ports.historyRegistry.create();
      const serviceStarters: Array<() => WorkService | Promise<WorkService>> = [];
      const started: WorkService[] = [];
      let accepting = true;
      let authorization: ReturnType<WorkRegistrationContext['getAuthorization']> | undefined;
      let selectedRuntime: WorkSelectedRuntime | undefined;
      const context: WorkRegistrationContext = Object.freeze({
        pool: options.pool,
        queues: WORK_QUEUES,
        client: options.client,
        env,
        clock,
        history,
        ...(options.drainOriginals ? { drainOriginals: true } : {}),
        getSelectedRuntime() {
          return (selectedRuntime ??= composeSelectedRuntime(options.pool, options.client));
        },
        getAuthorization() {
          return (authorization ??= ports.authorization.create({
            pool: options.pool,
            client: options.client,
            env,
            clock,
            ...(options.receiptKeys === undefined ? {} : { receiptKeys: options.receiptKeys }),
          }));
        },
        getKindConsentParticipant(deadline) {
          const config = ports.kindConsent.readConfig(env);
          if (!config) return undefined;
          return ports.kindConsent.createParticipant(config, deadline);
        },
        addEffects(effects) {
          if (!accepting) throw new WorkCompositionError('Cannot add effects after work composition');
          collectedEffects.push(
            ...effects.map((effect) =>
              effect.name === ports.effects.identityFxName
                ? ports.effects.bindIdentityOriginal(effect, { pool: options.pool, client: options.client })
                : effect,
            ),
          );
        },
        addNativeEffects(effects) {
          if (!accepting) throw new WorkCompositionError('Cannot add native effects after work composition');
          collectedEffects.push(...effects);
        },
        addService(start, serviceOptions) {
          if (!accepting) throw new WorkCompositionError('Cannot add a service after composition');
          if (!options.drainOriginals || serviceOptions?.servesOriginals) serviceStarters.push(start);
        },
      });
      try {
        for (const module of modules) await module.register(context);
      } finally {
        accepting = false;
      }
      const effects = ports.effects.register(collectedEffects, options.pool);
      history.seal();

      const stopServices = async (services: readonly WorkService[], admissionOnly = false): Promise<unknown> => {
        let failure: unknown;
        for (let index = services.length - 1; index >= 0; index -= 1) {
          try {
            const service = services[index]!;
            if (admissionOnly && service.stopAdmission) await service.stopAdmission();
            else await service.stop();
          } catch (error) {
            failure ??= error;
          }
        }
        return failure;
      };

      let launching: Promise<void> | undefined;
      let stopping: Promise<void> | undefined;
      let draining: Promise<void> | undefined;
      const drain = (): Promise<void> =>
        (draining ??= (async () => {
          // The Auth-bound process has a 20 s shutdown boundary. Leave time for
          // SDK teardown, the retained workflow dependencies, IPC and pool closure.
          const drainUntil = performance.now() + 10_000;
          let failure: unknown;
          try {
            if (ports.sdkRuntime.isInitialized()) await ports.sdkRuntime.deactivateEventReceivers();
          } catch (error) {
            failure = error;
          }
          const services = started.splice(0);
          const stopFailure = await stopServices(services, true);
          failure ??= stopFailure;
          try {
            await ports.sdkRuntime.shutdown({
              workflowCompletionTimeoutMS: Math.max(0, Math.floor(drainUntil - performance.now())),
            });
          } catch (error) {
            failure ??= error;
          }
          const releaseFailure = await stopServices(services.filter((service) => service.stopAdmission));
          failure ??= releaseFailure;
          if (failure) throw failure;
        })());
      return {
        effects,
        launch(): Promise<void> {
          if (stopping) return Promise.reject(new WorkCompositionError('Work launch refused after shutdown'));
          return (launching ??= (async () => {
            await ports.sdkRuntime.launch();
            try {
              for (const start of serviceStarters) started.push(await start());
            } catch (error) {
              // The SDK can already have recovered a workflow using an earlier service.
              await drain().catch(() => {});
              throw error;
            }
          })());
        },
        shutdown(): Promise<void> {
          return (stopping ??= (async () => {
            // A failed registrar/launch still owns any initialized SDK resources.
            try {
              await launching;
            } finally {
              await drain();
            }
          })());
        },
      };
    },
  };
}
