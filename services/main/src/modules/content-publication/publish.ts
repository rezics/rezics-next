import type { ContentCore, ExactContentReference, PublicationPreparation } from '../../../../content/src/core.ts';
import { profileRegistry } from '../../../../../packages/model/src/generated/profiles.ts';
import type { CommandValidation } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { RevisionNotFound } from '../work/history.ts';
import { hasDocumentContent } from '@rezics/document';
import { retainedDocumentBody, retainedPostNotes, POST_CONTENT_MODEL } from '../../../../content/src/document-body.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { ContentEmbedDenied, assertPublicContentEmbeds, publicContentEmbedConditions,
  publicContentEmbedGuards }
  from './embed-closure.ts';

const NONE = 'urn:rezics:none';
const REVISION_IRI_PREFIX = 'urn:rezics:content:revision:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class EmptyContentPublicationBody extends Error {}
export class InvalidContentPublication extends Error {}
export class ContentPublicationConflict extends Error {}
export class StaleContentOwnerEpoch extends Error {}
export class StaleGraphReceiptEpoch extends Error {}
export class ContentPublicationProfileUnavailable extends Error {}

/** Added to the existing publication path only when changing a Post declaration. */
export const POST_SPOILER_PUBLICATION_COST = { graphCalls: 4, identityRows: 2, validationFocus: 1 } as const;

export interface PublishPinnedContentInput {
  /** Omission preserves the Post declaration; false explicitly clears it. */
  spoiler?: boolean;
  targetProfile?: 'work' | 'catalog-description';
  preparationId: string;
  revisionId: string;
  expectedDigest: string;
  expectedContentEpoch: string;
  resourceId: string;
  variantId: string;
  expectedPublicationHead: string | null;
}

export interface ContentPublicationResult {
  status: 'active' | 'rejected' | 'pending';
  receipt: string;
  decision: string | null;
  graphDataEpoch: string | null;
  graphSequence: string | null;
  replayed: boolean;
}

interface GraphReceipt {
  outcome: 'active' | 'rejected';
  digest: string;
  admissionId: string;
  authorityEpoch: string;
  scope: string;
  preparationId: string;
  revisionId: string;
  variantId: string;
  resourceId: string;
  byteDigest: string;
  contentEpoch: string;
  contentSequence: string;
  expectedHead: string | null;
  decision: string | null;
  graphDataEpoch: string;
  graphSequence: string;
}

function checkedInput(input: PublishPinnedContentInput): void {
  if (input.spoiler !== undefined && typeof input.spoiler !== 'boolean') {
    throw new InvalidContentPublication('invalid Post spoiler declaration');
  }
  if (input.targetProfile !== undefined
    && input.targetProfile !== 'work' && input.targetProfile !== 'catalog-description') {
    throw new InvalidContentPublication('unknown Content publication target profile');
  }
  for (const value of [input.resourceId, input.variantId]) iri(value);
  if (input.expectedPublicationHead !== null) iri(input.expectedPublicationHead);
  if (!uuid.test(input.revisionId) || !uuid.test(input.expectedContentEpoch)
    || !/^[0-9a-f]{64}$/.test(input.expectedDigest)
    || !/^[A-Za-z0-9:_./-]{1,200}$/.test(input.preparationId)) {
    throw new InvalidContentPublication('invalid exact Content publication input');
  }
}

/** One bounded exact body read and, for v2, one current Post proof; no admission or pin is created. */
export async function assertContentPublicationBody(content: Pick<ContentCore, 'readExactBatch'>,
  input: PublishPinnedContentInput, env?: WorkActivationEnvironment): Promise<void> {
  const exact = (await content.readExactBatch([input.revisionId], async ids => new Set(ids)))[0];
  if (!exact || exact.status === 'missing' || exact.status === 'denied' || exact.status === 'erased') {
    throw new RevisionNotFound('Content revision is unavailable');
  }
  if (exact.status !== 'available') {
    throw new ContentPublicationConflict('Content revision is unavailable');
  }
  if (exact.reference.revisionId !== input.revisionId
    || exact.reference.resourceId !== input.resourceId || exact.reference.variantId !== input.variantId
    || exact.reference.byteDigest !== input.expectedDigest) {
    throw new ContentPublicationConflict('Content revision differs from publication intent');
  }
  if (input.spoiler !== undefined) {
    if (typeof input.spoiler !== 'boolean' || input.targetProfile === 'catalog-description' || !env) {
      throw new ContentPublicationConflict('spoiler requires a Post target');
    }
    const post = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.resourceId)} a rv:Post } }`);
    if (post.boolean !== true) throw new ContentPublicationConflict('spoiler requires a Post target');
  }
  if (exact.body.notes !== undefined || exact.reference.model === POST_CONTENT_MODEL) {
    try { retainedPostNotes(exact.body.notes); }
    catch { throw new ContentPublicationConflict('Content notes are invalid'); }
    if (exact.reference.model !== POST_CONTENT_MODEL || input.targetProfile === 'catalog-description') {
      throw new ContentPublicationConflict('notes require the Post Content model');
    }
    if (!env) throw new ContentPublicationConflict('Post target owner is unavailable');
    const post = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.resourceId)} a rv:Post } }`);
    if (post.boolean !== true) throw new ContentPublicationConflict('notes require a Post target');
  }
  // Structured Content has owner-defined fields rather than a text body.
  let empty = typeof exact.body.body === 'string' && !exact.body.body.trim();
  if (exact.body.document !== undefined) {
    try { empty = !hasDocumentContent(retainedDocumentBody(exact.body).document!); }
    catch { throw new ContentPublicationConflict('Content document projection differs'); }
  }
  if (empty) {
    throw new EmptyContentPublicationBody('Cannot publish an empty draft');
  }
}

export function contentPublicationDigest(input: PublishPinnedContentInput): string {
  checkedInput(input);
  return hash(JSON.stringify({ family: 'publish-content-revision-v1', ...input }));
}

export function contentPublicationReceiptIri(admissionId: string): string {
  if (!uuid.test(admissionId)) throw new InvalidContentPublication('invalid admission ID');
  return `urn:rezics:receipt:${hash(`${admissionId}\0publish-content-revision`)}`;
}

export function contentPublicationDecisionIri(admissionId: string): string {
  if (!uuid.test(admissionId)) throw new InvalidContentPublication('invalid admission ID');
  return `urn:rezics:content-publication:${hash(admissionId)}`;
}

function exactRevisionIri(revisionId: string): string {
  if (!uuid.test(revisionId)) throw new InvalidContentPublication('invalid Content revision ID');
  return `${REVISION_IRI_PREFIX}${revisionId.toLowerCase()}`;
}

function expectedHeadTerm(input: PublishPinnedContentInput): string {
  return iri(input.expectedPublicationHead ?? NONE);
}

function receiptFields(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: PublishPinnedContentInput, preparation: PublicationPreparation, outcome: 'active' | 'rejected',
  reason: 'StaleHead' | 'EmbedDenied' = 'StaleHead',
): string {
  const base = `rv:requestDigest ${lit(contentPublicationDigest(input))} ;
    rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
    rv:admittedScope ${lit(admission.scope)} ; rv:contentPreparation ${lit(input.preparationId)} ;
    rv:contentRevision ${iri(exactRevisionIri(input.revisionId))} ;
    rv:variant ${iri(input.variantId)} ; rv:resource ${iri(input.resourceId)} ;
    rv:byteDigest ${lit(input.expectedDigest)} ;
    rv:ownerDataEpoch ${lit(preparation.position.dataEpoch)} ;
    rv:ownerSequence ${lit(preparation.position.sequence)} ;
    rv:expectedHead ${expectedHeadTerm(input)} ; rv:datasetId ${iri(DATASET)} ;
    rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next`;
  return outcome === 'active'
    ? `${base} ; rv:publicationDecision ${iri(contentPublicationDecisionIri(admission.id))} ; rv:outcome rv:Succeeded`
    : `${base} ; rv:reason rv:${reason} ; rv:outcome rv:Cancelled`;
}

export function buildPinnedContentPublicationUpdate(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: PublishPinnedContentInput, preparation: PublicationPreparation,
  embedded: readonly ExactContentReference[] = []): string {
  const receipt = contentPublicationReceiptIri(admission.id);
  const decision = contentPublicationDecisionIri(admission.id);
  const operation = `urn:rezics:operation:${hash(`${admission.id}\0content-publication`)}`;
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0content`)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0content`)}`;
  const ref = preparation.reference;
  const targetKind = input.targetProfile === 'catalog-description' ? 'schema:Organization'
    : ref.model === POST_CONTENT_MODEL ? 'rv:Post' : '?kind . VALUES ?kind { schema:CreativeWork rv:Post }';
  const languageTag = ref.language.kind === 'tag' ? `rv:contentLanguage ${lit(ref.language.tag)} ;` : '';
  return `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.variantId)} rv:contentPublicationHead ?prior }
      ${input.spoiler !== undefined ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.resourceId)} rv:spoiler ?priorSpoiler }` : ''}
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${input.spoiler !== undefined ? `${iri(input.resourceId)} rv:spoiler ${input.spoiler} .` : ''}
        ${iri(input.variantId)} a rv:ContentVariant ; rv:resource ${iri(input.resourceId)} ;
          rv:contentPublicationHead ${iri(decision)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(decision)} a rv:ContentPublicationDecision, rv:RevisionAnchor ;
          rv:component ${iri(input.variantId)} ; rv:operation ${iri(operation)} ;
          rv:contentRevision ${iri(exactRevisionIri(input.revisionId))} ;
          rv:contentPreparation ${lit(input.preparationId)} ; rv:resource ${iri(input.resourceId)} ;
          rv:byteDigest ${lit(input.expectedDigest)} ; rv:contentFormat ${lit(ref.format)} ;
          rv:contentModel ${lit(ref.model)} ; rv:contentLanguageKind ${lit(ref.language.kind)} ;
          ${languageTag} rv:contentDirection ${lit(ref.direction)} ;
          rv:ownerDataEpoch ${lit(preparation.position.dataEpoch)} ;
          rv:ownerSequence ${lit(preparation.position.sequence)} ;
          rv:modelRevision ${iri('https://rezics.com/definition/content-publication-v1')} ;
          rv:shapeRevision ${iri('https://rezics.com/definition/content-publication-v1')} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          ${receiptFields(env, admission, input, preparation, 'active')} .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ContentPublicationEvent ; rv:ordinal 0 ;
          rv:action "content.publish" ; rv:receipt ${iri(receipt)} ;
          rv:variant ${iri(input.variantId)} ;
          rv:contentRevision ${iri(exactRevisionIri(input.revisionId))} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.resourceId)} a ${targetKind} .
        ${input.spoiler !== undefined ? `${iri(input.resourceId)} a rv:Post . OPTIONAL { ${iri(input.resourceId)} rv:spoiler ?priorSpoiler }` : ''}
        OPTIONAL { ${iri(input.variantId)} rv:resource ?registeredResource }
        OPTIONAL { ${iri(input.variantId)} rv:contentPublicationHead ?prior }
      }
      FILTER(!BOUND(?registeredResource) || ?registeredResource = ${iri(input.resourceId)})
      FILTER(COALESCE(?prior, ${iri(NONE)}) = ${expectedHeadTerm(input)})
      ${publicContentEmbedGuards(embedded)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
}

function rejectedUpdate(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: PublishPinnedContentInput, preparation: PublicationPreparation,
  reason: 'StaleHead' | 'EmbedDenied', embedded: readonly ExactContentReference[] = []): string {
  const receipt = contentPublicationReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0rejected-content`)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0rejected-content`)}`;
  const targetKind = input.targetProfile === 'catalog-description' ? 'schema:Organization'
    : preparation.reference.model === POST_CONTENT_MODEL ? 'rv:Post' : '?kind . VALUES ?kind { schema:CreativeWork rv:Post }';
  const guard = reason === 'StaleHead'
    ? `FILTER(COALESCE(?prior, ${iri(NONE)}) != ${expectedHeadTerm(input)})`
    : `FILTER(COALESCE(?prior, ${iri(NONE)}) = ${expectedHeadTerm(input)})
      FILTER(!(${publicContentEmbedConditions(embedded).join(' && ')}))`;
  return `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ;
          ${receiptFields(env, admission, input, preparation, 'rejected', reason)} .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ContentPublicationRejectedEvent ; rv:ordinal 0 ;
          rv:action "content.publish" ; rv:receipt ${iri(receipt)} ;
          rv:contentRevision ${iri(exactRevisionIri(input.revisionId))} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.resourceId)} a ${targetKind} .
        OPTIONAL { ${iri(input.variantId)} rv:resource ?registeredResource }
        OPTIONAL { ${iri(input.variantId)} rv:contentPublicationHead ?prior }
      }
      FILTER(!BOUND(?registeredResource) || ?registeredResource = ${iri(input.resourceId)})
      ${guard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
}

async function readGraphReceipt(env: WorkActivationEnvironment, admissionId: string): Promise<GraphReceipt | null> {
  const receipt = contentPublicationReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?reason ?digest ?admissionId
    ?authorityEpoch ?scope ?preparation ?revision ?variant ?resource ?byteDigest
    ?contentEpoch ?contentSequence ?expectedHead ?decision ?graphEpoch ?graphSequence WHERE {
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ; rv:requestDigest ?digest ;
          rv:admissionId ?admissionId ; rv:authorityEpoch ?authorityEpoch ;
          rv:admittedScope ?scope ; rv:contentPreparation ?preparation ;
          rv:contentRevision ?revision ; rv:variant ?variant ; rv:resource ?resource ;
          rv:byteDigest ?byteDigest ; rv:ownerDataEpoch ?contentEpoch ;
          rv:ownerSequence ?contentSequence ; rv:expectedHead ?expectedHead ;
          rv:dataEpoch ?graphEpoch ; rv:sequence ?graphSequence .
        OPTIONAL { ${iri(receipt)} rv:reason ?reason }
        OPTIONAL { ${iri(receipt)} rv:publicationDecision ?decision }
      }
    }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new ContentPublicationConflict('graph receipt cardinality violation');
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'active'
    : value('outcome') === `${RV}Cancelled`
      && [`${RV}StaleHead`, `${RV}EmbedDenied`].includes(value('reason') ?? '') ? 'rejected' : null;
  if (!outcome || !value('digest') || !value('admissionId') || !value('authorityEpoch')
    || !value('scope') || !value('preparation') || !value('revision') || !value('variant')
    || !value('resource') || !value('byteDigest') || !value('contentEpoch')
    || !/^(0|[1-9][0-9]*)$/.test(value('contentSequence') ?? '')
    || !value('expectedHead') || !value('graphEpoch')
    || !/^(0|[1-9][0-9]*)$/.test(value('graphSequence') ?? '')
    || (outcome === 'active' && (!value('decision') || value('reason')))
    || (outcome === 'rejected' && value('decision'))) {
    throw new ContentPublicationConflict('graph receipt is incomplete');
  }
  return { outcome, digest: value('digest')!, admissionId: value('admissionId')!,
    authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
    preparationId: value('preparation')!, revisionId: value('revision')!,
    variantId: value('variant')!, resourceId: value('resource')!, byteDigest: value('byteDigest')!,
    contentEpoch: value('contentEpoch')!, contentSequence: value('contentSequence')!,
    expectedHead: value('expectedHead') === NONE ? null : value('expectedHead')!,
    decision: value('decision') ?? null, graphDataEpoch: value('graphEpoch')!,
    graphSequence: value('graphSequence')! };
}

async function reconcile(env: WorkActivationEnvironment, content: ContentCore,
  admission: RegisteredAdmission, input: PublishPinnedContentInput,
  preparation: PublicationPreparation): Promise<ContentPublicationResult | null> {
  const receiptIri = contentPublicationReceiptIri(admission.id);
  const graph = await readGraphReceipt(env, admission.id);
  if (!graph) return null;
  if ((await content.ownerPosition()).dataEpoch !== preparation.position.dataEpoch) {
    throw new StaleContentOwnerEpoch('Content owner epoch changed before graph settlement');
  }
  if (graph.graphDataEpoch !== env.lineage.dataEpoch) {
    throw new StaleGraphReceiptEpoch('graph receipt belongs to another data epoch');
  }
  if (graph.digest !== contentPublicationDigest(input) || graph.admissionId !== admission.id
    || graph.authorityEpoch !== admission.authorityEpoch || graph.scope !== admission.scope
    || graph.preparationId !== input.preparationId
    || graph.revisionId !== exactRevisionIri(input.revisionId)
    || graph.variantId !== input.variantId || graph.resourceId !== input.resourceId
    || graph.byteDigest !== input.expectedDigest || graph.contentEpoch !== preparation.position.dataEpoch
    || graph.contentSequence !== preparation.position.sequence
    || graph.expectedHead !== input.expectedPublicationHead
    || (graph.outcome === 'active' && graph.decision !== contentPublicationDecisionIri(admission.id))) {
    throw new ContentPublicationConflict('graph receipt does not prove this exact Content preparation');
  }
  const settleId = `content-settle:${hash(input.preparationId)}`;
  const settled = await content.settlePublication(settleId, input.preparationId, {
    outcome: graph.outcome, revisionId: input.revisionId, receipt: receiptIri,
    dataEpoch: graph.graphDataEpoch, sequence: graph.graphSequence,
  }, preparation.position.dataEpoch);
  return { status: graph.outcome, receipt: receiptIri, decision: graph.decision,
    graphDataEpoch: graph.graphDataEpoch, graphSequence: graph.graphSequence,
    replayed: settled.replayed };
}

function checkedAdmission(admission: RegisteredAdmission, input: PublishPinnedContentInput): string {
  const digest = contentPublicationDigest(input);
  if (admission.action !== 'content.publish'
    || ![input.resourceId, input.variantId].some(target => admission.scope === `content:publish:${target}`)
    || admission.requestDigest !== digest
    || !/^(0|[1-9][0-9]*)$/.test(admission.authorityEpoch)) {
    throw new ContentPublicationConflict('Content publication admission differs');
  }
  return digest;
}

function checkedPreparation(preparation: PublicationPreparation, input: PublishPinnedContentInput): void {
  const ref: ExactContentReference = preparation.reference;
  if (ref.revisionId !== input.revisionId || ref.byteDigest !== input.expectedDigest
    || ref.resourceId !== input.resourceId || ref.variantId !== input.variantId
    || (input.targetProfile === 'catalog-description') !== (ref.model === 'catalog-description-v1')) {
    throw new ContentPublicationConflict('Content preparation targets another exact revision');
  }
}

function pending(receipt: string, replayed: boolean): ContentPublicationResult {
  return { status: 'pending', receipt, decision: null, graphDataEpoch: null,
    graphSequence: null, replayed };
}

/** Reconcile a previously prepared pin after an ambiguous or lost graph outcome. */
export async function reconcilePinnedContentPublication(env: WorkActivationEnvironment, content: ContentCore,
  admission: RegisteredAdmission, input: PublishPinnedContentInput): Promise<ContentPublicationResult> {
  checkedAdmission(admission, input);
  const receipt = contentPublicationReceiptIri(admission.id);
  const preparation = await content.readPublicationPreparation(input.preparationId);
  if (!preparation) throw new ContentPublicationConflict('Content preparation is absent');
  checkedPreparation(preparation, input);
  if (preparation.position.dataEpoch !== input.expectedContentEpoch
    || (await content.ownerPosition()).dataEpoch !== input.expectedContentEpoch) {
    throw new StaleContentOwnerEpoch('Content owner data epoch changed');
  }
  const terminal = await reconcile(env, content, admission, input, preparation);
  if (terminal) return terminal;
  if (preparation.status !== 'pending' || !preparation.pinActive) {
    throw new ContentPublicationConflict('settled Content preparation has no matching graph receipt');
  }
  return pending(receipt, true);
}

async function candidateValidations(env: WorkActivationEnvironment, admissionId: string,
  variantId: string, post?: string): Promise<CommandValidation[]> {
  const registry = profileRegistry as Record<string, { sha256: string; shapes: readonly string[] }>;
  const profile = registry['content-publication-v1'];
  const decisionShape = 'https://rezics.com/definition/content-publication-v1/decision-shape';
  const variantShape = 'https://rezics.com/definition/content-publication-v1/variant-shape';
  if (!profile || !profile.shapes.includes(decisionShape) || !profile.shapes.includes(variantShape)) {
    throw new ContentPublicationProfileUnavailable('reviewed Content publication profile is not generated');
  }
  const health = await env.fuseki.commandHealth();
  if (health.profiles['content-publication-v1'] !== profile.sha256) {
    throw new ContentPublicationProfileUnavailable('Fuseki Content publication profile differs');
  }
  const postChecks: CommandValidation[] = [];
  if (post) {
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?publisher ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(post)} a rv:Post ; rv:publisher ?publisher ; rv:head ?head }
    } LIMIT ${POST_SPOILER_PUBLICATION_COST.identityRows}`)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]!.publisher || !rows[0]!.head) {
      throw new ContentPublicationConflict('Post publication identity is unavailable');
    }
    postChecks.push(...await profileValidations(env.fuseki, 'post-v1', [{
      shape: 'https://rezics.com/definition/post-v1/post-shape', focus: [post], graphs: [GRAPHS.current],
    }], { post, publisher: rows[0]!.publisher.value, revision: rows[0]!.head.value }));
  }
  return [...postChecks, { profile: 'content-publication-v1', sha256: profile.sha256,
    shape: variantShape, focus: [variantId], graphs: [GRAPHS.current] },
  { profile: 'content-publication-v1', sha256: profile.sha256,
    shape: decisionShape, focus: [contentPublicationDecisionIri(admissionId)],
    graphs: [GRAPHS.revisions] }];
}

/** Graph receipt, not an HTTP response, proves the terminal result before Content settlement. */
export async function publishPinnedContent(env: WorkActivationEnvironment, content: ContentCore,
  admission: RegisteredAdmission, input: PublishPinnedContentInput): Promise<ContentPublicationResult> {
  const digest = checkedAdmission(admission, input);
  await assertContentPublicationBody(content, input, env);
  // The existing graph writer rejects unknown current types and unvalidated
  // product writes. Do not create a pin until both reviewed shape bindings exist.
  const validations = await candidateValidations(env, admission.id, input.variantId,
    input.spoiler !== undefined ? input.resourceId : undefined);
  const receipt = contentPublicationReceiptIri(admission.id);
  // A fresh preparation must not pin an exact revision whose dependency closure
  // is already undisclosed. A replay first checks its durable graph receipt.
  const existing = await content.readPublicationPreparation(input.preparationId);
  let embeds = existing ? null : await assertPublicContentEmbeds(env, content, input.revisionId);
  const preparation = await content.preparePublication(input.preparationId, input.revisionId,
    input.expectedDigest, true, input.expectedContentEpoch);
  checkedPreparation(preparation, input);
  if (preparation.position.dataEpoch !== input.expectedContentEpoch
    || (await content.ownerPosition()).dataEpoch !== input.expectedContentEpoch) {
    throw new StaleContentOwnerEpoch('Content owner data epoch changed');
  }
  const prior = await reconcile(env, content, admission, input, preparation);
  if (prior) return { ...prior, replayed: true };
  embeds ??= await assertPublicContentEmbeds(env, content, input.revisionId);
  if (preparation.status !== 'pending' || !preparation.pinActive) {
    throw new ContentPublicationConflict('settled Content preparation has no matching graph receipt');
  }
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    return pending(receipt, preparation.replayed);
  }
  const envelope = { receipt, digest, update: buildPinnedContentPublicationUpdate(env, admission,
    input, preparation, embeds.dependencies),
    validations, deadlineMs: 10_000 };
  let guardUnmatched = false;
  try {
    const result = await env.fuseki.commandWithReceipt(envelope);
    guardUnmatched = result.status === 'guard-unmatched';
    if (result.status === 'conflict') throw new ContentPublicationConflict('graph receipt key conflicts');
  } catch (error) {
    if (error instanceof ContentPublicationConflict) throw error;
    // An uncertain graph response must be resolved by reading its exact receipt.
  }
  let terminal = await reconcile(env, content, admission, input, preparation);
  if (terminal) return terminal;
  if (guardUnmatched) {
    let denied = false;
    try { await assertPublicContentEmbeds(env, content, input.revisionId); }
    catch (error) {
      if (!(error instanceof ContentEmbedDenied)) throw error;
      denied = true;
    }
    if (denied) {
      try {
        await env.fuseki.commandWithReceipt({ receipt, digest,
          update: rejectedUpdate(env, admission, input, preparation, 'EmbedDenied',
            embeds.dependencies), validations: [], deadlineMs: 10_000 });
      } catch { /* the exact rejection receipt resolves an uncertain response */ }
      terminal = await reconcile(env, content, admission, input, preparation);
      if (terminal) return terminal;
    }
    try {
      await env.fuseki.commandWithReceipt({ receipt, digest,
        update: rejectedUpdate(env, admission, input, preparation, 'StaleHead'),
        validations: [], deadlineMs: 10_000 });
    } catch { /* a lost stale outcome is resolved from the same receipt */ }
    terminal = await reconcile(env, content, admission, input, preparation);
    if (terminal) return terminal;
  }
  return pending(receipt, preparation.replayed);
}
