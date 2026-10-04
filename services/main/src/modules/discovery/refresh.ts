import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { withWorkerTelemetry } from '@rezics/observability/runtime';
import { standingContextPattern } from '../rating/contexts.ts';
import {
  digest,
  RecommendationRestart,
  RecommendationStale,
} from '../recommendation/derived-generation.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import {
  workRead,
  WorkReadInvalid,
  WorkReadMissing,
  WorkReadMoved,
  WorkReadUnavailable,
  type WorkReadSession,
} from '../work/read-session.ts';
import { automaticDiscovery } from './automation.ts';
import type { OwnedDiscoveryBasis } from './contract.ts';
import {
  DISCOVERY_REFRESH_COST,
  discoveryRetryDelay,
  DiscoveryRefreshStore,
  type RefreshJob,
} from './refresh-store.ts';
import { admitDiscoveryBasis, projectDiscoveryBatch } from './source.ts';
import { discoveryChanges, type DiscoveryChanges } from './changes.ts';
import type { DiscoveryProjection } from './store.ts';

export type RefreshOutcome =
  | 'idle'
  | 'relay-behind'
  | 'current'
  | 'inactive'
  | 'advanced'
  | 'activated'
  | 'retry'
  | 'basis-unavailable'
  | 'basis-invalid';
const request = () => new Request('http://main.internal/discovery-refresh');

/** Bounded source batches and conservative outbox deltas. Immutable completed
 * cuts may activate while later writes wait for the next refresh. */
export class DiscoveryRefreshWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<unknown> | undefined;
  private foregroundTicks = 0;

  constructor(
    private readonly deps: MainWorkDependencies,
    private readonly store: DiscoveryRefreshStore,
    private readonly projection: DiscoveryProjection,
  ) {}

  private async caughtUp(session: WorkReadSession): Promise<boolean> {
    const relay = await this.deps.relayPosition?.read();
    return (
      !!relay &&
      relay.dataEpoch === session.position.dataEpoch &&
      relay.sequence === session.position.sequence
    );
  }

  private async enroll(): Promise<void> {
    const after = await this.store.catalog();
    if (after === null) return;
    const result = await workRead(this.deps, request(), {}, async (session) => {
      if (!(await this.caughtUp(session))) return null;
      const rows = await session.query(
        `SELECT ?resource ?context ?scope ?realm WHERE { GRAPH ${iri(GRAPHS.current)} {
        { ${standingContextPattern()} BIND(?context AS ?resource) } UNION {
          ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
          ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
          BIND(?realm AS ?resource) BIND("realm" AS ?scope)
        } FILTER(STR(?resource) > ${lit(after)})
      } } ORDER BY STR(?resource) LIMIT ${DISCOVERY_REFRESH_COST.catalogSize + 1}`,
        DISCOVERY_REFRESH_COST.catalogSize + 1,
      );
      if (
        rows.some((row) => !row.resource || !row.scope) ||
        new Set(rows.map((row) => row.resource!.value)).size !== rows.length
      ) {
        throw new WorkReadUnavailable('Discovery Context catalog is ambiguous');
      }
      const page = rows.slice(0, DISCOVERY_REFRESH_COST.catalogSize);
      const bases: OwnedDiscoveryBasis[] = [
        { scope: 'global', realm: null, context: null, owner: null },
      ];
      for (const row of page) {
        const basis: OwnedDiscoveryBasis = {
          scope: row.scope!.value as 'global' | 'realm',
          realm: row.realm?.value ?? null,
          context: row.context?.value ?? null,
          owner: null,
        };
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
    try {
      await this.enroll();
    } catch (error) {
      if (!(error instanceof WorkReadUnavailable)) throw error;
      // The catalog retries on its next due time; existing jobs still advance.
    }
    const background = ++this.foregroundTicks > DISCOVERY_REFRESH_COST.foregroundBurst;
    if (background) this.foregroundTicks = 0;
    const job = await this.store.claim(background);
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
      const prepared = await workRead(
        this.deps,
        request(),
        { scope: job.basis.scope, realm: job.basis.realm ?? undefined },
        async (session) => {
          if (!(await this.caughtUp(session))) return 'relay-behind';
          const state = await this.store.inspect(job, session.position);
          if (state.inactive) return 'inactive';
          session.principal = state.principal;
          try {
            await admitDiscoveryBasis(session, job.basis);
          } catch (error) {
            // Return through workRead's final source fence: a missing policy
            // during a moved graph is a retry, not stable ineligibility.
            if (error instanceof WorkReadMissing) return 'basis-unavailable';
            if (error instanceof WorkReadInvalid) return 'basis-invalid';
            throw error;
          }
          if (state.fresh) {
            generationId = null;
            return 'current';
          }
          const operator = automaticDiscovery(job.basis.owner);
          let intervening: DiscoveryChanges | null = { works: [], created: [] };
          if (
            state.row &&
            !state.row.complete &&
            (state.row.validated_sequence ?? state.row.source_sequence) !==
              session.position.sequence
          ) {
            const after = state.row.validated_sequence ?? state.row.source_sequence;
            intervening = this.deps.discoveryRefreshInputs
              ? await this.deps.discoveryRefreshInputs.read(session.position, after, job.basis)
              : await discoveryChanges(session, after, job.basis);
            // Finish the pinned population; journal changes and reconcile them
            // before publication. Remote HTTP cannot reconstruct an old mutable
            // head, so mixed source pages never activate at the original cut.
          }
          const changes =
            !state.row && state.reuse
              ? this.deps.discoveryRefreshInputs
                ? await this.deps.discoveryRefreshInputs.read(
                    session.position,
                    state.reuse.covered_sequence ?? state.reuse.source_sequence,
                    job.basis,
                  )
                : await discoveryChanges(
                    session,
                    state.reuse.covered_sequence ?? state.reuse.source_sequence,
                    job.basis,
                  )
              : null;
          if (!state.row && changes && state.reuse && !changes.works.length) {
            return { acknowledge: state.reuse, position: session.position };
          }
          const row =
            state.row ??
            (await this.projection.register(
              operator,
              job.basis,
              session.position,
              {
                idempotencyKey: `refresh:${job.scope_key}:${job.lease_epoch}`,
                requestDigest: digest([job.basis, session.position]),
              },
              changes && state.reuse
                ? { generation: state.reuse.generation_id, works: changes.works }
                : undefined,
            ));
          generationId = row.generation_id;
          await this.store.attach(job, generationId);
          if (!row.complete) {
            const step = await this.projection.beginStep(
              operator,
              row.generation_id,
              row.checkpoint,
            );
            held.step = { id: row.generation_id, lease: step.lease };
            const projected = await projectDiscoveryBatch(session, job.basis, row.checkpoint, {
              works: row.changed_works ?? undefined,
              sequence: row.source_sequence,
            });
            const catchup = [
              ...new Set([...(row.catchup_works ?? []), ...(intervening?.works ?? [])]),
            ].sort();
            const rebuild = row.rebuild_pending || intervening === null || catchup.length > 2000;
            const nextPass =
              projected.complete && (rebuild || catchup.length)
                ? { works: rebuild ? null : catchup, position: session.position }
                : undefined;
            return {
              row,
              step,
              projected: { ...projected, nextPass },
              position: session.position,
              intervening,
            };
          }
          return { row, step: null, projected: null, position: session.position, intervening };
        },
      );
      if (typeof prepared === 'string') outcome = prepared;
      else if ('acknowledge' in prepared && prepared.acknowledge) {
        await this.store.acknowledge(job, prepared.acknowledge, prepared.position);
        generationId = null;
        outcome = 'current';
      } else {
        // Only commit after workRead has checked the graph, principal, Realm
        // and source-attribution fences. A moved multi-query snapshot has no rows.
        const operator = automaticDiscovery(job.basis.owner);
        if (prepared.step)
          await this.store.validated(
            job,
            prepared.row,
            prepared.position.sequence,
            prepared.intervening,
          );
        const row =
          prepared.step && prepared.projected
            ? await this.projection.commitBatch(
                operator,
                prepared.row.generation_id,
                prepared.step.lease,
                prepared.row.checkpoint,
                prepared.projected,
                { dataEpoch: prepared.row.source_epoch, sequence: prepared.row.source_sequence },
              )
            : prepared.row;
        if (!row.complete) outcome = 'advanced';
        else {
          const activated = await this.projection.activate(
            operator,
            row.generation_id,
            row.active_head,
            prepared.position,
            {
              idempotencyKey: `refresh-activate:${row.generation_id}:${row.active_head ?? 'none'}`,
              requestDigest: digest([row.generation_id, row.active_head]),
            },
          );
          if (activated.outcome !== 'succeeded')
            throw new RecommendationStale('Discovery activation head changed');
          generationId = null;
          outcome = 'activated';
        }
      }
    } catch (error) {
      moved = error instanceof WorkReadMoved;
      if (held.step)
        await this.projection.releaseStep(
          automaticDiscovery(job.basis.owner),
          held.step.id,
          held.step.lease,
        );
      if (
        !(
          error instanceof RecommendationRestart ||
          error instanceof RecommendationStale ||
          error instanceof WorkReadMoved
        )
      ) {
        console.error('discovery refresh deferred', error);
      }
    }
    await this.store.finish(
      job,
      generationId,
      outcome,
      performance.now() - started,
      outcome === 'advanced' || moved
        ? DISCOVERY_REFRESH_COST.intervalMs
        : outcome === 'retry'
          ? discoveryRetryDelay(job.attempts)
          : outcome === 'inactive' || outcome === 'basis-unavailable' || outcome === 'basis-invalid'
            ? DISCOVERY_REFRESH_COST.maximumRetryMs
            : job.basis.scope === 'global'
              ? DISCOVERY_REFRESH_COST.idleMs
              : DISCOVERY_REFRESH_COST.backgroundIdleMs,
    );
    return outcome;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = withWorkerTelemetry(
        'main.discovery.refresh',
        () => this.tick(),
        (outcome) => ({
          outcome:
            outcome === 'relay-behind' ||
            outcome === 'inactive' ||
            outcome === 'basis-unavailable' ||
            outcome === 'basis-invalid'
              ? 'deferred'
              : outcome === 'advanced' || outcome === 'activated'
                ? 'worked'
                : outcome,
        }),
      )
        .catch((error) => {
          console.error('discovery refresh tick failed', error);
        })
        .finally(() => {
          this.running = undefined;
        });
    }, DISCOVERY_REFRESH_COST.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
