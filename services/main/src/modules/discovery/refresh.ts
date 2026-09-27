import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { standingContextPattern } from '../rating/contexts.ts';
import { digest, RecommendationRestart, RecommendationStale } from '../recommendation/derived-generation.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { workRead, WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { automaticDiscovery } from './automation.ts';
import type { OwnedDiscoveryBasis } from './contract.ts';
import { DISCOVERY_REFRESH_COST, DiscoveryRefreshStore, type RefreshJob } from './refresh-store.ts';
import { admitDiscoveryBasis, projectDiscoveryWork } from './source.ts';
import type { DiscoveryProjection } from './store.ts';

export type RefreshOutcome = 'idle' | 'relay-behind' | 'current' | 'inactive' | 'advanced' | 'activated' | 'retry';
const request = () => new Request('http://main.internal/discovery-refresh');

/** Scheduled full rebuilds coalesce writes at the relay checkpoint. A tick
 * advances one Work; no browse request starts work. Continuous writes may
 * postpone activation: stale disclosure remains fenced, never served as fresh. */
export class DiscoveryRefreshWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<unknown> | undefined;

  constructor(private readonly deps: MainWorkDependencies, private readonly store: DiscoveryRefreshStore,
    private readonly projection: DiscoveryProjection) {}

  private async caughtUp(session: WorkReadSession): Promise<boolean> {
    const relay = await this.deps.relayPosition?.read();
    return !!relay && relay.dataEpoch === session.position.dataEpoch && relay.sequence === session.position.sequence;
  }

  private async enroll(): Promise<void> {
    const after = await this.store.catalog();
    if (after === null) return;
    const result = await workRead(this.deps, request(), {}, async session => {
      if (!await this.caughtUp(session)) return null;
      const rows = await session.query(`SELECT ?resource ?context ?scope ?realm WHERE { GRAPH ${iri(GRAPHS.current)} {
        { ${standingContextPattern()} BIND(?context AS ?resource) } UNION {
          ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
          ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
          BIND(?realm AS ?resource) BIND("realm" AS ?scope)
        } FILTER(STR(?resource) > ${lit(after)})
      } } ORDER BY STR(?resource) LIMIT ${DISCOVERY_REFRESH_COST.catalogSize + 1}`, DISCOVERY_REFRESH_COST.catalogSize + 1);
      if (rows.some(row => !row.resource || !row.scope) || new Set(rows.map(row => row.resource!.value)).size !== rows.length) {
        throw new WorkReadUnavailable('Discovery Context catalog is ambiguous');
      }
      const page = rows.slice(0, DISCOVERY_REFRESH_COST.catalogSize);
      const bases: OwnedDiscoveryBasis[] = [{ scope: 'global', realm: null, context: null, owner: null }];
      for (const row of page) {
        const basis: OwnedDiscoveryBasis = { scope: row.scope!.value as 'global' | 'realm',
          realm: row.realm?.value ?? null, context: row.context?.value ?? null, owner: null };
        bases.push(basis);
      }
      return { bases, after: rows.length > page.length ? page.at(-1)!.resource!.value : '' };
    });
    if (!result) return;
    await this.store.enroll(result.bases);
    await this.store.catalogDone(after, result.after);
  }

  async tick(): Promise<RefreshOutcome> {
    await this.store.purge();
    await this.enroll();
    const job = await this.store.claim();
    if (!job) return 'idle';
    return this.advance(job);
  }

  private async advance(job: RefreshJob): Promise<RefreshOutcome> {
    const started = performance.now();
    let generationId = job.generation_id;
    let outcome: RefreshOutcome = 'retry';
    try {
      outcome = await workRead(this.deps, request(), { scope: job.basis.scope, realm: job.basis.realm ?? undefined },
        async session => {
          if (!await this.caughtUp(session)) return 'relay-behind';
          const state = await this.store.inspect(job, session.position);
          if (state.fresh) { generationId = null; return 'current'; }
          if (state.inactive) return 'inactive';
          session.principal = state.principal;
          await admitDiscoveryBasis(session, job.basis);
          const operator = automaticDiscovery(job.basis.owner);
          let row = state.row ?? await this.projection.register(operator, job.basis, session.position,
            { idempotencyKey: `refresh:${job.scope_key}:${job.lease_epoch}`, requestDigest: digest([job.basis, session.position]) });
          generationId = row.generation_id;
          await this.store.attach(job, generationId);
          if (!row.complete) {
            const step = await this.projection.beginStep(operator, row.generation_id, row.checkpoint);
            const projected = await projectDiscoveryWork(session, job.basis, row.checkpoint);
            row = await this.projection.commitStep(operator, row.generation_id, step.lease, row.checkpoint,
              projected, session.position);
          }
          if (!row.complete) return 'advanced';
          const activated = await this.projection.activate(operator, row.generation_id, row.active_head, session.position,
            { idempotencyKey: `refresh-activate:${row.generation_id}:${row.active_head ?? 'none'}`,
              requestDigest: digest([row.generation_id, row.active_head]) });
          if (activated.outcome !== 'succeeded') throw new RecommendationStale('Discovery activation head changed');
          generationId = null;
          return 'activated';
        });
    } catch (error) {
      if (!(error instanceof RecommendationRestart || error instanceof RecommendationStale || error instanceof WorkReadMoved)) {
        console.error('discovery refresh deferred', error);
      }
    }
    await this.store.finish(job, generationId, outcome, performance.now() - started,
      outcome === 'advanced' ? DISCOVERY_REFRESH_COST.intervalMs
        : outcome === 'retry' || outcome === 'inactive' ? DISCOVERY_REFRESH_COST.retryMs : DISCOVERY_REFRESH_COST.idleMs);
    return outcome;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.tick().catch(error => { console.error('discovery refresh tick failed', error); })
        .finally(() => { this.running = undefined; });
    }, DISCOVERY_REFRESH_COST.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
