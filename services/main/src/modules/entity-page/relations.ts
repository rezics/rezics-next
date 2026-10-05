import { readResourceRelations } from '../relation/traversal.ts';
import { readResourceSummaries } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { referenceDisclosure } from '../target/disclosed-references.ts';
import { targetSummaryReader } from '../target/resolve.ts';
import { readingBoundary } from '../reading-position/boundary.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { readWikiClaimEvidence, projectWikiEvidence } from '../wiki/evidence-read.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import type { Coordinate } from '../projection/dimension.ts';

/** The same incidence inventory for a subject page and a projection page. All
 * Access, publication, disclosure and reading-position gates stay in owner reads. */
export async function readPageRelations(session: WorkReadSession, resource: string,
  frames?: readonly Coordinate[], limit = 4, after?: string) {
  const { deps, principal } = session;
  const actor = session.options.actingSubject ?? null;
  const boundary = readingBoundary(session);
  const visible = (refs: readonly string[]) => boundary.visible(refs);
  const canReadSemantic = (ref: string) => deps.access.canReadSemanticResource?.(
    principal, actor, ref, undefined, deps.environment.fuseki) ?? Promise.resolve(false);
  const reader = { ...targetSummaryReader(session), visibleRecords: visible };
  const summarize = async (resources: string[]) => (await readResourceSummaries(deps.environment,
    deps.media?.store, reader, { resources, context: DEFAULT_MEDIA_CONTEXT,
      language: null, languages: session.displayLanguages, includeCollections: true })).summaries;
  const canRead = async (ref: string) => (await canReadSemantic(ref) || (await summarize([ref]))[0]?.status === 'available')
    && (await discloseInventory(deps.environment, [{ owner: 'graph', resource: ref, component: 'record' }],
      session.viewer, 'read'))[0] === 'visible' && (await visible([ref])).has(ref);
  const result = await readResourceRelations(deps.environment, {
    resource, frames, limit, after, languages: session.displayLanguages, canRead,
    disclose: referenceDisclosure(deps.environment,
      { access: deps.access, principal, ...(actor ? { actingSubject: actor } : {}) }, canRead),
    canReadOccurrence: canReadSemantic,
    publicOccurrences: async refs => new Map([...(await readWikiClaimEvidence(session, refs, 'relation', boundary))]
      .map(([claim, evidence]) => [claim, new Set(evidence.map(row => row.id))])),
    canReadDraftPresentations: async definition => {
      if (!principal || !actor || !deps.mediaAccess) return false;
      const disclosure = await deps.mediaAccess.canReadSemantics(principal, actor, [definition], deps.environment.fuseki);
      return 'granted' in disclosure && disclosure.granted.has(definition);
    }, summarize, visibleRecords: visible,
    readingPosition: JSON.stringify([principal, actor, await boundary.binding()]),
  });
  const evidence = await readWikiClaimEvidence(session, result.items.filter(item => item.kind === 'occurrence')
    .map(item => item.relation), 'relation', boundary);
  const projected = await projectWikiEvidence(session, [...evidence.values()].flat());
  return { ...result, items: result.items.map(item => ({ ...item,
    ...(evidence.get(item.relation)?.some(source => source.id === item.evidence) ? { citations: projected.filter(row =>
      evidence.get(item.relation)!.some(source => source.id === row.id)) } : {}) })) };
}
