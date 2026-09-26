import type { Pool } from 'pg';
import { RecommendationNotReady, RecommendationStale, RecommendationUnavailable }
  from './derived-generation.ts';
import { RankingGenerations } from './ranking.ts';

/** Advances at most one bounded relay batch per tick. A lease and checkpoint are
 * durable, so another Main can resume after this process exits. */
export class RankingBuildWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private held: { generation: string; epoch: string } | undefined;

  constructor(private readonly access: Pool, private readonly rankings: RankingGenerations,
    private readonly intervalMs = 1000) {}

  async tick(): Promise<void> {
    if (!this.held) {
      const candidate = (await this.access.query<{ id: string }>(`SELECT id::text FROM access.derived_generation
        WHERE family = 'ranking' AND state = 'building' AND lease_expires_at <= clock_timestamp()
        ORDER BY lease_expires_at, id LIMIT 1`)).rows[0];
      if (!candidate) return;
      try { this.held = { generation: candidate.id, epoch: await this.rankings.claim(candidate.id) }; }
      catch (error) { if (error instanceof RecommendationStale) return; throw error; }
    }
    const { generation, epoch } = this.held;
    try {
      const batch = await this.rankings.runBatch(generation, epoch);
      if (batch.failed) { this.held = undefined; return; }
      if (!batch.snapshotComplete) return;
      try { await this.rankings.finish(generation, epoch); this.held = undefined; }
      catch (error) { if (!(error instanceof RecommendationNotReady)) throw error; }
    } catch (error) {
      if (error instanceof RecommendationStale) this.held = undefined;
      else if (!(error instanceof RecommendationUnavailable)) throw error;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.tick().catch(error => {
        console.error('ranking build tick failed', error);
      }).finally(() => { this.running = undefined; });
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
