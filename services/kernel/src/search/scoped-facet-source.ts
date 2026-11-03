import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerContext } from './public-filter-consumer-contract.ts';
import type { FacetDiscoveryScope } from './facet-discovery-contract.ts';
import { ScopeWork, zeroScopeWork } from './scope-execution.ts';
import type { ScopeEvaluationProgress, PreparedSearchScope } from './scope-source.ts';
import type { createSearchScopeForService } from './service-scope.ts';
import { subjectPartition } from './source.ts';

type SearchResourceScope = FacetDiscoveryScope;

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

type ServiceScopeFacetRequest = {
  scope: ReturnType<typeof createSearchScopeForService>;
  prepared: PreparedSearchScope;
  work: ScopeWork;
  identity: ScopedFacetIdentity;
  progress: ScopeEvaluationProgress | null;
  reported: ReturnType<typeof zeroScopeWork>;
  pendingPage?: Readonly<{ after: string | null; inputLimit: number; page: ScopedFacetCandidatePage }>;
};

const ownerPorts = new WeakMap<object, Readonly<{ ports: ScopedFacetPorts; request: unknown }>>();

/** Keep service-bound scope handles in memory; neither owner ports nor native locators enter the facet wire. */
export function bindScopedFacetPorts(ports: ScopedFacetPorts, request: unknown): unknown {
  const handle = Object.freeze({});
  ownerPorts.set(handle, { ports, request });
  return handle;
}

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
export function createScopedFacetSource(ports?: ScopedFacetPorts) {
  function resolve(admission: ScopedFacetAdmission) {
    const bound = admission.request !== null && typeof admission.request === 'object'
      ? ownerPorts.get(admission.request)
      : undefined;
    const selected = bound?.ports ?? ports;
    return selected ? { ports: selected, request: bound?.request ?? admission.request } : undefined;
  }

  async function observe(admission: ScopedFacetAdmission, context: PublicFilterConsumerContext) {
    const owner = resolve(admission);
    if (!owner) return { status: 'unavailable' as const, cost: emptyCost() };
    const expected = scopedFacetIdentityKey(admission.identity);
    const current = await owner.ports.observe(owner.request, context);
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
      const owner = resolve(admission);
      if (!owner) return { status: 'unavailable', cost: emptyCost() };
      const expected = scopedFacetIdentityKey(admission.identity);
      let cost = emptyCost();
      const start = await observe(admission, context);
      cost = add(cost, start.cost);
      if (start.status !== 'observed') return { status: start.status, cost };

      const page = await owner.ports.readCandidates(owner.request, after, inputLimit, context);
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

      const membership = await owner.ports.readMembership(owner.request, page.subjects, context);
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

const hash = (value: unknown) => createHash('sha256').update(canonicalize(value) ?? '').digest('hex');

function scopeWorkCost(request: ServiceScopeFacetRequest): PublicFilterCost {
  const { used } = request.work.receipt();
  const previous = request.reported;
  const delta = {
    candidateKeys: used.candidateKeys - previous.candidateKeys,
    identityMetadataRows: used.identityMetadataRows - previous.identityMetadataRows,
    nativePoints: used.nativePoints - previous.nativePoints,
    witnessKeys: used.witnessKeys - previous.witnessKeys,
  };
  request.reported = { ...used };
  return {
    ...emptyCost(),
    inputKeys: delta.candidateKeys,
    candidates: delta.candidateKeys,
    accessPoints: delta.identityMetadataRows,
    dependencyPoints: delta.nativePoints + delta.witnessKeys,
  };
}

function evaluationReservation(work: ScopeWork, subjects: readonly string[]) {
  const allowance = work.remaining();
  return {
    rawKeys: Math.min(subjects.length, allowance.remaining.candidateKeys),
    native: {
      points: allowance.remaining.nativePoints,
      witnesses: allowance.remaining.witnessKeys,
      rows: allowance.remaining.nativeRows,
      bytes: allowance.remaining.bytes,
      emptySeeks: allowance.remaining.emptySeeks,
    },
    allowance,
  };
}

/** Adapt the installed service-bound Collection Scope to the facet owner's finite candidate and current-evaluation ports. */
export function createServiceScopeFacetPorts(
  _resource: SearchResourceScope,
): ScopedFacetPorts {
  async function evaluate(
    request: ServiceScopeFacetRequest,
    subjects: readonly string[],
    resume = true,
  ) {
    let progress = resume ? request.progress : null;
    const progressSeen = new Set<string>();
    if (progress) progressSeen.add(canonicalize(progress) ?? '');
    for (;;) {
      const before = request.work.receipt().used;
      const remaining = request.work.remaining().remaining;
      if (subjects.length && remaining.candidateKeys < subjects.length) return undefined;
      const result = await request.scope.evaluate(request.prepared, subjects, {
        ...evaluationReservation(request.work, subjects),
        ...(progress !== null ? { progress } : {}),
      });
      request.work.native(request.scope.work(result));
      const unresolved = result.values.some((value) => value === 'not_proven');
      if (!unresolved || result.progress === null) {
        request.progress = null;
        return result;
      }
      const key = canonicalize(result.progress);
      if (key === undefined || progressSeen.has(key)) {
        request.progress = result.progress;
        return result;
      }
      if (canonicalize(before) === canonicalize(request.work.receipt().used)) {
        request.progress = result.progress;
        return result;
      }
      progressSeen.add(key);
      progress = result.progress;
      request.progress = progress;
    }
  }

  return {
    async observe(opaque, _context) {
      const request = opaque as ServiceScopeFacetRequest;
      try {
        const result = await evaluate(request, [], false);
        return result && result.basis.canonical === request.prepared.basis.canonical
          ? { status: 'observed', identity: request.identity, cost: scopeWorkCost(request) }
          : { status: 'unready', cost: scopeWorkCost(request) };
      } catch {
        return { status: 'unready', cost: scopeWorkCost(request) };
      }
    },
    async readCandidates(opaque, after, inputLimit, _context) {
      const request = opaque as ServiceScopeFacetRequest;
      if (request.pendingPage?.after === after && request.pendingPage.inputLimit === inputLimit)
        return { ...request.pendingPage.page, cost: emptyCost() };
      try {
        const remaining = request.work.remaining();
        if (remaining.remaining.candidateKeys < 1)
          return { status: 'unready', cost: scopeWorkCost(request) };
        const allowance = {
          ...remaining,
          remaining: {
            ...remaining.remaining,
            candidateKeys: Math.min(inputLimit, remaining.remaining.candidateKeys),
          },
        };
        const page = await request.scope.sourcePrefix(request.prepared, {
          afterSubjectId: after,
          allowance,
        });
        request.work.native(page.work);
        if (page.basis.canonical !== request.prepared.basis.canonical)
          return { status: 'changed', cost: scopeWorkCost(request) };
        const subjects = page.candidates.map(({ subjectId }) => subjectId);
        const frontier = page.coveredThrough ?? subjects.at(-1) ?? after ?? 'empty';
        const result: ScopedFacetCandidatePage = {
          status: page.exhausted ? 'complete' : 'progress',
          identity: request.identity,
          subjects,
          frontier,
          cost: scopeWorkCost(request),
        };
        request.pendingPage = { after, inputLimit, page: result };
        return result;
      } catch {
        return { status: 'unready', cost: scopeWorkCost(request) };
      }
    },
    async readMembership(opaque, subjects, _context) {
      const request = opaque as ServiceScopeFacetRequest;
      try {
        const result = await evaluate(request, subjects);
        if (!result) return { status: 'unready', cost: scopeWorkCost(request) };
        if (result.basis.canonical !== request.prepared.basis.canonical) {
          delete request.pendingPage;
          return { status: 'changed', cost: scopeWorkCost(request) };
        }
        if (result.values.every((value) => value !== 'not_proven')) delete request.pendingPage;
        return {
          status: 'matched',
          identity: request.identity,
          subjects: subjects.map((subject, index) => ({ subject, member: result.values[index] ?? 'not_proven' })),
          cost: scopeWorkCost(request),
        };
      } catch {
        return { status: 'unready', cost: scopeWorkCost(request) };
      }
    },
  };
}

export function serviceScopeFacetIdentity(
  resource: SearchResourceScope,
  prepared: PreparedSearchScope,
  principal: string,
  meaning: unknown,
): ScopedFacetIdentity {
  return {
    source: hash({ resource, profile: prepared.basis.profile }),
    meaning: hash({ release: prepared.basis.release, meaning }),
    population: hash({ canonical: prepared.basis.canonical, source: prepared.basis.nativeOwner ?? prepared.basis.index }),
    authorization: hash({ principal, basis: prepared.basis.query }),
  };
}

export function serviceScopeFacetAdmission(input: Readonly<{
  resource: SearchResourceScope;
  scope: ReturnType<typeof createSearchScopeForService>;
  prepared: PreparedSearchScope;
  work: ScopeWork;
  principal: string;
  meaning: unknown;
}>): ScopedFacetAdmission {
  const identity = serviceScopeFacetIdentity(
    input.resource,
    input.prepared,
    input.principal,
    input.meaning,
  );
  const request: ServiceScopeFacetRequest = {
    scope: input.scope,
    prepared: input.prepared,
    work: input.work,
    identity,
    progress: null,
    reported: zeroScopeWork(),
  };
  return {
    identity,
    request: bindScopedFacetPorts(createServiceScopeFacetPorts(input.resource), request),
  };
}
