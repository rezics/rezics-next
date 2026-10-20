import { GRAPHS, iri } from '../work/activate.ts';
import { publicWork, unerased, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { targetSummaries, targetSummaryReader, TARGET_RESOLVE_COST } from '../target/resolve.ts';
import { readResourceSummaries } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { canReadStructureTargets, isCatalogTarget, type StructureProfileRegistration } from '../structure/profiles.ts';
import { admittedPublicWorks, publishedStructuredWorkSourceFromRows, structuredPublicationRead }
  from '../work/public-patterns.ts';
import { collectionTargetBatchReader } from './visible-targets.ts';

/** One exact Work probe per distinct candidate, under the caller's read budget.
 * Reuse the Work header's public predicate and current Access fallback; erasure
 * and protection withhold the Work even from a reader with an explicit grant. */
export async function canReadCompositionWork(session: WorkReadSession, work: string): Promise<boolean> {
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)) return false;
  const rows = await session.query(`SELECT ?main ?public ?structuredDecision ?structuredSource
    ?structuredStructure ?structuredProfile ?structuredRevision ?structuredGeneration ?structuredRoot ?structuredExact WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a schema:CreativeWork ; rv:mainVersion ?main .
      ?main a rv:MainVersion ; rv:work ${iri(work)} . }
    ${unerased(iri(work))}
    BIND(EXISTS { ${publicWork(iri(work), '?main')} } AS ?public)
    OPTIONAL { ${structuredPublicationRead(iri(work), '?main')} }
  } LIMIT 2`, 2);
  if (!rows.length) return false;
  // Publication joins can multiply even private Work rows. Establish audience
  // admission before reporting their shape, so private and absent stay equal.
  const readable = rows.some(row => row.public?.value === 'true') || !!session.principal && !!session.options.actingSubject
    && await session.deps.access.canReadWork(session.principal, session.options.actingSubject, work);
  if (!readable) return false;
  if (rows.length !== 1 || !rows[0]?.public) throw new WorkReadUnavailable('Work disclosure is ambiguous');
  // Reuse the exact source at this Work probe's cut; a separate source query
  // would add a scalar round trip to every parts/wholes admission.
  const source = publishedStructuredWorkSourceFromRows(rows, work, rows[0]!.main?.value ?? '');
  const sources = new Map(source ? [[work, source]] : []);
  return (await admittedPublicWorks(session.deps.environment, [work], session.viewer, sources)).has(work);
}

/** Public semantic disclosure remains owned by Access, including closed gates.
 * The graph argument is explicit for dependency sets without a baseline graph. */
export function canReadCompositionSemantic(session: WorkReadSession, resource: string) {
  return session.deps.access.canReadSemanticResource?.(session.principal,
    session.options.actingSubject ?? null, resource, undefined, session.deps.environment.fuseki)
    ?? Promise.resolve(false);
}

export function compositionSummaryReader(session: WorkReadSession) {
  return { ...targetSummaryReader(session),
    canReadSemantic: (resource: string) => canReadCompositionSemantic(session, resource) };
}

export async function canReadCompositionResource(session: WorkReadSession, resource: string) {
  return (await canReadCompositionResources(session, [resource])).has(resource);
}

async function canReadCompositionResources(session: WorkReadSession, resources: readonly string[]) {
  const readable = new Set<string>();
  for (let at = 0; at < resources.length; at += TARGET_RESOLVE_COST.batch) {
    session.checkDeadline();
    const batch = resources.slice(at, at + TARGET_RESOLVE_COST.batch);
    const result = await readResourceSummaries(session.deps.environment, session.deps.media?.store,
      compositionSummaryReader(session), { resources: [...batch], context: DEFAULT_MEDIA_CONTEXT,
        language: null, languages: session.displayLanguages, includeCollections: true });
    for (const summary of result.summaries) if (summary.status === 'available') readable.add(summary.reference);
  }
  return readable;
}

type CompositionTargetBatchReader = (targets: readonly string[]) => Promise<ReadonlySet<string>>;
type TargetReadPurpose = 'projection' | 'disclosure';

/** Projection admission applies the native guard; disclosure leaves profile
 * diagnostics to the native owner. Both retain the selected semantic heads and
 * summary authority in the enclosing session's final dependency fence. */
async function currentEpisodeTargets(session: WorkReadSession, profile: StructureProfileRegistration,
  targets: readonly string[], purpose: TargetReadPurpose) {
  const readable = new Set<string>();
  if (!profile.targetGuard) throw new WorkReadUnavailable('Episode target validation is unavailable');
  for (let at = 0; at < targets.length; at += TARGET_RESOLVE_COST.batch) {
    session.checkDeadline();
    const candidates = targets.slice(at, at + TARGET_RESOLVE_COST.batch);
    // The resolver owns public/granted disclosure and its final authority fence.
    const summaries = await targetSummaries(session, [...candidates], { includeCollections: true });
    const batch = summaries.summaries.filter(summary => summary.status === 'available')
      .map(summary => summary.reference);
    if (!batch.length) continue;
    // The Episode guard has no owner-dependent term; no editing principal or
    // Structure owner is supplied as public disclosure authority.
    let guard = '';
    if (purpose === 'projection') {
      session.checkDeadline();
      guard = (await profile.targetGuard(session.deps.environment, '', batch)).guard;
      if (!guard) throw new WorkReadUnavailable('Episode target validation is unavailable');
    }
    // A disclosed Work or other grain can lack a semantic head. Keep that
    // absence fenced so the native owner can classify its profile mismatch.
    const head = `GRAPH ${iri(GRAPHS.current)} { ?target rv:semanticHead ?head }`;
    const rows = await session.query(`SELECT DISTINCT ?target ?head WHERE {
      VALUES ?target { ${batch.map(iri).join(' ')} }
      ${guard}
      ${purpose === 'projection' ? head : `OPTIONAL { ${head} }`}
    } LIMIT ${batch.length + 1}`, batch.length);
    if (purpose === 'disclosure' && rows.length !== batch.length) {
      throw new WorkReadUnavailable('Episode target identity is unavailable');
    }
    for (const row of rows) {
      const target = row.target?.value;
      if (row.target?.type !== 'uri' || !target || !batch.includes(target)
        || (row.head ? row.head.type !== 'uri' : purpose === 'projection') || readable.has(target)) {
        throw new WorkReadUnavailable('Episode target identity is ambiguous');
      }
      readable.add(target);
    }
  }
  return readable;
}

/** Read projections keep each profile's disclosure policy. Mixed Collection members pass
 * through the capability resolver so this adds no new admitted target grain. */
export function compositionTargetReader(session: WorkReadSession, profile: StructureProfileRegistration) {
  const read = compositionTargetBatchReader(session, profile);
  return async (target: string) => (await read([target])).has(target);
}

/** The single profile decision for both scalar probes and candidate ranges.
 * Catalog identifiers have no native revision and retain their profile proof. */
export function compositionTargetBatchReader(session: WorkReadSession,
  profile: StructureProfileRegistration): CompositionTargetBatchReader {
  return targetBatchReader(session, profile, 'projection');
}

/** Native acknowledgement checks disclosure before reporting private profile
 * diagnostics. Its owner must still validate the current target profile at
 * opening, closing and final fences; this reader alone admits no native basis.
 * Other profiles retain their existing target-authority policy. */
export function compositionTargetDisclosureBatchReader(session: WorkReadSession,
  profile: StructureProfileRegistration): CompositionTargetBatchReader {
  return targetBatchReader(session, profile, 'disclosure');
}

function targetBatchReader(session: WorkReadSession, profile: StructureProfileRegistration,
  purpose: TargetReadPurpose): CompositionTargetBatchReader {
  const read = collectionTargetBatchReader(session);
  return async (targets: readonly string[]): Promise<ReadonlySet<string>> => {
    const distinct = [...new Set(targets)];
    const catalog = distinct.filter(target => isCatalogTarget(profile, target));
    const native = distinct.filter(target => !isCatalogTarget(profile, target));
    const disclosure = profile.targetDisclosure ?? 'structure-target';
    let readable: ReadonlySet<string>;
    if (disclosure === 'work') readable = await read(native);
    else if (disclosure === 'resource') readable = await canReadCompositionResources(session, native);
    else if (profile.id === 'episode-list-v1') {
      readable = await currentEpisodeTargets(session, profile, native, purpose);
    } else {
      // Only an explicitly declared public resource policy supplies a baseline.
      // Recipe and Zone retain their own target authority instead of accepting
      // an unrelated public Work summary as a profile admission.
      const baseline = profile.targetDisclosure === 'structure-target'
        ? await canReadCompositionResources(session, native) : new Set<string>();
      if (!session.principal || !session.options.actingSubject) readable = baseline;
      else {
        const granted = await canReadStructureTargets(profile, { environment: session.deps.environment,
          access: session.deps.access, principal: session.principal,
          actingSubject: session.options.actingSubject, targetReader: operation => operation(session) },
        native.filter(target => !baseline.has(target)));
        readable = new Set([...baseline, ...granted]);
      }
    }
    return new Set([...catalog, ...readable]);
  };
}
