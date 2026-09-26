import { ContentConflict, contentDraftIntentDigest, type ContentCore,
  type SaveDraftCommand, type SaveDraftResult, type VariantIdentity } from '../../../../content/src/core.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission, type VerifiedPrincipal } from '../access/admission.ts';
import { contentDraftReceiptIri } from '../content-publication/draft.ts';
import { DATASET, GRAPHS, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';

export class HubDraftDenied extends Error {}
export class HubDraftStale extends Error {}
export class HubDraftUnavailable extends Error {}

export interface HubDraftInput {
  resourceId: string;
  variant: VariantIdentity;
  expectedHead: string | null;
  model: 'rezics-skill-package-v1' | 'rezics-prompt-v1';
  serializedJson: string;
  actingSubject: string;
  idempotencyKey: string;
}

function terminalProof(admission: RegisteredAdmission, result: SaveDraftResult) {
  return { outcome: result.outcome === 'succeeded' ? 'succeeded' as const : 'cancelled' as const,
    receipt: contentDraftReceiptIri(admission.id), admissionId: admission.id,
    requestDigest: admission.requestDigest, authorityEpoch: admission.authorityEpoch,
    scope: admission.scope, dataEpoch: result.position.dataEpoch,
    sequence: result.position.sequence };
}

async function assertCurrentWork(env: WorkActivationEnvironment, resourceId: string,
  variantId: string): Promise<void> {
  const result = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> ASK {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      GRAPH ${iri(GRAPHS.current)} { ${iri(resourceId)} a schema:CreativeWork ;
        rv:mainVersion ?main ; rv:head ?head . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(variantId)} rv:resource ?other . FILTER(?other != ${iri(resourceId)}) } }
    }`);
  if (result.boolean !== true) throw new HubDraftUnavailable('current Work is unavailable');
}

/**
 * Specialized Hub bodies reuse Content's draft.save receipt, CAS revision and
 * existing content.draft Access action. The type-specific Hub rows are added
 * after this idempotent save and can be repaired by replaying the same key.
 */
export async function saveAdmittedHubDraft(env: WorkActivationEnvironment, content: ContentCore,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  principal: VerifiedPrincipal, input: HubDraftInput): Promise<{ saved: SaveDraftResult; operationId: string }> {
  if (input.variant.resourceId !== input.resourceId
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i.test(input.resourceId)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i.test(input.actingSubject)
    || !/^urn:rezics:variant:[0-9a-f-]{36}$/i.test(input.variant.id)
    || (input.expectedHead !== null && !/^[0-9a-f-]{36}$/i.test(input.expectedHead))
    || !/^[A-Za-z0-9:_./-]{1,128}$/.test(input.idempotencyKey)) {
    throw new ContentConflict('invalid Hub draft identity');
  }
  const command: SaveDraftCommand = { operationId: '', variant: input.variant,
    expectedHead: input.expectedHead, model: input.model, sourceRevision: null,
    provenance: {}, serializedJson: input.serializedJson };
  const digest = contentDraftIntentDigest(command, input.actingSubject);
  await assertCurrentWork(env, input.resourceId, input.variant.id);
  const scope = `content:draft:${input.resourceId}`;
  const admission = await access.register({ principal, actingSubject: input.actingSubject,
    scope, action: 'content.draft', idempotencyKey: input.idempotencyKey,
    requestDigest: digest });
  command.operationId = `content-draft:${admission.id}`;
  command.provenance = { kind: 'admitted-original-contribution-v1', author: input.actingSubject,
    admissionId: admission.id, authorityEpoch: admission.authorityEpoch,
    scope, requestDigest: digest, expectedHead: input.expectedHead,
    rightsBasis: 'original-contribution' };
  if (admission.state !== 'sealed') {
    try { await access.claim(admission.id, digest); }
    catch (error) {
      if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      if (!await content.readDraftReceipt(command.operationId)) {
        throw new HubDraftDenied('Hub draft dispatch is not admitted');
      }
    }
  }
  await assertCurrentWork(env, input.resourceId, input.variant.id);
  const saved = await content.saveDraft(command);
  await access.recordGraphOutcome(admission.id, terminalProof(admission, saved));
  if (saved.outcome === 'cancelled') throw new HubDraftDenied('Hub draft admission was fenced');
  if (saved.outcome === 'stale_head') throw new HubDraftStale('Hub draft head changed');
  return { saved: { ...saved, replayed: admission.replayed || saved.replayed },
    operationId: command.operationId };
}
