import { DATASET, GRAPHS, iri } from '../work/activate.ts';
import { WorkReadLimit, WorkReadMissing, WorkReadMoved, type WorkReadSession } from '../work/read-session.ts';
import { resolveTargets, resolveVisibleTargets, TARGET_RESOLVE_COST, TargetNotBound, TargetUnavailable } from '../target/resolve.ts';
import { MAX_TARGET_TYPES, type ResolvedTarget } from '../target/contract.ts';
import { dimensionOf, type FrameDimension } from '../projection/dimension.ts';
import { MAX_FRAMES } from '../projection/schema.ts';
import { MAX_SUMMARY_BATCH } from '../media/summary.ts';
import { RatingAggregateUnavailable } from './aggregate.ts';
import { type AcceptanceTarget, type ContextAcceptance } from './acceptance.ts';
import { componentsAgree } from './components.ts';
import { RANK_FORMULA, RANK_MINIMUM_RATINGS, memberFigure, rankMembers, rankingPrior, rollUp, rollupMemberVerdict, MAX_ROLLUP_MEMBERS,
  type RollupFormula } from './rollup.ts';
import { readTargetRatingContext, type TargetGrain } from './target.ts';
import type { TargetRatingInventoryStore } from './target-inventory.ts';
import { ROLLUP_PROFILE } from './rollup-api.ts';

/** This owner's own work is fixed: one Access snapshot of every member's row and
 * the Context's own (plus a fence recheck) and two graph probes, whatever the
 * members' ratings. Acceptance is that Context read. A non-projection member is
 * classified from the types the resolver already returned. A projection's subject
 * and frames are one probe per visibility batch, and only when the Context declares
 * acceptance. Whether a caller may read a member is the shared target resolver's
 * work and grows with the members, so it runs in sessions of at most 64 members,
 * each with its own call budget and deadline. */
export const ROLLUP_COST = { members: MAX_ROLLUP_MEMBERS, accessSnapshots: 1, graphProbes: 2,
  visibilityBatch: MAX_SUMMARY_BATCH, perMember: { graphCalls: 3, accessCheckouts: 3 } } as const;

/** Runs an operation in its own read session; each call has a fresh budget and graph-position fence. */
export type RollupReader = <T>(operation: (session: WorkReadSession) => Promise<T>) => Promise<T>;

type Unavailable = 'unavailable' | 'grain-mismatch' | 'needs-reconstruction' | 'unverified';
type MemberMark = Unavailable | 'not-accepted';

/** The same coordinate read as `ratingAcceptanceTarget`, one visibility batch at a time.
 * A projection whose subject or frames cannot be verified is named, not dropped. */
async function projectionAcceptance(session: WorkReadSession, projections: readonly ResolvedTarget[]): Promise<Map<string, AcceptanceTarget | 'unverified'>> {
  const result = new Map<string, AcceptanceTarget | 'unverified'>();
  if (!projections.length) return result;
  const bound = projections.length * (MAX_FRAMES + MAX_TARGET_TYPES);
  let rows: Awaited<ReturnType<WorkReadSession['query']>>;
  try {
    rows = await session.query(`SELECT ?projection ?subject ?frame ?type WHERE { GRAPH ${iri(GRAPHS.current)} {
      VALUES (?projection ?revision) { ${projections.map(target => `(${iri(target.resource)} ${iri(target.revision)})`).join(' ')} }
      ?projection a rv:Projection ; rv:projectionOf ?subject ; rv:projectionHead ?revision .
      { ?projection rv:frame ?frame } UNION { ?subject a ?type }
    } } LIMIT ${bound + 1}`, bound);
  } catch (error) {
    if (!(error instanceof WorkReadLimit)) throw error;
    if (projections.length === 1) { result.set(projections[0]!.resource, 'unverified'); return result; }
    const half = projections.length >> 1;
    for (const part of [projections.slice(0, half), projections.slice(half)]) {
      for (const [id, value] of await projectionAcceptance(session, part)) result.set(id, value);
    }
    return result;
  }
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const id = row.projection?.value;
    if (!id) continue;
    const list = grouped.get(id) ?? [];
    list.push(row);
    grouped.set(id, list);
  }
  const pending: { resource: string; frameIds: string[]; types: string[]; subject: string }[] = [];
  for (const target of projections) {
    const group = grouped.get(target.resource) ?? [];
    const subjects = new Set(group.map(row => row.subject?.value));
    const frameIds = group.flatMap(row => row.frame ? [row.frame.value] : []);
    const types = group.flatMap(row => row.type ? [row.type.value] : []);
    if (!group.length || subjects.size !== 1 || !group[0]?.subject || !frameIds.length || frameIds.length > MAX_FRAMES
      || !types.length || types.length > MAX_TARGET_TYPES || new Set(frameIds).size !== frameIds.length) {
      result.set(target.resource, 'unverified');
      continue;
    }
    pending.push({ resource: target.resource, frameIds, types, subject: group[0].subject.value });
  }
  const frames = new Map<string, ResolvedTarget>();
  const resolveFrames = async (batch: readonly string[]): Promise<void> => {
    if (!batch.length) return;
    try {
      for (const frame of await resolveTargets(session, batch, 'rating')) frames.set(frame.resource, frame);
    } catch (error) {
      if (!(error instanceof TargetNotBound) && !(error instanceof TargetUnavailable)) throw error;
      if (batch.length === 1) return;
      const half = batch.length >> 1;
      await resolveFrames(batch.slice(0, half));
      await resolveFrames(batch.slice(half));
    }
  };
  const frameIds = [...new Set(pending.flatMap(item => item.frameIds))];
  for (let start = 0; start < frameIds.length; start += TARGET_RESOLVE_COST.batch) await resolveFrames(frameIds.slice(start, start + TARGET_RESOLVE_COST.batch));
  for (const item of pending) {
    const resolved = item.frameIds.map(id => frames.get(id));
    const dimensions = resolved.map(frame => frame ? dimensionOf(frame) : null);
    if (resolved.some(frame => !frame) || item.types.includes('https://rezics.com/vocab/Projection')
      || dimensions.some(dimension => dimension === null) || new Set(dimensions).size !== dimensions.length) {
      result.set(item.resource, 'unverified');
      continue;
    }
    result.set(item.resource, { types: item.types, dimensions: dimensions as FrameDimension[], subject: item.subject,
      frames: resolved as ResolvedTarget[] });
  }
  return result;
}

/** Members the caller cannot read, or that cannot be verified, are named with a
 * reason. A member the Context does not accept is named `not-accepted` and is not
 * part of the metric. Nothing is dropped silently. An unreadable member is never
 * reported as not-accepted: that would disclose a target the caller cannot see. */
async function classifyMembers(read: RollupReader, targets: readonly string[], grain: TargetGrain, policy: ContextAcceptance) {
  const verdict = new Map<string, MemberMark | null>(targets.map(target => [target, 'unavailable']));
  const visible = new Map<string, ResolvedTarget>();
  const resolve = async (batch: readonly string[]): Promise<void> => {
    try {
      const resolved = await read(session => resolveVisibleTargets(session, batch, 'rating'));
      for (const target of resolved) visible.set(target.resource, target);
    } catch (error) {
      if (!(error instanceof TargetNotBound)) throw error;
      // A target the rating capability rejects is another grain, not a failure of its batch.
      if (batch.length === 1) { verdict.set(batch[0]!, 'grain-mismatch'); return; }
      const half = batch.length >> 1;
      await resolve(batch.slice(0, half));
      await resolve(batch.slice(half));
    }
  };
  for (let start = 0; start < targets.length; start += MAX_SUMMARY_BATCH) await resolve(targets.slice(start, start + MAX_SUMMARY_BATCH));
  const declared = !!policy.acceptedSubjectTypes || !!policy.acceptedFrameDimensions;
  const coordinates = new Map<string, AcceptanceTarget | 'unverified'>();
  if (declared) {
    const projections = [...visible.values()].filter(target => target.base === 'projection');
    for (let start = 0; start < projections.length; start += MAX_SUMMARY_BATCH) {
      const loaded = await read(session => projectionAcceptance(session, projections.slice(start, start + MAX_SUMMARY_BATCH)));
      for (const [id, value] of loaded) coordinates.set(id, value);
    }
  }
  for (const target of visible.values()) {
    if (declared && target.base === 'projection') {
      const acceptance = coordinates.get(target.resource);
      verdict.set(target.resource, !acceptance || acceptance === 'unverified' ? 'unverified'
        : rollupMemberVerdict(policy, grain, { base: target.base, acceptance }));
      continue;
    }
    verdict.set(target.resource, rollupMemberVerdict(policy, grain, { base: target.base,
      acceptance: { types: target.types, dimensions: [] } }));
  }
  return verdict;
}

export async function queryRatingRollup(read: RollupReader, store: TargetRatingInventoryStore,
  input: { context: string; targets: readonly string[]; formula: RollupFormula; rank: boolean }) {
  const context = await read(session => readTargetRatingContext(session.deps.environment, input.context));
  if (!context) throw new WorkReadMissing('Target Context unavailable');
  // One acceptance read per request: `readTargetRatingContext` already loaded the declaration.
  const policy: ContextAcceptance = {
    ...(context.acceptedSubjectTypes ? { acceptedSubjectTypes: context.acceptedSubjectTypes } : {}),
    ...(context.acceptedFrameDimensions ? { acceptedFrameDimensions: context.acceptedFrameDimensions } : {}),
  };
  const verdict = await classifyMembers(read, input.targets, context.targetGrain, policy);
  const readable = input.targets.filter(target => verdict.get(target) === null);
  return read(session => assemble(session, store, input, context, verdict, readable));
}

/** One Access snapshot and two graph probes over the readable members. */
async function assemble(session: WorkReadSession, store: TargetRatingInventoryStore,
  input: { context: string; targets: readonly string[]; formula: RollupFormula; rank: boolean },
  context: NonNullable<Awaited<ReturnType<typeof readTargetRatingContext>>>,
  verdict: ReadonlyMap<string, MemberMark | null>, readable: readonly string[]) {
  const signal = AbortSignal.timeout(10_000);
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
    if (reason === 'not-accepted') return { target, status: 'not-accepted' as const };
    if (reason !== null) return { target, status: 'unavailable' as const, reason: reason ?? ('unavailable' as const) };
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
    ...rollUp(input.formula, figures, input.targets.filter(target => verdict.get(target) !== 'not-accepted').length, context.displayThreshold),
    members, rank: ranking, sourcePosition: { datasetId: 'product' as const, ...session.position } };
}
