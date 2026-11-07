import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { FacetDiscoveryScope } from './facet-discovery-contract.ts';
import {
  foldFacetAccessObserveStatus,
  resolveFacetAccessObservation,
  type FacetAccessClosedStatus,
  type FacetAccessObservationPort,
} from './facet-access-port.ts';
import { ScopeWork, zeroScopeWork } from './scope-execution.ts';
import type { ScopeEvaluationProgress, PreparedSearchScope } from './scope-source.ts';
import type { createSearchScopeForService } from './service-scope.ts';
import type { PreparedRealmScope } from './realm-scope.ts';
import {
  bindScopedFacetPorts,
  createScopedFacetSource,
  type ScopedFacetAdmission,
  type ScopedFacetCandidatePage,
  type ScopedFacetIdentity,
  type ScopedFacetObservation,
  type ScopedFacetPorts,
} from './scoped-facet-source.ts';

type SearchResourceScope = FacetDiscoveryScope;

export type ScopedFacetApplication = Readonly<{
  access: FacetAccessObservationPort;
  source: ReturnType<typeof createScopedFacetSource>;
  admitCollection(input: ServiceScopeFacetAdmissionInput): ScopedFacetAdmission;
  admitRealm(input: ServiceRealmFacetAdmissionInput): ScopedFacetAdmission;
  collectionPorts(resource: SearchResourceScope): ScopedFacetPorts;
  realmPorts(): ScopedFacetPorts;
}>;

export type ServiceScopeFacetAdmissionInput = Readonly<{
  resource: SearchResourceScope;
  scope: ReturnType<typeof createSearchScopeForService>;
  prepared: PreparedSearchScope;
  work: ScopeWork;
  principal: string;
  meaning: unknown;
  access?: FacetAccessObservationPort;
}>;

export type ServiceRealmFacetAdmissionInput = Readonly<{
  resource: SearchResourceScope;
  scope: ReturnType<typeof createSearchScopeForService>;
  prepared: PreparedRealmScope;
  realms: readonly string[];
  work: ScopeWork;
  principal: string;
  meaning: unknown;
  access?: FacetAccessObservationPort;
}>;

type ServiceScopeFacetRequest = {
  scope: ReturnType<typeof createSearchScopeForService>;
  prepared: PreparedSearchScope;
  work: ScopeWork;
  identity: ScopedFacetIdentity;
  progress: ScopeEvaluationProgress | null;
  reported: ReturnType<typeof zeroScopeWork>;
  pendingPage?: Readonly<{ after: string | null; inputLimit: number; page: ScopedFacetInputPage }>;
};

type RealmFacetFrontier = Readonly<{ basis: string; anchor: number; after: string | null }>;
type ServiceRealmFacetRequest = {
  scope: ReturnType<typeof createSearchScopeForService>;
  prepared: PreparedRealmScope;
  realms: readonly string[];
  work: ScopeWork;
  identity: ScopedFacetIdentity;
  reported: ReturnType<typeof zeroScopeWork>;
  pendingPage?: Readonly<{ after: string | null; inputLimit: number; page: ScopedFacetInputPage }>;
};

type ScopedFacetInputPage = Extract<ScopedFacetCandidatePage, { status: 'progress' | 'complete' }>;
type ScopedFacetCost = ScopedFacetObservation['cost'];

const emptyCost = (): ScopedFacetCost => ({
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

const hash = (value: unknown) =>
  createHash('sha256')
    .update(canonicalize(value) ?? '')
    .digest('hex');

function workCost(request: { work: ScopeWork; reported: ReturnType<typeof zeroScopeWork> }): ScopedFacetCost {
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

function closed<Observe extends boolean>(
  status: FacetAccessClosedStatus,
  cost: ScopedFacetCost,
  observe: Observe,
): Observe extends true
  ? Extract<ScopedFacetObservation, { status: 'unready' | 'unavailable' }>
  : Extract<ScopedFacetCandidatePage, { status: FacetAccessClosedStatus }> {
  return { status: observe ? foldFacetAccessObserveStatus(status) : status, cost } as ReturnType<typeof closed<Observe>>;
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
  access?: FacetAccessObservationPort,
): ScopedFacetPorts {
  const observation = resolveFacetAccessObservation(access);

  async function evaluate(request: ServiceScopeFacetRequest, subjects: readonly string[], resume = true) {
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
      const ran = await observation.runCurrentReader(async () => {
        const result = await evaluate(request, [], false);
        return Boolean(result && result.basis.canonical === request.prepared.basis.canonical);
      });
      const cost = workCost(request);
      if (ran.status !== 'ready') return closed(ran.status, cost, true);
      return ran.value
        ? { status: 'observed', identity: request.identity, cost }
        : { status: 'unready', cost };
    },
    async readCandidates(opaque, after, inputLimit, _context) {
      const request = opaque as ServiceScopeFacetRequest;
      if (request.pendingPage?.after === after && request.pendingPage.inputLimit === inputLimit)
        return { ...request.pendingPage.page, cost: emptyCost() };
      const ran = await observation.runCurrentReader(async () => {
        const remaining = request.work.remaining();
        if (remaining.remaining.candidateKeys < 1) return { status: 'unready' as const };
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
        if (page.basis.canonical !== request.prepared.basis.canonical) return { status: 'changed' as const };
        const subjects = page.candidates.map(({ subjectId }) => subjectId);
        const frontier = page.coveredThrough ?? subjects.at(-1) ?? after ?? 'empty';
        return {
          status: page.exhausted ? ('complete' as const) : ('progress' as const),
          identity: request.identity,
          subjects,
          frontier,
        };
      });
      const cost = workCost(request);
      if (ran.status !== 'ready') return closed(ran.status, cost, false);
      if (ran.value.status === 'unready' || ran.value.status === 'changed') return { status: ran.value.status, cost };
      const page: ScopedFacetCandidatePage = { ...ran.value, cost };
      request.pendingPage = { after, inputLimit, page: page as ScopedFacetInputPage };
      return page;
    },
    async readMembership(opaque, subjects, _context) {
      const request = opaque as ServiceScopeFacetRequest;
      const ran = await observation.runCurrentReader(async () => {
        const result = await evaluate(request, subjects);
        if (!result) return { status: 'unready' as const };
        if (result.basis.canonical !== request.prepared.basis.canonical) {
          delete request.pendingPage;
          return { status: 'changed' as const };
        }
        if (result.values.every((value) => value !== 'not_proven')) delete request.pendingPage;
        return {
          status: 'matched' as const,
          identity: request.identity,
          subjects: subjects.map((subject, index) => ({ subject, member: result.values[index] ?? 'not_proven' })),
        };
      });
      const cost = workCost(request);
      if (ran.status !== 'ready') return closed(ran.status, cost, false);
      if (ran.value.status === 'unready' || ran.value.status === 'changed') return { status: ran.value.status, cost };
      return { ...ran.value, cost };
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
    population: hash({
      canonical: prepared.basis.canonical,
      source: prepared.basis.nativeOwner ?? prepared.basis.index,
    }),
    authorization: hash({ principal, basis: prepared.basis.query }),
  };
}

export function serviceScopeFacetAdmission(input: ServiceScopeFacetAdmissionInput): ScopedFacetAdmission {
  const identity = serviceScopeFacetIdentity(input.resource, input.prepared, input.principal, input.meaning);
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
    request: bindScopedFacetPorts(
      createServiceScopeFacetPorts(input.resource, resolveFacetAccessObservation(input.access)),
      request,
    ),
  };
}

function realmFacetFrontier(value: RealmFacetFrontier): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function readRealmFacetFrontier(
  value: string | null,
  basis: string,
  realms: readonly string[],
): RealmFacetFrontier | undefined {
  if (value === null) return { basis, anchor: 0, after: null };
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!decoded || typeof decoded !== 'object') return undefined;
  const frontier = decoded as Partial<RealmFacetFrontier>;
  if (
    frontier.basis !== basis ||
    !Number.isSafeInteger(frontier.anchor) ||
    frontier.anchor! < 0 ||
    frontier.anchor! > realms.length ||
    (frontier.anchor === realms.length && frontier.after !== null) ||
    (frontier.anchor! < realms.length &&
      frontier.after !== null &&
      (typeof frontier.after !== 'string' || frontier.after.length === 0 || frontier.after.length > 1024))
  )
    return undefined;
  return frontier as RealmFacetFrontier;
}

/** Adapt Content Realm population and the shared current Realm/Subject evaluator to retained facets. */
export function createServiceRealmScopeFacetPorts(access?: FacetAccessObservationPort): ScopedFacetPorts {
  const observation = resolveFacetAccessObservation(access);

  async function observePrepared(request: ServiceRealmFacetRequest): Promise<'observed'> {
    const work = await request.scope.realm.revalidate(request.prepared, request.work.remaining());
    request.work.native(work);
    return 'observed';
  }

  return {
    async observe(opaque, _context) {
      const request = opaque as ServiceRealmFacetRequest;
      const ran = await observation.runCurrentReader(() => observePrepared(request));
      const cost = workCost(request);
      if (ran.status !== 'ready') return closed(ran.status, cost, true);
      return { status: 'observed', identity: request.identity, cost };
    },
    async readCandidates(opaque, after, inputLimit, _context) {
      const request = opaque as ServiceRealmFacetRequest;
      if (!Number.isInteger(inputLimit) || inputLimit < 1 || inputLimit > 100)
        throw new RangeError('Invalid Realm facet input limit');
      if (request.pendingPage?.after === after && request.pendingPage.inputLimit === inputLimit)
        return { ...request.pendingPage.page, cost: emptyCost() };
      const start = readRealmFacetFrontier(after, request.prepared.basis, request.realms);
      if (!start) return { status: 'unready', cost: workCost(request) };
      const ran = await observation.runCurrentReader(async () => {
        let anchor = start.anchor;
        let contentAfter = start.after;
        let steps = 0;
        while (anchor < request.realms.length && steps < 16) {
          const remaining = request.work.remaining();
          if (remaining.remaining.candidateKeys < 1) return { status: 'unready' as const };
          const prefix = await request.scope.realm.sourcePrefix(
            request.prepared,
            request.realms[anchor]!,
            contentAfter,
            Math.min(inputLimit, 32),
            remaining,
          );
          request.work.native(prefix.work);
          if (prefix.basis !== request.prepared.basis) return { status: 'changed' as const };
          steps++;
          const next: RealmFacetFrontier = prefix.exhausted
            ? { basis: request.prepared.basis, anchor: anchor + 1, after: null }
            : { basis: request.prepared.basis, anchor, after: prefix.after };
          if (prefix.subjects.length) {
            const complete = next.anchor === request.realms.length;
            return {
              status: complete ? ('complete' as const) : ('progress' as const),
              identity: request.identity,
              subjects: prefix.subjects,
              frontier: realmFacetFrontier(next),
            };
          }
          anchor = next.anchor;
          contentAfter = next.after;
        }
        const next = { basis: request.prepared.basis, anchor, after: contentAfter } satisfies RealmFacetFrontier;
        const complete = anchor === request.realms.length;
        return {
          status: complete ? ('complete' as const) : ('progress' as const),
          identity: request.identity,
          subjects: [] as readonly string[],
          frontier: realmFacetFrontier(next),
        };
      });
      const cost = workCost(request);
      if (ran.status !== 'ready') return closed(ran.status, cost, false);
      if (ran.value.status === 'unready' || ran.value.status === 'changed') return { status: ran.value.status, cost };
      const page: ScopedFacetCandidatePage = { ...ran.value, cost };
      request.pendingPage = { after, inputLimit, page: page as ScopedFacetInputPage };
      return page;
    },
    async readMembership(opaque, subjects, _context) {
      const request = opaque as ServiceRealmFacetRequest;
      const pending = request.pendingPage;
      if (
        !pending ||
        pending.page.subjects.length !== subjects.length ||
        pending.page.subjects.some((subject, index) => subject !== subjects[index])
      )
        return { status: 'unready', cost: workCost(request) };
      const ran = await observation.runCurrentReader(async () => {
        const result = await request.scope.realm.evaluate(request.prepared, subjects, request.work.remaining());
        request.work.native(result.work);
        if (result.basis !== request.prepared.basis) {
          delete request.pendingPage;
          return { status: 'changed' as const };
        }
        if (result.values.length !== subjects.length) throw new TypeError('Realm facet membership alignment changed');
        delete request.pendingPage;
        return {
          status: 'matched' as const,
          identity: request.identity,
          subjects: subjects.map((subject, index) => ({
            subject,
            member: result.values[index] === 'not_proven' ? 'not_proven' : result.values[index] === true,
          })),
        };
      });
      const cost = workCost(request);
      if (ran.status !== 'ready') return closed(ran.status, cost, false);
      if (ran.value.status === 'changed') return { status: ran.value.status, cost };
      return { ...ran.value, cost };
    },
  };
}

export function serviceRealmScopeFacetAdmission(input: ServiceRealmFacetAdmissionInput): ScopedFacetAdmission {
  const identity: ScopedFacetIdentity = {
    source: hash({ resource: input.resource, source: 'content.realm-subjects-discussed.v1' }),
    meaning: hash({ release: input.prepared.basis, meaning: input.meaning }),
    population: hash({ basis: input.prepared.basis, realms: input.realms }),
    authorization: hash({ principal: input.principal, basis: input.prepared.basis }),
  };
  const request: ServiceRealmFacetRequest = {
    scope: input.scope,
    prepared: input.prepared,
    realms: Object.freeze([...input.realms]),
    work: input.work,
    identity,
    reported: zeroScopeWork(),
  };
  return {
    identity,
    request: bindScopedFacetPorts(
      createServiceRealmScopeFacetPorts(resolveFacetAccessObservation(input.access)),
      request,
    ),
  };
}

/** Live scoped facet preparation, execution and current-reader admission from one Access observation port. */
export function createScopedFacetApplication(
  config: Readonly<{
    access?: FacetAccessObservationPort;
    source?: ReturnType<typeof createScopedFacetSource>;
  }> = {},
): ScopedFacetApplication {
  const access = resolveFacetAccessObservation(config.access);
  const source = config.source ?? createScopedFacetSource();
  return {
    access,
    source,
    admitCollection(input) {
      return serviceScopeFacetAdmission({ ...input, access });
    },
    admitRealm(input) {
      return serviceRealmScopeFacetAdmission({ ...input, access });
    },
    collectionPorts(resource) {
      return createServiceScopeFacetPorts(resource, access);
    },
    realmPorts() {
      return createServiceRealmScopeFacetPorts(access);
    },
  };
}
