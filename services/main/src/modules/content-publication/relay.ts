import type { ContentCore, ContentOutboxEvent, ProjectionPublication } from '../../../../content/src/core.ts';
import { ContentProjectionCursor, CONTENT_PROJECTION_COST } from '../../../../content/src/projection-cursor.ts';
import { profileRegistry } from '../../../../../packages/model/src/generated/profiles.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { ContentProjectionUnavailable, extractProjectionText, projectionRecipeFor } from './projection-recipes.ts';
import { graphRevisionSuppressed } from '../erasure/graph.ts';
import { readZoneSitePublicationReceipt } from '../zone/configuration.ts';
import { zonePublishedPageBinding } from '../zone/config-format.ts';
import { compositionReceiptIri, readCompositionReceipt } from '../structure/change.ts';
export { ContentProjectionUnavailable } from './projection-recipes.ts';

const PROFILE_ID = 'content-match-unit-v1';
const PROFILE = 'https://rezics.com/definition/content-match-unit-v1';
const SHAPE = `${PROFILE}/projection-shape`;
const UNIT_SHAPE = `${PROFILE}/unit-shape`;
const ELIGIBILITY_PROFILE_ID = 'content-search-eligibility-v1';
const ELIGIBILITY_SHAPE = 'https://rezics.com/definition/content-search-eligibility-v1/decision-shape';
const CONTENT_REVISION = 'urn:rezics:content:revision:';
const decimal = /^(0|[1-9][0-9]*)$/;

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

/** Both independently reviewed native profiles are mandatory before public search. */
export async function assertContentProjectionProfiles(env: WorkActivationEnvironment) {
  const registry = profileRegistry as Record<string, { sha256: string; shapes: readonly string[] }>;
  const profile = registry[PROFILE_ID];
  const eligibility = registry[ELIGIBILITY_PROFILE_ID];
  if (!profile || !profile.shapes.includes(SHAPE) || !profile.shapes.includes(UNIT_SHAPE)
    || !eligibility || !eligibility.shapes.includes(ELIGIBILITY_SHAPE)) {
    throw new ContentProjectionProfileUnavailable('reviewed Content search profiles are unavailable');
  }
  const health = await env.fuseki.commandHealth();
  if (health.profiles[PROFILE_ID] !== profile.sha256
    || health.profiles[ELIGIBILITY_PROFILE_ID] !== eligibility.sha256) {
    throw new ContentProjectionProfileUnavailable('Fuseki Content search profiles differ');
  }
  return profile;
}

/** An installed native profile is mandatory before reading bodies or mutating search. */
async function projectionValidation(env: WorkActivationEnvironment, anchor: string, unit: string) {
  const profile = await assertContentProjectionProfiles(env);
  return [{ profile: PROFILE_ID, sha256: profile.sha256, shape: SHAPE,
    focus: [anchor], graphs: [GRAPHS.revisions] },
  { profile: PROFILE_ID, sha256: profile.sha256, shape: UNIT_SHAPE,
    focus: [unit], graphs: [PUBLIC_SEARCH_GRAPH] }];
}

async function graphPublication(env: WorkActivationEnvironment, publication: ProjectionPublication) {
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
  return { kind: 'content' as const, decision: value('decision') ?? null, head: value('head') ?? null,
    eligibility: value('eligibility') ?? null,
    eligibleDecision: value('eligibleDecision') ?? null };
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
    const site = await readZoneSitePublicationReceipt(env, graph.receipt);
    if (!site) throw new ContentProjectionUnavailable('site publication receipt is incomplete');
    if (site.zone !== ref.resourceId || site.dataEpoch !== graph.dataEpoch || site.sequence !== graph.sequence
      || !site.pages.some(page => page.page === ref.resourceId && page.variantId === ref.variantId && page.revisionId === ref.revisionId)) {
      throw new ContentProjectionUnavailable('site receipt differs from terminal Content publication');
    }
    const binding = zonePublishedPageBinding(site.revision, ref.resourceId, ref.revisionId);
    const proof = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?current .
        FILTER(?current >= ${graph.sequence})
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
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
  if (!terminal || terminal.outcome !== 'cancelled' || matched[2] !== ref.revisionId
    || terminal.scope !== `zone:edit:${ref.resourceId}` || terminal.dataEpoch !== graph.dataEpoch
    || terminal.sequence !== graph.sequence) {
    throw new ContentProjectionUnavailable('site cancellation differs from rejected Content custody');
  }
  const open = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?current .
      FILTER(?current >= ${graph.sequence}) FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
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
  if (['content.publication.active', 'content.publication.rejected'].includes(event.eventType)) {
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
  } else if (event.eventType === 'content.publication.active' || event.eventType === 'content.publication.rejected') {
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
    const graph = await graphPublication(env, publication);
    if (graph.kind === 'site') return 'ignored';
    if (publication.status === 'rejected') return 'ignored';
    if (graph.head !== graph.decision) {
      if (!graph.head) throw new ContentProjectionUnavailable('active publication head is absent');
      return 'superseded';
    }
    const recipe = projectionRecipeFor(publication.reference.model);
    if (recipe.kind === 'skip') {
      // Prove the terminal graph receipt before advancing past a non-text revision.
      return 'ignored';
    }
    if (publication.status === 'active') {
      const identity = projectionIdentity(event, rebuildId);
      const validations = await projectionValidation(env, identity.anchor, identity.unit);
      // An obsolete head needs only its owner/graph proofs; bytes are required
      // only for the exact current publication that will be projected.
      await content.readProjectionPublication(event);
      if (!graph.eligibility || graph.eligibleDecision !== graph.decision) {
        throw new ContentProjectionUnavailable('public Content search eligibility is unproven');
      }
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

/** Advance one source event and independently retry a bounded set of failed targets. */
export async function relayContentProjectionOnce(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, consumer: string,
  rebuildId?: string): Promise<ContentProjectionResult | null> {
  if (rebuildId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(rebuildId)) {
    throw new ContentProjectionUnavailable('invalid rebuild identity');
  }
  let retried: ContentProjectionResult | null = null;
  for (const event of await cursor.retries(consumer)) {
    let disposition: ContentProjectionResult['disposition'];
    try {
      const publication = await terminalPublication(content, event);
      disposition = await projectEvent(env, content, event, publication, rebuildId);
    }
    catch {
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
    catch (error) { if (!target) throw error; }
  }
  await cursor.acknowledge(consumer, checkpoint, event.position,
    disposition === 'deferred' ? { event, target: target! } : undefined);
  return { sourceEpoch: event.position.dataEpoch, sourceSequence: event.position.sequence, disposition };
}
