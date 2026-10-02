import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { MAX_RATING_AGGREGATE_SLOTS } from '../access/rating-aggregate-inventory.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { readComponentState } from '../work/history.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import type { Base } from '../target/contract.ts';
import { queryWorkStandingRating } from './global-aggregate.ts';
import { queryExperienceRatingAggregate } from './experience-aggregate.ts';
import { queryReleaseRatingAggregate } from './release-aggregate.ts';
import { queryTargetRatingAggregate } from './target-aggregate.ts';
import {
  DAILY_CADENCE,
  DAILY_CONTEXT_PROFILE,
  DAILY_OBSERVATION_PROFILE,
  retainedRatingPeriod,
} from './calendar.ts';
import { EXPERIENCE_CADENCE } from './experience.ts';
import {
  RATING_STANDING_CADENCE,
  RATING_ACCOUNT_POPULATION,
  RATING_LATEST_MEAN_POLICY,
} from './context.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from './global.ts';
import { RELEASE_CONTEXT_PROFILE } from './release.ts';
import { sameRatingInstant, standingRatingDigest } from './observation.ts';

const unavailable = (): never => {
  throw new WorkReadUnavailable('Rating population evidence is unavailable');
};

/** Public count is an adapter over the exact-grain sealed owners, never a
 * second rating calculation. Each Context retains its owner's 100-slot budget;
 * exceeding it returns unavailable rather than a sampled count. */
export async function verifiedPopulationCounts(
  session: WorkReadSession,
  target: { resource: string; base: Base; main: string | null },
  contexts: string[],
) {
  const ids = [...new Set(contexts)],
    counts = new Map<string, number>();
  if (ids.length > 64) unavailable();
  if (!ids.length) return counts;
  const rows = await session.query(
    `SELECT ?context ?cadence ?profile WHERE {
    VALUES ?context { ${ids.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?context rv:ratingCadence ?cadence ; rv:head ?head }
    GRAPH ${iri(GRAPHS.revisions)} { ?head rv:modelRevision ?profile }
  } LIMIT ${ids.length + 1}`,
    ids.length,
  );
  if (
    rows.length !== ids.length ||
    new Set(rows.map((row) => row.context?.value)).size !== ids.length
  )
    unavailable();
  const access = session.deps.access;
  const inventory =
    access.readRatingAggregateInventory && access.checkRatingAggregateFence
      ? {
          readRatingAggregateInventory: access.readRatingAggregateInventory.bind(access),
          checkRatingAggregateFence: access.checkRatingAggregateFence.bind(access),
        }
      : null;
  for (const row of rows) {
    const context = row.context!.value;
    let result: { count: number; sourcePosition: { dataEpoch: string; sequence: string } };
    if (target.main) {
      if (!inventory) unavailable();
      const input = { context, work: target.resource, mainVersion: target.main };
      if (row.cadence!.value === RATING_STANDING_CADENCE) {
        result = await queryWorkStandingRating(session.deps.environment, inventory!, {
          ...input,
          kind: row.profile!.value.includes('/global-') ? 'global' : 'realm',
        });
      } else if (row.cadence!.value === EXPERIENCE_CADENCE) {
        result = await queryExperienceRatingAggregate(session.deps.environment, inventory!, {
          ...input,
          profile: 'realm-experience-pooled-observation-mean-v1',
        });
      } else if (row.cadence!.value === DAILY_CADENCE) {
        result = await dailyCount(session, context, input.work, input.mainVersion);
      } else unavailable();
    } else if (target.base === 'release' && row.profile!.value === RELEASE_CONTEXT_PROFILE) {
      if (!session.deps.releaseRatingInventory) unavailable();
      result = await queryReleaseRatingAggregate(
        session.deps.environment,
        session.deps.releaseRatingInventory!,
        {
          context,
          release: target.resource,
        },
      );
    } else {
      if (!session.deps.targetRatingInventory) unavailable();
      result = await queryTargetRatingAggregate(
        session.deps.environment,
        session.deps.targetRatingInventory!,
        {
          context,
          target: target.resource,
        },
      );
    }
    if (
      result!.sourcePosition.dataEpoch !== session.position.dataEpoch ||
      result!.sourcePosition.sequence !== session.position.sequence
    )
      unavailable();
    counts.set(context, result!.count);
  }
  return counts;
}

/** Daily counts all available daily slots, without rolling them into standing
 * or experience populations. The sealed head and immutable bytes must agree. */
async function dailyCount(session: WorkReadSession, context: string, work: string, main: string) {
  const access = session.deps.access;
  const signal = fusekiReadBudget.getStore()?.signal ?? AbortSignal.timeout(10_000);
  const inventory = await access.readRatingAggregateInventory!(context, main, signal);
  if (inventory.heads.length > MAX_RATING_AGGREGATE_SLOTS) unavailable();
  const roots = await session.query(
    `SELECT ?manifest ?receipt ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(context)} rv:head ${iri(inventory.contextRevision)} ;
      rv:realm ${iri(inventory.realm)} ; rv:contextState rv:Active }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(inventory.contextRevision)} rv:component ${iri(context)} ;
      rv:modelRevision ${iri(DAILY_CONTEXT_PROFILE)} ; rv:manifest ?manifest ; rv:dataEpoch ?epoch ; rv:sequence ?sequence }
    GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:ratingContextRevision ${iri(inventory.contextRevision)} ; rv:outcome rv:Succeeded }
  } LIMIT 2`,
    1,
  );
  const root = roots[0];
  if (
    !root?.manifest ||
    root.receipt?.value !== inventory.contextReceipt ||
    root.epoch?.value !== inventory.contextDataEpoch ||
    root.sequence?.value !== inventory.contextSequence
  )
    unavailable();
  const budget = { signal, bytesLeft: 524_288 };
  const contextState = readComponentState(
    session.deps.environment.objectDirectory,
    root!.manifest!.value,
    context,
    DAILY_CONTEXT_PROFILE,
    budget,
  );
  if (
    contextState.context !== context ||
    contextState.realm !== inventory.realm ||
    contextState.cadence !== DAILY_CADENCE ||
    contextState.targetGrain !== 'MainVersion' ||
    contextState.state !== 'active' ||
    contextState.scaleMin !== 1 ||
    contextState.scaleMax !== 10 ||
    contextState.populationPolicy !== RATING_ACCOUNT_POPULATION ||
    contextState.aggregationPolicy !== RATING_LATEST_MEAN_POLICY
  )
    unavailable();
  const rows = await session.query(
    `SELECT ?observation ?head ?slot ?manifest ?availability ?value
      ?receipt ?digest ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?observation rv:ratingContext ${iri(context)} ; rv:targetMainVersion ${iri(main)} .
      FILTER NOT EXISTS { ?observation rv:targetRelease ?release } }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?observation rv:observationHead ?head ; rv:ratingSlot ?slot }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RevisionAnchor ; rv:component ?observation ;
        rv:modelRevision ${iri(DAILY_OBSERVATION_PROFILE)} ; rv:manifest ?manifest ;
        rv:ratingAvailability ?availability ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ?head a rv:ErasedRevision } OPTIONAL { ?head rv:ratingValue ?value } }
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:observationRevision ?head ; rv:requestDigest ?digest ; rv:outcome rv:Succeeded } }
  } LIMIT 101`,
    101,
  );
  if (rows.length !== inventory.heads.length) unavailable();
  const sealed = new Map(inventory.heads.map((head) => [head.observation, head]));
  const seen = new Set<string>();
  let count = 0;
  for (const row of rows) {
    const head = sealed.get(row.observation!.value);
    if (
      !head ||
      seen.has(head.slot) ||
      head.originWork ||
      head.work !== work ||
      !row.manifest ||
      row.head?.value !== head.revision ||
      row.slot?.value !== head.slot ||
      row.receipt?.value !== head.receipt ||
      row.digest?.value !== head.requestDigest ||
      row.epoch?.value !== head.dataEpoch ||
      row.sequence?.value !== head.sequence
    )
      unavailable();
    seen.add(head!.slot);
    const state = readComponentState(
      session.deps.environment.objectDirectory,
      row.manifest!.value,
      head!.observation,
      DAILY_OBSERVATION_PROFILE,
      budget,
    );
    try {
      const period = retainedRatingPeriod(state);
      if (period.timeZone !== contextState.timeZone || period.calendar !== contextState.calendar)
        unavailable();
    } catch {
      unavailable();
    }
    const available = row.availability?.value === `${RV}Available`,
      withdrawn = row.availability?.value === `${RV}Withdrawn`;
    const value = row.value ? Number(row.value.value) : null;
    if (
      (!available && !withdrawn) ||
      (available && (!Number.isInteger(value) || value! < 1 || value! > 10)) ||
      (withdrawn && value !== null) ||
      state.observation !== head!.observation ||
      state.revision !== head!.revision ||
      state.slot !== head!.slot ||
      state.context !== context ||
      state.realm !== inventory.realm ||
      state.contextRevision !== inventory.contextRevision ||
      state.work !== work ||
      state.mainVersion !== main ||
      state.availability !== (available ? 'available' : 'withdrawn') ||
      state.value !== value ||
      !sameRatingInstant(state.evaluatedAt, head!.evaluatedAt) ||
      !sameRatingInstant(state.submittedAt, head!.submittedAt) ||
      standingRatingDigest(
        {
          context,
          work,
          mainVersion: main,
          value,
          expectedRevisionHead: state.predecessor as string | null,
          actingSubject: head!.actingSubject,
        },
        true,
      ) !== head!.requestDigest
    )
      unavailable();
    if (available) count++;
  }
  if (
    inventory.realm === GLOBAL_RATING_POPULATION_OWNER ||
    !(await access.checkRatingAggregateFence!(inventory.recoveryGeneration, signal))
  )
    unavailable();
  return { count, sourcePosition: session.position };
}
