import { withWorkerTelemetry } from '@rezics/observability/runtime';
import { logWorkerFault } from '@rezics/observability/log';
import { prepareLibraryShelves } from './modules/library/backfill.ts';
import { prepareChapterPosts } from './modules/post/backfill.ts';
import type { composeMain } from './composition.ts';

const startOrder = [
  'feedWorker', 'occurrenceLabelWorker', 'realmPolicyRecovery', 'contentProjectionWorker',
  'libraryImportRetentionWorker', 'mediaScreenWorker', 'requiredMediaMatchWorker',
  'mediaRenditionWorker', 'discoveryWorker', 'recommendationWorker', 'serialStats',
  'zoneBrowse', 'readRankings', 'correctionWorker', 'notificationProducerWorker',
  'notificationDigestWorker', 'rightsCounterNoticeWorker', 'notificationDeliveryWorker',
  'statementSeekWorker',
] as const;
const beforeListenerStop = [
  'occurrenceLabelWorker', 'statementSeekWorker', 'realmPolicyRecovery',
  'libraryImportRetentionWorker', 'mediaScreenWorker', 'requiredMediaMatchWorker',
  'mediaRenditionWorker', 'serialStats', 'zoneBrowse', 'readRankings',
] as const;
const afterListenerStop = [
  'feedWorker', 'discoveryWorker', 'correctionWorker', 'notificationProducerWorker',
  'notificationDigestWorker', 'rightsCounterNoticeWorker', 'notificationDeliveryWorker',
  'notificationRealtime', 'recommendationWorker', 'contentProjectionWorker',
] as const;
type WorkerName = typeof startOrder[number] | 'notificationRealtime';
type Worker = { start(): void | Promise<void>; stop(): void | Promise<void> };
type Resources = Partial<Record<WorkerName, Worker>> & {
  recommendationWorker?: Worker & { enablePublicRefresh(): void };
  templateSeek: {
    backfill(epoch: string): Promise<unknown>;
    startRecovery(epoch: string): void;
    stopRecovery(): Promise<void>;
  };
};
interface Preparation {
  epoch: string;
  chapters(): Promise<unknown>;
  shelves(signal: AbortSignal): Promise<unknown>;
  listen(): void;
  stopListening(): Promise<unknown>;
}

/** One startup/shutdown order for the process entry and in-process applications. */
export function createMainLifecycle(resources: Resources, preparation: Preparation) {
  const started = new Set<WorkerName>();
  const controller = new AbortController();
  let template: Promise<void> | undefined;
  let shelves: Promise<unknown> | undefined;
  let listening = false;
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    const errors: unknown[] = [];
    const finish = async (operation: () => unknown) => {
      try { await operation(); } catch (error) { errors.push(error); }
    };
    const stopWorker = async (name: WorkerName) => {
      if (started.has(name)) await finish(() => resources[name]!.stop());
    };
    if (template) {
      await finish(() => template);
      await finish(() => resources.templateSeek.stopRecovery());
    }
    for (const name of beforeListenerStop) await stopWorker(name);
    controller.abort();
    if (shelves) await finish(() => shelves);
    if (listening) await finish(preparation.stopListening);
    for (const name of afterListenerStop) await stopWorker(name);
    if (errors.length) throw new AggregateError(errors, 'Main lifecycle shutdown failed');
  })();
  return {
    async start() {
      try {
        if (resources.notificationRealtime) {
          started.add('notificationRealtime');
          await resources.notificationRealtime.start();
        }
        template = resources.templateSeek.backfill(preparation.epoch)
          .catch(error => { console.error('Template directory is unavailable', error); })
          .then(() => resources.templateSeek.startRecovery(preparation.epoch));
        await preparation.chapters();
        preparation.listen();
        listening = true;
        shelves = preparation.shelves(controller.signal);
        for (const name of startOrder) {
          const worker = resources[name];
          if (!worker) continue;
          if (name === 'recommendationWorker') resources.recommendationWorker!.enablePublicRefresh();
          started.add(name);
          worker.start();
        }
      } catch (error) {
        try { await stop(); } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Main lifecycle startup failed');
        }
        throw error;
      }
    },
    stop,
  };
}

export function mainLifecycle(
  main: Awaited<ReturnType<typeof composeMain>>,
  listen: () => void,
  stopListening = () => main.app.stop(),
) {
  return createMainLifecycle(main, {
    epoch: main.environment.lineage.dataEpoch,
    listen, stopListening,
    // Failed conversions remain legacy and are resumed on the next startup.
    chapters: () => withWorkerTelemetry('main.post.backfill',
      () => prepareChapterPosts(main.environment, main.pool), undefined, 'startup')
      .catch(error => logWorkerFault('main.post.backfill', error)),
    shelves: signal => withWorkerTelemetry('main.library.backfill',
      () => prepareLibraryShelves(main.contentPool, main.pool, main.fuseki, { signal }), undefined, 'startup')
      .catch(error => { if (!signal.aborted) logWorkerFault('main.library.backfill', error); }),
  });
}
