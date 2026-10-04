// Typed Main answers for the scoped rating stories, and an in-memory `ScopedRatingApi` that answers as Main does:
// thresholds withhold a mean, a roll-up counts only the members a question accepts, a ranking waits for 50 ratings.
// Shapes come from the Eden types, so a contract change breaks the stories' build as well as the components'.
import { uuidToSid } from '@rezics/model/address';
import { direction } from '@rezics/main/language';
import { memoryOwnRatings, type ProjectionList, type ProjectionRead, type QuestionScope, type ScopedRatingApi } from './api.ts';
import { type FrameCandidate, type FrameDimension, sameProjection } from './frames.ts';
import { staticFrameSource } from './sources.ts';
import type { Failure, Outcome, ProjectionView, Question, ResourceSummary, Rollup, RollupMember, Subject, TargetRating }
  from './types.ts';

const base = 'https://rezics.com/id/';
/** Native IDs are UUIDv7; the tail makes each fixture's readable at a glance. */
export const iri = (tail: string) => `${base}019a5c00-0000-7000-8000-${tail.padStart(12, '0')}`;
const sourcePosition = { datasetId: 'product' as const, dataEpoch: '8c483e38-59e7-4d95-b27b-de9cd6742a3e', sequence: '4812' };
const ok = <T>(data: T): Outcome<T> => ({ ok: true, data });
const fail = <T>(failure: Failure): Outcome<T> => ({ ok: false, failure });
const name = (value: string, language = 'en') => ({ value, language, direction: direction(language, value), basis: 'requested' as const });

// ── What is rated, and where ───────────────────────────────────────────────

export const subject: Subject = { iri: iri('c001'), name: { value: 'Elizabeth Bennet', language: 'en', direction: direction('en', 'Elizabeth Bennet') } };

const frame = (tail: string, value: string, dimension: FrameDimension): FrameCandidate =>
  ({ iri: iri(tail), dimension, name: { value, language: 'en', direction: direction('en', value) } });
export const episodes = [
  frame('e001', 'Episode 1 · Netherfield', 'position'), frame('e002', 'Episode 2 · The ball', 'position'),
  frame('e003', 'Episode 3 · Hunsford', 'position'), frame('e004', 'Episode 4 · Pemberley', 'position'),
  frame('e005', 'Episode 5 · Lydia', 'position'), frame('e006', 'Episode 6 · The proposal', 'position'),
];
export const continuities = [
  frame('a001', 'Austen’s novel', 'continuity'), frame('a002', 'The 1995 serial', 'continuity'),
];
export const matches = [frame('b001', 'Spring Finals · Harbor Crossing', 'event'), frame('b002', 'Spring Finals · Salt Flats', 'event')];
const people = { [subject.iri]: 'Elizabeth Bennet', [iri('c002')]: 'Kestrel', [iri('c003')]: 'Vesper', [iri('c004')]: 'Orin', [iri('c005')]: 'Mako' };
const frameByIri = new Map([...episodes, ...continuities, ...matches].map(item => [item.iri, item]));

export const sources = [
  staticFrameSource('position', episodes, 'Episodes'),
  staticFrameSource('continuity', continuities, 'Continuities'),
];

/** Summary parts are plain summaries of the subject and each frame. */
function part(reference: string, value: string, type: 'character' | 'occurrence' | 'resource', key: string) {
  return { reference, status: 'available' as const, type, base: type === 'occurrence' ? 'occurrence' as const : 'resource' as const,
    work: null, disclosure: 'public' as const, address: { prefix: '/e/' as const, key: uuidToSid(reference.slice(-36)), suffixSource: value },
    name: name(value), avatar: { kind: 'fallback' as const, policy: 'avatar-fallback-v1' as const, key, resourceType: type } };
}

export function summaryOf(id: string, subjectIri: string, frames: readonly string[]): ResourceSummary {
  const who = part(subjectIri, people[subjectIri] ?? 'Someone', 'character', '3fa2c9d17b8e4a6f0c2d5e8b1a4f7c90');
  return { ...who, reference: id, type: 'projection', base: 'projection', address: { ...who.address, key: uuidToSid(id.slice(-36)) },
    parts: { subject: who, frames: frames.map(item => {
      const known = frameByIri.get(item);
      return part(item, known?.name.value ?? 'Somewhere', known?.dimension === 'position' ? 'occurrence' : 'resource', 'b81f0e6a2c4d9e7f3a5b1c8d0e2f4a6b');
    }) } } as ResourceSummary;
}

export const hiddenSummary = (id: string): ResourceSummary => ({ reference: id, status: 'unavailable' });

export function projectionRead(id: string, subjectIri: string, frames: readonly string[], hidden = false): ProjectionRead {
  const view: ProjectionView = { id, subject: subjectIri, frames: [...frames].sort(), revision: iri('f0000000'), disclosure: 'public' };
  return { projection: view, summary: hidden ? hiddenSummary(id) : summaryOf(id, subjectIri, frames) };
}

// ── The questions asked, and the figures ───────────────────────────────────

export function question(tail: string, text: string, language = 'en'): Question {
  return { context: iri(tail), question: text, language, scale: { min: 1, max: 10, step: 1 },
    owner: { kind: 'global', id: iri('9001') },
    displayQuestion: { value: text, language, direction: direction(language, text), basis: 'requested', script: null, reviewStatus: 'reviewed',
      presentation: null, source: null, licence: null, fallback: null } };
}
export const writing = question('d001', 'How well written is this character here?');
export const strength = question('d002', 'How compelling is this character here?');
export const performance = question('d003', 'How well did this player do in this match?');

/** A ten-bucket histogram of `count` ratings around `mean`, summing exactly to `count`. */
export function histogram(count: number, mean: number): number[] {
  if (count <= 0) return Array.from({ length: 10 }, () => 0);
  const weights = Array.from({ length: 10 }, (_, index) => Math.exp(-((index + 1 - mean) ** 2) / (2 * 1.6 ** 2)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const buckets = weights.map(weight => Math.round((weight / total) * count));
  const largest = buckets.indexOf(Math.max(...buckets));
  buckets[largest]! += count - buckets.reduce((sum, bucket) => sum + bucket, 0);
  return buckets;
}

export const THRESHOLD = 10;
const total = (buckets: readonly number[]) => buckets.reduce((sum, bucket) => sum + bucket, 0);
const weightedSum = (buckets: readonly number[]) => buckets.reduce((sum, bucket, index) => sum + bucket * (index + 1), 0);

export function ratingOf(target: string, context: string, buckets: readonly number[], scope: QuestionScope = { kind: 'global' }): TargetRating {
  const count = total(buckets);
  const shown = count >= THRESHOLD;
  return { profile: 'target-rating-read-v1', target, targetGrain: 'projection',
    scope: { kind: scope.kind, realm: scope.kind === 'realm' ? scope.realm : null }, context, status: 'available',
    aggregationScope: { question: 'How well written is this character here?', language: 'en', grain: 'projection',
      population: 'account-principal', countedTarget: target },
    scale: { min: 1, max: 10, step: 1 }, count, mean: shown ? weightedSum(buckets) / count : null, displayThreshold: THRESHOLD,
    meanDisplay: count === 0 ? 'no-data' : shown ? 'shown' : 'withheld-below-threshold',
    distribution: buckets.map((bucket, index) => ({ value: index + 1, count: bucket })), sourcePosition };
}

// ── The in-memory adapter ──────────────────────────────────────────────────

export interface Scenario {
  /** The projections that exist, in the order Main lists them. */
  places?: ProjectionRead[];
  /** Questions by target; `*` answers any target without its own. */
  questions?: Record<string, Question[]>;
  /** Ratings by `${target}|${question}`; a target and question without one has nobody who rated. */
  histograms?: Record<string, number[]>;
  /** Targets a question does not accept, which a roll-up names and leaves out. */
  notAccepted?: readonly string[];
  /** Targets the roll-up cannot read. */
  unreadable?: readonly string[];
  signedIn?: boolean;
  /** Values the person has already given, by `${target}|${question}`. */
  own?: Record<string, number>;
  /** Every rating write answers with this failure. */
  rateFails?: Failure;
  /** Every get-or-create answers with this failure. */
  projectionFails?: Failure;
  /** Every read of a subject's places answers with this failure. */
  listFails?: Failure;
  /** Milliseconds each call takes, so loading states can be seen. */
  delay?: number;
  /** Projections per page of a subject's list. */
  pageSize?: number;
}

const wait = (milliseconds: number) => milliseconds ? new Promise<void>(resolve => setTimeout(resolve, milliseconds)) : Promise.resolve();
const key = (target: string, context: string) => `${target}|${context}`;

export function memoryScopedRatingApi(scenario: Scenario = {}): ScopedRatingApi {
  const places = [...scenario.places ?? []];
  const histograms = { ...scenario.histograms };
  const own = memoryOwnRatings();
  const pageSize = scenario.pageSize ?? 20;
  let minted = 0;

  const questionsOf = (target: string) => scenario.questions?.[target] ?? scenario.questions?.['*'] ?? [];
  const bucketsOf = (target: string, context: string) => histograms[key(target, context)] ?? histogram(0, 0);

  function member(target: string, context: string): RollupMember {
    if (scenario.notAccepted?.includes(target)) return { target, status: 'not-accepted' };
    if (scenario.unreadable?.includes(target)) return { target, status: 'unavailable', reason: 'unavailable' };
    const buckets = bucketsOf(target, context);
    const count = total(buckets);
    const meets = count >= THRESHOLD;
    return { target, status: 'available', components: { population: count, count, withdrawnCount: 0, sum: weightedSum(buckets), histogram: buckets },
      mean: meets ? weightedSum(buckets) / count : null, meetsThreshold: meets,
      meanDisplay: count === 0 ? 'no-data' : meets ? 'shown' : 'withheld-below-threshold' };
  }

  function rollup(context: string, targets: readonly string[], formula: 'pooled' | 'mean-of-means', ranked: boolean): Rollup {
    const members = targets.map(target => member(target, context));
    const counted = members.filter(item => item.status !== 'not-accepted');
    const available = counted.flatMap(item => item.status === 'available' ? [item] : []);
    const meeting = available.filter(item => item.meetsThreshold);
    const ratings = available.reduce((sum, item) => sum + item.components.count, 0);
    const pooled = ratings ? available.reduce((sum, item) => sum + item.components.sum, 0) / ratings : null;
    const withheld = meeting.length * 2 < counted.length;
    const value = withheld ? null : formula === 'pooled' ? pooled
      : meeting.length ? meeting.reduce((sum, item) => sum + item.components.sum / item.components.count, 0) / meeting.length : null;
    const weight = Math.max(50, available.length ? Math.round(ratings / available.length) : 50);
    const items = available.filter(item => item.components.count >= 50 && pooled !== null).map(item => {
      const mean = item.components.sum / item.components.count;
      const votes = item.components.count;
      return { target: item.target, count: votes, mean, score: votes / (votes + weight) * mean + weight / (votes + weight) * pooled! };
    }).sort((a, b) => b.score - a.score).map((item, index) => ({ position: index + 1, ...item }));
    return { profile: 'rating-rollup-v1', context, realm: iri('9001'),
      scope: { question: 'How well written is this character here?', language: 'en', grain: 'projection', population: 'account-principal' },
      scale: { min: 1, max: 10, step: 1 }, formula, displayThreshold: THRESHOLD, memberCount: members.length,
      coverage: { members: counted.length, available: available.length, meetingThreshold: meeting.length },
      value, valueWithheld: withheld && available.length ? 'coverage-below-half' : null, members,
      rank: ranked ? { formula: 'bayesian-weighted-rating', minimumRatings: 50, status: items.length ? 'ranked' : 'unavailable',
        prior: pooled === null ? null : { mean: pooled, weight, ratings, targets: available.length }, items } : null,
      sourcePosition };
  }

  return {
    async projection(subjectIri, frames) {
      await wait(scenario.delay ?? 0);
      if (!scenario.signedIn) return fail('sign-in');
      if (scenario.projectionFails) return fail(scenario.projectionFails);
      const wanted = { subject: subjectIri, frames: [...frames] };
      const existing = places.find(place => sameProjection(place.projection, wanted));
      // A place the reader has not reached does not exist for them: Main refuses it as it refuses an absent one.
      if (existing) return existing.summary?.status === 'available' ? ok({ ...existing, created: false }) : fail('missing');
      minted += 1;
      const created = projectionRead(iri(`f${String(minted).padStart(3, '0')}`), subjectIri, frames);
      places.push(created);
      return ok({ ...created, created: true });
    },
    async projections(subjectIri, cursor) {
      await wait(scenario.delay ?? 0);
      if (scenario.listFails) return fail(scenario.listFails);
      const mine = places.filter(place => place.projection.subject === subjectIri);
      const from = cursor ? Number(cursor) : 0;
      const page: ProjectionList = { items: mine.slice(from, from + pageSize),
        nextCursor: from + pageSize < mine.length ? String(from + pageSize) : null };
      return ok(page);
    },
    async questions(target) {
      await wait(scenario.delay ?? 0);
      return ok(questionsOf(target));
    },
    async rating(target, context, scope) {
      await wait(scenario.delay ?? 0);
      return ok(ratingOf(target, context, bucketsOf(target, context), scope));
    },
    async rate(target, context, value) {
      await wait(scenario.delay ?? 0);
      if (!scenario.signedIn) return fail('sign-in');
      if (scenario.rateFails) return fail(scenario.rateFails);
      const before = own.get('me', context, target)?.value ?? scenario.own?.[key(target, context)] ?? null;
      const buckets = [...bucketsOf(target, context)];
      // A rating replaces the person's earlier one: the histogram moves one count, never two.
      if (before !== null) buckets[before - 1] = Math.max(0, (buckets[before - 1] ?? 0) - 1);
      if (value !== null) buckets[value - 1] = (buckets[value - 1] ?? 0) + 1;
      histograms[key(target, context)] = buckets;
      own.set('me', context, target, value === null ? null : { value, revision: iri('a0000000') });
      return ok({ value, pending: false });
    },
    own: (target, context) => own.get('me', context, target)?.value ?? scenario.own?.[key(target, context)] ?? null,
    async rollup(context, targets, formula, ranked = false) {
      await wait(scenario.delay ?? 0);
      return ok(rollup(context, targets, formula, ranked));
    },
  };
}

// ── Scenarios the stories share ────────────────────────────────────────────

const [e1, e2, e3, e4, e5, e6] = episodes as [FrameCandidate, FrameCandidate, FrameCandidate, FrameCandidate, FrameCandidate, FrameCandidate];
const place = (id: string, frames: FrameCandidate[], hidden = false) => projectionRead(iri(id), subject.iri, frames.map(item => item.iri), hidden);
export const placeEpisode1 = place('1a01', [e1]);
export const placeEpisode2 = place('1a02', [e2]);
export const placeEpisode3 = place('1a03', [e3]);
export const placeEpisode4 = place('1a04', [e4]);
export const placeEpisode5 = place('1a05', [e5]);
export const placeEpisode6 = place('1a06', [e6], true);
export const placeNovel = place('1a07', [continuities[0]!]);

const episodeFigures = {
  [placeEpisode1.projection.id]: histogram(190, 8.4),
  [placeEpisode2.projection.id]: histogram(41, 6.9),
  [placeEpisode3.projection.id]: histogram(214, 8.8),
  [placeEpisode4.projection.id]: histogram(3, 5),
  [placeEpisode5.projection.id]: histogram(76, 4.4),
};

/** A subject rated in several places: well rated, thin, unrated, hidden by the reader's position, and in another continuity. */
export const populated: Scenario = { signedIn: true,
  places: [placeEpisode1, placeEpisode2, placeEpisode3, placeEpisode4, placeEpisode5, placeEpisode6, placeNovel],
  questions: { '*': [writing] },
  histograms: Object.fromEntries(Object.entries({ ...episodeFigures, [placeNovel.projection.id]: histogram(1280, 8.1) })
    .map(([target, buckets]) => [key(target, writing.context), buckets])),
  notAccepted: [placeNovel.projection.id] };

export const empty: Scenario = { signedIn: true, places: [], questions: { '*': [writing] } };

/** Every place is below the display threshold, or unrated: counts show, means do not. */
export const belowThreshold: Scenario = { signedIn: true,
  places: [placeEpisode4, placeEpisode2, placeEpisode1],
  questions: { '*': [writing] },
  histograms: { [key(placeEpisode4.projection.id, writing.context)]: histogram(3, 5), [key(placeEpisode2.projection.id, writing.context)]: histogram(9, 7.2) } };

/** Everything a reader has not reached yet. */
export const allHidden: Scenario = { signedIn: true,
  places: [placeEpisode1, placeEpisode2, placeEpisode3].map(item => ({ ...item, summary: hiddenSummary(item.projection.id) })),
  questions: { '*': [writing] } };

// An event's participants, each in the match.
const player = (tail: string, id: string) => projectionRead(iri(id), iri(tail), [matches[0]!.iri]);
export const kestrel = player('c002', '2a01');
export const vesper = player('c003', '2a02');
export const orin = player('c004', '2a03');
export const mako = player('c005', '2a04');
export const hiddenPlayer = projectionRead(iri('2a05'), iri('c005'), [matches[1]!.iri], true);
export const participants = [kestrel, vesper, orin, mako, hiddenPlayer];
export const participantScenario: Scenario = { signedIn: true, places: participants, questions: { '*': [performance] },
  histograms: {
    [key(kestrel.projection.id, performance.context)]: histogram(312, 8.3),
    [key(vesper.projection.id, performance.context)]: histogram(88, 7.6),
    [key(orin.projection.id, performance.context)]: histogram(12, 9),
  } };
/** Nobody has the 50 ratings a ranking needs. */
export const thinParticipants: Scenario = { ...participantScenario, histograms: {
  [key(kestrel.projection.id, performance.context)]: histogram(14, 8), [key(vesper.projection.id, performance.context)]: histogram(6, 7) } };

export const readerViewer = { kind: 'reader' as const };
export const signedOutViewer = { kind: 'signed-out' as const, signInHref: '/auth/start?next=%2Fen%2Fe%2Fmisaka' };
