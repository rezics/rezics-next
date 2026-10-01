import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { EditorialBlocked, EditorialInvalid } from '../editorial-review/contract.ts';
import { readMergedIdentity, type MergedIdentity } from '../identity-merge/resolution.ts';
import { discloseWikiHistory, wikiHistory, wikiReceipts, WIKI_HISTORY_COST } from './history.ts';
import { revisionSetDigest, type WikiRevisionSet } from './delta.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { readingPositionRead } from '../reading-position/read.ts';
import { propertyRevelationRecord } from '../reading-position/store.ts';
import { wikiSegment } from './apply-snapshot.ts';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { wikiHistoryPage } from './history-page.ts';

export interface WikiHistoryScope {
  entity?: string;
  section?: 'characters' | 'places' | 'events' | 'chapters';
}

/** A selection is an exact complete prefix of the owner's applied journal.
 * Caller-supplied claims, evidence and names are never rendering inputs. */
async function readWikiHistoryUnchecked(
  work: MainWorkDependencies,
  principal: VerifiedPrincipal,
  actor: string,
  resource: string,
  selection?: WikiRevisionSet,
  request = new Request('http://main.local/?position=all'),
  scope: WikiHistoryScope = {},
  page: { limit?: number; cursor?: string } = {},
) {
  scope = {
    ...(scope.entity ? { entity: scope.entity } : {}),
    ...(scope.section ? { section: scope.section } : {}),
  };
  if (!work.editorialReview || !work.wikiEvidence)
    throw new EditorialBlocked({ code: 'owner_unavailable' });
  if (!(await work.access.canReadWork(principal, actor, resource)))
    throw new EditorialInvalid('Wiki is unavailable');
  const selected = await wikiReceipts(work.editorialReview, resource, selection);
  const pinnedHistory = wikiHistory(resource, selected);
  const visibleHistory = await readingPositionRead(
    work,
    request,
    principal,
    actor,
    async (boundary) => {
      const nameRecord = (
        entity: string,
        name: (typeof pinnedHistory.entities)[number]['names'][number],
      ) =>
        propertyRevelationRecord(
          entity,
          `https://schema.org/${name.kind === 'alias' ? 'alternateName' : 'name'}`,
          { kind: 'language-string', lexical: name.value, language: name.language },
        );
      const records = [
        ...pinnedHistory.claims.flatMap((claim) => [
          claim.claim,
          claim.value.subject,
          ...(claim.value.object.kind === 'entity' ? [claim.value.object.ref] : []),
        ]),
        ...pinnedHistory.entities.flatMap((entity) => [
          entity.entity,
          ...entity.names.map((name) => nameRecord(entity.entity, name)),
        ]),
      ];
      const visible = await boundary.visible(records);
      const claims = pinnedHistory.claims.filter(
        (claim) =>
          visible.has(claim.claim) &&
          visible.has(claim.value.subject) &&
          (claim.value.object.kind !== 'entity' || visible.has(claim.value.object.ref)),
      );
      const entities = pinnedHistory.entities
        .filter((entity) => visible.has(entity.entity))
        .map((entity) => ({
          ...entity,
          names: entity.names.filter((name) => visible.has(nameRecord(entity.entity, name))),
        }));
      const units = new Set([
        ...claims.map((claim) => claim.value.revealedAt),
        ...entities.flatMap((entity) => entity.names.map((name) => name.revealedAt)),
      ]);
      return {
        ...pinnedHistory,
        claims,
        entities,
        units: pinnedHistory.units.filter((unit) => units.has(unit.id)),
      };
    },
  );
  const selectedEntities = visibleHistory.entities.filter(
    (entity) =>
      (!scope.entity || scope.entity === entity.entity) &&
      (!scope.section ||
        (scope.section !== 'chapters' && wikiSegment(entity.type) === scope.section)),
  );
  const subjects = new Set(selectedEntities.map((entity) => entity.entity));
  const history =
    scope.entity || scope.section
      ? {
          ...visibleHistory,
          entities: selectedEntities,
          claims: visibleHistory.claims.filter((claim) => subjects.has(claim.value.subject)),
        }
      : visibleHistory;
  const pins = [
    ...history.claims.map((claim) => claim.revision),
    ...history.entities.map((entity) => entity.revision),
  ];
  let sequence = '0';
  const uniquePins = [...new Set(pins)];
  for (let at = 0; at < uniquePins.length; at += 64) {
    const batch = uniquePins.slice(at, at + 64);
    const rows =
      (
        await work.environment.fuseki.query(
          `PREFIX rv: <${RV}>
      SELECT ?revision ?epoch ?sequence WHERE { GRAPH ${iri(GRAPHS.revisions)} {
        VALUES ?revision { ${batch.map(iri).join(' ')} }
        ?revision rv:dataEpoch ?epoch ; rv:sequence ?sequence . } } LIMIT 65`,
          262144,
        )
      ).results?.bindings ?? [];
    if (
      rows.length !== batch.length ||
      rows.some(
        (row) =>
          row.epoch?.value !== work.environment.lineage.dataEpoch ||
          !/^[0-9]+$/.test(row.sequence?.value ?? ''),
      )
    )
      throw new EditorialInvalid('Historical graph pins are unavailable');
    sequence = rows.reduce(
      (max, row) => (BigInt(row.sequence!.value) > BigInt(max) ? row.sequence!.value : max),
      sequence,
    );
  }
  const paged = wikiHistoryPage(
    history,
    {
      resource,
      actor,
      principal: [principal.issuer, principal.subject],
      revisions: pinnedHistory.revisions,
      scope,
      position: new URL(request.url).searchParams.get('position'),
    },
    page,
  );
  const canRead = async (entity: string) =>
    !!(await work.access.canReadSemanticResource?.(principal, actor, entity));
  const identities = new Set([
    ...paged.entities.map((entity) => entity.entity),
    ...paged.claims.flatMap((claim) => [
      claim.value.subject,
      ...(claim.value.object.kind === 'entity' ? [claim.value.object.ref] : []),
    ]),
  ]);
  const resolutions: Record<string, MergedIdentity> = {};
  for (const entity of identities) {
    if (!(await canRead(entity))) throw new EditorialInvalid('Wiki dependency is unavailable');
    const resolution = await readMergedIdentity(work.environment, entity, canRead);
    if (resolution) resolutions[entity] = resolution;
  }
  // Resolutions describe today's links; they never replace a pinned IRI/name.
  return {
    ...(await discloseWikiHistory(paged, work.wikiEvidence, work.rights?.store)),
    nextCursor: paged.nextCursor,
    sourcePosition: { dataEpoch: work.environment.lineage.dataEpoch, sequence },
    scope,
    revisionSetDigest: revisionSetDigest(history.revisions),
    resolutions,
  };
}
export function readWikiHistory(...args: Parameters<typeof readWikiHistoryUnchecked>) {
  return fusekiReadBudget.run(
    {
      signal: AbortSignal.timeout(WIKI_HISTORY_COST.deadlineMs),
      callsLeft: WIKI_HISTORY_COST.graphCalls,
      bytesLeft: WIKI_HISTORY_COST.graphBytes,
    },
    () => readWikiHistoryUnchecked(...args),
  );
}
