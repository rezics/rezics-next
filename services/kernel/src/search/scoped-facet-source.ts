import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerContext } from './public-filter-consumer-contract.ts';
import { subjectPartition } from './source.ts';

/** Identity supplied by the scope admission owner. `source` names the actual native population,
 * `meaning` binds the admitted query, and the observations bind membership and current authorization.
 */
export type ScopedFacetIdentity = Readonly<{
  source: string;
  meaning: string;
  population: string;
  authorization: string;
}>;

/** Internal admitted request. The opaque request stays in memory and is never serialized into a cursor. */
export type ScopedFacetAdmission = Readonly<{
  identity: ScopedFacetIdentity;
  request: unknown;
}>;

export type ScopedFacetObservation =
  | Readonly<{ status: 'observed'; identity: ScopedFacetIdentity; cost: PublicFilterCost }>
  | Readonly<{ status: 'unready' | 'unavailable'; cost: PublicFilterCost }>;

export type ScopedFacetCandidatePage =
  | Readonly<{
      status: 'progress' | 'complete';
      identity: ScopedFacetIdentity;
      subjects: readonly string[];
      frontier: string;
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'changed' | 'unready' | 'unavailable'; cost: PublicFilterCost }>;

export type ScopedFacetMembership =
  | Readonly<{
      status: 'matched';
      identity: ScopedFacetIdentity;
      subjects: readonly Readonly<{ subject: string; member: boolean | 'not_proven' }>[];
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'changed' | 'unready' | 'unavailable'; cost: PublicFilterCost }>;

/** Scope owners provide these existing native candidate and current membership reads. A candidate
 * page is the complete next input window for this admitted source; `complete` proves source exhaustion.
 */
export type ScopedFacetPorts = Readonly<{
  observe(request: unknown, context: PublicFilterConsumerContext): Promise<ScopedFacetObservation>;
  readCandidates(
    request: unknown,
    after: string | null,
    inputLimit: number,
    context: PublicFilterConsumerContext,
  ): Promise<ScopedFacetCandidatePage>;
  readMembership(
    request: unknown,
    subjects: readonly string[],
    context: PublicFilterConsumerContext,
  ): Promise<ScopedFacetMembership>;
}>;

export type ScopedFacetPage =
  | Readonly<{
      status: 'progress' | 'complete';
      observation: string;
      subjects: readonly Readonly<{ partition: number; subject: string }>[];
      frontier: string;
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'changed' | 'unready' | 'unavailable'; cost: PublicFilterCost }>;

const emptyCost = (): PublicFilterCost => ({
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

function add(left: PublicFilterCost, right: PublicFilterCost): PublicFilterCost {
  const next = { ...left };
  for (const key of Object.keys(next) as (keyof PublicFilterCost)[]) {
    if (!Number.isSafeInteger(right[key]) || right[key] < 0 || !Number.isSafeInteger(next[key] + right[key]))
      throw new RangeError('Invalid scoped facet cost');
    next[key] += right[key];
  }
  return next;
}

function validIdentity(identity: ScopedFacetIdentity): boolean {
  return (
    identity !== null &&
    typeof identity === 'object' &&
    ['source', 'meaning', 'population', 'authorization'].every((key) => {
      const value = identity[key as keyof ScopedFacetIdentity];
      return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.isWellFormed();
    })
  );
}

export function scopedFacetIdentityKey(identity: ScopedFacetIdentity): string {
  if (!validIdentity(identity)) throw new TypeError('Invalid scoped facet identity');
  const canonical = canonicalize(identity);
  if (canonical === undefined) throw new TypeError('Invalid scoped facet identity');
  return createHash('sha256').update(canonical).digest('hex');
}

function sameIdentity(left: ScopedFacetIdentity, right: ScopedFacetIdentity): boolean {
  return (
    validIdentity(left) &&
    validIdentity(right) &&
    left.source === right.source &&
    left.meaning === right.meaning &&
    left.population === right.population &&
    left.authorization === right.authorization
  );
}

/** Bind complete native subject pages to one admitted Realm or Collection observation.
 * A changed/uncertain membership read yields no subjects, so callers cannot fall back to Global.
 */
export function createScopedFacetSource(ports: ScopedFacetPorts) {
  async function observe(admission: ScopedFacetAdmission, context: PublicFilterConsumerContext) {
    const expected = scopedFacetIdentityKey(admission.identity);
    const current = await ports.observe(admission.request, context);
    if (current.status !== 'observed') return current;
    if (!sameIdentity(current.identity, admission.identity) || scopedFacetIdentityKey(current.identity) !== expected)
      return { status: 'unready' as const, cost: current.cost };
    return current;
  }

  return {
    observe,
    async readPage(
      admission: ScopedFacetAdmission,
      after: string | null,
      inputLimit: number,
      context: PublicFilterConsumerContext,
    ): Promise<ScopedFacetPage> {
      if (!Number.isInteger(inputLimit) || inputLimit < 1 || inputLimit > 100)
        throw new RangeError('Invalid scoped facet input limit');
      const expected = scopedFacetIdentityKey(admission.identity);
      let cost = emptyCost();
      const start = await observe(admission, context);
      cost = add(cost, start.cost);
      if (start.status !== 'observed') return { status: start.status, cost };

      const page = await ports.readCandidates(admission.request, after, inputLimit, context);
      cost = add(cost, page.cost);
      if (!('identity' in page)) return { status: page.status, cost };
      if (
        !sameIdentity(page.identity, admission.identity) ||
        scopedFacetIdentityKey(page.identity) !== expected ||
        page.subjects.length > inputLimit ||
        typeof page.frontier !== 'string' ||
        page.frontier.length === 0 ||
        (page.status === 'progress' && page.frontier === after)
      )
        return { status: 'unready', cost };

      const unique = new Set<string>();
      try {
        for (const subject of page.subjects) {
          subjectPartition(subject);
          if (unique.has(subject)) return { status: 'unready', cost };
          unique.add(subject);
        }
      } catch {
        return { status: 'unready', cost };
      }

      const membership = await ports.readMembership(admission.request, page.subjects, context);
      cost = add(cost, membership.cost);
      if (!('subjects' in membership)) return { status: membership.status, cost };
      if (
        !sameIdentity(membership.identity, admission.identity) ||
        scopedFacetIdentityKey(membership.identity) !== expected ||
        membership.subjects.length !== page.subjects.length ||
        membership.subjects.some((entry, index) => entry.subject !== page.subjects[index])
      )
        return { status: 'unready', cost };
      if (membership.subjects.some((entry) => entry.member === 'not_proven')) return { status: 'unready', cost };

      const finish = await observe(admission, context);
      cost = add(cost, finish.cost);
      if (finish.status !== 'observed') return { status: finish.status, cost };
      if (scopedFacetIdentityKey(finish.identity) !== expected) return { status: 'unready', cost };

      return {
        status: page.status,
        observation: expected,
        subjects: membership.subjects.flatMap(({ subject, member }) =>
          member ? [{ partition: subjectPartition(subject), subject }] : [],
        ),
        frontier: page.frontier,
        cost,
      };
    },
  };
}
