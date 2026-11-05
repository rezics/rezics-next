import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { ProblemError } from '../http/problem.ts';
import type {
  PublicFilterSource,
  PublicFilterProjectionMeaning,
  PublicFilterCost,
} from '../semantic/public-filter-source-contract.ts';
import type {
  PublicFilterSourceBootstrapBinding,
  PublicFilterSourceCaptureInput,
} from '../semantic/public-filter-source-binding.ts';
import {
  createPublicFilterConsumerOperations,
  queryScopeOrderedKeys,
  measurePublicFilterIteratorSteps,
} from './public-filter-consumer.ts';
import {
  createPublicFilterCustody,
  encodePublicFilterNativeState,
  decodePublicFilterNativeState,
} from './public-filter-custody.ts';
import type { CustodyCost, CustodyUse } from './public-filter-custody-contract.ts';
import type { PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';
import type { OpenSearch } from './opensearch.ts';
import { discoveryIndexUuid, subjectGenerations } from './indices.ts';
import type { SearchHit } from './query.ts';
import { ScopeWork, zeroScopeWork } from './scope-execution.ts';
import {
  addScopePublicCost,
  emptyScopePublicCost,
  validateScopeOrderedHit,
  type ScopeOrderedDefinition,
  type ScopeOrderedPreparation,
} from './scope-ordered.ts';
import { assertCompleteSearch } from './complete-search.ts';
import { admitHitPayload } from './query-payload.ts';
import custodySql from './scope-ordered-custody.sql';

function unavailable(): never {
  throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
}

/** Internal keyed preparation, using the actual consumer capture, custody and native Source.
 * No public response page is used as a membership oracle. The full definition, original cut
 * and execution start remain at the native owners, including on a ready-result reread.
 */
export function createScopeOrderedNative(config: {
  pool: Pool;
  search: OpenSearch;
  prefix: string;
  source: PublicFilterSource;
  binding: PublicFilterSourceBootstrapBinding;
  clock: KernelClock;
  meaning: PublicFilterProjectionMeaning;
  definition: ScopeOrderedDefinition;
}) {
  const custody = createPublicFilterCustody(config.pool, config.binding);
  async function restore(q: PublicFilterQueriedObservation, work: ScopeWork): Promise<PublicFilterQueriedObservation> {
    if (q.snapshot.kind !== 'pit') unavailable();
    const home = Number(q.snapshot.observation.split(':')[0]);
    if (!Number.isSafeInteger(home) || home < 0 || home > 4095) unavailable();
    work.consume({ ...zeroScopeWork(), statements: 1 });
    const rows = await custodySql.run(config.pool, {
      partition: home,
      observation: q.snapshot.observation,
      pit_id: createHash('sha256').update(encodePublicFilterNativeState(q.snapshot.pit)).digest('hex'),
    });
    if (rows.length !== 1) unavailable();
    const row = rows[0]!;
    work.consume({
      ...zeroScopeWork(),
      nativeRows: Number(row.queried !== null) + Number(row.locator !== null),
      bytes: Buffer.byteLength(JSON.stringify(row)),
    });
    if (
      !row.queried ||
      row.state !== 'open' ||
      Number(row.expires_at) <= Date.now() ||
      row.pit_state !== 'owned' ||
      row.locator !== q.snapshot.pit
    )
      unavailable();
    const current = decodePublicFilterNativeState<PublicFilterQueriedObservation>(row.queried);
    if (
      !isDeepStrictEqual(current.consumer, q.consumer) ||
      current.snapshot.kind !== 'pit' ||
      current.snapshot.observation !== q.snapshot.observation
    )
      unavailable();
    // Only a native renewal in the SAME retained observation can recover a crash between
    // PIT retention and the result/frontier CAS. This lookup never certifies Source authority.
    return current;
  }
  function meter(work: ScopeWork) {
    const cost = emptyScopePublicCost();
    const charge = (next: PublicFilterCost) => {
      Object.assign(cost, addScopePublicCost(cost, next));
      const physical = next as Partial<CustodyCost>;
      work.consume({
        ...zeroScopeWork(),
        candidateKeys: next.inputKeys,
        nativePoints: next.accessPoints + next.dependencyPoints,
        nativeRows: physical.rows ?? 0,
        statements: physical.statements ?? 0,
        bytes: physical.bytes ?? 0,
      });
    };
    return { charge, cost: () => cost };
  }
  async function physical(q: PublicFilterQueriedObservation, work: ScopeWork, deadline: number) {
    if (q.consumer.physicalTarget !== config.definition.index || q.consumer.incarnation !== config.definition.uuid)
      unavailable();
    const engineWork = {
      bytes: work.remaining().remaining.bytes,
      deadline,
      settle(bytes: number) {
        work.consume({ ...zeroScopeWork(), bytes });
      },
    };
    const active = await subjectGenerations(config.search, config.prefix, engineWork);
    if (
      active.active !== config.definition.generation ||
      (await discoveryIndexUuid(config.search, config.definition.index, engineWork)) !== config.definition.uuid
    )
      unavailable();
  }
  async function safe(
    q: PublicFilterQueriedObservation,
    execution: string | undefined,
    charge: (c: PublicFilterCost) => void,
    deadline: number,
  ) {
    const joined = await config.binding.join({ queried: q, ...(execution ? { execution } : {}) }, { deadline });
    charge(joined.cost);
    if (joined.status !== 'joined') unavailable();
    const plan = joined.definition.capture;
    if ('purpose' in plan || 'representation' in plan) unavailable();
    if (
      !isDeepStrictEqual(joined.queried, q) ||
      joined.definition.meaning.digest !== config.meaning.digest ||
      plan.sort !== config.definition.nativeOrder ||
      plan.pageSize !== config.definition.pageSize ||
      (execution && joined.execution?.id !== execution)
    )
      unavailable();
    const observed = await config.source.readPrivacyReductionHeads(
      execution
        ? { kind: 'population', queried: q, start: joined.execution!.start, execution, context: { deadline } }
        : { kind: 'population', queried: q, start: null, context: { deadline } },
    );
    charge(observed.cost);
    if (
      observed.status !== 'observed' ||
      observed.coverage !== 'all_native_homes' ||
      !observed.routingComplete ||
      observed.blocking.length ||
      observed.unacknowledged.length ||
      observed.changed.length
    )
      unavailable();
    return { joined, observed };
  }
  return {
    async capture(
      plan: PublicFilterSourceCaptureInput,
      state: ScopeOrderedPreparation,
      work: ScopeWork,
      deadline: number,
    ) {
      if (
        'purpose' in plan ||
        'representation' in plan ||
        plan.sort !== config.definition.nativeOrder ||
        plan.pageSize !== config.definition.pageSize
      )
        unavailable();
      const m = meter(work);
      if (state.queried) {
        const q = await restore(state.queried, work);
        await physical(q, work, deadline);
        await safe(q, state.execution ?? undefined, m.charge, deadline);
        let steps = 0;
        const checked: OpenSearch = {
          ...config.search,
          async request(method, path, body, options) {
            const result = await config.search.request(
              method,
              path,
              path === '/_search' ? { ...(body as object), profile: true } : body,
              options,
            );
            if (path === '/_search') {
              if (result.status !== 200) unavailable();
              assertCompleteSearch(result.body);
              admitHitPayload(
                result.body,
                { sort: config.definition.nativeOrder, size: 0, generation: config.definition.generation },
                config.prefix,
              );
              if (typeof result.body.pit_id !== 'string' || !result.body.pit_id) unavailable();
              steps += measurePublicFilterIteratorSteps(result.body);
            }
            return result as never;
          },
        };
        const renewed = await custody.renewPit(q, 300000, checked, { deadline });
        m.charge({ ...renewed.cost, engineIteratorSteps: steps });
        if (renewed.status !== 'retained') unavailable();
        await safe(renewed.queried, state.execution ?? undefined, m.charge, deadline);
        return { state: { ...state, queried: renewed.queried }, cost: m.cost(), ready: true };
      }
      const operations = await createPublicFilterConsumerOperations({
        ...config,
        physicalTarget: config.definition.index,
        context: { deadline },
      });
      // Consumer capture/repair state survives factory/process loss; never close its observation here.
      if (state.repair) {
        const advanced = await operations.repairStep(state.repair, { deadline });
        m.charge(advanced.cost);
        if (advanced.status !== 'progress' && advanced.status !== 'settled') unavailable();
        const match = /^\d+:bootstrap:(.+)$/.exec(state.repair.job);
        if (!match) unavailable();
        const recovered = await config.binding.recover({ bootstrap: decodeURIComponent(match[1]!) }, { deadline });
        m.charge(recovered.cost);
        if (recovered.status !== 'adopted') return { state, cost: m.cost(), ready: false };
        return { state: { ...state, queried: recovered.queried }, cost: m.cost(), ready: true };
      }
      const result = await operations.capture({ plan, snapshot: 'pit' }, { deadline });
      m.charge(result.cost);
      if (result.status !== 'captured' && result.status !== 'preparing') unavailable();
      return {
        state: {
          ...state,
          queried: result.status === 'captured' ? result.queried : null,
          repair: result.repair,
          execution: null,
        },
        cost: m.cost(),
        ready: result.status === 'captured',
      };
    },
    async validate(state: ScopeOrderedPreparation, work: ScopeWork, deadline: number) {
      if (!state.queried) unavailable();
      const m = meter(work);
      const q = await restore(state.queried, work);
      await physical(q, work, deadline);
      await safe(q, state.execution ?? undefined, m.charge, deadline);
      return m.cost();
    },
    async keys(
      state: ScopeOrderedPreparation,
      keys: readonly string[],
      work: ScopeWork,
      deadline: number,
      retained?: readonly SearchHit[],
    ) {
      if (!state.queried) unavailable();
      let q = await restore(state.queried, work);
      const m = meter(work);
      let use: CustodyUse | undefined;
      try {
        await physical(q, work, deadline);
        const acquired = await custody.acquire(q, { deadline });
        m.charge(acquired.cost);
        if (acquired.status !== 'acquired') unavailable();
        use = acquired.use;
        const { joined, observed } = await safe(q, undefined, m.charge, deadline);
        const plan = joined.definition.capture;
        if ('representation' in plan || 'purpose' in plan || (plan.sort !== 'name' && plan.sort !== 'collections'))
          unavailable();
        let hits: readonly SearchHit[];
        if (retained) hits = retained;
        else {
          const search: OpenSearch = {
            ...config.search,
            request(method, path, body, options) {
              return config.search.request(method, path, body, {
                ...options,
                work: {
                  bytes: work.remaining().remaining.bytes,
                  deadline,
                  settle(bytes) {
                    work.consume({ ...zeroScopeWork(), bytes });
                  },
                },
              });
            },
          };
          const executed = await queryScopeOrderedKeys(
            search,
            q,
            { ...plan, sort: plan.sort },
            keys,
            { deadline },
            async (pit) => {
              const renewal = await custody.retainPit({ use: use!, queried: q, pit }, { deadline });
              m.charge(renewal.cost);
              if (renewal.status !== 'retained') unavailable();
              q = renewal.queried;
            },
          );
          hits = executed.hits;
          m.charge({ ...emptyScopePublicCost(), engineSearches: 1, engineIteratorSteps: executed.engineIteratorSteps });
          work.consume({ ...zeroScopeWork(), statements: 1 });
        }
        m.charge({ ...emptyScopePublicCost(), candidates: hits.length });
        const ownRows: { original: string; terminal: string }[] = [];
        const canonical: SearchHit[] = [];
        for (const hit of hits) {
          validateScopeOrderedHit(config.definition.nativeOrder, hit, config.definition.index);
          const inputLimit = Math.min(100, work.remaining().remaining.candidateKeys);
          if (inputLimit < 1) unavailable();
          const page = await config.source.readPublicFilterProjectionPage({
            subject: hit.id,
            meaning: config.meaning,
            inputLimit,
            frontier: null,
            context: { deadline },
          });
          m.charge(page.cost);
          if (
            page.status !== 'complete' ||
            page.source.subject !== hit.id ||
            page.source.partition !== hit.partition ||
            page.source.securityRevision !== String(hit.securityRevision) ||
            page.source.currentRelease !== config.meaning.digest
          )
            unavailable();
          ownRows.push({ original: hit.id, terminal: page.source.terminal });
          // Never rewrite a post-LIMIT ID or fabricate a canonical Hit. The complete input traversal
          // encounters the real terminal independently; DISTINCT is enforced before ready output.
          if (page.source.terminal === hit.id) canonical.push(hit);
        }
        const execution = randomUUID();
        const appended = await custody.appendExecution(
          { use, execution: { id: execution, start: observed.start, ownRows } },
          { deadline },
        );
        m.charge(appended.cost);
        if (appended.status !== 'appended') unavailable();
        const final = await safe(q, execution, m.charge, deadline);
        if (
          !isDeepStrictEqual(final.joined.covered, joined.covered) ||
          !isDeepStrictEqual(final.joined.execution, { id: execution, start: observed.start, ownRows })
        )
          unavailable();
        await physical(q, work, deadline);
        return { state: { ...state, queried: q, execution }, hits: canonical, cost: m.cost() };
      } finally {
        if (use) m.charge((await custody.release(use, { deadline })).cost);
      }
    },
  };
}
