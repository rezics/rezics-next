import { Value } from 'typebox/value';
import { MAX_WORK_REDIRECT_HOPS } from '../address/contract.ts';
import { FusekiClient } from '../../infrastructure/fuseki.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { MAX_SUMMARY_BATCH, readResourceSummaries, SummaryGraphMoved, type SummaryBatch,
  type SummaryReader } from '../media/summary.ts';
import { DATASET, GRAPHS, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { READ_PREFIX, workRead, WorkReadInvalid, WorkReadMissing, WorkReadMoved, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { capabilityBases, MAX_TARGET_TYPES, resolvedTarget, targetRef, type Base, type Capability, type ResolvedTarget } from './contract.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';
import type { Viewer } from '../suitability/policy.ts';
import { disclosureGraphEnvironment } from '../disclosure/read.ts';

/** One summary batch and one exact-head query, independent of target count.
 * Owner-specific summary probes remain in the summary's reported cost. */
export const TARGET_RESOLVE_COST = { batch: MAX_SUMMARY_BATCH, revisionQueries: 1,
  typesPerTarget: MAX_TARGET_TYPES, revisionRows: MAX_SUMMARY_BATCH * MAX_TARGET_TYPES,
  redirectHops: MAX_WORK_REDIRECT_HOPS, redirectBatch: MAX_SUMMARY_BATCH,
  /** Each visited identity is disclosed and hydrated in bounded batches. */
  mergedBatches: MAX_WORK_REDIRECT_HOPS + 1 } as const;

export class TargetNotBound extends Error {
  readonly status = 422;
  readonly code = 'target_not_bound';
  constructor() { super('Capability is not bound to this target grain'); }
}
export class TargetUnavailable extends WorkReadMissing {
  readonly status = 404;
  readonly code = 'resource_unavailable';
  constructor() { super('Resource is unavailable'); }
}
export type RedirectOf = (resource: string) => string | null | Promise<string | null>;
/** Report owners cover admitted grains such as Realm profiles and standalone
 * media that do not yet participate in the other capability summaries. */
export type ReportTargets<Session extends TargetReadSession = WorkReadSession> =
  (session: Session, resources: readonly string[]) =>
  Promise<ReadonlyMap<string, ResolvedTarget>>;

/** Graph-only baseline proofs have no principal or optional hydration owners. */
export type TargetReadSession = Pick<WorkReadSession, 'query' | 'checkDeadline' | 'request'
  | 'options' | 'position' | 'displayLanguages' | 'principal'> & {
  /** Owner-supplied evidence only; public request fields never set this value. */
  viewer?: Viewer;
  deps: Pick<WorkReadSession['deps'], 'environment'>
    & Partial<Pick<WorkReadSession['deps'], 'account' | 'governance'
      | 'media' | 'mediaAccess' | 'contextSelections'>>
    & { access?: Partial<Pick<WorkReadSession['deps']['access'], 'realmReadProof'
      | 'canReadWork' | 'canReadSemanticResource'>> };
};

/** Four common graph probes per exact target, including the read envelope's
 * position fences; owner summary probes remain charged to that envelope. */
export function resourceTargetReader(deps: WorkReadSession['deps'], request: Request, actingSubject: string) {
  return <T>(operation: (session: TargetReadSession) => Promise<T>) =>
    workRead(deps, request, { actingSubject }, operation);
}

/** Owner-internal verified-principal adapter. The caller owns Account verification;
 * this adapter fences graph positions and leaves all disclosure to the resolver. */
export async function targetRead<T>(environment: WorkActivationEnvironment,
  authority: { access?: TargetReadSession['deps']['access']; principal?: TargetReadSession['principal'];
    actingSubject?: string;
    /** Owners that hydrate with batched authority (public decisions, private Contexts) pass the same readers a route has. */
    readers?: Partial<Pick<TargetReadSession['deps'], 'account' | 'governance' | 'media' | 'mediaAccess' | 'contextSelections'>> },
  operation: (session: TargetReadSession) => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10_000;
  const checkDeadline = () => {
    if (Date.now() > deadline) throw new WorkReadUnavailable('Target deadline exceeded');
  };
  const query: TargetReadSession['query'] = async (body, limit) => {
    checkDeadline();
    const rows = (await environment.fuseki.query(`${READ_PREFIX}\n${body}`, 262_144)).results?.bindings ?? [];
    if (rows.length > limit) throw new WorkReadUnavailable('Target probe exceeds its bound');
    return rows;
  };
  const position = async () => {
    const rows = await query(`SELECT ?epoch ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    } LIMIT 2`, 2);
    if (rows.length !== 1 || !rows[0]?.epoch || !/^\d+$/.test(rows[0].sequence?.value ?? '')
      || environment.lineage.dataEpoch && environment.lineage.dataEpoch !== rows[0].epoch.value) {
      throw new WorkReadUnavailable('Target graph is unavailable');
    }
    return { dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence!.value };
  };
  const before = await position();
  const session: TargetReadSession = { query, checkDeadline,
    request: new Request('http://main.local/v1/resources'), options: { actingSubject: authority.actingSubject },
    position: before, displayLanguages: ['en'], principal: authority.principal ?? null,
    deps: { ...authority.readers, access: authority.access, environment: { ...environment,
      lineage: { ...environment.lineage, dataEpoch: before.dataEpoch } } } };
  const result = await operation(session);
  const after = await position();
  if (before.dataEpoch !== after.dataEpoch || before.sequence !== after.sequence) {
    throw new WorkReadMoved('Target changed during authorization');
  }
  return result;
}

/** Graph-only public proofs cannot read restricted targets. No Account, media
 * or object owner is invented; owners needing manifests supply targetRead's environment. */
export function publicTargetRead<T>(graph: Pick<FusekiClient, 'query'>,
  operation: (session: TargetReadSession) => Promise<T>) {
  const fuseki = new FusekiClient('http://graph-only.invalid');
  fuseki.query = graph.query.bind(graph);
  const composed = disclosureGraphEnvironment(graph);
  return targetRead(composed ? { ...composed, fuseki } : { fuseki, objectDirectory: '.temp/target-proofs',
    lineage: { dataEpoch: '', routingEpoch: '' } }, {}, operation);
}

/** Ownership, never descriptive type, chooses the exact revision path. */
const revisionPatterns = {
  work: `GRAPH ${iri(GRAPHS.current)} { ?r a schema:CreativeWork ; rv:mainVersion ?main ; rv:head ?revision }`,
  realization: `{ GRAPH ${iri(GRAPHS.current)} { ?r a rv:TextContribution ; rv:publicationHead ?publication }
    GRAPH ${iri(GRAPHS.revisions)} { ?publication a rv:PublicationDecision ; rv:component ?r ;
      rv:selectedDraft ?revision . ?revision a rv:RevisionAnchor ; rv:component ?r } }
    UNION { GRAPH ${iri(GRAPHS.current)} { ?r a rv:Realization ; rv:head ?revision }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RealizationRevision ; rv:component ?r } }`,
  release: `{ GRAPH ${iri(GRAPHS.current)} { ?r a rv:Release ; rv:releaseHead ?revision } }
    UNION { GRAPH ${iri(GRAPHS.revisions)} { ?r a rv:FixedRelease } BIND(?r AS ?revision) }`,
  occurrence: `GRAPH ${iri(GRAPHS.current)} { ?r a schema:ListItem ; rv:structure ?structure .
    ?structure rv:structureHead ?revision ; rv:selectedGeneration ?generation .
    ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ?r .
    FILTER NOT EXISTS { ?placement rv:removedBy ?removedBy } }`,
  resource: `GRAPH ${iri(GRAPHS.current)} { ?r rv:semanticHead ?revision }`,
  projection: `GRAPH ${iri(GRAPHS.current)} { ?r a rv:Projection ; rv:projectionHead ?revision }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ProjectionRevision ; rv:component ?r }`,
} satisfies Record<Base, string>;

const requiresWork = { work: true, realization: true, release: true, occurrence: true,
  resource: false, projection: false } satisfies Record<Base, boolean>;

/** Command identity proof: no names, bodies, media or audience admission. Call
 * only from a command owner that establishes its own authority before exposing
 * a result. Shares the reader's structural revision paths and position fences.
 * One target, one bounded query with at most 64 structural/semantic types. */
export async function resolveCommandTarget(session: TargetReadSession, resource: string): Promise<ResolvedTarget> {
  session.checkDeadline();
  if (!Value.Check(targetRef, resource)) throw new WorkReadInvalid('Command target is invalid');
  const ownership = {
    work: 'BIND(?r AS ?work)',
    realization: `GRAPH ${iri(GRAPHS.current)} { ?r rv:work ?work }`,
    release: `{ GRAPH ${iri(GRAPHS.current)} { ?r rv:work ?work } }
      UNION { GRAPH ${iri(GRAPHS.revisions)} { ?r a rv:FixedRelease ; rv:work ?work } }`,
    occurrence: `GRAPH ${iri(GRAPHS.current)} { ?structure rv:structureOf ?component .
      { ?component a rv:MainVersion ; rv:work ?work }
      UNION { ?component a schema:CreativeWork . BIND(?component AS ?work) } }`,
    // Structural grains keep their owner even when they also have semantic facts.
    resource: `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r a ?structural .
      VALUES ?structural { schema:CreativeWork rv:MainVersion rv:TextContribution
        rv:Realization rv:Release schema:ListItem rv:Projection } } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?r a rv:FixedRelease } }`,
    projection: '',
  } satisfies Record<Base, string>;
  // Only revision-bearing grains can be checked for erasure. MainVersion has
  // no capability revision; an unrelated erased revision cannot hide its grain.
  const branches = capabilityBases.suitability.map(base => `{
    { ${revisionPatterns[base]} } ${ownership[base]} BIND("${base}" AS ?base)
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision } }
  }`);
  const rows = await session.query(`SELECT ?epoch ?sequence ?r ?base ?work ?revision ?type WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence }
    OPTIONAL { VALUES ?r { ${iri(resource)} }
      { ${branches.join(' UNION ')}
        UNION { GRAPH ${iri(GRAPHS.current)} { ?r a rv:MainVersion } BIND("main-version" AS ?base) } }
      OPTIONAL { { GRAPH ${iri(GRAPHS.current)} { ?r a ?type } }
        UNION { GRAPH ${iri(GRAPHS.revisions)} { ?r a rv:FixedRelease } BIND(rv:FixedRelease AS ?type) } }
    }
  } LIMIT ${TARGET_RESOLVE_COST.typesPerTarget + 1}`, TARGET_RESOLVE_COST.typesPerTarget);
  if (!rows.length || rows.some(row => row.epoch?.value !== session.position.dataEpoch
    || row.sequence?.value !== session.position.sequence)) throw new WorkReadMoved('Graph changed during command target resolution');
  const exact = rows.filter(row => row.r?.value === resource && row.base);
  if (!exact.length) throw new TargetUnavailable();
  const bases = new Set(exact.map(row => row.base!.value));
  if (bases.size !== 1) throw new WorkReadUnavailable('Command target grain is ambiguous');
  const base = exact[0]!.base!.value as Base;
  if (!capabilityBases.suitability.includes(base)) throw new TargetNotBound();
  const revisions = new Set(exact.map(row => row.revision?.value));
  const works = new Set(exact.map(row => row.work?.value ?? null));
  const types = [...new Set(exact.flatMap(row => row.type ? [row.type.value] : []))].sort();
  const target = { resource, base, revision: exact[0]!.revision?.value,
    work: exact[0]!.work?.value ?? null, types, disclosure: 'restricted' as const };
  if (revisions.size !== 1 || works.size !== 1 || !Value.Check(resolvedTarget, target)
    || requiresWork[base] !== (target.work !== null) || base === 'work' && target.work !== resource) {
    throw new WorkReadUnavailable('Command target identity is ambiguous');
  }
  return target;
}

export function targetSummaryReader(session: TargetReadSession): SummaryReader {
  const { deps, principal, options } = session;
  const actingSubject = options.actingSubject;
  const reader: SummaryReader = { viewer: session.viewer ?? disclosureViewer(principal),
    ...(deps.governance?.store ? {
      restrictedTitles: (heads, context) => deps.governance!.store.restrictedTitles(heads, context),
    } : {}) };
  if (!principal || !actingSubject) return { ...reader,
    canReadSemantics: deps.mediaAccess ? resources => deps.mediaAccess!.canReadSemantics(
      null, null, resources, deps.environment.fuseki) : undefined };
  const access = deps.access;
  if (!access) throw new WorkReadUnavailable('Target authority is unavailable');
  let verifiedContext: ReturnType<NonNullable<typeof deps.account>['verify']> | undefined;
  const contextPrincipal = () => {
    if (!deps.account) throw new WorkReadUnavailable('Context authority is unavailable');
    return verifiedContext ??= deps.account.verify(session.request, ['context:read']);
  };
  return { ...reader,
    realmReadProof: realm => Promise.resolve(access.realmReadProof?.(principal, actingSubject, realm) ?? null),
    canReadWork: work => Promise.resolve(access.canReadWork?.(principal, actingSubject, work) ?? false),
    canReadWorks: deps.mediaAccess
      ? works => deps.mediaAccess!.canReadWorks(principal, actingSubject, works) : undefined,
    canReadSemantic: resource => Promise.resolve(
      access.canReadSemanticResource?.(principal, actingSubject, resource) ?? false),
    canReadSemantics: deps.mediaAccess
      ? resources => deps.mediaAccess!.canReadSemantics(principal, actingSubject, resources, deps.environment.fuseki) : undefined,
    canReadPrivateContext: deps.contextSelections
      ? async context => deps.contextSelections!.canReadPrivate(await contextPrincipal(), actingSubject, context)
      : undefined,
    canReadPrivateContexts: deps.mediaAccess
      ? async contexts => deps.mediaAccess!.canReadPrivateContexts(await contextPrincipal(), actingSubject, contexts)
      : undefined,
  };
}

/** Use the resolver's authority adapter when filtering mixed public inventories. Merged identities
 * stay as asked unless `resolveMerges` names their survivors; Collections are summarized only on request. */
export async function targetSummaries(session: TargetReadSession, resources: readonly string[],
  options: { resolveMerges?: boolean; includeCollections?: boolean } = {}) {
  try {
    return await readResourceSummaries(session.deps.environment, session.deps.media?.store,
      targetSummaryReader(session), { resources, context: DEFAULT_MEDIA_CONTEXT,
        resolveMerges: options.resolveMerges ?? false, includeCollections: options.includeCollections,
        language: session.options.language?.toLowerCase() ?? null, languages: session.displayLanguages });
  } catch (error) {
    if (error instanceof SummaryGraphMoved) throw new WorkReadMoved(error.message);
    throw error;
  }
}

async function redirected(resource: string, redirectOf: RedirectOf): Promise<string> {
  const seen = new Set<string>();
  for (let hop = 0; hop <= TARGET_RESOLVE_COST.redirectHops; hop++) {
    if (seen.has(resource)) throw new WorkReadUnavailable('Target redirect is cyclic');
    seen.add(resource);
    const next = await redirectOf(resource);
    if (next === null) return resource;
    if (!Value.Check(targetRef, next)) throw new WorkReadUnavailable('Target redirect is invalid');
    resource = next;
  }
  throw new WorkReadUnavailable('Target redirect exceeds its bound');
}

/** All targets must be admitted and bound. Results preserve input order and
 * duplicates; a failed batch exposes no partial target metadata. Call inside
 * workRead so its graph-position and current-principal fences cover hydration. */
export async function resolveTargets<Session extends TargetReadSession>(session: Session, iris: readonly string[],
  capability: Capability, redirectOf?: RedirectOf, reportOwners?: ReportTargets<Session>): Promise<ResolvedTarget[]> {
  session.checkDeadline();
  if (!iris.length || iris.length > TARGET_RESOLVE_COST.batch || iris.some(resource => !Value.Check(targetRef, resource))) {
    throw new WorkReadInvalid('Target batch is invalid');
  }
  if (redirectOf) return resolveTargetHeads(session, iris, capability, redirectOf, reportOwners);
  const current = new Map(iris.map(resource => [resource, resource]));
  const seen = new Map(iris.map(resource => [resource, new Set<string>()]));
  const resolved = new Map<string, ResolvedTarget>();
  for (let hop = 0; hop <= TARGET_RESOLVE_COST.redirectHops; hop++) {
    const active = [...current].filter(([source]) => !resolved.has(source));
    const resources = [...new Set(active.map(([, resource]) => resource))];
    const redirects = new Map<string, string>();
    const targets = await resolveTargetHeads(session, resources, capability, () => null, reportOwners, redirects);
    const byResource = new Map(targets.map(target => [target.resource, target]));
    for (const [source, resource] of active) {
      const path = seen.get(source)!;
      if (path.has(resource)) throw new WorkReadUnavailable('Target redirect is cyclic');
      path.add(resource);
      const next = redirects.get(resource);
      if (!next) resolved.set(source, byResource.get(resource)!);
      else {
        if (!Value.Check(targetRef, next) || path.has(next)) throw new WorkReadUnavailable('Target redirect is cyclic or invalid');
        current.set(source, next);
      }
    }
    if (resolved.size === current.size) return iris.map(resource => resolved.get(resource)!);
  }
  throw new WorkReadUnavailable('Target redirect exceeds its bound');
}

async function resolveTargetHeads<Session extends TargetReadSession>(session: Session, iris: readonly string[],
  capability: Capability, redirectOf: RedirectOf, reportOwners?: ReportTargets<Session>,
  redirects?: Map<string, string>): Promise<ResolvedTarget[]> {
  session.checkDeadline();
  if (!iris.length || iris.length > TARGET_RESOLVE_COST.batch
    || iris.some(resource => !Value.Check(targetRef, resource))) {
    throw new WorkReadInvalid('Target batch is invalid');
  }
  const canonical = new Map<string, string>();
  for (const resource of new Set(iris)) {
    canonical.set(resource, redirectOf ? await redirected(resource, redirectOf) : resource);
  }
  const resources = [...new Set(canonical.values())];
  if (capability === 'report' && reportOwners) {
    const owned = await reportOwners(session, resources);
    if ([...owned].some(([resource, target]) => !resources.includes(resource)
      || target.resource !== resource || !Value.Check(resolvedTarget, target)
      || !capabilityBases.report.includes(target.base))) throw new WorkReadUnavailable('Report owner returned an invalid target');
    if (owned.size) {
      const remaining = resources.filter(resource => !owned.has(resource));
      if (redirects) {
        const rows = await session.query(`SELECT ?r ?mergedInto WHERE {
          VALUES ?r { ${[...owned.keys()].map(iri).join(' ')} }
          GRAPH ${iri(GRAPHS.current)} { ?r rv:mergedInto ?mergedInto }
        } LIMIT ${owned.size + 1}`, owned.size + 1);
        collectRedirects(rows, redirects);
      }
      const resolved = remaining.length ? await resolveTargetHeads(session, remaining, capability, () => null, undefined, redirects) : [];
      const all = new Map([...owned, ...resolved.map(target => [target.resource, target] as const)]);
      return iris.map(resource => all.get(canonical.get(resource)!)!);
    }
  }
  const summaries = await targetSummaries(session, resources);
  const targets = await resolveSummarizedTargets(session, summaries, capability, false, redirects);
  return iris.map(resource => targets.get(canonical.get(resource)!)!);
}

/** Inventory disclosure shares the exact resolver with command/capability reads.
 * Hydrate once, omit unavailable identities, and fail closed on invalid grains,
 * ambiguous heads or graph movement. This does not grant partial command success. */
export async function resolveVisibleTargets(session: TargetReadSession, resources: readonly string[],
  capability: Capability): Promise<ResolvedTarget[]> {
  session.checkDeadline();
  if (!resources.length || resources.length > TARGET_RESOLVE_COST.batch
    || resources.some(resource => !Value.Check(targetRef, resource))) {
    throw new WorkReadInvalid('Target batch is invalid');
  }
  const summaries = await targetSummaries(session, [...new Set(resources)]);
  const targets = await resolveSummarizedTargets(session, summaries, capability, true);
  return resources.flatMap(resource => {
    const target = targets.get(resource);
    return target ? [target] : [];
  });
}

async function resolveSummarizedTargets(session: TargetReadSession, summaries: SummaryBatch,
  capability: Capability, inventory: boolean, redirects?: Map<string, string>): Promise<Map<string, ResolvedTarget>> {
  if (summaries.generation.graph !== `${session.position.dataEpoch}:${session.position.sequence}`) {
    throw new WorkReadMoved('Graph changed during target resolution');
  }
  // Availability is checked for the entire batch before revealing any grain mismatch.
  if (!inventory && summaries.summaries.some(summary => summary.status !== 'available')) throw new TargetUnavailable();
  const accepted: readonly Base[] = capabilityBases[capability];
  const available = summaries.summaries.filter(summary => summary.status === 'available').map(summary => {
    if (summary.type === 'main-version' || !summary.base || !accepted.includes(summary.base)) {
      throw new TargetNotBound();
    }
    if (requiresWork[summary.base] !== (summary.work !== null)
      || summary.work !== null && !Value.Check(targetRef, summary.work)
      || summary.base === 'work' && summary.work !== summary.reference) {
      throw new WorkReadUnavailable('Target ownership is ambiguous');
    }
    return summary;
  });
  if (!available.length) return new Map();
  const branches = [...new Set(available.map(summary => summary.base!))].map(base => `{
    VALUES ?r { ${available.filter(summary => summary.base === base).map(summary => iri(summary.reference)).join(' ')} }
    ${revisionPatterns[base]}
  }`);
  const rows = await session.query(`SELECT ?epoch ?sequence ?r ?revision ?type ?mergedInto WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence }
    OPTIONAL { ${branches.join(' UNION ')}
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?r rv:mergedInto ?mergedInto } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision } }
      OPTIONAL { { GRAPH ${iri(GRAPHS.current)} { ?r a ?type } }
        UNION { GRAPH ${iri(GRAPHS.revisions)} { ?r a rv:FixedRelease }
          BIND(rv:FixedRelease AS ?type) } }
    }
  } LIMIT ${TARGET_RESOLVE_COST.revisionRows + 1}`, TARGET_RESOLVE_COST.revisionRows);
  if (!rows.length || rows.some(row => row.epoch?.value !== session.position.dataEpoch
    || row.sequence?.value !== session.position.sequence)) throw new WorkReadMoved('Graph changed during target resolution');
  const byResource = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.r) continue;
    const grouped = byResource.get(row.r.value) ?? [];
    grouped.push(row);
    byResource.set(row.r.value, grouped);
  }
  const targets = new Map<string, ResolvedTarget>();
  if (redirects) collectRedirects(rows, redirects);
  for (const summary of available) {
    const exact = byResource.get(summary.reference) ?? [];
    if (!exact.length) {
      if (inventory) continue;
      throw new TargetUnavailable();
    }
    const revisions = new Set(exact.map(row => row.revision?.value));
    if (revisions.size !== 1 || !Value.Check(targetRef, exact[0]?.revision?.value)) {
      throw new WorkReadUnavailable('Target revision is ambiguous');
    }
    const types = [...new Set(exact.flatMap(row => row.type ? [row.type.value] : []))].sort();
    if (types.length > TARGET_RESOLVE_COST.typesPerTarget) throw new WorkReadUnavailable('Target types exceed their bound');
    targets.set(summary.reference, { resource: summary.reference, base: summary.base!,
      work: summary.work, revision: exact[0]!.revision!.value, types, disclosure: summary.disclosure });
  }
  return targets;
}

function collectRedirects(rows: Awaited<ReturnType<TargetReadSession['query']>>, redirects: Map<string, string>) {
  for (const row of rows) {
    if (!row.mergedInto) continue;
    if (!row.r || row.mergedInto.type !== 'uri' || !Value.Check(targetRef, row.mergedInto.value)
      || redirects.has(row.r.value) && redirects.get(row.r.value) !== row.mergedInto.value) {
      throw new WorkReadUnavailable('Target merge destination is ambiguous');
    }
    redirects.set(row.r.value, row.mergedInto.value);
  }
}
