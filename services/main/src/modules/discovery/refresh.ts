import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { logWorkerFault } from '@rezics/observability/log';
import { withWorkerTelemetry } from '@rezics/observability/runtime';
import { runWorkerTick } from '../../worker-tick.ts';
import { graphReadVersion } from '../../infrastructure/graph-read-fence.ts';
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
  WorkReadLimit,
  WorkReadMissing,
  WorkReadMoved,
  WorkReadUnavailable,
  type WorkReadSession,
} from '../work/read-session.ts';
import { isWorkReadSourceInvalid } from '../work/read-source-fault.ts';
import { MediaInvalid } from '../media/contract.ts';
import { automaticDiscovery } from './automation.ts';
import type { OwnedDiscoveryBasis } from './contract.ts';
import {
  DISCOVERY_REFRESH_COST,
  discoveryRetryDelay,
  DiscoveryRefreshStore,
  type RefreshJob,
  type RefreshDisposition,
} from './refresh-store.ts';
import { admitDiscoveryBasis, projectDiscoveryBatch } from './source.ts';
import { discoveryChanges, discoveryStatementWorks, type DiscoveryChanges } from './changes.ts';
import {
  DISCOVERY_SOURCE_KEY_COST,
  type DiscoveryGeneration,
  type DiscoveryProjection,
} from './store.ts';
import { ALSO_ENJOYED_COST } from '../also-enjoyed/store.ts';
import {
  compareRelayPositions,
  MAIN_RELAY_STREAM_SCOPE,
  type RelayHandoffPosition,
} from '../outbox/relay-position.ts';

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
  private coReaderFoldDue = 0;

  constructor(
    private readonly deps: MainWorkDependencies,
    private readonly store: DiscoveryRefreshStore,
    private readonly projection: DiscoveryProjection,
  ) {}

  private async judgedWorks(
    session: WorkReadSession,
    prior: DiscoveryGeneration,
    statements: readonly string[],
  ): Promise<string[] | null> {
    if (!statements.length) return [];
    const works = await discoveryStatementWorks(session, statements);
    return works && (await this.store.members(prior, works));
  }

  private async streamCoverage(session: WorkReadSession): Promise<RelayHandoffPosition | null> {
    const coverage = await this.deps.relayPosition?.read();
    if (!coverage) return null;
    try {
      const start = {
        streamScope: MAIN_RELAY_STREAM_SCOPE,
        dataEpoch: session.position.dataEpoch,
        sequence: '0',
      };
      compareRelayPositions(coverage, start);
      return coverage;
    } catch {
      return null;
    }
  }

  private async caughtUp(session: WorkReadSession): Promise<boolean> {
    return (await this.streamCoverage(session)) !== null;
  }

  private async enroll(): Promise<void> {
    const after = await this.store.catalog();
    if (after === null) return;
    // One keyset query. A later sequence is the next catalog pass; the cursor
    // still advances. An epoch change still refuses the page.
    const result = await workRead(this.deps, request(), { movingGraph: true }, async (session) => {
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
    }).catch(async (error: unknown) => {
      if (error instanceof WorkReadMoved) {
        // Restart the keyset scan after a restore; its old cursor can skip
        // resources introduced before that key in the restored graph.
        await this.store.catalogDone(after, '');
      }
      throw error;
    });
    if (!result) return;
    await this.store.enroll(result.bases);
    await this.store.catalogDone(after, result.after);
  }

  async tick(): Promise<RefreshOutcome> {
    await this.store.purge();
    // Reuse this scheduler for co-reader maintenance and one durable build step.
    await this.deps.alsoEnjoyed?.purge().catch((error: unknown) => {
      logWorkerFault('main.discovery.refresh', error);
    });
    if (this.deps.alsoEnjoyed && performance.now() >= this.coReaderFoldDue) {
      this.coReaderFoldDue = performance.now() + ALSO_ENJOYED_COST.foldMs;
      await this.deps.alsoEnjoyed.fold().catch((error: unknown) => {
        logWorkerFault('main.discovery.refresh', error);
      });
    }
    await this.deps.alsoEnjoyed?.refresh(this.deps, request()).catch((error: unknown) => {
      logWorkerFault('main.discovery.refresh', error);
    });
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
    const held: { step?: { id: string; lease: string }; disposition?: RefreshDisposition } = {};
    let disposition: RefreshDisposition | undefined;
    let moved = false;
    try {
      const prepared = await workRead(
        this.deps,
        request(),
        { scope: job.basis.scope, realm: job.basis.realm ?? undefined },
        async (session) => {
          const streamCoverage = await this.streamCoverage(session);
          if (!streamCoverage) return 'relay-behind';
          // The native stamp also notices repairs made without a graph receipt.
          // Without that transport extension, the graph/Access source cuts still
          // conservatively rearm every receipted change.
          const graphVersion = graphReadVersion(await this.deps.environment.fuseki.query('ASK {}', 1024)) ?? null;
          const state = await this.store.inspect(job, session.position, graphVersion);
          if (state.quarantined) {
            held.disposition = { basis: state.sourceBasis, reason: job.quarantine_reason!,
              error: job.last_error! };
            return job.quarantine_reason!;
          }
          if (state.inactive) {
            held.disposition = { basis: state.sourceBasis, reason: 'inactive', error: 'Reader is inactive' };
            return 'inactive';
          }
          session.principal = state.principal;
          try {
            try {
              await admitDiscoveryBasis(session, job.basis);
            } catch (error) {
              // Return through workRead's final source fence: a missing policy
              // during a moved graph is a retry, not stable ineligibility.
              if (error instanceof WorkReadMissing) {
                held.disposition = { basis: state.sourceBasis, reason: 'basis-unavailable', error: error.message };
                return 'basis-unavailable';
              }
              throw error;
            }
            if (state.fresh) {
              generationId = null;
              return 'current';
            }
            const operator = automaticDiscovery(job.basis.owner);
            // The immutable input pin remains at registration. A newer source cut
            // means the scan has entered its one catch-up pass; later writes belong
            // to the next generation, even when this pass takes several ticks.
            const catchingUp =
              !!state.row &&
              BigInt(state.row.source_sequence) > BigInt(state.row.population_sequence);
            let intervening: DiscoveryChanges | null = { works: [], created: [] };
            if (
              state.row &&
              !state.row.complete &&
              !catchingUp &&
              (state.row.validated_sequence ?? state.row.source_sequence) !==
                session.position.sequence
            ) {
              const after = {
                dataEpoch: state.row.source_epoch,
                sequence: state.row.validated_sequence ?? state.row.source_sequence,
              };
              intervening = this.deps.discoveryRefreshInputs
                ? await this.deps.discoveryRefreshInputs.read(
                    streamCoverage,
                    after,
                    job.basis,
                    session,
                  )
                : await discoveryChanges(session, after.sequence, job.basis);
              // Finish the pinned population; journal changes and reconcile them
              // before publication. Remote HTTP cannot reconstruct an old mutable
              // head, so mixed source pages never activate at the original cut.
            }
            const changes =
              !state.row && state.reuse
                ? this.deps.discoveryRefreshInputs
                  ? await this.deps.discoveryRefreshInputs.read(
                      streamCoverage,
                      {
                        dataEpoch: state.reuse.source_epoch,
                        sequence: state.reuse.covered_sequence ?? state.reuse.source_sequence,
                      },
                      job.basis,
                      session,
                    )
                  : await discoveryChanges(
                      session,
                      state.reuse.covered_sequence ?? state.reuse.source_sequence,
                      job.basis,
                    )
                : null;
            // Judged Statements folded after the active basis reach only the
            // Works they classify there; votes elsewhere are acknowledged.
            const judged =
              changes && state.reuse && state.access
                ? await this.judgedWorks(session, state.reuse, state.access.statements)
                : null;
            const works =
              changes && judged ? [...new Set([...changes.works, ...judged])].sort() : null;
            if (!state.row && works && state.reuse && state.access && !works.length) {
              return {
                acknowledge: state.reuse,
                position: session.position,
                access: state.access.revision,
              };
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
                works &&
                  state.reuse &&
                  state.access &&
                  works.length <= DISCOVERY_SOURCE_KEY_COST.statements
                  ? {
                      generation: state.reuse.generation_id,
                      works,
                      access: state.access.revision,
                    }
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
                !catchingUp && projected.complete && (rebuild || catchup.length)
                  ? { works: rebuild ? null : catchup, position: session.position }
                  : undefined;
              return {
                row,
                step,
                projected: { ...projected, nextPass },
                position: session.position,
                validatedPosition: catchingUp
                  ? { dataEpoch: row.source_epoch, sequence: row.source_sequence }
                  : session.position,
                intervening,
              };
            }
            return { row, step: null, projected: null, position: session.position, intervening };
          } catch (error) {
            if (!(error instanceof WorkReadInvalid || error instanceof WorkReadLimit
              || error instanceof MediaInvalid || isWorkReadSourceInvalid(error))) throw error;
            // A typed input refusal is evidence only if workRead can still close
            // its graph and authority fences. Exhausted budgets, timeouts and
            // moved sources instead leave this attempt on the transient path.
            // Classified-source summaries can reject malformed stored references
            // with MediaInvalid; MediaUnavailable still follows normal backoff.
            held.disposition = { basis: state.sourceBasis, reason: 'basis-invalid', error: error.message };
            return 'basis-invalid';
          }
        },
      );
      if (typeof prepared === 'string') {
        if (held.step) await this.projection.releaseStep(automaticDiscovery(job.basis.owner), held.step.id, held.step.lease);
        disposition = held.disposition;
        outcome = prepared;
      } else if ('acknowledge' in prepared && prepared.acknowledge) {
        await this.store.acknowledge(job, prepared.acknowledge, prepared.position, prepared.access);
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
            prepared.validatedPosition,
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
        (error instanceof RecommendationStale && error.cause !== undefined) ||
        !(
          error instanceof RecommendationRestart ||
          error instanceof RecommendationStale ||
          error instanceof WorkReadMoved
        )
      ) {
        logWorkerFault('main.discovery.refresh', error);
      }
    }
    // A probe outage must not turn quarantined input back into ordinary work.
    // inspect clears this basis only after observing a genuinely changed source.
    if (!disposition && job.quarantine_basis)
      disposition = { basis: job.quarantine_basis, reason: job.quarantine_reason!, error: job.last_error! };
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
      disposition,
    );
    return outcome;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = runWorkerTick('main.discovery.refresh', () => withWorkerTelemetry(
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
      ))
        .catch((error) => {
          logWorkerFault('main.discovery.refresh', error);
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
