import { DATASET, GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMissing, WorkReadMoved, type WorkReadSession } from '../work/read-session.ts';
import { resolveVisibleTargets, TargetNotBound } from '../target/resolve.ts';
import { MAX_SUMMARY_BATCH } from '../media/summary.ts';
import { RatingAggregateUnavailable } from './aggregate.ts';
import { componentsAgree } from './components.ts';
import { RANK_FORMULA, RANK_MINIMUM_RATINGS, memberFigure, rankMembers, rankingPrior, rollUp, MAX_ROLLUP_MEMBERS,
  type RollupFormula } from './rollup.ts';
import { readTargetRatingContext, type TargetGrain } from './target.ts';
import type { TargetRatingInventoryStore } from './target-inventory.ts';
import { ROLLUP_PROFILE } from './rollup-api.ts';

/** One Access snapshot of every member's row and the Context's own, two graph
 * probes (Context seal, the members' last writes) and ceil(members / 64)
 * visibility batches; no member's raters are read. */
export const ROLLUP_COST = { members: MAX_ROLLUP_MEMBERS, accessSnapshots: 1, graphProbes: 2,
  visibilityBatch: MAX_SUMMARY_BATCH, deadlineMs: 10_000 } as const;

type Unavailable = 'unavailable' | 'grain-mismatch' | 'needs-reconstruction' | 'unverified';

/** Members the caller cannot read, or that cannot be verified, are named with a
 * reason and counted in the member total; nothing is dropped silently. */
async function readableMembers(session: WorkReadSession, targets: readonly string[], grain: TargetGrain) {
  const verdict = new Map<string, Unavailable | null>(targets.map(target => [target, 'unavailable']));
  const resolve = async (batch: readonly string[]) => {
    for (const target of await resolveVisibleTargets(session, batch, 'rating')) {
      verdict.set(target.resource, target.base === grain ? null : 'grain-mismatch');
    }
  };
  for (let start = 0; start < targets.length; start += MAX_SUMMARY_BATCH) {
    const batch = targets.slice(start, start + MAX_SUMMARY_BATCH);
    // A target the rating capability rejects is another grain, not a failure of its batch.
    try { await resolve(batch); }
    catch (error) {
      if (!(error instanceof TargetNotBound)) throw error;
      for (const target of batch) {
        try { await resolve([target]); } catch (single) {
          if (!(single instanceof TargetNotBound)) throw single;
          verdict.set(target, 'grain-mismatch');
        }
      }
    }
  }
  return verdict;
}

export async function queryRatingRollup(session: WorkReadSession, store: TargetRatingInventoryStore,
  input: { context: string; targets: readonly string[]; formula: RollupFormula; rank: boolean }) {
  const env = session.deps.environment;
  const signal = AbortSignal.timeout(ROLLUP_COST.deadlineMs);
  const context = await readTargetRatingContext(env, input.context);
  if (!context) throw new WorkReadMissing('Target Context unavailable');
  const verdict = await readableMembers(session, input.targets, context.targetGrain);
  const readable = input.targets.filter(target => verdict.get(target) === null);
  const snapshot = await store.readMembers(input.context, readable.length ? readable : [input.targets[0]!], signal);
  if (context.contextRevision !== snapshot.contextRevision || context.realm !== snapshot.realm) {
    throw new RatingAggregateUnavailable('Target Context seal differs');
  }
  const [witness] = await session.query(`SELECT ?epoch ?sequence ?contextReceipt ?contextEpoch ?contextSequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(snapshot.contextRevision)} rv:component ${iri(input.context)} ;
      rv:dataEpoch ?contextEpoch ; rv:sequence ?contextSequence }
    GRAPH ${iri(GRAPHS.receipts)} { ?contextReceipt rv:ratingContext ${iri(input.context)} ;
      rv:ratingContextRevision ${iri(snapshot.contextRevision)} ; rv:outcome rv:Succeeded }
  } LIMIT 2`, 1);
  if (!witness || witness.epoch?.value !== session.position.dataEpoch || witness.sequence?.value !== session.position.sequence
    || witness.contextReceipt?.value !== snapshot.contextReceipt || witness.contextEpoch?.value !== snapshot.contextDataEpoch
    || witness.contextSequence?.value !== snapshot.contextSequence) throw new WorkReadMoved('Target Context witness changed');
  // A member's last sealed write must still be its observation's live head.
  const withRatings = readable.filter(target => snapshot.members.has(target));
  const live = new Map<string, string>();
  if (withRatings.length) {
    const rows = await session.query(`SELECT ?target ?digest ?epoch ?sequence WHERE {
      VALUES (?receipt ?target) { ${withRatings.map(target => `(${iri(snapshot.members.get(target)!.last.receipt)} ${iri(target)})`).join(' ')} }
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:ratingContext ${iri(input.context)} ;
        rv:target ?target ; rv:ratingObservation ?observation ; rv:observationRevision ?revision ;
        rv:requestDigest ?digest ; rv:outcome rv:Succeeded ; rv:dataEpoch ?epoch ; rv:sequence ?sequence }
      GRAPH ${iri(GRAPHS.current)} { ?observation a rv:TargetRatingObservation ; rv:ratingContext ${iri(input.context)} ;
        rv:target ?target ; rv:observationHead ?revision }
    } LIMIT ${withRatings.length + 1}`, withRatings.length);
    for (const row of rows) {
      const sealed = snapshot.members.get(row.target?.value ?? '')?.last;
      if (sealed && sealed.requestDigest === row.digest?.value && sealed.dataEpoch === row.epoch?.value
        && sealed.sequence === row.sequence?.value) live.set(row.target!.value, row.digest!.value);
    }
  }
  const members = input.targets.map(target => {
    const reason = verdict.get(target);
    if (reason !== null) return { target, status: 'unavailable' as const, reason: reason ?? 'unavailable' as const };
    const sealed = snapshot.members.get(target);
    if (sealed && sealed.unvalued > 0) return { target, status: 'unavailable' as const, reason: 'needs-reconstruction' as const };
    if (sealed && (!live.has(target) || !componentsAgree(sealed))) {
      return { target, status: 'unavailable' as const, reason: 'unverified' as const };
    }
    const components = sealed ?? { slots: 0, count: 0, sum: 0, histogram: Array.from({ length: 10 }, () => 0) };
    return { target, status: 'available' as const, components: { population: components.slots, count: components.count,
      withdrawnCount: components.slots - components.count, sum: components.sum, histogram: [...components.histogram] },
    ...memberFigure(components, context.displayThreshold) };
  });
  const available = members.flatMap(member => member.status === 'available' ? [member] : []);
  const figures = available.map(member => member.components);
  const ranking = input.rank ? (() => {
    const prior = snapshot.contextComponents && snapshot.contextComponents.unvalued === 0
      && componentsAgree(snapshot.contextComponents) ? rankingPrior(snapshot.contextComponents) : null;
    return { formula: RANK_FORMULA, minimumRatings: RANK_MINIMUM_RATINGS, status: prior ? 'ranked' as const : 'unavailable' as const,
      prior, items: prior ? rankMembers(available, prior) : [] };
  })() : null;
  if (!await store.checkFence(snapshot.recoveryGeneration, signal)) throw new RatingAggregateUnavailable('Recovery fence changed');
  return { profile: ROLLUP_PROFILE, context: input.context, realm: context.realm,
    scope: { question: context.question, language: context.language, grain: context.targetGrain,
      population: 'account-principal' as const }, scale: context.scale, formula: input.formula,
    displayThreshold: context.displayThreshold, memberCount: input.targets.length,
    ...rollUp(input.formula, figures, input.targets.length, context.displayThreshold),
    members, rank: ranking, sourcePosition: { datasetId: 'product' as const, ...session.position } };
}
