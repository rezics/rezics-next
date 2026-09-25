import { createHash } from 'node:crypto';
import { ContentComments, contentCommentIntentDigest,
  type ContentComment, type ContentCommentInput } from '../../../../content/src/comments.ts';
import { AdmissionDenied, AdmissionExpired,
  type AccessAdmissionRegistry, type GraphTerminalProof,
  type RegisteredAdmission } from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { DATASET, GRAPHS, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';

export class ContentCommentDenied extends Error {}
export class ContentCommentWorkUnavailable extends Error {}

export interface AuthoredContentCommentInput extends ContentCommentInput {
  idempotencyKey: string;
}

function receiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${createHash('sha256')
    .update(`${admissionId}\0content-comment-create`).digest('hex')}`;
}

function terminal(admission: RegisteredAdmission, result: {
  outcome: 'succeeded' | 'cancelled'; position: { dataEpoch: string; sequence: string };
}): GraphTerminalProof {
  return { outcome: result.outcome, receipt: receiptIri(admission.id),
    admissionId: admission.id, requestDigest: admission.requestDigest,
    authorityEpoch: admission.authorityEpoch, scope: admission.scope,
    dataEpoch: result.position.dataEpoch, sequence: result.position.sequence };
}

export async function sealContentCommentAdmission(comments: ContentComments,
  admission: RegisteredAdmission): Promise<GraphTerminalProof> {
  if (admission.action !== 'content.comment') throw new ContentCommentDenied('wrong admission action');
  return terminal(admission, await comments.cancel(admission.id, admission.requestDigest));
}

async function assertCurrentWork(env: WorkActivationEnvironment, resourceId: string): Promise<void> {
  const result = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> ASK {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      GRAPH ${iri(GRAPHS.current)} { ${iri(resourceId)} a schema:CreativeWork ; rv:head ?head . }
    }`);
  if (result.boolean !== true) throw new ContentCommentWorkUnavailable('current Work is unavailable');
}

/** Account and Access admit an authored comment, while Content checks its
 * quoted paragraph against the retained exact source under a row lock. */
export async function createAdmittedContentComment(env: WorkActivationEnvironment,
  comments: ContentComments, account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, input: AuthoredContentCommentInput): Promise<ContentComment> {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['comment:create']);
  await assertCurrentWork(env, input.resourceId);
  const scope = `content:comment:${input.resourceId}`;
  const digest = contentCommentIntentDigest(input);
  const registered = await access.register({ principal, actingSubject: input.author,
    scope, action: 'content.comment', idempotencyKey: input.idempotencyKey,
    requestDigest: digest });
  if (registered.state !== 'sealed') {
    try { await access.claim(registered.id, digest); }
    catch (error) {
      if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      if (!await comments.readReceipt(registered.id)) {
        throw new ContentCommentDenied('comment dispatch is not admitted');
      }
    }
  }
  await assertCurrentWork(env, input.resourceId);
  let saved: ContentComment;
  try {
    saved = await comments.create({ ...input, admissionId: registered.id,
      authorityEpoch: registered.authorityEpoch, scope, requestDigest: digest });
  } catch (error) {
    // The owner lock orders cancellation with an uncertain successful insert.
    const settled = await comments.cancel(registered.id, digest);
    await access.recordGraphOutcome(registered.id, terminal(registered, settled));
    throw error;
  }
  await access.recordGraphOutcome(registered.id, terminal(registered, {
    outcome: 'succeeded', position: saved.sourcePosition }));
  return { ...saved, replayed: registered.replayed || saved.replayed };
}
