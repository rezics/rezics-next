import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { withWorkerTelemetry } from '@rezics/observability/runtime';
import { standingContextPattern } from '../rating/contexts.ts';
import { digest, RecommendationRestart, RecommendationStale } from '../recommendation/derived-generation.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { workRead, WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { automaticDiscovery } from './automation.ts';
import type { OwnedDiscoveryBasis } from './contract.ts';
import { DISCOVERY_REFRESH_COST, DiscoveryRefreshStore, type RefreshJob } from './refresh-store.ts';
import { admitDiscoveryBasis, projectDiscoveryBatch } from './source.ts';
import { discoveryChanges } from './changes.ts';
import type { DiscoveryProjection } from './store.ts';

export type RefreshOutcome = 'idle' | 'relay-behind' | 'current' | 'inactive' | 'advanced' | 'activated' | 'retry';
const request = () => new Request('http://main.internal/discovery-refresh');

/** Bounded source batches and conservative outbox deltas. Immutable completed
 * cuts may activate while later writes wait for the next refresh. */
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
    try { await this.enroll(); }
    catch (error) {
      if (!(error instanceof WorkReadUnavailable)) throw error;
      // The catalog retries on its next due time; existing jobs still advance.
    }
    const job = await this.store.claim();
    if (!job) return 'idle';
    return this.advance(job);
  }

  private async advance(job: RefreshJob): Promise<RefreshOutcome> {
    const started = performance.now();
    let generationId = job.generation_id;
    let outcome: RefreshOutcome = 'retry';
    const held: { step?: { id: string; lease: string } } = {};
    let moved = false;
    try {
      const prepared = await workRead(this.deps, request(), { scope: job.basis.scope, realm: job.basis.realm ?? undefined },
        async session => {
          if (!await this.caughtUp(session)) return 'relay-behind';
          const state = await this.store.inspect(job, session.position);
          if (state.fresh) { generationId = null; return 'current'; }
          if (state.inactive) return 'inactive';
          session.principal = state.principal;
          await admitDiscoveryBasis(session, job.basis);
          const operator = automaticDiscovery(job.basis.owner);
          if (state.row && !state.row.complete && state.row.source_sequence !== session.position.sequence) {
            const changes = await discoveryChanges(session, state.row.source_sequence);
            // Appending new Works does not change the pinned population. Its
            // enumeration excludes births after the cut; existing-Work writes
            // require a new snapshot because HTTP cannot retain a transaction.
            if (!changes || changes.works.some(work => !changes.created.includes(work))) {
              await this.projection.cancel(operator, state.row.generation_id);
              generationId = null;
              return 'advanced';
            }
          }
          const changes = !state.row && state.reuse ? await discoveryChanges(session, state.reuse.source_sequence) : null;
          const row = state.row ?? await this.projection.register(operator, job.basis, session.position,
            { idempotencyKey: `refresh:${job.scope_key}:${job.lease_epoch}`, requestDigest: digest([job.basis, session.position]) },
            changes && state.reuse ? { generation: state.reuse.generation_id, works: changes.works } : undefined);
          generationId = row.generation_id;
          await this.store.attach(job, generationId);
          if (!row.complete) {
            const step = await this.projection.beginStep(operator, row.generation_id, row.checkpoint);
            held.step = { id: row.generation_id, lease: step.lease };
            const projected = await projectDiscoveryBatch(session, job.basis, row.checkpoint,
              { works: row.changed_works ?? undefined, sequence: row.source_sequence });
            return { row, step, projected, position: session.position };
          }
          return { row, step: null, projected: null, position: session.position };
        });
      if (typeof prepared === 'string') outcome = prepared;
      else {
        // Only commit after workRead has checked the graph, principal, Realm
        // and source-attribution fences. A moved multi-query snapshot has no rows.
        const operator = automaticDiscovery(job.basis.owner);
        const row = prepared.step && prepared.projected
          ? await this.projection.commitBatch(operator, prepared.row.generation_id, prepared.step.lease,
            prepared.row.checkpoint, prepared.projected,
            { dataEpoch: prepared.row.source_epoch, sequence: prepared.row.source_sequence }) : prepared.row;
        if (!row.complete) outcome = 'advanced';
        else {
          const activated = await this.projection.activate(operator, row.generation_id, row.active_head, prepared.position,
            { idempotencyKey: `refresh-activate:${row.generation_id}:${row.active_head ?? 'none'}`,
              requestDigest: digest([row.generation_id, row.active_head]) });
          if (activated.outcome !== 'succeeded') throw new RecommendationStale('Discovery activation head changed');
          generationId = null;
          outcome = 'activated';
        }
      }
    } catch (error) {
      moved = error instanceof WorkReadMoved;
      if (moved && held.step) await this.projection.releaseStep(automaticDiscovery(job.basis.owner), held.step.id, held.step.lease);
      if (!(error instanceof RecommendationRestart || error instanceof RecommendationStale || error instanceof WorkReadMoved)) {
        console.error('discovery refresh deferred', error);
      }
    }
    await this.store.finish(job, generationId, outcome, performance.now() - started,
      outcome === 'advanced' || moved ? DISCOVERY_REFRESH_COST.intervalMs
        : outcome === 'retry' || outcome === 'inactive' ? DISCOVERY_REFRESH_COST.retryMs : DISCOVERY_REFRESH_COST.idleMs);
    return outcome;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = withWorkerTelemetry('main.discovery.refresh', () => this.tick(), outcome => ({
        outcome: outcome === 'relay-behind' || outcome === 'inactive' ? 'deferred'
          : outcome === 'advanced' || outcome === 'activated' ? 'worked' : outcome,
      })).catch(error => { console.error('discovery refresh tick failed', error); })
        .finally(() => { this.running = undefined; });
    }, DISCOVERY_REFRESH_COST.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
