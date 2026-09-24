import { createHash } from 'node:crypto';
import { ContentConflict, contentDraftIntentDigest, type ContentCore,
  type SaveDraftCommand, type SaveDraftResult, type VariantIdentity } from '../../../../content/src/core.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type GraphTerminalProof, type RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';

export class ContentDraftDenied extends Error {}
export class ContentDraftStale extends Error {}
export class ContentDraftUnavailable extends Error {}

export interface AuthoredContentDraftInput {
  resourceId: string;
  variant: VariantIdentity;
  expectedHead: string | null;
  body: string;
  actingSubject: string;
  idempotencyKey: string;
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

async function assertCurrentWork(env: WorkActivationEnvironment,
  resourceId: string, variantId: string): Promise<void> {
  const result = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> ASK {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      GRAPH ${iri(GRAPHS.current)} { ${iri(resourceId)} a schema:CreativeWork ;
        rv:mainVersion ?main ; rv:head ?head . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(variantId)} rv:resource ?other .
        FILTER(?other != ${iri(resourceId)}) } }
    }`);
  if (result.boolean !== true) throw new ContentDraftUnavailable('current Work is unavailable');
}

/** Account, Access and current Work admit a draft before Content's local CAS. */
export async function saveAdmittedContentDraft(env: WorkActivationEnvironment,
  content: ContentCore, account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, input: AuthoredContentDraftInput): Promise<SaveDraftResult> {
  if (input.variant.resourceId !== input.resourceId
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i.test(input.resourceId)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i.test(input.actingSubject)
    || !/^urn:rezics:variant:[0-9a-f-]{36}$/i.test(input.variant.id)
    || (input.expectedHead !== null
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.expectedHead))
    || !input.body || input.body.length > 65_536) {
    throw new ContentConflict('invalid authored Content draft');
  }
  const serializedJson = JSON.stringify({ body: input.body });
  const command: SaveDraftCommand = { operationId: '', variant: input.variant,
    expectedHead: input.expectedHead, model: 'content-shape-v1', sourceRevision: null,
    provenance: {}, serializedJson };
  const digest = contentDraftIntentDigest(command, input.actingSubject);
  const principal = await account.verify(request, ['work:edit']);
  await assertCurrentWork(env, input.resourceId, input.variant.id);
  const scope = `content:draft:${input.resourceId}`;
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope, action: 'content.draft', idempotencyKey: input.idempotencyKey,
    requestDigest: digest });
  command.operationId = `content-draft:${registered.id}`;
  command.provenance = { kind: 'admitted-original-contribution-v1', author: input.actingSubject,
    admissionId: registered.id, authorityEpoch: registered.authorityEpoch,
    scope, requestDigest: digest, expectedHead: input.expectedHead,
    rightsBasis: 'original-contribution' };
  if (registered.state !== 'sealed') {
    try { await access.claim(registered.id, digest); }
    catch (error) {
      if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      if (!await content.readDraftReceipt(command.operationId)) {
        throw new ContentDraftDenied('draft dispatch is not admitted');
      }
    }
  }
  await assertCurrentWork(env, input.resourceId, input.variant.id);
  const saved = await content.saveDraft(command);
  await access.recordGraphOutcome(registered.id, terminalProof(registered, saved));
  if (saved.outcome === 'cancelled') throw new ContentDraftDenied('draft admission was fenced');
  if (saved.outcome === 'stale_head') throw new ContentDraftStale('Content draft head changed');
  return { ...saved, replayed: registered.replayed || saved.replayed };
}
