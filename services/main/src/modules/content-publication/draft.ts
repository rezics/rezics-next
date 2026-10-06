import { createHash } from 'node:crypto';
import { ContentConflict, contentDraftIntentDigest, type ContentCore,
  validPublicDomainSource, type PublicDomainTextSource, type SaveDraftCommand,
  type SaveDraftResult, type VariantIdentity } from '../../../../content/src/core.ts';
import { directContentEmbeds } from '../../../../content/src/embed.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type GraphTerminalProof, type RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import type { RightsStore } from '../rights/store.ts';
import { authoredDocumentBody, authoredPostNotes, POST_CONTENT_MODEL, CONTENT_TEXT_COST, checkedContentText,
  type PostNotesInput, type AuthoredBodyInput } from '../../../../content/src/document-body.ts';

export class ContentDraftDenied extends Error {}
export class ContentDraftRightsDenied extends ContentDraftDenied {}
export class ContentDraftStale extends Error {
  constructor(message: string, readonly currentHead: string | null = null) { super(message); }
}
export class ContentDraftUnavailable extends Error {}

export interface AuthoredContentDraftInput extends AuthoredBodyInput {
  resourceId: string;
  targetProfile?: 'work' | 'catalog-description';
  variant: VariantIdentity;
  expectedHead: string | null;
  embeds?: string[];
  notes?: PostNotesInput;
  actingSubject: string;
  idempotencyKey: string;
  publicDomain?: { assessmentId: string; source: PublicDomainTextSource };
}

export function contentDraftReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${createHash('sha256')
    .update(`${admissionId}\0content-draft-save`).digest('hex')}`;
}

function terminalProof(admission: RegisteredAdmission, result: SaveDraftResult): GraphTerminalProof {
  return { outcome: result.outcome === 'succeeded' ? 'succeeded' : 'cancelled',
    receipt: contentDraftReceiptIri(admission.id), admissionId: admission.id,
    requestDigest: admission.requestDigest, authorityEpoch: admission.authorityEpoch,
    scope: admission.scope, dataEpoch: result.position.dataEpoch,
    sequence: result.position.sequence };
}

/** Called only after an Access scope/principal fence. The Content operation lock
 * converts a missing receipt to a durable cancellation or returns the winning save. */
export async function sealContentDraftAdmission(content: ContentCore,
  admission: RegisteredAdmission): Promise<GraphTerminalProof> {
  if (admission.action !== 'content.draft') throw new ContentDraftDenied('wrong admission action');
  const result = await content.cancelDraft(admission.id, admission.requestDigest);
  return terminalProof(admission, result);
}

async function assertCurrentTarget(env: WorkActivationEnvironment,
  resourceId: string, variantId: string, targetProfile: AuthoredContentDraftInput['targetProfile'],
  hasNotes: boolean): Promise<void> {
  const result = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> ASK {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      GRAPH ${iri(GRAPHS.current)} { ${iri(resourceId)} ${targetProfile === 'catalog-description'
        ? 'a schema:Organization .' : hasNotes ? 'a rv:Post ; rv:head ?head .'
          : 'a ?kind ; rv:head ?head . VALUES ?kind { schema:CreativeWork rv:Post }'} }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(variantId)} rv:resource ?other .
        FILTER(?other != ${iri(resourceId)}) } }
    }`);
  if (result.boolean !== true) {
    if (hasNotes) throw new ContentConflict('notes require a current Post target');
    throw new ContentDraftUnavailable('current Work is unavailable');
  }
}

/** Account, Access and current Work admit a draft before Content's local CAS. */
export async function saveAdmittedContentDraft(env: WorkActivationEnvironment,
  content: ContentCore, account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, input: AuthoredContentDraftInput,
  rights?: Pick<RightsStore, 'currentPublicDomainAssessment'>): Promise<SaveDraftResult & { byteDigest: string }> {
  let body;
  let notes;
  // Content's text API retains its 65,536 UTF-16-unit budget. UTF-8 custody
  // permits up to three bytes per unit; Contribution and reply limits differ.
  try {
    body = authoredDocumentBody(input, CONTENT_TEXT_COST.textBytes);
    checkedContentText(body.body);
    notes = authoredPostNotes(input.notes);
    if (notes !== undefined && input.targetProfile === 'catalog-description') {
      throw new Error('notes require a Post');
    }
  }
  catch { throw new ContentConflict('invalid authored Content body'); }
  if (input.variant.resourceId !== input.resourceId
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i.test(input.resourceId)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i.test(input.actingSubject)
    || !/^urn:rezics:variant:[0-9a-f-]{36}$/i.test(input.variant.id)
    || (input.expectedHead !== null
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.expectedHead))
    || (input.publicDomain !== undefined && (input.targetProfile === 'catalog-description'
      || !/^[0-9a-f-]{36}$/i.test(input.publicDomain.assessmentId)
      || !validPublicDomainSource(input.publicDomain.source)))) {
    throw new ContentConflict('invalid authored Content draft');
  }
  const embeds = directContentEmbeds(input.embeds);
  const serializedJson = JSON.stringify({ ...body,
    ...(notes !== undefined ? { notes } : {}),
    ...(embeds.length ? { embeds } : {}) });
  const command: SaveDraftCommand = { operationId: '', variant: input.variant,
    expectedHead: input.expectedHead,
    model: input.targetProfile === 'catalog-description' ? 'catalog-description-v1'
      : notes !== undefined ? POST_CONTENT_MODEL : 'content-shape-v1',
    sourceRevision: null,
    provenance: {}, serializedJson };
  const publicDomain = input.publicDomain;
  const digest = contentDraftIntentDigest(command, input.actingSubject,
    publicDomain ? { rightsAssessmentId: publicDomain.assessmentId, source: publicDomain.source } : undefined);
  const principal = await account.verify(request, ['work:edit']);
  await assertCurrentTarget(env, input.resourceId, input.variant.id, input.targetProfile, notes !== undefined);
  const scope = `content:draft:${input.resourceId}`;
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope, action: 'content.draft', idempotencyKey: input.idempotencyKey,
    requestDigest: digest });
  command.operationId = `content-draft:${registered.id}`;
  command.provenance = publicDomain ? { kind: 'admitted-public-domain-v1',
    transcriber: input.actingSubject, rightsBasis: 'public-domain',
    rightsAssessmentId: publicDomain.assessmentId, source: publicDomain.source,
    admissionId: registered.id, authorityEpoch: registered.authorityEpoch,
    scope, requestDigest: digest, expectedHead: input.expectedHead } : {
    kind: 'admitted-original-contribution-v1', author: input.actingSubject,
    admissionId: registered.id, authorityEpoch: registered.authorityEpoch,
    scope, requestDigest: digest, expectedHead: input.expectedHead,
    rightsBasis: 'original-contribution' };
  if (publicDomain && !registered.replayed) {
    if (!rights) throw new ContentDraftUnavailable('rights owner is unavailable');
    let current: boolean;
    try { current = await rights.currentPublicDomainAssessment(input.resourceId, publicDomain.assessmentId); }
    catch { throw new ContentDraftUnavailable('rights owner is unavailable'); }
    if (!current) throw new ContentDraftRightsDenied('current public-domain Work assessment is required');
  }
  if (registered.state !== 'sealed') {
    try { await access.claim(registered.id, digest, principal); }
    catch (error) {
      if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      if (!await content.readDraftReceipt(command.operationId)) {
        throw new ContentDraftDenied('draft dispatch is not admitted');
      }
    }
  }
  await assertCurrentTarget(env, input.resourceId, input.variant.id, input.targetProfile, notes !== undefined);
  const saved = await content.saveDraft(command);
  await access.recordGraphOutcome(registered.id, terminalProof(registered, saved));
  if (saved.outcome === 'cancelled') throw new ContentDraftDenied('draft admission was fenced');
  if (saved.outcome === 'stale_head') {
    const current = await content.readDraftHead(input.resourceId, input.variant.id);
    throw new ContentDraftStale('Content draft head changed', current?.revisionId ?? null);
  }
  return { ...saved, byteDigest: createHash('sha256').update(serializedJson).digest('hex'),
    replayed: registered.replayed || saved.replayed };
}
