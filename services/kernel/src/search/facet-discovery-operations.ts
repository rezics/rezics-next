import type { Access } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import type { Pool } from 'pg';
import type { PublicFilterCost, PublicFilterSource } from '../semantic/public-filter-source-contract.ts';
import { createFacetPopulationSource } from '../semantic/facet-population.ts';
import type { PublicFilterSourceBinding } from '../semantic/public-filter-source-binding.ts';
import type { PrivacyReductionStart } from '../semantic/public-filter-source-contract.ts';
import { subjectPartition, type SubjectSource } from './source.ts';
import { validateRequestSourceSnapshot } from './request-source-snapshot.ts';
import { compileFilter } from './filter.ts';
import { isDeepStrictEqual } from 'node:util';
import type {
  PublicFilterConsumerCapture,
  PublicFilterConsumerCaptureInput,
  PublicFilterConsumerContext,
  PublicFilterConsumerRepair,
  PublicFilterConsumerJob,
  PublicFilterConsumerQuery,
  PublicFilterQueriedObservation,
} from './public-filter-consumer-contract.ts';
import type { OpenSearch } from './opensearch.ts';
import {
  type FacetNativeOperations,
  type FacetNativePlan,
  type FacetNativePageResult,
} from './facet-discovery-native.ts';
import { createFacetDiscoveryStorage } from './facet-discovery-storage.ts';
import {
  scopedFacetIdentityKey,
  type ScopedFacetAdmission,
  type ScopedFacetObservation,
} from './scoped-facet-source.ts';
import type { createScopedFacetSource } from './scoped-facet-source.ts';

type Meter = { -readonly [K in keyof PublicFilterCost]: number };
const empty = (): Meter => ({
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
});
function add(meter: Meter, cost: PublicFilterCost) {
  for (const key of Object.keys(meter) as (keyof PublicFilterCost)[]) meter[key] += cost[key];
}

function overflowFor(plan: FacetNativePlan): string[] | undefined {
  const fromFilter = plan.filterDocument
    ? [
        ...new Set(
          compileFilter(plan.filterDocument, { prefix: 'f', relationOverflow: true }).leaves.flatMap((leaf) =>
            leaf.facet === 'statement' ? [leaf.property] : [],
          ),
        ),
      ]
    : [];
  const extra = plan.valueKind === 'type' || plan.property === 'type' ? [] : [plan.property];
  const all = [...new Set([...fromFilter, ...extra])];
  return all.length ? all : undefined;
}

function captureInput(plan: FacetNativePlan): PublicFilterConsumerCaptureInput {
  const overflowProperties = overflowFor(plan);
  return {
    filterDocument: plan.filterDocument,
    text: plan.text,
    sort: plan.valueKind === 'item' ? 'name' : 'id',
    size: 1,
    ...(overflowProperties === undefined ? {} : { overflowProperties }),
  };
}

function clean(
  observed: Awaited<ReturnType<PublicFilterSource['readPrivacyReductionHeads']>>,
): observed is Extract<Awaited<ReturnType<PublicFilterSource['readPrivacyReductionHeads']>>, { status: 'observed' }> {
  return (
    observed.status === 'observed' &&
    observed.routingComplete &&
    observed.unacknowledged.length === 0 &&
    observed.changed.length === 0 &&
    observed.blocking.length === 0
  );
}

type StoredRow = {
  value: string;
  labels: Record<string, string>;
  contributor_original: string;
  contributor_terminal: string;
  target_original: string | null;
  target_terminal: string | null;
};

export function createFacetNativeOperations(
  config: Readonly<{
    pool: Pool;
    routeKey: Uint8Array;
    access: Access;
    search: OpenSearch;
    clock: KernelClock;
    source: PublicFilterSource;
    binding: PublicFilterSourceBinding;
    subjects: SubjectSource;
    scopedFacets?: ReturnType<typeof createScopedFacetSource>;
    query: (
      queried: PublicFilterQueriedObservation,
      context: PublicFilterConsumerContext,
    ) => Promise<PublicFilterConsumerQuery>;
    capture: (
      plan: PublicFilterConsumerCaptureInput,
      snapshot: 'pit' | 'prepared',
      context: PublicFilterConsumerContext,
    ) => Promise<PublicFilterConsumerCapture>;
    repair: (job: PublicFilterConsumerJob, context: PublicFilterConsumerContext) => Promise<PublicFilterConsumerRepair>;
  }>,
): FacetNativeOperations {
  const storage = createFacetDiscoveryStorage({
    pool: config.pool,
    source: config.source,
    binding: config.binding,
    population: createFacetPopulationSource({
      pool: config.pool,
      routeKey: config.routeKey,
      access: config.access,
      clock: config.clock,
    }),
    ...(config.scopedFacets ? { scopedFacets: config.scopedFacets } : {}),
    subjects: config.subjects,
    search: config.search,
    clock: config.clock,
  });

  async function visible(id: string | null) {
    if (!id) return null;
    const partition = subjectPartition(id);
    const snapshot = validateRequestSourceSnapshot(await config.subjects.read(partition, [id]), partition, [id]);
    const subject = snapshot.get(id);
    if (!subject || subject.visibility !== 'visible' || subject.redirect !== null) return null;
    return subject;
  }

  async function current(row: StoredRow, kind: FacetNativePlan['valueKind']) {
    const contributor = await visible(row.contributor_original);
    if (!contributor || contributor.id !== row.contributor_terminal) return null;
    if (kind !== 'item') return { labels: {} as Record<string, string> };
    const target = await visible(row.target_original);
    if (!target || target.id !== (row.target_terminal ?? row.value)) return null;
    return { labels: Object.fromEntries(target.labels.map(({ language, value }) => [language, value])) };
  }

  type RetainedExecution = Readonly<{ start: PrivacyReductionStart; execution: string }>;

  function cleanForExecution(
    observed: Awaited<ReturnType<PublicFilterSource['readPrivacyReductionHeads']>>,
    retained: RetainedExecution,
  ) {
    return clean(observed) && observed.start.observation === retained.start.observation;
  }

  async function observe(
    queried: PublicFilterQueriedObservation,
    retained: RetainedExecution,
    context: PublicFilterConsumerContext,
  ) {
    return config.source.readPrivacyReductionHeads({
      kind: 'population',
      queried,
      start: retained.start,
      execution: retained.execution,
      context,
    });
  }

  async function observeScope(admission: ScopedFacetAdmission, context: PublicFilterConsumerContext) {
    const current: ScopedFacetObservation = config.scopedFacets
      ? await config.scopedFacets.observe(admission, context)
      : { status: 'unready', cost: empty() };
    return current.status === 'observed' &&
      scopedFacetIdentityKey(current.identity) === scopedFacetIdentityKey(admission.identity)
      ? current
      : current.status === 'observed'
        ? { status: 'unready' as const, cost: current.cost }
        : current;
  }

  const executions = new Map<string, RetainedExecution>();

  return {
    async captureFacet({ plan }, context) {
      const input = captureInput(plan);
      const prepared = await config.capture(input, 'prepared', context);
      if (prepared.status !== 'captured') {
        if (prepared.status === 'preparing') await config.repair(prepared.repair, context).catch(() => {});
        return prepared;
      }
      const meter = empty();
      add(meter, prepared.cost);
      if (prepared.queried.snapshot.kind !== 'prepared')
        return { status: 'preparing' as const, repair: prepared.repair, cost: meter };
      let textObservation: PublicFilterQueriedObservation | undefined;
      if (plan.text) {
        const pit = await config.capture(input, 'pit', context);
        if (pit.status !== 'captured' || pit.queried.snapshot.kind !== 'pit') {
          if (pit.status === 'preparing') await config.repair(pit.repair, context).catch(() => {});
          add(meter, pit.cost);
          return pit.status === 'captured'
            ? { status: 'preparing' as const, repair: prepared.repair, cost: meter }
            : { ...pit, cost: meter };
        }
        add(meter, pit.cost);
        textObservation = pit.queried;
      }
      const observation = prepared.queried.snapshot.observation;
      let retained = executions.get(observation);
      if (!retained) {
        const query = await config.query(prepared.queried, context);
        add(meter, query.cost);
        if (query.status !== 'queried') {
          if (query.status === 'preparing') await config.repair(prepared.repair, context).catch(() => {});
          return query.status === 'preparing'
            ? { status: 'preparing' as const, repair: prepared.repair, cost: meter }
            : { ...query, cost: meter };
        }
        if (
          query.queried.snapshot.kind !== 'prepared' ||
          !isDeepStrictEqual(query.queried, prepared.queried) ||
          !query.execution ||
          !query.start?.observation
        )
          return { status: 'preparing' as const, repair: prepared.repair, cost: meter };
        retained = { start: query.start, execution: query.execution };
        executions.set(observation, retained);
      }
      const start = await observe(prepared.queried, retained, context);
      add(meter, start.cost);
      if (start.status !== 'observed' || !cleanForExecution(start, retained)) {
        executions.delete(observation);
        return { status: 'preparing' as const, repair: prepared.repair, cost: meter };
      }
      try {
        for (let step = 0; step < 256 && Date.now() < context.deadline; step++) {
          const charged = empty();
          const published = await storage.prepareFacetStep(
            plan,
            prepared.queried,
            context,
            charged,
            textObservation,
            retained,
          );
          add(meter, charged);
          if (published === true) return { ...prepared, cost: meter };
        }
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Facet deadline exceeded') {
          executions.delete(observation);
          throw error;
        }
      }
      executions.delete(observation);
      return { status: 'preparing' as const, repair: prepared.repair, cost: meter };
    },

    async pageFacets({ reads }, context) {
      const pageObservations = new Set(reads.map(({ queried }) => queried.snapshot.observation));
      try {
        const meter = empty();
        if (reads.length === 0) return { status: 'preparing' as const, cost: meter };
        const seen = new Set<string>();
        for (const read of reads) {
          if (seen.has(read.queried.snapshot.observation)) continue;
          seen.add(read.queried.snapshot.observation);
          const retained = executions.get(read.queried.snapshot.observation);
          if (!retained) return { status: 'preparing' as const, cost: meter };
          const start = await observe(read.queried, retained, context);
          add(meter, start.cost);
          if (start.status === 'unready' || start.status === 'unavailable' || !cleanForExecution(start, retained))
            return { status: 'preparing' as const, cost: meter };
        }
        seen.clear();
        for (const read of reads) {
          const admission = read.plan.scope;
          if (!admission) continue;
          const key = scopedFacetIdentityKey(admission.identity);
          if (seen.has(key)) continue;
          seen.add(key);
          const start = await observeScope(admission, context);
          add(meter, start.cost);
          if (start.status !== 'observed') return { status: 'preparing' as const, cost: meter };
        }
        const facets: Extract<FacetNativePageResult, { status: 'ready' }>['facets'][number][] = [];
        let asOf = '';
        for (const read of reads) {
          const eligible: { value: string; labels: Record<string, string> }[] = [];
          const found = await storage.readFacetCandidates(read, context);
          add(meter, found.cost);
          if (found.status !== 'candidates' || found.rows.length > read.size + 1)
            return { status: 'preparing' as const, cost: meter };
          asOf = found.asOf;
          for (const row of found.rows as StoredRow[]) {
            let disclosed: Awaited<ReturnType<typeof current>> | null;
            try {
              disclosed = await current(row, read.plan.valueKind);
            } catch {
              disclosed = null;
            }
            meter.accessPoints++;
            if (!disclosed) {
              const invalidated = await storage.retireFacetCandidates(read, context);
              add(meter, invalidated.cost);
              return { status: 'preparing' as const, cost: meter };
            }
            eligible.push({ value: row.value, labels: disclosed.labels });
          }
          if (read.after !== null && eligible.length === 0) return { status: 'preparing' as const, cost: meter };
          const values = eligible.slice(0, read.size);
          facets.push({
            property: read.plan.property,
            values,
            after: values.at(-1)?.value ?? null,
            hasMore: eligible.length > read.size,
          });
          const retained = executions.get(read.queried.snapshot.observation);
          if (!retained) return { status: 'preparing' as const, cost: meter };
          const currentSource = await observe(read.queried, retained, context);
          add(meter, currentSource.cost);
          const currentScope = read.plan.scope ? await observeScope(read.plan.scope, context) : undefined;
          if (currentScope) add(meter, currentScope.cost);
          if (
            currentSource.status !== 'observed' ||
            !cleanForExecution(currentSource, retained) ||
            (currentScope !== undefined && currentScope.status !== 'observed')
          ) {
            for (const candidate of reads) {
              const invalidated = await storage.retireFacetCandidates(candidate, context);
              add(meter, invalidated.cost);
            }
            return { status: 'preparing' as const, cost: meter };
          }
        }
        seen.clear();
        for (const read of reads) {
          if (seen.has(read.queried.snapshot.observation)) continue;
          seen.add(read.queried.snapshot.observation);
          const retained = executions.get(read.queried.snapshot.observation);
          if (!retained) return { status: 'preparing' as const, cost: meter };
          const final = await observe(read.queried, retained, context);
          add(meter, final.cost);
          if (final.status === 'unready' || final.status === 'unavailable' || !cleanForExecution(final, retained)) {
            for (const candidate of reads) {
              const invalidated = await storage.retireFacetCandidates(candidate, context);
              add(meter, invalidated.cost);
            }
            return { status: 'preparing' as const, cost: meter };
          }
        }
        seen.clear();
        for (const read of reads) {
          const admission = read.plan.scope;
          if (!admission) continue;
          const key = scopedFacetIdentityKey(admission.identity);
          if (seen.has(key)) continue;
          seen.add(key);
          const final = await observeScope(admission, context);
          add(meter, final.cost);
          if (final.status !== 'observed') {
            for (const candidate of reads) {
              const invalidated = await storage.retireFacetCandidates(candidate, context);
              add(meter, invalidated.cost);
            }
            return { status: 'preparing' as const, cost: meter };
          }
        }
        return { status: 'ready' as const, facets, asOf, cost: meter };
      } finally {
        for (const observation of pageObservations) executions.delete(observation);
      }
    },

    repairStep: config.repair,
  };
}
