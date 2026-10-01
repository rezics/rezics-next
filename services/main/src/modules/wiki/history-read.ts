import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { EditorialBlocked, EditorialInvalid } from '../editorial-review/contract.ts';
import { readMergedIdentity, type MergedIdentity } from '../identity-merge/resolution.ts';
import {
  discloseWikiHistory,
  wikiHistory,
  wikiReceipts,
  WIKI_HISTORY_COST,
  type WikiHistory,
} from './history.ts';
import { revisionSetDigest, type WikiRevisionSet } from './delta.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { readingPositionRead } from '../reading-position/read.ts';
import { propertyRevelationRecord } from '../reading-position/store.ts';
import { wikiSegment } from './apply-snapshot.ts';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { wikiHistoryPage } from './history-page.ts';
import { canReadCompositionWork } from '../composition/disclosure-read.ts';
import { WorkReadMissing, WorkReadMoved } from '../work/read-session.ts';
import { readResourceSummaries, MAX_SUMMARY_BATCH } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { targetSummaryReader } from '../target/resolve.ts';
import type { DisclosureChannel, DisclosureTarget } from '../disclosure/read.ts';
import type { ReadingBoundary } from '../reading-position/boundary.ts';

export interface WikiHistoryScope {
  entity?: string;
  section?: 'characters' | 'places' | 'events' | 'chapters';
}

async function requireWikiWork(
  boundary: ReadingBoundary,
  resource: string,
  channel: DisclosureChannel,
) {
  const { session } = boundary;
  if (
    !session.principal ||
    !session.options.actingSubject ||
    !(await session.deps.access.canReadWork(
      session.principal,
      session.options.actingSubject,
      resource,
    )) ||
    !(await canReadCompositionWork(session, resource)) ||
    (
      await session.disclosure(
        [
          { owner: 'graph', resource, component: 'name', work: resource },
          { owner: 'graph', resource, component: 'record', work: resource },
        ],
        channel,
      )
    ).some((decision) => decision !== 'visible')
  ) {
    throw new WorkReadMissing('Resource is unavailable');
  }
}

/** Current privacy and audience admission precede pinned names/values. The
 * summaries own erasure/protection and Access; published claims need no new
 * semantic grant. Historical names never come from these current summaries. */
async function readableIdentities(
  boundary: ReadingBoundary,
  identities: readonly string[],
  channel: DisclosureChannel,
) {
  const { session } = boundary;
  const readable = new Set<string>();
  for (let at = 0; at < identities.length; at += MAX_SUMMARY_BATCH) {
    const batch = await readResourceSummaries(
      session.deps.environment,
      undefined,
      targetSummaryReader(session),
      {
        resources: identities.slice(at, at + MAX_SUMMARY_BATCH),
        context: DEFAULT_MEDIA_CONTEXT,
        language: null,
        resolveMerges: false,
        channel,
      },
    );
    if (batch.generation.graph !== `${session.position.dataEpoch}:${session.position.sequence}`)
      throw new WorkReadMoved('Wiki dependencies changed during the read');
    for (const summary of batch.summaries)
      if (summary.status === 'available') readable.add(summary.reference);
  }
  return readable;
}

function historyTargets(history: WikiHistory): DisclosureTarget[] {
  const target = (
    resource: string,
    component: 'record' | 'name',
    revision?: string,
  ): DisclosureTarget => ({ owner: 'graph', resource, component, revision, work: history.work });
  return [
    ...history.claims.flatMap((claim) => [
      target(claim.claim, 'record', claim.revision),
      target(claim.revision, 'record', claim.revision),
    ]),
    ...history.entities.flatMap((entity) => [
      target(entity.entity, 'name', entity.revision),
      target(entity.entity, 'record', entity.revision),
      target(entity.revision, 'record', entity.revision),
      // Names can survive several entity revisions. The journal has no
      // per-name pin, so a missing revision must not bypass an exact fence.
      ...entity.names.map((name) => target(nameRecord(entity.entity, name), 'record')),
    ]),
    ...history.units.flatMap((unit) => (unit.occurrence ? [target(unit.occurrence, 'name')] : [])),
  ];
}

function nameRecord(entity: string, name: WikiHistory['entities'][number]['names'][number]) {
  return propertyRevelationRecord(
    entity,
    `https://schema.org/${name.kind === 'alias' ? 'alternateName' : 'name'}`,
    { kind: 'language-string', lexical: name.value, language: name.language },
  );
}

async function admittedHistory(
  boundary: ReadingBoundary,
  history: WikiHistory,
  channel: DisclosureChannel,
  availablePins: ReadonlySet<string>,
) {
  const decisions = await boundary.session.disclosure(historyTargets(history), channel);
  let at = 0;
  const claims = history.claims.filter((claim) => {
    const visible = decisions[at++] === 'visible';
    const pinVisible = decisions[at++] === 'visible';
    return visible && pinVisible && availablePins.has(claim.revision);
  });
  const entities = history.entities.flatMap((entity) => {
    const nameVisible = decisions[at++] === 'visible';
    const visible = decisions[at++] === 'visible';
    const pinVisible = decisions[at++] === 'visible';
    const names = entity.names.filter(() => decisions[at++] === 'visible');
    return nameVisible && visible && pinVisible && availablePins.has(entity.revision)
      ? [{ ...entity, names }]
      : [];
  });
  const units = history.units.filter((unit) => !unit.occurrence || decisions[at++] === 'visible');
  const identities = [
    ...new Set([
      ...entities.map((entity) => entity.entity),
      ...claims.flatMap((claim) => [
        claim.value.subject,
        ...(claim.value.object.kind === 'entity' ? [claim.value.object.ref] : []),
      ]),
    ]),
  ];
  const readable = await readableIdentities(boundary, identities, channel);
  return {
    ...history,
    entities: entities.filter((entity) => readable.has(entity.entity)),
    units,
    claims: claims.filter(
      (claim) =>
        readable.has(claim.value.subject) &&
        (claim.value.object.kind !== 'entity' || readable.has(claim.value.object.ref)),
    ),
  };
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
  page: { limit?: number; cursor?: string; all?: boolean } = {},
  channel: DisclosureChannel = 'read',
) {
  scope = {
    ...(scope.entity ? { entity: scope.entity } : {}),
    ...(scope.section ? { section: scope.section } : {}),
  };
  if (!work.editorialReview || !work.wikiEvidence)
    throw new EditorialBlocked({ code: 'owner_unavailable' });
  return readingPositionRead(work, request, principal, actor, async (boundary) => {
    await requireWikiWork(boundary, resource, channel);
    const selected = await wikiReceipts(work.editorialReview!, resource, selection);
    const pinnedHistory = wikiHistory(resource, selected);
    // The position describes the retained journal cut, independent of page,
    // scope or newly withheld records. Exact erased pins supply no content.
    let sequence = '0';
    const availablePins = new Set<string>();
    const uniquePins = [
      ...new Set([
        ...pinnedHistory.claims.map((claim) => claim.revision),
        ...pinnedHistory.entities.map((entity) => entity.revision),
      ]),
    ];
    for (let at = 0; at < uniquePins.length; at += 64) {
      const batch = uniquePins.slice(at, at + 64);
      const rows =
        (
          await work.environment.fuseki.query(
            `PREFIX rv: <${RV}>
          SELECT ?revision ?epoch ?sequence ?erased WHERE { GRAPH ${iri(GRAPHS.revisions)} {
            VALUES ?revision { ${batch.map(iri).join(' ')} }
            ?revision rv:dataEpoch ?epoch ; rv:sequence ?sequence .
            BIND(EXISTS { ?revision a rv:ErasedRevision } AS ?erased) } } LIMIT 65`,
            262144,
          )
        ).results?.bindings ?? [];
      if (
        rows.length !== batch.length ||
        new Set(rows.map((row) => row.revision?.value)).size !== batch.length ||
        rows.some(
          (row) =>
            !batch.includes(row.revision?.value ?? '') ||
            row.epoch?.value !== work.environment.lineage.dataEpoch ||
            !/^[0-9]+$/.test(row.sequence?.value ?? '') ||
            !['true', 'false'].includes(row.erased?.value ?? ''),
        )
      )
        throw new EditorialInvalid('Historical graph pins are unavailable');
      for (const row of rows) {
        if (row.erased!.value === 'false') availablePins.add(row.revision!.value);
        if (BigInt(row.sequence!.value) > BigInt(sequence)) sequence = row.sequence!.value;
      }
    }
    const admitted = await admittedHistory(boundary, pinnedHistory, channel, availablePins);
    const records = [
      ...admitted.claims.flatMap((claim) => [
        claim.claim,
        claim.value.subject,
        ...(claim.value.object.kind === 'entity' ? [claim.value.object.ref] : []),
      ]),
      ...admitted.entities.flatMap((entity) => [
        entity.entity,
        ...entity.names.map((name) => nameRecord(entity.entity, name)),
      ]),
    ];
    const visible = await boundary.visible(records);
    const admittedUnits = new Set(admitted.units.map((unit) => unit.id));
    const claims = admitted.claims.filter(
      (claim) =>
        visible.has(claim.claim) &&
        visible.has(claim.value.subject) &&
        admittedUnits.has(claim.value.revealedAt) &&
        (claim.value.object.kind !== 'entity' || visible.has(claim.value.object.ref)),
    );
    const entities = admitted.entities
      .filter((entity) => visible.has(entity.entity))
      .map((entity) => ({
        ...entity,
        names: entity.names.filter(
          (name) =>
            visible.has(nameRecord(entity.entity, name)) && admittedUnits.has(name.revealedAt),
        ),
      }));
    const units = new Set([
      ...claims.map((claim) => claim.value.revealedAt),
      ...entities.flatMap((entity) => entity.names.map((name) => name.revealedAt)),
    ]);
    const visibleHistory = {
      ...pinnedHistory,
      claims,
      entities,
      units: admitted.units.filter((unit) => units.has(unit.id)),
    };
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
    const paged = page.all
      ? { ...history, nextCursor: null }
      : wikiHistoryPage(
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
      (await readableIdentities(boundary, [entity], channel)).has(entity) &&
      (await boundary.visible([entity])).has(entity);
    const identities = new Set([
      ...paged.entities.map((entity) => entity.entity),
      ...paged.claims.flatMap((claim) => [
        claim.value.subject,
        ...(claim.value.object.kind === 'entity' ? [claim.value.object.ref] : []),
      ]),
    ]);
    const resolutions: Record<string, MergedIdentity> = {};
    for (const entity of identities) {
      if (!(await canRead(entity))) throw new WorkReadMissing('Resource is unavailable');
      const resolution = await readMergedIdentity(work.environment, entity, canRead);
      if (resolution) resolutions[entity] = resolution;
    }
    // Resolutions describe today's links; they never replace a pinned IRI/name.
    const disclosed = await discloseWikiHistory(paged, work.wikiEvidence!, work.rights?.store);
    // Access and suitability can move without a graph sequence. Re-evaluate the
    // same inventory after hydration; a prior page/cursor never grants disclosure.
    await requireWikiWork(boundary, resource, channel);
    const fenced = await admittedHistory(boundary, pinnedHistory, channel, availablePins);
    if (JSON.stringify(fenced) !== JSON.stringify(admitted))
      throw new WorkReadMoved('Wiki disclosure changed during the read');
    for (const resolution of Object.values(resolutions))
      if (!(await canRead(resolution.survivor)))
        throw new WorkReadMoved('Wiki identity disclosure changed during the read');
    return {
      ...disclosed,
      nextCursor: paged.nextCursor,
      sourcePosition: { dataEpoch: work.environment.lineage.dataEpoch, sequence },
      scope,
      revisionSetDigest: revisionSetDigest(history.revisions),
      resolutions,
    };
  });
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
