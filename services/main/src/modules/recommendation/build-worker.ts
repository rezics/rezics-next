import type { Pool } from 'pg';
import { logWorkerFault } from '@rezics/observability/log';
import { recordWorkerOutcome, withWorkerTelemetry } from '@rezics/observability/runtime';
import { runWorkerTick } from '../../worker-tick.ts';
import { RecommendationNotReady, RecommendationStale, RecommendationUnavailable }
  from './derived-generation.ts';
import { RankingGenerations } from './ranking.ts';

/** Advances at most one bounded relay batch per tick. A lease and checkpoint are
 * durable, so another Main can resume after this process exits. */
export class RankingBuildWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private held: { generation: string; epoch: string } | undefined;
  private publicRefresh = false;

  constructor(private readonly access: Pool, private readonly rankings: RankingGenerations,
    private readonly intervalMs = 1000) {}

  /** Enabled by Main for Discover; manual/synthetic ranking runners keep their
   * existing management lifecycle. No request can enable this authority. */
  enablePublicRefresh(): void { this.publicRefresh = true; }

  async tick(): Promise<void> {
    recordWorkerOutcome({ outcome: 'idle', processed: 0, unit: 'batch' });
    if (this.publicRefresh) {
      try { await this.rankings.refreshPublicRanking(); }
      catch (error) {
        if (!(error instanceof RecommendationStale || error instanceof RecommendationUnavailable)) throw error;
        this.logDeferred(error);
        recordWorkerOutcome({ outcome: error instanceof RecommendationStale ? 'deferred' : 'retry' });
      }
    }
    if (!this.held) {
      const candidate = (await this.access.query<{ id: string }>(`SELECT g.id::text FROM access.derived_generation g
        JOIN access.derived_generation_input i ON i.generation_id=g.id AND i.source='main-graph'
        WHERE g.family = 'ranking' AND g.state = 'building' AND g.lease_expires_at <= clock_timestamp()
          AND i.data_epoch=$1 ORDER BY g.lease_expires_at, g.id LIMIT 1`, [this.rankings.dataEpoch])).rows[0];
      if (!candidate) return;
      try { this.held = { generation: candidate.id, epoch: await this.rankings.claim(candidate.id) }; }
      catch (error) { if (error instanceof RecommendationStale) { this.logDeferred(error); recordWorkerOutcome({ outcome: 'deferred' }); return; } throw error; }
    }
    const { generation, epoch } = this.held;
    try {
      const batch = await this.rankings.runBatch(generation, epoch);
      recordWorkerOutcome({ outcome: 'worked', processed: 1, unit: 'batch' });
      if (batch.failed) {
        console.error('ranking build failed', { generation, reason: batch.failed, checkpoint: batch.checkpoint });
        recordWorkerOutcome({ outcome: 'blocked' }); this.held = undefined; return;
      }
      if (!batch.snapshotComplete) return;
      try { await this.rankings.finish(generation, epoch); this.held = undefined; }
      catch (error) { if (!(error instanceof RecommendationNotReady)) throw error; recordWorkerOutcome({ outcome: 'deferred' }); }
    } catch (error) {
      this.logDeferred(error);
      if (error instanceof RecommendationStale) { this.held = undefined; recordWorkerOutcome({ outcome: 'deferred' }); }
      else if (!(error instanceof RecommendationUnavailable)) throw error;
      else recordWorkerOutcome({ outcome: 'retry' });
    }
  }

  private logDeferred(error: unknown): void {
    if (error instanceof RecommendationUnavailable || error instanceof RecommendationStale && error.cause !== undefined)
      logWorkerFault('main.ranking.build', error);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = runWorkerTick('main.ranking.build', () => withWorkerTelemetry('main.ranking.build', () => this.tick())).catch(error => {
        logWorkerFault('main.ranking.build', error);
      }).finally(() => { this.running = undefined; });
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
