import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { controlPlaneReleaseBrief } from './briefs.ts';
import {
  StaleAttemptError,
  type AttemptFence,
  type DevLandingTranspileHandoff,
  type GateOutcome,
  type GateOutcomeSink,
} from './contracts.ts';
import { SqliteManagerInbox } from './inbox.ts';
import type { LandingEntry, SqliteLandingQueue } from './land.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { policyGit } from './merge.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';
import type { WorkerStore } from './store.ts';
import type { Task } from './types.ts';

export type DevResolutionHandoff = {
  kind: 'dev-resolution';
  entry: LandingEntry;
  outcome: GateOutcome;
  targetHead: string;
  paths: string[];
};

export type BatchLandingResult = {
  outcomes: { entry: LandingEntry; outcome: GateOutcome }[];
  deferredIds: number[];
  skippedIds: number[];
  resolution?: DevResolutionHandoff;
  transpileHandoff?: DevLandingTranspileHandoff;
};

export type TrainQueueConfigurationReloader<T> = () => T | Promise<T>;

/** The queue owns scheduling and durability; these callbacks stay bound to MergeTrain's candidate lifecycle. */
export type TrainQueueOptions<TConfiguration> = {
  mainCheckout: string;
  stateDirectory: string;
  integrationBranch?: string | undefined;
  storagePolicy?: ControlPolicy['storage'] | undefined;
  mergePolicy?: ControlPolicy['merge'] | undefined;
  leasePolicy?: ControlPolicy['leases'] | undefined;
  inboxDirectory?: string | undefined;
  inboxPolicy?: ControlPolicy['inbox'] | undefined;
  batchSize?: number | undefined;
  codeIsCurrent?: (() => boolean) | undefined;
  startedCodeVersion?: string | undefined;
  queue: SqliteLandingQueue;
  fence: AttemptFence;
  sink: GateOutcomeSink;
  workspaceFailures: Map<number, GateOutcome[]>;
  beforeRelease?: (() => Promise<void>) | undefined;
  promote?: (() => Promise<void>) | undefined;
  handOff?: (() => void | Promise<void>) | undefined;
  applyConfiguration: (configuration: TConfiguration) => void;
  ensureConfigurationRevision: () => void;
  cloneForRefresh: () => TrainQueue<TConfiguration>;
  integrateBatch: (entries: readonly LandingEntry[], lane: 'main' | 'dev') => Promise<BatchLandingResult>;
  integrateOrdinary: (
    entry: LandingEntry,
    lane: 'main' | 'dev',
    handOff: () => Promise<void>,
    drainDev: () => Promise<void>,
  ) => Promise<GateOutcome | DevResolutionHandoff | DevLandingTranspileHandoff | undefined>;
  resolveDevLanding: (pending: DevResolutionHandoff) => Promise<void>;
};

/** Resolve task metadata used by queue lane selection and candidate lifecycle decisions. */
export function taskIntegrationTarget(
  stateDirectory: string,
  taskId: string,
  policy = defaultPolicy.storage,
): { target?: string; manager?: string; goal?: string; kind?: string; base?: string; workspace?: Task['workspace'] } {
  const path = join(stateDirectory, 'goal.sqlite');
  if (!existsSync(path)) return {};
  const db = new Database(path, { readonly: true, strict: true });
  db.exec('PRAGMA busy_timeout = ' + policy.sqliteBusyTimeoutMs);
  try {
    const row = db.query('SELECT body FROM worker_tasks WHERE id=?').get(taskId) as { body: string } | null;
    if (!row) return {};
    const task = JSON.parse(row.body) as {
      base?: unknown;
      workspace?: Task['workspace'];
      brief?: { target?: unknown; manager?: unknown; goal?: unknown; kind?: unknown };
    };
    const brief = task.brief;
    return {
      ...(task.workspace ? { workspace: task.workspace } : {}),
      ...(typeof brief?.target === 'string' ? { target: brief.target } : {}),
      ...(typeof brief?.manager === 'string' ? { manager: brief.manager } : {}),
      ...(typeof brief?.goal === 'string' ? { goal: brief.goal } : {}),
      ...(typeof brief?.kind === 'string' ? { kind: brief.kind } : {}),
      ...(typeof task.base === 'string' ? { base: task.base } : {}),
    };
  } finally {
    db.close();
  }
}

/** Owns the main/dev lane drains, their leases, replay and empty-queue handoff. */
export class TrainQueue<TConfiguration> {
  constructor(private readonly options: TrainQueueOptions<TConfiguration>) {}

  async run(
    failWhenInitiallyHeld: boolean,
    refreshConfiguration?: TrainQueueConfigurationReloader<TConfiguration>,
  ): Promise<void> {
    // Spawn only after both lanes have released. A child that starts while either lease is held exits at once
    // and consumes the only wake, leaving remaining work stranded.
    let handOffRequested = false;
    const requestHandOff = () => {
      handOffRequested = true;
      return Promise.resolve();
    };
    const start = (lane: 'main' | 'dev') =>
      new Promise<void>((resolve, reject) => {
        const train = refreshConfiguration ? this.options.cloneForRefresh() : this;
        setTimeout(
          () => train.drain(lane, failWhenInitiallyHeld, requestHandOff, refreshConfiguration).then(resolve, reject),
          0,
        );
      });
    // Start dev first: a strict run must not mistake its own main release's dev lease for another train.
    // Once dev has acquired its lane, later contention already uses the normal quiet return path.
    await Promise.all([start('dev'), start('main')]);
    if (handOffRequested) await Promise.resolve(this.options.handOff?.());
  }

  private integrationHead(): string | undefined {
    const branch = this.options.integrationBranch;
    if (!branch) return undefined;
    try {
      return policyGit(this.options.mainCheckout, ['rev-parse', 'refs/heads/' + branch], this.options.mergePolicy);
    } catch {
      return undefined;
    }
  }

  private canBatch(entry: LandingEntry): boolean {
    const o = this.options;
    if (entry.request.unchangedClaim) return false;
    if (entry.request.devResolution) return false;
    if (entry.request.managerLanding) return false;
    if (!o.integrationBranch || !o.fence.commitBatchMerge) return false;
    if ((entry.request.affectedTests ?? []).some((test) => test.status === 'failed')) return false;
    const recorded = taskIntegrationTarget(o.stateDirectory, entry.request.taskId, o.storagePolicy);
    return !recorded.workspace && recorded.target !== 'stabilize' && !controlPlaneReleaseBrief(recorded);
  }

  private async drain(
    lane: 'main' | 'dev',
    failWhenInitiallyHeld: boolean,
    handOff: () => Promise<void>,
    refreshConfiguration?: TrainQueueConfigurationReloader<TConfiguration>,
  ): Promise<void> {
    const o = this.options;
    mkdirSync(o.stateDirectory, { recursive: true });
    const leasePath = join(o.stateDirectory, lane === 'main' ? 'train-main.lease' : 'train.lease');
    let acquired = false;
    const retryDeferred = new Set<number>();
    const stale = () => Boolean(o.codeIsCurrent && !o.codeIsCurrent());
    for (;;) {
      // Check immediately before every acquisition attempt. A process that turns stale while queued must
      // leave the request for a fresh train instead of briefly taking the lease to discover that fact.
      if (stale()) {
        await handOff();
        return;
      }
      let lease: ReturnType<typeof acquireDirectoryLease>;
      try {
        lease = acquireDirectoryLease(
          leasePath,
          o.leasePolicy,
          o.startedCodeVersion ? { codeVersion: o.startedCodeVersion } : undefined,
        );
      } catch (error) {
        if (error instanceof LeaseHeldError) {
          if (failWhenInitiallyHeld && !acquired) throw error;
          return;
        }
        throw error;
      }
      acquired = true;
      // Each lease is a train start or a sweep: a resolution abandoned by a stopped train is selectable again here.
      o.queue.releaseAbandonedResolutions();
      const roundHead = this.integrationHead();
      const deferred = new Set<number>();
      const pendingDevResolutions: DevResolutionHandoff[] = [];
      const pendingDevTranspiles: DevLandingTranspileHandoff[] = [];
      let processedEntry = false;
      let retire = false;
      let stop = false;
      try {
        if (stale()) {
          retire = true;
        } else {
          for (;;) {
            if (stale()) {
              retire = true;
              break;
            }
            if (refreshConfiguration) o.applyConfiguration(await refreshConfiguration());
            o.ensureConfigurationRevision();
            const entry = o.queue.nextBatch(1, [...deferred], lane)[0];
            if (!entry) break;
            processedEntry = true;
            try {
              if (entry.outcome) {
                o.sink.onGateOutcome(entry.outcome);
                o.queue.acknowledge(entry.id);
                retryDeferred.delete(entry.id);
                continue;
              }
              o.fence.assertCurrent(entry.request);
              const batchSize = o.batchSize ?? 1;
              const batch: LandingEntry[] = [];
              const scanned = new Set<number>([entry.id]);
              if (this.canBatch(entry)) batch.push(entry);
              while (batch.length < batchSize && batch.length > 0) {
                const candidate = o.queue.nextBatch(1, [...deferred, ...scanned], lane)[0];
                if (!candidate) break;
                scanned.add(candidate.id);
                if (candidate.outcome || !this.canBatch(candidate)) continue;
                try {
                  o.fence.assertCurrent(candidate.request);
                } catch (error) {
                  if (!(error instanceof StaleAttemptError)) throw error;
                  o.queue.acknowledge(candidate.id);
                  retryDeferred.delete(candidate.id);
                  continue;
                }
                batch.push(candidate);
              }
              if (batch.length > 1 || (batch.length === 1 && retryDeferred.has(batch[0]!.id))) {
                const integrated = await o.integrateBatch(batch, lane);
                if (integrated.resolution) {
                  o.queue.beginResolution(integrated.resolution.entry.id);
                  pendingDevResolutions.push(integrated.resolution);
                }
                if (integrated.transpileHandoff) {
                  o.queue.beginResolution(integrated.transpileHandoff.entryId);
                  pendingDevTranspiles.push(integrated.transpileHandoff);
                }
                for (const id of integrated.skippedIds) {
                  o.queue.acknowledge(id);
                  retryDeferred.delete(id);
                }
                for (const id of integrated.deferredIds) {
                  deferred.add(id);
                  retryDeferred.add(id);
                }
                for (const { entry: member, outcome } of integrated.outcomes) {
                  try {
                    o.queue.finish(member.id, outcome);
                    o.sink.onGateOutcome(outcome);
                    o.queue.acknowledge(member.id);
                    retryDeferred.delete(member.id);
                  } catch (error) {
                    if (!(error instanceof StaleAttemptError)) throw error;
                    o.queue.acknowledge(member.id);
                    retryDeferred.delete(member.id);
                  }
                }
              } else {
                const integration = await o.integrateOrdinary(entry, lane, handOff, () =>
                  this.drain('dev', false, handOff),
                );
                if (!integration) {
                  // Leave the request pending for the next pump, without retrying contention in this drain.
                  if (stale()) retire = true;
                  stop = true;
                  break;
                }
                if (isDevResolutionHandoff(integration)) {
                  o.queue.beginResolution(entry.id);
                  pendingDevResolutions.push(integration);
                  continue;
                }
                if (isDevLandingTranspileHandoff(integration)) {
                  o.queue.beginResolution(entry.id);
                  pendingDevTranspiles.push(integration);
                  continue;
                }
                const outcome = integration;
                const workspaceFailures = o.workspaceFailures.get(entry.id);
                o.workspaceFailures.delete(entry.id);
                if (workspaceFailures) {
                  for (const failure of workspaceFailures) {
                    if (failure.taskId === entry.request.taskId) continue;
                    const store = o.fence as WorkerStore;
                    try {
                      store.assertCurrent(failure);
                    } catch (error) {
                      if (error instanceof StaleAttemptError) continue;
                      throw error;
                    }
                    if (store.record(failure)) o.sink.onGateOutcome(failure);
                    else {
                      const task = store.task(failure.taskId);
                      new SqliteManagerInbox(
                        store.db,
                        o.inboxDirectory ?? join(o.stateDirectory, 'inboxes'),
                        undefined,
                        o.inboxPolicy,
                      ).deliver({
                        managerId: task.brief.manager,
                        taskId: task.id,
                        kind: 'instruction',
                        summary: (
                          'Shared workspace landing failed in your work: ' +
                          (failure.firstFailure?.assertion ?? failure.stage) +
                          '. See ' +
                          failure.logPath
                        ).replace(/[\r\n]+/g, ' '),
                      });
                    }
                  }
                  if (!workspaceFailures.some((failure) => failure.taskId === entry.request.taskId)) {
                    deferred.add(entry.id);
                    continue;
                  }
                }

                o.queue.finish(entry.id, outcome);
                // Sink delivery is at least once; obsolete entries must never block the current attempt.
                o.sink.onGateOutcome(outcome);
                o.queue.acknowledge(entry.id);
                retryDeferred.delete(entry.id);
              }
            } catch (error) {
              if (!(error instanceof StaleAttemptError)) throw error;
              o.queue.acknowledge(entry.id);
              retryDeferred.delete(entry.id);
            }
          }
        }
        // The main and dev lanes drain concurrently. A hook intended to observe a finished landing must not
        // be consumed by the idle lane before the lane with queued work reaches its handoff.
        if (processedEntry) await o.beforeRelease?.();
      } finally {
        lease.release();
      }

      if (pendingDevTranspiles.length) {
        for (const handoff of pendingDevTranspiles) {
          if (!o.sink.onDevLandingTranspileHandoff)
            throw new Error('dev landing transpile handoff requires the worker continuation sink');
          o.sink.onDevLandingTranspileHandoff(handoff);
          o.queue.acknowledge(handoff.entryId);
        }
      }

      if (pendingDevResolutions.length) {
        for (const pending of pendingDevResolutions) await o.resolveDevLanding(pending);
        if (retire || stale()) {
          await handOff();
          return;
        }
        continue;
      }

      if (pendingDevTranspiles.length) {
        if (retire || stale()) {
          await handOff();
          return;
        }
        continue;
      }

      if (retire || stale()) {
        await handOff();
        return;
      }
      if (stop) return;
      // The empty check is outside the lease: enqueueing while we drained can wake no owner, so retry if needed.
      if (o.queue.nextBatch(1, [...deferred], lane).length) continue;
      if (o.queue.nextBatch(1, [], lane).length) {
        if (deferred.size) {
          if (roundHead !== this.integrationHead()) continue;
          return;
        }
        continue;
      }
      await o.promote?.();
      if (stale()) {
        await handOff();
        return;
      }
      if (!o.queue.nextBatch(1, [], lane).length) return;
    }
  }
}

function isDevResolutionHandoff(
  value: GateOutcome | DevResolutionHandoff | DevLandingTranspileHandoff | undefined,
): value is DevResolutionHandoff {
  return !!value && 'kind' in value && value.kind === 'dev-resolution';
}

function isDevLandingTranspileHandoff(
  value: GateOutcome | DevResolutionHandoff | DevLandingTranspileHandoff | undefined,
): value is DevLandingTranspileHandoff {
  return !!value && 'kind' in value && value.kind === 'dev-landing-transpile';
}
