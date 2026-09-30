import { GRAPHS, iri } from '../work/activate.ts';
import { publicWork, unerased, WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { targetSummaryReader, resolveTargets } from '../target/resolve.ts';
import { readResourceSummaries } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { canReadStructureTarget, isCatalogTarget, type StructureProfileRegistration } from '../structure/profiles.ts';

/** One exact Work probe per distinct candidate, under the caller's read budget.
 * Reuse the Work header's public predicate and current Access fallback; erasure
 * and protection withhold the Work even from a reader with an explicit grant. */
export async function canReadCompositionWork(session: WorkReadSession, work: string): Promise<boolean> {
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)) return false;
  const rows = await session.query(`SELECT ?main ?public WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a schema:CreativeWork ; rv:mainVersion ?main .
      ?main a rv:MainVersion ; rv:work ${iri(work)} . }
    ${unerased(iri(work))}
    BIND(EXISTS { ${publicWork(iri(work), '?main')} } AS ?public)
  } LIMIT 2`, 2);
  if (!rows.length) return false;
  if (rows.length !== 1 || !rows[0]?.public) throw new WorkReadUnavailable('Work disclosure is ambiguous');
  return rows[0].public.value === 'true' || !!session.principal && !!session.options.actingSubject
    && await session.deps.access.canReadWork(session.principal, session.options.actingSubject, work);
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
  const result = await readResourceSummaries(session.deps.environment, session.deps.media?.store,
    compositionSummaryReader(session), { resources: [resource], context: DEFAULT_MEDIA_CONTEXT,
      language: null, languages: session.displayLanguages, includeCollections: true });
  return result.summaries[0]?.status === 'available';
}

/** Read projections use public baselines; command authority keeps using the
 * profile's existing authorization hook. Mixed Collection members still pass
 * through the capability resolver so this adds no new admitted target grain. */
export function compositionTargetReader(session: WorkReadSession, profile: StructureProfileRegistration) {
  return (target: string) => {
    if (isCatalogTarget(profile, target)) return Promise.resolve(true);
    if (profile.id === 'work-composition' || profile.id === 'book-composition') {
      return canReadCompositionWork(session, target);
    }
    if (profile.id === 'collection-membership') {
      return resolveTargets(session, [target], 'collection-member').then(() => true).catch((error: unknown) => {
        if (error instanceof WorkReadMissing) return false;
        throw error;
      });
    }
    if (!session.principal || !session.options.actingSubject) return Promise.resolve(false);
    return canReadStructureTarget(profile, { environment: session.deps.environment,
      access: session.deps.access, principal: session.principal,
      actingSubject: session.options.actingSubject, target,
      targetReader: operation => operation(session) });
  };
}
