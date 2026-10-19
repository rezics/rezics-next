import type { ContentCore, ContentOutboxEvent, ProjectionPublication } from '../../../../content/src/core.ts';
import { ContentUnavailable } from '../../../../content/src/errors.ts';
import { ContentProjectionCursor, CONTENT_PROJECTION_COST } from '../../../../content/src/projection-cursor.ts';
import { profileRegistry } from '../../../../../packages/model/src/generated/profiles.ts';
import { DATASET, GRAPHS, PUBLIC_SEARCH_ANCHOR, RV, hash, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { ContentProjectionUnavailable, extractProjectionText, projectionRecipeFor } from './projection-recipes.ts';
import { graphRevisionSuppressed } from '../erasure/graph.ts';
import { readZoneSitePublishedPageReceipt } from '../zone/configuration.ts';
import { zonePublishedPageBinding } from '../zone/config-format.ts';
import { compositionReceiptIri, readCompositionReceipt } from '../structure/change.ts';
import { readContentEligibilityStatesForVariants } from './eligibility-state.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../outbox/relay-position.ts';
export { ContentProjectionUnavailable } from './projection-recipes.ts';

const PROFILE_ID = 'content-match-unit-v1';
const PROFILE = 'https://rezics.com/definition/content-match-unit-v1';
const SHAPE = `${PROFILE}/projection-shape`;
const UNIT_SHAPE = `${PROFILE}/unit-shape`;
const ELIGIBILITY_PROFILES = [
  { id: 'content-search-eligibility-v1', shape: 'https://rezics.com/definition/content-search-eligibility-v1/decision-shape' },
  { id: 'content-search-eligibility-v2', shape: 'https://rezics.com/definition/content-search-eligibility-v2/decision-shape' },
] as const;
const CONTENT_REVISION = 'urn:rezics:content:revision:';
const decimal = /^(0|[1-9][0-9]*)$/;
const ELIGIBILITY_DELIVERY_EVENT = 'content.publication.eligibility-delivered';

interface DeliveredEligibilitySource {
  sourcePosition: { dataEpoch: string; sequence: string };
  sourceReceipt: {
    resource: string;
    variant: string;
    publicationDecision: string;
    eligibilityDecision: string;
  };
}

function deliveredEligibilitySource(event: ContentOutboxEvent): DeliveredEligibilitySource | undefined {
  if (event.eventType !== ELIGIBILITY_DELIVERY_EVENT) return undefined;
  const sourcePosition = event.payload.sourcePosition as DeliveredEligibilitySource['sourcePosition'] | undefined;
  const sourceReceipt = event.payload.sourceReceipt as DeliveredEligibilitySource['sourceReceipt'] | undefined;
  if (!sourcePosition || !sourceReceipt || !sourcePosition.dataEpoch || !decimal.test(sourcePosition.sequence)
    || !sourceReceipt.resource || !sourceReceipt.variant || !sourceReceipt.publicationDecision
    || !sourceReceipt.eligibilityDecision) {
    throw new ContentProjectionGap('Content eligibility delivery identity is incomplete');
  }
  return { sourcePosition, sourceReceipt };
}

export class ContentProjectionGap extends Error {}
export class ContentProjectionProfileUnavailable extends Error {}

export interface ContentProjectionResult {
  sourceEpoch: string;
  sourceSequence: string;
  disposition: 'ignored' | 'superseded' | 'projected' | 'deferred';
}

function projectionIdentity(event: ContentOutboxEvent, rebuildId?: string): { receipt: string; anchor: string; unit: string } {
  const digest = hash(`${event.position.dataEpoch}\0${event.position.sequence}\0${event.id}`
    + (rebuildId ? `\0rebuild:${rebuildId}` : ''));
  return { receipt: `urn:rezics:receipt:content-projection:${digest}`,
    anchor: `urn:rezics:content:projection:${digest}`,
    unit: `urn:rezics:content:match-unit:${digest}` };
}

/** Installed Content and the retained eligibility profiles are mandatory before public search. */
export async function assertContentProjectionProfiles(env: WorkActivationEnvironment,
  additionalEligibilityProfiles: readonly string[] = []) {
  const registry = profileRegistry as Record<string, { sha256: string; shapes: readonly string[] }>;
  const profile = registry[PROFILE_ID];
  const requiredEligibilityProfiles = new Set(['content-search-eligibility-v1', ...additionalEligibilityProfiles]);
  if (!profile || !profile.shapes.includes(SHAPE) || !profile.shapes.includes(UNIT_SHAPE)
    || [...requiredEligibilityProfiles].some(id => {
      const reviewed = ELIGIBILITY_PROFILES.find(profileEntry => profileEntry.id === id);
      return !reviewed || !registry[id]?.shapes.includes(reviewed.shape);
    })) {
    throw new ContentProjectionProfileUnavailable('reviewed Content search profiles are unavailable');
  }
  const health = await env.fuseki.commandHealth();
  if (health.profiles[PROFILE_ID] !== profile.sha256
    || [...requiredEligibilityProfiles].some(id => health.profiles[id] !== registry[id]!.sha256)) {
    throw new ContentProjectionProfileUnavailable('Fuseki Content search profiles differ');
  }
  return profile;
}

/** An installed native profile is mandatory before reading bodies or mutating search. */
async function projectionValidation(env: WorkActivationEnvironment, anchor: string, unit: string,
  eligibilityProfile: string) {
  const profile = await assertContentProjectionProfiles(env, [eligibilityProfile]);
  return [{ profile: PROFILE_ID, sha256: profile.sha256, shape: SHAPE,
    focus: [anchor], graphs: [GRAPHS.revisions] },
  { profile: PROFILE_ID, sha256: profile.sha256, shape: UNIT_SHAPE,
    focus: [unit], graphs: [PUBLIC_SEARCH_GRAPH] }];
}

async function graphPublication(env: WorkActivationEnvironment, publication: ProjectionPublication,
  ownerPosition: Awaited<ReturnType<ContentCore['ownerPosition']>>) {
  const { graph, reference, preparationId, preparationPosition } = publication;
  if (graph.dataEpoch !== env.lineage.dataEpoch || !decimal.test(graph.sequence)) {
    throw new ContentProjectionUnavailable('publication owner epoch differs');
  }
  const site = await sitePublicationProof(env, publication);
  if (site) return { kind: 'site' as const, decision: null, head: null, eligibility: null, eligibleDecision: null };
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?epoch ?sequence ?routing ?outcome ?receiptEpoch ?receiptSequence ?decision ?head
    ?eligibility ?eligibleDecision
    ?revision ?digest ?ownerEpoch ?ownerSequence ?resource ?variant
    ?decisionRevision ?decisionDigest ?decisionEpoch ?decisionSequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ;
        rv:routingEpoch ?routing ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(graph.receipt)} a rv:OperationReceipt ;
        rv:outcome ?outcome ; rv:dataEpoch ?receiptEpoch ; rv:sequence ?receiptSequence ;
        rv:contentPreparation ${lit(preparationId)} ;
        rv:contentRevision ?revision ; rv:byteDigest ?digest ;
        rv:ownerDataEpoch ?ownerEpoch ; rv:ownerSequence ?ownerSequence ;
        rv:resource ?resource ; rv:variant ?variant .
        OPTIONAL { ${iri(graph.receipt)} rv:publicationDecision ?decision }
      }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
        ${iri(reference.variantId)} rv:contentPublicationHead ?head .
        OPTIONAL { ${iri(reference.variantId)} rv:publicSearchEligibilityHead ?eligibility }
      } }
      OPTIONAL { FILTER(BOUND(?eligibility)) GRAPH ${iri(GRAPHS.revisions)} {
        ?eligibility a rv:ContentSearchEligibilityDecision ;
          rv:variant ${iri(reference.variantId)} ; rv:resource ${iri(reference.resourceId)} ;
          rv:publicationDecision ?eligibleDecision ; rv:disclosure rv:Public . } }
      OPTIONAL { FILTER(BOUND(?decision)) GRAPH ${iri(GRAPHS.revisions)} {
        ?decision a rv:ContentPublicationDecision ;
        rv:contentRevision ?decisionRevision ; rv:byteDigest ?decisionDigest ;
        rv:ownerDataEpoch ?decisionEpoch ; rv:ownerSequence ?decisionSequence ;
        rv:resource ${iri(reference.resourceId)} ; rv:component ${iri(reference.variantId)} . } }
    }`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  const value = (key: string) => row?.[key]?.value;
  const expectedOutcome = publication.status === 'active' ? `${RV}Succeeded` : `${RV}Cancelled`;
  if (rows.length !== 1 || value('epoch') !== env.lineage.dataEpoch
    || value('routing') !== env.lineage.routingEpoch
    || !decimal.test(value('sequence') ?? '')
    || BigInt(value('sequence')!) < BigInt(graph.sequence)
    || value('outcome') !== expectedOutcome
    || value('receiptEpoch') !== graph.dataEpoch || value('receiptSequence') !== graph.sequence
    || value('revision') !== `${CONTENT_REVISION}${reference.revisionId}`
    || value('digest') !== reference.byteDigest
    || value('ownerEpoch') !== preparationPosition.dataEpoch
    || value('ownerSequence') !== preparationPosition.sequence
    || value('resource') !== reference.resourceId || value('variant') !== reference.variantId
    || (publication.status === 'active' && (!value('decision')
      || value('decisionRevision') !== `${CONTENT_REVISION}${reference.revisionId}`
      || value('decisionDigest') !== reference.byteDigest
      || value('decisionEpoch') !== preparationPosition.dataEpoch
      || value('decisionSequence') !== preparationPosition.sequence))
    || (publication.status === 'rejected' && value('decision'))) {
    throw new ContentProjectionUnavailable('graph receipt does not prove terminal Content publication');
  }
  let eligibilityState: Awaited<ReturnType<typeof readContentEligibilityStatesForVariants>>[number] | null = null;
  if (publication.status === 'active') {
    [eligibilityState] = await readContentEligibilityStatesForVariants(env, [reference.variantId], ownerPosition,
      { expectedGraphSequence: value('sequence') });
    if (!eligibilityState || eligibilityState.kind === 'unresolved') {
      throw new ContentProjectionUnavailable(`Content eligibility owner proof is unresolved${eligibilityState
        ? `: ${eligibilityState.reason}` : ''}`);
    }
  }
  const eligibility = eligibilityState?.kind === 'public-current'
    ? eligibilityState.eligibilityDecision : value('eligibility') ?? null;
  const eligibleDecision = eligibilityState?.kind === 'public-current'
    ? eligibilityState.id : null;
  return { kind: 'content' as const, decision: value('decision') ?? null, head: value('head') ?? null,
    eligibility, eligibleDecision, eligibilityState };
}

/** Site publication has one atomic bundle receipt and correlated page bindings,
 * rather than one Content decision/head per language variant. Its exact terminal
 * events acknowledge custody; they grant no body-search eligibility. */
async function sitePublicationProof(env: WorkActivationEnvironment, publication: ProjectionPublication): Promise<boolean> {
  const { graph, reference: ref, preparationId, preparationPosition } = publication;
  if (publication.status === 'active') {
    const marker = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(graph.receipt)} rv:sitePublicationRevision ?site . }
    }`, 1024);
    if (marker.boolean !== true) return false;
    const site = await readZoneSitePublishedPageReceipt(env, graph.receipt, ref);
    if (!site) throw new ContentProjectionUnavailable('site publication receipt is incomplete');
    if (site.dataEpoch !== graph.dataEpoch || site.sequence !== graph.sequence
      || !site.pages.some(page => page.page === ref.resourceId && page.variantId === ref.variantId
        && page.revisionId === ref.revisionId && page.byteDigest === ref.byteDigest)) {
      throw new ContentProjectionUnavailable('site receipt differs from terminal Content publication');
    }
    const binding = zonePublishedPageBinding(site.revision, ref.resourceId, ref.revisionId);
    const proof = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?current .
        FILTER(?current >= ${graph.sequence})
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(site.zone)} a rv:Zone .
        ${site.zone === ref.resourceId ? '' : `${iri(site.zone)} rv:homeDocument ${iri(ref.resourceId)} .
          FILTER NOT EXISTS { ?otherZone rv:homeDocument ${iri(ref.resourceId)} .
            FILTER(?otherZone != ${iri(site.zone)}) }`}
      }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(binding)} rv:sitePublicationRevision ${iri(site.revision)} ;
        rv:page ${iri(ref.resourceId)} ; rv:variant ${iri(ref.variantId)} ;
        rv:contentRevision ${iri(`${CONTENT_REVISION}${ref.revisionId}`)} ; rv:byteDigest ${lit(ref.byteDigest)} ;
        rv:ownerDataEpoch ${lit(preparationPosition.dataEpoch)} ; rv:contentPreparation ?selectedPin ; rv:ownerSequence ?selectedSequence .
        FILTER(?selectedPin != ${lit(preparationId)} || ?selectedSequence = ${preparationPosition.sequence}) }
    }`, 1024);
    if (proof.boolean !== true) throw new ContentProjectionUnavailable('site page binding differs from settled Content custody');
    return true;
  }
  const matched = /^content-site-pin:([0-9a-f-]{36}):([0-9a-f-]{36})$/.exec(preparationId);
  if (!matched || graph.receipt !== compositionReceiptIri(matched[1]!, 'zone.edit')) return false;
  const terminal = await readCompositionReceipt(env, matched[1]!, 'zone.edit');
  const zone = /^zone:edit:(https:\/\/rezics\.com\/id\/[0-9a-f-]{36})$/.exec(terminal?.scope ?? '')?.[1];
  if (!terminal || terminal.outcome !== 'cancelled' || matched[2] !== ref.revisionId
    || !zone || terminal.dataEpoch !== graph.dataEpoch
    || terminal.sequence !== graph.sequence) {
    throw new ContentProjectionUnavailable('site cancellation differs from rejected Content custody');
  }
  const open = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?current .
      FILTER(?current >= ${graph.sequence}) FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(zone)} a rv:Zone .
      ${zone === ref.resourceId ? '' : `${iri(zone)} rv:homeDocument ${iri(ref.resourceId)} .
        FILTER NOT EXISTS { ?otherZone rv:homeDocument ${iri(ref.resourceId)} .
          FILTER(?otherZone != ${iri(zone)}) }`}
    }
  }`, 1024);
  if (open.boolean !== true) throw new ContentProjectionUnavailable('site cancellation graph position is unavailable');
  return true;
}

function projectionUpdate(env: WorkActivationEnvironment, event: ContentOutboxEvent,
  publication: ProjectionPublication, decision: string, eligibility: string,
  text: string, language: string, identity: { receipt: string; anchor: string; unit: string }): string {
  const { receipt, anchor, unit } = identity;
  const reference = publication.reference;
  const digest = hash(JSON.stringify({ event: event.id, source: event.position,
    graph: publication.graph, reference, eligibility,
    text: hash(text), language, recipe: PROFILE_ID }));
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0batch`)}`;
  const projectionEvent = `urn:rezics:event:${hash(`${receipt}\0projection`)}`;
  return `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> DELETE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
    GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?oldUnit ?oldPredicate ?oldValue }
  } INSERT {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(anchor)} a rv:ContentProjection, rv:RevisionAnchor ;
      rv:component ${iri(reference.variantId)} ; rv:resource ${iri(reference.resourceId)} ;
      rv:contentRevision ${iri(`${CONTENT_REVISION}${reference.revisionId}`)} ;
      rv:publicationDecision ${iri(decision)} ; rv:eligibility ${iri(eligibility)} ;
      rv:matchUnit ${iri(unit)} ;
      rv:ownerDataEpoch ${lit(event.position.dataEpoch)} ;
      rv:ownerSequence ${lit(event.position.sequence)} ;
      rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:sequence ?next . }
    GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(unit)} a rv:MatchUnit ;
      rv:resource ${iri(reference.resourceId)} ; rv:variant ${iri(reference.variantId)} ;
      rv:revision ${iri(`${CONTENT_REVISION}${reference.revisionId}`)} ;
      rv:publicationDecision ${iri(decision)} ; rv:eligibility ${iri(eligibility)} ;
      rv:projection ${iri(anchor)} ;
      rv:language ${lit(language)} ; rv:field rv:Body ; rv:disclosure rv:Public ;
      rv:searchBody ${lit(text)}@${language} .
 }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
      rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
      rv:ownerDataEpoch ${lit(event.position.dataEpoch)} ;
      rv:ownerSequence ${lit(event.position.sequence)} ;
      rv:resource ${iri(reference.resourceId)} ; rv:variant ${iri(reference.variantId)} ;
      rv:contentRevision ${iri(`${CONTENT_REVISION}${reference.revisionId}`)} ;
      rv:publicationDecision ${iri(decision)} ; rv:eligibility ${iri(eligibility)} ;
      rv:projection ${iri(anchor)} ; rv:matchUnit ${iri(unit)} ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:sequence ?next . }
    GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
      rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
      rv:eventCount 1 ; rv:event ${iri(projectionEvent)} .
      ${iri(projectionEvent)} a rv:ContentProjectionEvent ; rv:ordinal 0 ;
        rv:action "content.project" ; rv:receipt ${iri(receipt)} ;
        rv:variant ${iri(reference.variantId)} ;
        rv:contentRevision ${iri(`${CONTENT_REVISION}${reference.revisionId}`)} . }
  } WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
    GRAPH ${iri(GRAPHS.current)} { ${iri(reference.variantId)} a rv:ContentVariant ;
      rv:resource ${iri(reference.resourceId)} ; rv:contentPublicationHead ${iri(decision)} ;
      rv:publicSearchEligibilityHead ${iri(eligibility)} . }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} a rv:ContentPublicationDecision ;
      rv:contentRevision ${iri(`${CONTENT_REVISION}${reference.revisionId}`)} ;
      rv:byteDigest ${lit(reference.byteDigest)} ;
      rv:ownerDataEpoch ${lit(publication.preparationPosition.dataEpoch)} ;
      rv:ownerSequence ${lit(publication.preparationPosition.sequence)} . }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(eligibility)} a rv:ContentSearchEligibilityDecision ;
      rv:variant ${iri(reference.variantId)} ; rv:resource ${iri(reference.resourceId)} ;
      rv:publicationDecision ${iri(decision)} ; rv:disclosure rv:Public . }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(publication.graph.receipt)} rv:outcome rv:Succeeded ;
      rv:publicationDecision ${iri(decision)} . }
    OPTIONAL { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      ?oldUnit a rv:MatchUnit ; rv:variant ${iri(reference.variantId)} ;
        rv:projection ?oldProjection ; ?oldPredicate ?oldValue . } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
    BIND(?n + 1 AS ?next)
  }`;
}

/** Validate the owner proof before retention: malformed events never advance. */
async function terminalPublication(content: ContentCore, event: ContentOutboxEvent) {
  if (!event.recipe) throw new ContentProjectionGap('Content outbox event is incomplete');
  if (event.recipe !== 'content-body-v1') return undefined;
  if (['content.publication.active', 'content.publication.rejected', ELIGIBILITY_DELIVERY_EVENT].includes(event.eventType)) {
    return content.readProjectionPublication(event, true);
  }
  if (!['content.revision.saved', 'content.draft.stale', 'content.publication.prepared',
    'content.comment.created', 'content.comment.cancelled'].includes(event.eventType)) {
    throw new ContentProjectionGap('unrecognized Content event');
  }
  return undefined;
}

async function projectEvent(env: WorkActivationEnvironment, content: ContentCore,
  event: ContentOutboxEvent, publication: ProjectionPublication | undefined, rebuildId?: string) {
  let disposition: ContentProjectionResult['disposition'] = 'ignored';
  // Other owners in the Content database (media, replies, protection) write their own recipes to the shared
  // outbox; search projects only content-body-v1 events and acknowledges the rest in order.
  if (event.recipe !== 'content-body-v1') {
    // Acknowledged below without projection.
  } else if (event.eventType === 'content.publication.active' || event.eventType === 'content.publication.rejected'
    || event.eventType === ELIGIBILITY_DELIVERY_EVENT) {
    // Resolve the published revision's model from Content's settled pin first.
    // Non-text revisions need no body-byte read or text-profile check.
    if (!publication) throw new ContentProjectionGap('terminal publication source missing');
    if (publication.status === 'active') {
      const erased = await content.readPublicationErasureSupersession(publication.preparationId);
      if (erased) {
        if (erased.revisionId !== publication.reference.revisionId
          || !await graphRevisionSuppressed(env.fuseki, env.lineage, erased.revisionId,
            erased.erasureId, erased.erasureEpoch, { receipt: erased.graphReceipt,
              dataEpoch: erased.graphDataEpoch, sequence: erased.graphSequence })) {
          throw new ContentProjectionUnavailable('erased publication lacks exact graph suppression');
        }
        return 'superseded';
      }
    }
    const graph = await graphPublication(env, publication, await content.ownerPosition());
    if (graph.kind === 'site') return 'ignored';
    if (publication.status === 'rejected') return 'ignored';
    if (graph.head !== graph.decision) {
      if (!graph.head) throw new ContentProjectionUnavailable('active publication head is absent');
      return 'superseded';
    }
    const source = deliveredEligibilitySource(event);
    if (source && (source.sourceReceipt.resource !== publication.reference.resourceId
      || source.sourceReceipt.variant !== publication.reference.variantId
      || source.sourceReceipt.publicationDecision !== graph.decision)) {
      throw new ContentProjectionUnavailable('delivered eligibility differs from its settled publication');
    }
    // Absence and a proved approval of an older publication are terminal owner
    // evaluations. A later approval has its own durable Content source event.
    if (graph.eligibilityState?.kind === 'closed-withdrawn'
      || graph.eligibilityState?.kind === 'closed-absent'
      || graph.eligibilityState?.kind === 'closed-superseded-approval') return 'ignored';
    if (event.eventType === 'content.publication.active' && graph.eligibilityState?.kind === 'public-current') {
      if (!graph.eligibility || !graph.decision || graph.eligibleDecision !== graph.decision) {
        throw new ContentProjectionUnavailable('current Public approval does not bind the active publication');
      }
      const delivery = await content.readEligibilityDeliveryForPublication(event, {
        streamScope: MAIN_RELAY_STREAM_SCOPE,
        graphDataEpoch: env.lineage.dataEpoch,
        resourceId: publication.reference.resourceId,
        variantId: publication.reference.variantId,
        publicationDecision: graph.decision,
        eligibilityDecision: graph.eligibility,
        preparationId: publication.preparationId,
        revisionId: publication.reference.revisionId,
      });
      if (!delivery) {
        throw new ContentProjectionUnavailable('current Public approval has no durable Content delivery');
      }
      const delivered = deliveredEligibilitySource(delivery.event);
      if (!delivered || !decimal.test(delivery.sourceSequence)
        || delivered.sourcePosition.dataEpoch !== env.lineage.dataEpoch
        || delivered.sourcePosition.sequence !== delivery.sourceSequence
        || delivered.sourceReceipt.resource !== publication.reference.resourceId
        || delivered.sourceReceipt.variant !== publication.reference.variantId
        || delivered.sourceReceipt.publicationDecision !== graph.decision
        || delivered.sourceReceipt.eligibilityDecision !== graph.eligibility) {
        throw new ContentProjectionUnavailable('durable Public approval delivery differs from current eligibility');
      }
      const deliveredPublication = await content.readProjectionPublication(delivery.event, true);
      if (deliveredPublication.preparationId !== publication.preparationId
        || deliveredPublication.reference.revisionId !== publication.reference.revisionId
        || deliveredPublication.reference.resourceId !== publication.reference.resourceId
        || deliveredPublication.reference.variantId !== publication.reference.variantId) {
        throw new ContentProjectionUnavailable('durable Public approval delivery names another Content pin');
      }
      return 'superseded';
    }
    if (source && source.sourceReceipt.eligibilityDecision !== graph.eligibility) {
      if (graph.eligibilityState?.kind !== 'public-current' || !graph.eligibility || !graph.decision) {
        throw new ContentProjectionUnavailable('newer eligibility source is not an exact current Public approval');
      }
      const successor = await content.readEligibilityDeliverySuccessor(event, {
        streamScope: MAIN_RELAY_STREAM_SCOPE,
        graphDataEpoch: env.lineage.dataEpoch,
        sourceSequence: source.sourcePosition.sequence,
        resourceId: publication.reference.resourceId,
        variantId: publication.reference.variantId,
        publicationDecision: graph.decision,
        eligibilityDecision: graph.eligibility,
      });
      if (!successor || !decimal.test(successor.sourceSequence)
        || BigInt(successor.sourceSequence) <= BigInt(source.sourcePosition.sequence)) {
        throw new ContentProjectionUnavailable('newer Public approval delivery is not durably retained in Content');
      }
      const nextSource = deliveredEligibilitySource(successor.event);
      if (!nextSource || nextSource.sourcePosition.dataEpoch !== env.lineage.dataEpoch
        || BigInt(nextSource.sourcePosition.sequence) !== BigInt(successor.sourceSequence)
        || nextSource.sourceReceipt.eligibilityDecision !== graph.eligibility
        || nextSource.sourceReceipt.publicationDecision !== graph.decision) {
        throw new ContentProjectionUnavailable('newer Public approval successor differs from current eligibility');
      }
      const nextPublication = await content.readProjectionPublication(successor.event, true);
      if (nextPublication.preparationId !== publication.preparationId
        || nextPublication.reference.revisionId !== publication.reference.revisionId
        || nextPublication.reference.resourceId !== publication.reference.resourceId
        || nextPublication.reference.variantId !== publication.reference.variantId) {
        throw new ContentProjectionUnavailable('newer Public approval successor names another Content pin');
      }
      return 'superseded';
    }
    const recipe = projectionRecipeFor(publication.reference.model);
    if (recipe.kind === 'skip') {
      // Prove the terminal graph receipt before advancing past a non-text revision.
      return 'ignored';
    }
    if (publication.status === 'active') {
      if (!graph.eligibilityState || graph.eligibilityState.kind !== 'public-current' || !graph.eligibility
        || graph.eligibleDecision !== graph.decision) {
        throw new ContentProjectionUnavailable('public Content search eligibility is unproven');
      }
      const identity = projectionIdentity(event, rebuildId);
      const eligibilityProfile = graph.eligibilityState.rightsBasis === `${RV}PublicDomain`
        ? 'content-search-eligibility-v2' : 'content-search-eligibility-v1';
      const validations = await projectionValidation(env, identity.anchor, identity.unit, eligibilityProfile);
      // An obsolete head needs only its owner/graph proofs; bytes are required
      // only for the exact current publication that will be projected.
      // The terminal metadata was proved before retention. Read the exact body
      // once here so unavailable bytes remain a retryable target, while the
      // erasure supersession check above still fences erased publications.
      const exact = (await content.readExactBatch([publication.reference.revisionId],
        async () => new Set([publication.reference.revisionId])))[0];
      if (exact?.status !== 'available' || exact.reference.byteDigest !== publication.reference.byteDigest) {
        throw new ContentProjectionUnavailable('exact Content body is unavailable');
      }
      const extracted = extractProjectionText(recipe, exact.body, exact.reference);
      const update = projectionUpdate(env, event, publication, graph.decision!, graph.eligibility!,
        extracted.text, extracted.language, identity);
      const digest = hash(JSON.stringify({ event: event.id, source: event.position,
        graph: publication.graph, reference: publication.reference,
        eligibility: graph.eligibility,
        text: hash(extracted.text), language: extracted.language, recipe: PROFILE_ID }));
      // A historical receipt alone cannot certify the current physical body.
      // Uncertain responses stay deferred until this exact command re-enters
      // the native writer and checks its original delivery descriptor.
      const result = await env.fuseki.command({ receipt: identity.receipt,
        digest, update, validations, deadlineMs: CONTENT_PROJECTION_COST.deadlineMs });
      if (result.status !== 'committed' || result.position.dataEpoch !== env.lineage.dataEpoch) {
        throw new ContentProjectionUnavailable(`Content projection command ${result.status}`);
      }
      disposition = 'projected';
    }
  } else if (!['content.revision.saved', 'content.draft.stale',
    'content.publication.prepared', 'content.comment.created',
    'content.comment.cancelled'].includes(event.eventType)) {
    throw new ContentProjectionUnavailable('unrecognized Content event');
  }
  return disposition;
}

async function publicSearchOpen(env: WorkActivationEnvironment): Promise<boolean> {
  const answer = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . } }`);
  if (answer.boolean !== true && answer.boolean !== false) {
    throw new ContentProjectionUnavailable('public search anchor is unreadable');
  }
  return answer.boolean === true;
}

/** Advance one source event and independently retry a bounded set of failed targets. */
export async function relayContentProjectionOnce(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, consumer: string,
  rebuildId?: string): Promise<ContentProjectionResult | null> {
  if (rebuildId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(rebuildId)) {
    throw new ContentProjectionUnavailable('invalid rebuild identity');
  }
  // The public consumer waits while the anchor is absent. Quarantine closes
  // readers, and a live projection uses a different receipt from the rebuild
  // replay, so it must not land in the closed graph. Replay passes a rebuild
  // id and is the writer that refills that graph. Returning idle leaves no
  // pending row, which would block checkpoint adoption.
  if (!rebuildId && !await publicSearchOpen(env)) return null;
  let retried: ContentProjectionResult | null = null;
  for (const event of await cursor.retries(consumer)) {
    let disposition: ContentProjectionResult['disposition'];
    try {
      const publication = await terminalPublication(content, event);
      disposition = await projectEvent(env, content, event, publication, rebuildId);
    }
    catch (error) {
      // An erased exact revision will not become readable on retry. Deferring it
      // would hide the refusal and leave a pending row that blocks adoption.
      if (error instanceof ContentUnavailable) throw error;
      await cursor.finishRetry(consumer, event, false);
      continue;
    }
    await cursor.finishRetry(consumer, event, true);
    retried = { sourceEpoch: event.position.dataEpoch, sourceSequence: event.position.sequence, disposition };
  }
  const checkpoint = await cursor.readScan(consumer);
  const highWater = await content.ownerPosition();
  if (checkpoint.dataEpoch !== highWater.dataEpoch || BigInt(checkpoint.sequence) > BigInt(highWater.sequence)) {
    throw new ContentProjectionGap('Content checkpoint is outside current owner epoch');
  }
  let events = await content.readOutbox(checkpoint.dataEpoch, checkpoint.sequence, CONTENT_PROJECTION_COST.scanEvents);
  if (!events.length && await content.sequencePending()) {
    events = await content.readOutbox(checkpoint.dataEpoch, checkpoint.sequence, CONTENT_PROJECTION_COST.scanEvents);
  }
  const event = events[0];
  if (!event) {
    if (checkpoint.sequence !== highWater.sequence) throw new ContentProjectionGap('Content outbox has a source gap');
    return retried;
  }
  if (event.position.dataEpoch !== checkpoint.dataEpoch
    || BigInt(event.position.sequence) !== BigInt(checkpoint.sequence) + 1n) {
    throw new ContentProjectionGap('Content outbox event is incomplete');
  }
  const publication = await terminalPublication(content, event);
  const target = publication?.reference.variantId;
  let disposition: ContentProjectionResult['disposition'] = 'deferred';
  if (!target || !await cursor.hasPendingTarget(consumer, event.position.dataEpoch, target)) {
    try { disposition = await projectEvent(env, content, event, publication, rebuildId); }
    catch (error) { if (!target || error instanceof ContentUnavailable) throw error; }
  }
  await cursor.acknowledge(consumer, checkpoint, event.position,
    disposition === 'deferred' ? { event, target: target! } : undefined);
  return { sourceEpoch: event.position.dataEpoch, sourceSequence: event.position.sequence, disposition };
}
