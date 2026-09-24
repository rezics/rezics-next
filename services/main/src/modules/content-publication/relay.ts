import type { ContentCore, ContentOutboxEvent, ProjectionPublication } from '../../../../content/src/core.ts';
import { ContentProjectionCursor } from '../../../../content/src/projection-cursor.ts';
import { profileRegistry } from '../../../../../packages/model/src/generated/profiles.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';

const PROFILE_ID = 'content-match-unit-v1';
const PROFILE = 'https://rezics.com/definition/content-match-unit-v1';
const SHAPE = `${PROFILE}/projection-shape`;
const UNIT_SHAPE = `${PROFILE}/unit-shape`;
const ELIGIBILITY_PROFILE_ID = 'content-search-eligibility-v1';
const ELIGIBILITY_SHAPE = 'https://rezics.com/definition/content-search-eligibility-v1/decision-shape';
const CONTENT_REVISION = 'urn:rezics:content:revision:';
const MAX_BODY_BYTES = 65_536;
const MAX_EVENTS_PER_POLL = 1;
const decimal = /^(0|[1-9][0-9]*)$/;

export class ContentProjectionUnavailable extends Error {}
export class ContentProjectionGap extends Error {}
export class ContentProjectionProfileUnavailable extends Error {}

export interface ContentProjectionResult {
  sourceEpoch: string;
  sourceSequence: string;
  disposition: 'ignored' | 'superseded' | 'projected';
}

function projectionIdentity(event: ContentOutboxEvent): { receipt: string; anchor: string; unit: string } {
  const digest = hash(`${event.position.dataEpoch}\0${event.position.sequence}\0${event.id}`);
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
  if (publication.status === 'active' && value('head') === value('decision')
    && (!value('eligibility') || value('eligibleDecision') !== value('decision'))) {
    throw new ContentProjectionUnavailable('public Content search eligibility is unproven');
  }
  return { decision: value('decision') ?? null, head: value('head') ?? null,
    eligibility: value('eligibility') ?? null };
}

function extractBody(body: Record<string, unknown>, publication: ProjectionPublication): { text: string; language: string } {
  const language = publication.reference.language;
  if (language.kind !== 'tag' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language.tag)) {
    throw new ContentProjectionUnavailable('Content language has no admitted search tag');
  }
  const text = body.body;
  if (typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
    throw new ContentProjectionUnavailable('Content body exceeds admitted single-unit recipe');
  }
  return { text, language: language.tag };
}

function projectionUpdate(env: WorkActivationEnvironment, event: ContentOutboxEvent,
  publication: ProjectionPublication, decision: string, eligibility: string,
  text: string, language: string): string {
  const { receipt, anchor, unit } = projectionIdentity(event);
  const reference = publication.reference;
  const digest = hash(JSON.stringify({ event: event.id, source: event.position,
    graph: publication.graph, reference, eligibility,
    text: hash(text), language, recipe: PROFILE_ID }));
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0batch`)}`;
  const projectionEvent = `urn:rezics:event:${hash(`${receipt}\0projection`)}`;
  return `PREFIX rv: <${RV}> DELETE {
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
      rv:searchBody ${lit(text)}@${language} . }
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

/** Process one contiguous Content position; stop on unresolved publication or profile drift. */
export async function relayContentProjectionOnce(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, consumer: string): Promise<ContentProjectionResult | null> {
  const checkpoint = await cursor.read(consumer);
  const highWater = await content.ownerPosition();
  if (checkpoint.dataEpoch !== highWater.dataEpoch || BigInt(checkpoint.sequence) > BigInt(highWater.sequence)) {
    throw new ContentProjectionGap('Content checkpoint is outside current owner epoch');
  }
  const events = await content.readOutbox(checkpoint.dataEpoch, checkpoint.sequence, MAX_EVENTS_PER_POLL);
  const event = events[0];
  if (!event) {
    if (checkpoint.sequence !== highWater.sequence) throw new ContentProjectionGap('Content outbox has a source gap');
    return null;
  }
  if (event.position.dataEpoch !== checkpoint.dataEpoch
    || BigInt(event.position.sequence) !== BigInt(checkpoint.sequence) + 1n
    || event.recipe !== 'content-body-v1') throw new ContentProjectionGap('Content outbox event is incomplete');
  let disposition: ContentProjectionResult['disposition'] = 'ignored';
  if (event.eventType === 'content.publication.active' || event.eventType === 'content.publication.rejected') {
    const publication = await content.readProjectionPublication(event);
    if (publication.status === 'active') {
      const identity = projectionIdentity(event);
      const validations = await projectionValidation(env, identity.anchor, identity.unit);
      const graph = await graphPublication(env, publication);
      if (graph.head !== graph.decision) {
        if (!graph.head) throw new ContentProjectionUnavailable('active publication head is absent');
        disposition = 'superseded';
      } else {
        const exact = (await content.readExactBatch([publication.reference.revisionId],
          async () => new Set([publication.reference.revisionId])))[0];
        if (exact?.status !== 'available' || exact.reference.byteDigest !== publication.reference.byteDigest) {
          throw new ContentProjectionUnavailable('exact Content body is unavailable');
        }
        const extracted = extractBody(exact.body, publication);
        const update = projectionUpdate(env, event, publication, graph.decision!, graph.eligibility!,
          extracted.text, extracted.language);
        const digest = hash(JSON.stringify({ event: event.id, source: event.position,
          graph: publication.graph, reference: publication.reference,
          eligibility: graph.eligibility,
          text: hash(extracted.text), language: extracted.language, recipe: PROFILE_ID }));
        const result = await env.fuseki.commandWithReceipt({ receipt: identity.receipt,
          digest, update, validations, deadlineMs: 10_000 });
        if (result.status !== 'committed' || result.position.dataEpoch !== env.lineage.dataEpoch) {
          throw new ContentProjectionUnavailable(`Content projection command ${result.status}`);
        }
        disposition = 'projected';
      }
    } else {
      await graphPublication(env, publication);
    }
  } else if (!['content.revision.saved', 'content.draft.stale', 'content.publication.prepared'].includes(event.eventType)) {
    throw new ContentProjectionUnavailable('unrecognized Content event');
  }
  await cursor.acknowledge(consumer, checkpoint, event.position);
  return { sourceEpoch: event.position.dataEpoch, sourceSequence: event.position.sequence, disposition };
}
