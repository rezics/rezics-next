import { Value } from 'typebox/value';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { MAX_SUMMARY_BATCH, readResourceSummaries, type SummaryReader } from '../media/summary.ts';
import { DATASET, GRAPHS, iri } from '../work/activate.ts';
import { WorkReadInvalid, WorkReadMissing, WorkReadMoved, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { capabilityBases, MAX_TARGET_TYPES, resolvedTarget, targetRef, type Base, type Capability, type ResolvedTarget } from './contract.ts';

/** One summary batch and one exact-head query, independent of target count.
 * Owner-specific summary probes remain in the summary's reported cost. */
export const TARGET_RESOLVE_COST = { batch: MAX_SUMMARY_BATCH, revisionQueries: 1,
  typesPerTarget: MAX_TARGET_TYPES, revisionRows: MAX_SUMMARY_BATCH * MAX_TARGET_TYPES, redirectHops: 8 } as const;

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
export type ReportTargets = (session: WorkReadSession, resources: readonly string[]) =>
  Promise<ReadonlyMap<string, ResolvedTarget>>;

/** Ownership, never descriptive type, chooses the exact revision path. */
const revisionPatterns = {
  work: `GRAPH ${iri(GRAPHS.current)} { ?r a schema:CreativeWork ; rv:mainVersion ?main ; rv:head ?revision }`,
  realization: `GRAPH ${iri(GRAPHS.current)} { ?r a rv:TextContribution ; rv:publicationHead ?publication }
    GRAPH ${iri(GRAPHS.revisions)} { ?publication a rv:PublicationDecision ; rv:component ?r ;
      rv:selectedDraft ?revision . ?revision a rv:RevisionAnchor ; rv:component ?r }`,
  release: `{ GRAPH ${iri(GRAPHS.current)} { ?r a rv:Release ; rv:releaseHead ?revision } }
    UNION { GRAPH ${iri(GRAPHS.revisions)} { ?r a rv:FixedRelease } BIND(?r AS ?revision) }`,
  occurrence: `GRAPH ${iri(GRAPHS.current)} { ?r a schema:ListItem ; rv:structure ?structure .
    ?structure rv:structureHead ?revision ; rv:selectedGeneration ?generation .
    ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ?r .
    FILTER NOT EXISTS { ?placement rv:removedBy ?removedBy } }`,
  resource: `GRAPH ${iri(GRAPHS.current)} { ?r rv:semanticHead ?revision }`,
} satisfies Record<Base, string>;

const requiresWork = { work: true, realization: true, release: true, occurrence: true,
  resource: false } satisfies Record<Base, boolean>;

function readerFor(session: WorkReadSession): SummaryReader {
  const { deps, principal, options } = session;
  const actingSubject = options.actingSubject;
  const reader: SummaryReader = deps.governance?.store ? {
    restrictedTitles: (heads, context) => deps.governance!.store.restrictedTitles(heads, context),
  } : {};
  if (!principal || !actingSubject) return reader;
  let verifiedContext: ReturnType<typeof deps.account.verify> | undefined;
  const contextPrincipal = () => verifiedContext ??= deps.account.verify(session.request, ['context:read']);
  return { ...reader,
    realmReadProof: realm => Promise.resolve(deps.access.realmReadProof?.(principal, actingSubject, realm) ?? null),
    canReadWork: work => deps.access.canReadWork(principal, actingSubject, work),
    canReadWorks: deps.mediaAccess
      ? works => deps.mediaAccess!.canReadWorks(principal, actingSubject, works) : undefined,
    canReadSemantic: resource => Promise.resolve(
      deps.access.canReadSemanticResource?.(principal, actingSubject, resource) ?? false),
    canReadSemantics: deps.mediaAccess
      ? resources => deps.mediaAccess!.canReadSemantics(principal, actingSubject, resources) : undefined,
    canReadPrivateContext: deps.contextSelections
      ? async context => deps.contextSelections!.canReadPrivate(await contextPrincipal(), actingSubject, context)
      : undefined,
    canReadPrivateContexts: deps.mediaAccess
      ? async contexts => deps.mediaAccess!.canReadPrivateContexts(await contextPrincipal(), actingSubject, contexts)
      : undefined,
  };
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
export async function resolveTargets(session: WorkReadSession, iris: readonly string[],
  capability: Capability, redirectOf?: RedirectOf, reportOwners?: ReportTargets): Promise<ResolvedTarget[]> {
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
      const resolved = remaining.length ? await resolveTargets(session, remaining, capability) : [];
      const all = new Map([...owned, ...resolved.map(target => [target.resource, target] as const)]);
      return iris.map(resource => all.get(canonical.get(resource)!)!);
    }
  }
  const summaries = await readResourceSummaries(session.deps.environment, session.deps.media?.store,
    readerFor(session), { resources, context: DEFAULT_MEDIA_CONTEXT,
      language: session.options.language?.toLowerCase() ?? null, languages: session.displayLanguages });
  if (summaries.generation.graph !== `${session.position.dataEpoch}:${session.position.sequence}`) {
    throw new WorkReadMoved('Graph changed during target resolution');
  }
  // Availability is checked for the entire batch before revealing any grain mismatch.
  if (summaries.summaries.some(summary => summary.status !== 'available')) throw new TargetUnavailable();
  const accepted: readonly Base[] = capabilityBases[capability];
  const available = summaries.summaries.map(summary => {
    if (summary.status !== 'available') throw new TargetUnavailable();
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
  const branches = [...new Set(available.map(summary => summary.base!))].map(base => `{
    VALUES ?r { ${available.filter(summary => summary.base === base).map(summary => iri(summary.reference)).join(' ')} }
    ${revisionPatterns[base]}
  }`);
  const rows = await session.query(`SELECT ?epoch ?sequence ?r ?revision ?type WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence }
    OPTIONAL { ${branches.join(' UNION ')}
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
  for (const summary of available) {
    const exact = byResource.get(summary.reference) ?? [];
    if (!exact.length) throw new TargetUnavailable();
    const revisions = new Set(exact.map(row => row.revision?.value));
    if (revisions.size !== 1 || !Value.Check(targetRef, exact[0]?.revision?.value)) {
      throw new WorkReadUnavailable('Target revision is ambiguous');
    }
    const types = [...new Set(exact.flatMap(row => row.type ? [row.type.value] : []))].sort();
    if (types.length > TARGET_RESOLVE_COST.typesPerTarget) throw new WorkReadUnavailable('Target types exceed their bound');
    targets.set(summary.reference, { resource: summary.reference, base: summary.base!,
      work: summary.work, revision: exact[0]!.revision!.value, types, disclosure: summary.disclosure });
  }
  return iris.map(resource => targets.get(canonical.get(resource)!)!);
}
