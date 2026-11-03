import type { Access } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import type { Pool } from 'pg';
import type { PublicFilterCost, PublicFilterSource } from '../semantic/public-filter-source-contract.ts';
import { createFacetPopulationSource } from '../semantic/facet-population.ts';
import type { PublicFilterSourceBinding } from '../semantic/public-filter-source-binding.ts';
import { subjectPartition, type SubjectSource } from './source.ts';
import { validateRequestSourceSnapshot } from './request-source-snapshot.ts';
import { compileFilter } from './filter.ts';
import type {
  PublicFilterConsumerCapture,
  PublicFilterConsumerCaptureInput,
  PublicFilterConsumerContext,
  PublicFilterConsumerRepair,
  PublicFilterConsumerJob,
  PublicFilterQueriedObservation,
} from './public-filter-consumer-contract.ts';
import type { OpenSearch } from './opensearch.ts';
import {
  type FacetNativeOperations,
  type FacetNativePlan,
  type FacetNativePageResult,
} from './facet-discovery-native.ts';
import { createFacetDiscoveryStorage } from './facet-discovery-storage.ts';
import { scopedFacetIdentityKey, type ScopedFacetAdmission, type ScopedFacetObservation } from './scoped-facet-source.ts';
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

  async function observe(queried: PublicFilterQueriedObservation, context: PublicFilterConsumerContext) {
    return config.source.readPrivacyReductionHeads({ kind: 'population', queried, start: null, context });
  }

  async function observeScope(admission: ScopedFacetAdmission, context: PublicFilterConsumerContext) {
    const current: ScopedFacetObservation = config.scopedFacets
      ? await config.scopedFacets.observe(admission, context)
      : { status: 'unready', cost: empty() };
    return current.status === 'observed' && scopedFacetIdentityKey(current.identity) === scopedFacetIdentityKey(admission.identity)
      ? current
      : current.status === 'observed'
        ? { status: 'unready' as const, cost: current.cost }
        : current;
  }

  return {
    async captureFacet({ plan }, context) {
      const input = captureInput(plan);
      const prepared = await config.capture(input, 'prepared', context);
      if (prepared.status !== 'captured') {
        if (prepared.status === 'preparing') await config.repair(prepared.repair, context).catch(() => {});
        return prepared;
      }
      let textObservation: PublicFilterQueriedObservation | undefined;
      if (plan.text) {
        const pit = await config.capture(input, 'pit', context);
        if (pit.status !== 'captured' || pit.queried.snapshot.kind !== 'pit') {
          if (pit.status === 'preparing') await config.repair(pit.repair, context).catch(() => {});
          return pit.status === 'captured' ? { status: 'preparing' as const, repair: pit.repair, cost: pit.cost } : pit;
        }
        textObservation = pit.queried;
      }
      const meter = empty();
      add(meter, prepared.cost);
      try {
        for (let step = 0; step < 256 && Date.now() < context.deadline; step++) {
          const charged = empty();
          const published = await storage.prepareFacetStep(plan, prepared.queried, context, charged, textObservation);
          add(meter, charged);
          if (published === true) return { ...prepared, cost: meter };
        }
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Facet deadline exceeded') throw error;
      }
      return { status: 'preparing' as const, repair: prepared.repair, cost: meter };
    },

    async pageFacets({ reads }, context) {
      const meter = empty();
      if (reads.length === 0) return { status: 'preparing' as const, cost: meter };
      const seen = new Set<string>();
      for (const read of reads) {
        if (seen.has(read.queried.snapshot.observation)) continue;
        seen.add(read.queried.snapshot.observation);
        const start = await observe(read.queried, context);
        add(meter, start.cost);
        if (start.status === 'unready' || start.status === 'unavailable' || !clean(start))
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
        let after = read.after;
        for (;;) {
          const found = await storage.readFacetCandidates({ ...read, after, size: read.size }, context);
          add(meter, found.cost);
          if (found.status !== 'candidates') return { status: 'preparing' as const, cost: meter };
          asOf = found.asOf;
          if (found.rows.length === 0) break;
          for (const row of found.rows as StoredRow[]) {
            const disclosed = await current(row, read.plan.valueKind);
            meter.accessPoints++;
            if (disclosed) {
              eligible.push({ value: row.value, labels: disclosed.labels });
              if (eligible.length === read.size + 1) break;
            }
          }
          if (eligible.length === read.size + 1 || found.rows.length < read.size + 1) break;
          after = found.rows.at(-1)!.value;
        }
        if (read.after !== null && eligible.length === 0) return { status: 'preparing' as const, cost: meter };
        const values = eligible.slice(0, read.size);
        facets.push({
          property: read.plan.property,
          values,
          after: values.at(-1)?.value ?? null,
          hasMore: eligible.length > read.size,
        });
      }
      seen.clear();
      for (const read of reads) {
        if (seen.has(read.queried.snapshot.observation)) continue;
        seen.add(read.queried.snapshot.observation);
        const final = await observe(read.queried, context);
        add(meter, final.cost);
        if (final.status === 'unready' || final.status === 'unavailable' || !clean(final))
          return { status: 'preparing' as const, cost: meter };
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
        if (final.status !== 'observed') return { status: 'preparing' as const, cost: meter };
      }
      return { status: 'ready' as const, facets, asOf, cost: meter };
    },

    repairStep: config.repair,
  };
}
