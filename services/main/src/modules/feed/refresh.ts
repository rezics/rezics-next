import type { Pool } from 'pg';
import { logWorkerFault } from '@rezics/observability/log';
import { withWorkerTelemetry } from '@rezics/observability/runtime';
import { runWorkerTick } from '../../worker-tick.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { workRead, WorkReadMoved, WorkReadUnavailable } from '../work/read-session.ts';
import { FEED_COST } from './contract.ts';
import { feedReferences, feedReviewSources, feedSources, reviewActivityId } from './source.ts';
import type { FeedStore } from './store.ts';

/** The existing relay verifies every graph event kind before this projector can
 * pass its durable checkpoint. No parallel outbox interpretation or new event
 * classes are introduced by these Access-only preferences and votes. */
export class FeedRefreshWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<unknown> | undefined;
  constructor(private readonly deps: MainWorkDependencies, private readonly store: FeedStore,
    private readonly relay: Pool) {}

  async tick(): Promise<'relay-behind' | 'current' | 'advanced'> {
    return workRead(this.deps, new Request('http://main.internal/feed-refresh'), {}, async session => {
      const relay = await this.deps.relayPosition?.read();
      if (!relay || relay.dataEpoch !== session.position.dataEpoch) return 'relay-behind';
      if (BigInt(relay.sequence) > BigInt(session.position.sequence)) throw new WorkReadUnavailable('Relay exceeds graph');
      const checkpoint = await this.store.initialize(session.position.dataEpoch);
      if (checkpoint.rebuild_epoch) { await this.store.copyRetained(checkpoint); return 'advanced'; }
      if (BigInt(checkpoint.sequence) > BigInt(relay.sequence)) throw new WorkReadUnavailable('Feed exceeds relay');
      if (checkpoint.sequence !== relay.sequence || checkpoint.after_id !== '\uffff') {
        const sources = await feedReferences(session, { epoch: relay.dataEpoch, through: relay.sequence,
          afterSequence: checkpoint.sequence, afterId: checkpoint.after_id });
        // Group only currently admitted activity identities. Hidden references still
        // enter the projection independently and are never dropped at ingestion.
        const admitted = new Map((await feedSources(session, { ids: sources.slice(0, FEED_COST.refreshItems).map(item => item.id) }))
          .map(item => [item.id, item]));
        const grouped = sources.map(item => {
          const source = admitted.get(item.id);
          return source ? { ...item, kind: source.kind, work: source.work, realm: source.realm,
            target: source.target, actor: source.actor, occurrence: source.occurrence ?? undefined,
            contentRevision: source.contentRevision ?? undefined,
            ...(source.occurrence ? { groupKind: 'chapter' as const } : source.contentTarget ? { groupKind: 'hub' as const } : {}) } : item;
        });
        // Legacy events without UUIDv7 time use the acknowledged relay timestamp.
        const times = await this.relay.query<{ sequence: string; delivered_at: Date }>(`SELECT s.sequence::text, e.delivered_at
          FROM unnest($2::numeric[]) s(sequence) CROSS JOIN LATERAL (
            SELECT delivered_at FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = s.sequence LIMIT 1
          ) e`, [relay.dataEpoch, [...new Set(sources.slice(0, FEED_COST.refreshItems).map(source => source.sequence))]]);
        await this.store.advance(checkpoint, relay.sequence, grouped, new Map(times.rows.map(row => [row.sequence, row.delivered_at])));
        return 'advanced';
      }
      // Both independent indexes get a bounded turn. A large Realm backfill
      // must not starve Following's target/author backfill on a fresh or restored stack.
      const targets = await this.store.projectTargets(session,this.relay,checkpoint,relay.sequence);
      const threads = await this.store.projectRealmThreads(session,this.relay,checkpoint,relay.sequence);
      const events = await this.deps.reviews?.eventsAfter(checkpoint.review_sequence) ?? [];
      if (!events.length) return targets || threads ? 'advanced' : 'current';
      const ids = [...new Set(events.slice(0, FEED_COST.refreshItems).filter(event => event.kind === 'created')
        .map(event => reviewActivityId(event.review)))];
      const admitted = new Map((await feedReviewSources(session, ids)).map(source => [source.id, source]));
      await this.store.advanceReviews(checkpoint, events.slice(0, FEED_COST.refreshItems + 1), admitted);
      return 'advanced';
    });
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = runWorkerTick('main.feed.refresh', () => withWorkerTelemetry('main.feed.refresh', () => this.tick(), outcome => ({
        outcome: outcome === 'relay-behind' ? 'deferred' : outcome === 'advanced' ? 'worked' : 'current',
      }))).catch(error => {
        if (!(error instanceof WorkReadMoved)) logWorkerFault('main.feed.refresh', error);
      }).finally(() => { this.running = undefined; });
    }, FEED_COST.intervalMs);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
