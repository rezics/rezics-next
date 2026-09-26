// Deterministic claim-support method `verification-lineage-support-v1` and the
// summary policy `verification-summary-policy-v1`. Pure functions over exact,
// already-loaded inputs: callers load a bounded lineage closure first, so the
// analysis never performs I/O and its traversal work is counted.

export const SUPPORT_METHOD = 'https://rezics.com/definition/verification-lineage-support-v1';
export const HUMAN_REVIEW_METHOD = 'https://rezics.com/definition/verification-human-review-v1';
export const SUMMARY_POLICY = 'https://rezics.com/definition/verification-summary-policy-v1';
/** Distinct lineage observations one analysis may visit; more is reported as over-budget. */
export const LINEAGE_BUDGET = 40;

/** Recheck graph owner heads and the deployed deterministic policy revision. */
export function currentVerificationHead(kind: string, reference: string,
  pinnedLocalHead: string | null, graphHeads: ReadonlyMap<string, string | null>,
  policyRevision: string): string | null {
  if (kind === 'policy') return policyRevision;
  if (kind === 'claim' || kind === 'source-assessment' || kind === 'acceptance') {
    return graphHeads.get(reference) ?? null;
  }
  return pinnedLocalHead;
}

export type Stance = 'supports' | 'contradicts' | 'uncertain';
export type Availability = 'available' | 'inaccessible' | 'withdrawn' | 'erased';
export type Dependence = 'established' | 'unknown' | 'circular' | 'over-budget';
export type Support = 'supported' | 'contradicted' | 'material-conflict' | 'insufficient' | 'abstained';
export type Coverage = 'complete' | 'partial' | 'incomplete';

export interface EvidenceItem {
  ordinal: number; stance: Stance; availability: Availability;
  observation: string | null; contentRevision: string | null; graphReference: string | null;
}

/** A directed dependency from one observation, from an edge or a derivation input. */
export interface LineageLink {
  source: string; relation: string;
  targetObservation: string | null; targetOrigin: string | null; targetReference: string | null;
}

export interface ClaimScope {
  referent: string; context: string; predicate: string;
  editionScope: string | null; validFrom: string | null; validUntil: string | null;
}

export interface ReliabilityInput {
  assessment: string; source: string; domain: string; context: string; result: string;
  applicableFrom: string | null; applicableUntil: string | null;
}

export interface AnalysisInput {
  claim: ClaimScope;
  evaluationContext: string;
  items: readonly EvidenceItem[];
  /** Links of every loaded observation; `truncated` when the closure exceeded the budget. */
  links: readonly LineageLink[];
  truncated: boolean;
  /** Source record (as `https://rezics.com/id/<uuid>`) of each evidence observation. */
  recordOf: ReadonlyMap<string, string>;
  /** Source-observation acquisition instants used for reliability applicability. */
  observedAt: ReadonlyMap<string, string>;
  /** Claim revisions referenced by graph evidence items, when they are claim revisions. */
  referencedClaims: ReadonlyMap<string, ClaimScope>;
  reliability: readonly ReliabilityInput[];
}

export interface AnalysisResult {
  dependence: Dependence;
  independentOrigins: number | null;
  origins: string[];
  coverage: Coverage;
  support: Support;
  reasons: string[];
  applicableReliability: string[];
  /** Traversal work, for the cost contract: node expansions and link reads. */
  work: { expansions: number; links: number };
}

function overlaps(a: ClaimScope, b: ClaimScope): boolean {
  if (a.editionScope && b.editionScope && a.editionScope !== b.editionScope) return false;
  const start = (value: string | null) => value === null ? -Infinity : Date.parse(value);
  const end = (value: string | null) => value === null ? Infinity : Date.parse(value);
  return start(a.validFrom) < end(b.validUntil) && start(b.validFrom) < end(a.validUntil);
}

/** Whether a referenced claim is about the same proposition slot in an overlapping scope. */
export function sameSlot(a: ClaimScope, b: ClaimScope): boolean {
  return a.referent === b.referent && a.context === b.context && a.predicate === b.predicate
    && overlaps(a, b);
}

type Roots = { kind: 'roots'; roots: Set<string> } | { kind: 'unknown' } | { kind: 'circular' };

/** Origins of one observation by bounded DFS; unknown when any path ends without an origin. */
function observationRoots(start: string, outgoing: ReadonlyMap<string, readonly LineageLink[]>,
  memo: Map<string, Roots>, visiting: Set<string>, work: AnalysisResult['work']): Roots {
  const known = memo.get(start);
  if (known) return known;
  if (visiting.has(start)) return { kind: 'circular' };
  work.expansions++;
  visiting.add(start);
  const links = outgoing.get(start) ?? [];
  work.links += links.length;
  let result: Roots;
  // A copied or generated observation cannot declare itself a new origin.
  // Follow its derivation even when an attached page also claims publication.
  const dependencies = links.filter(link => link.relation !== 'publishes-origin');
  const considered = dependencies.length ? dependencies : links;
  if (!considered.length) result = { kind: 'unknown' };
  else {
    const roots = new Set<string>();
    let state: 'roots' | 'unknown' | 'circular' = 'roots';
    for (const link of considered) {
      const next: Roots = link.targetObservation
        ? observationRoots(link.targetObservation, outgoing, memo, visiting, work)
        : link.targetOrigin ? { kind: 'roots', roots: new Set([`origin:${link.targetOrigin}`]) }
          : { kind: 'unknown' };
      if (next.kind === 'circular') { state = 'circular'; break; }
      if (next.kind === 'unknown') state = 'unknown';
      else if (next.kind === 'roots') for (const root of next.roots) roots.add(root);
    }
    result = state === 'roots' ? { kind: 'roots', roots } : state === 'unknown' ? { kind: 'unknown' } : { kind: 'circular' };
  }
  visiting.delete(start);
  // A cycle seen from inside is only recorded for the node that closed it.
  if (result.kind !== 'circular') memo.set(start, result);
  return result;
}

/** Apply the support method and summary policy to one complete evidence manifest. */
export function analyzeClaimSupport(input: AnalysisInput): AnalysisResult {
  const work = { expansions: 0, links: 0 };
  const reasons = new Set<string>();
  const outgoing = new Map<string, LineageLink[]>();
  for (const link of input.links) outgoing.set(link.source, [...outgoing.get(link.source) ?? [], link]);
  const appliesTo = (rating: ReliabilityInput, observation: string) => {
    const observed = input.observedAt.get(observation);
    if (observed === undefined) return false;
    const instant = Date.parse(observed);
    return Number.isFinite(instant)
      && (rating.applicableFrom === null || instant >= Date.parse(rating.applicableFrom))
      && (rating.applicableUntil === null || instant < Date.parse(rating.applicableUntil));
  };
  const applicable = input.reliability.filter(item => item.domain === input.claim.predicate
    && item.context === input.evaluationContext
    && input.items.some(evidence => evidence.observation && input.recordOf.get(evidence.observation) === item.source
      && appliesTo(item, evidence.observation)));
  if (applicable.length < input.reliability.length) reasons.add('source-assessment-not-applicable');

  const counted = input.items.filter(item => {
    if (item.availability !== 'available') {
      if (item.stance === 'supports') reasons.add(`support-${item.availability}`);
      return false;
    }
    const referenced = item.graphReference ? input.referencedClaims.get(item.graphReference) : undefined;
    if (referenced && !sameSlot(input.claim, referenced)) {
      reasons.add('scope-differs');
      return false;
    }
    return true;
  });
  const supporting = counted.filter(item => item.stance === 'supports');
  const contradicting = counted.filter(item => item.stance === 'contradicts');
  const uncertain = counted.some(item => item.stance === 'uncertain')
    || input.items.some(item => item.availability === 'inaccessible');

  const memo = new Map<string, Roots>();
  const origins = new Set<string>();
  let dependence: Dependence = input.truncated ? 'over-budget' : 'established';
  for (const item of supporting) {
    if (dependence === 'over-budget' || dependence === 'circular') break;
    // Exact anchors are inspectable, but their identities alone say nothing
    // about independence from another source or from each other.
    if (item.contentRevision || item.graphReference) { dependence = 'unknown'; continue; }
    const roots = observationRoots(item.observation!, outgoing, memo, new Set(), work);
    if (roots.kind === 'circular') dependence = 'circular';
    else if (roots.kind === 'unknown') dependence = 'unknown';
    else if (roots.kind === 'roots') for (const root of roots.roots) origins.add(root);
  }
  if (work.expansions > LINEAGE_BUDGET) dependence = 'over-budget';

  let support: Support;
  let coverage: Coverage = uncertain ? 'partial' : 'complete';
  if (dependence === 'circular' || dependence === 'over-budget') {
    support = 'abstained';
    coverage = 'incomplete';
    reasons.add(dependence === 'circular' ? 'lineage-circular' : 'lineage-over-budget');
  } else if (supporting.length && contradicting.length) {
    support = 'material-conflict';
    reasons.add('conflicting-evidence');
  } else if (contradicting.length) {
    support = 'contradicted';
    reasons.add('counterevidence');
  } else if (!supporting.length) {
    support = 'insufficient';
    reasons.add('no-available-support');
  } else if (dependence === 'unknown') {
    support = 'insufficient';
    reasons.add('dependence-unknown');
  } else if (origins.size >= 2) {
    support = 'supported';
    reasons.add('independent-origins');
  } else if (supporting.some(item => item.observation && applicable.some(reliability =>
    reliability.result === 'ReliableForDomain'
    && reliability.source === input.recordOf.get(item.observation!)
    && appliesTo(reliability, item.observation!)))) {
    support = 'supported';
    reasons.add('reliable-primary');
  } else {
    support = 'insufficient';
    reasons.add('single-origin');
  }
  if (dependence === 'unknown') reasons.add('dependence-unknown');
  return {
    dependence, independentOrigins: dependence === 'established' ? origins.size : null,
    origins: dependence === 'established' ? [...origins].sort() : [],
    coverage, support, reasons: [...reasons].sort(),
    applicableReliability: applicable.map(item => item.assessment).sort(), work,
  };
}

export type Review = 'unreviewed' | 'reviewed';
export type Dispute = 'none' | 'challenge-pending' | 'disputed' | 'resolved';

/** Separate review and dispute dimensions; a review never hides a dispute. */
export function summaryDimensions(support: Support | 'unknown', human: boolean,
  openChallenges: number, resolvedChallenges: number): { review: Review; dispute: Dispute } {
  const dispute: Dispute = support === 'material-conflict' ? 'disputed'
    : openChallenges > 0 ? 'challenge-pending' : resolvedChallenges > 0 ? 'resolved' : 'none';
  return { review: human ? 'reviewed' : 'unreviewed', dispute };
}
