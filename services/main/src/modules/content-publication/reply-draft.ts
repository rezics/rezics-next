import { createHash } from 'node:crypto';
import { ContentConflict, contentDraftIntentDigest, type ContentCore,
  type SaveDraftCommand } from '../../../../content/src/core.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { readReplyRoot, replyRoot } from '../realm-reply/root.ts';
import { targetRead } from '../target/resolve.ts';
import { WorkReadMissing } from '../work/read-session.ts';
import { readRealmPolicy } from '../space/policy.ts';
import { ContentDraftStale, contentDraftReceiptIri, sealContentDraftAdmission } from './draft.ts';
import { authoredDocumentBody } from '../../../../content/src/document-body.ts';
import { hasDocumentContent, type DocumentSnapshot } from '@rezics/document';

/** Direct root probes run before and after admission; Access baseline and
 * delegated target authority retain their owners' separate cost contracts. */
export const MEMBER_REPLY_COST = { bodyBytes: 8192, pageSize: 32,
  graphQueries: 11, graphResponseBytes: 262_144, ownerRowLocks: 12 } as const;
export interface MemberReplyDraft {
  originRealm?: string | null;
  reply: string; variantId: string; rootTarget: string; rootRevision: string;
  language: string; direction: 'ltr' | 'rtl' | 'none'; expectedHead: string | null;
  body?: string | null; document?: DocumentSnapshot; actingSubject: string;
}

/** The author/root binding and every edit/delete use Content's draft CAS and
 * immutable receipts. Deletion is a tombstone revision; retained history and
 * moderation evidence remain intact. A later edit never inherits Realm review. */
export async function saveMemberReplyDraft(env: WorkActivationEnvironment, content: ContentCore,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>
    & Partial<Pick<AccessAdmissionRegistry, 'withRealmPolicy' | 'canReadWork' | 'canReadSemanticResource'>>,
  request: Request, input: MemberReplyDraft, key: string, admittedOrigin = false): Promise<{
    reply: string; variantId: string; revisionId: string; revisionDigest: string; predecessor: string | null; deleted: boolean;
    sourcePosition: { dataEpoch: string; sequence: string }; replayed: boolean }> {
  const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
  const deleted = input.body === null && input.document === undefined;
  let body;
  try { body = deleted ? { body: '' } : authoredDocumentBody({
    ...(input.body !== undefined ? { body: input.body as string } : {}),
    ...(input.document !== undefined ? { document: input.document } : {}),
  }, MEMBER_REPLY_COST.bodyBytes); }
  catch { throw new ContentConflict('invalid member reply body'); }
  if (![input.reply, input.rootTarget, input.rootRevision, input.actingSubject].every(value => native.test(value))
    || input.originRealm != null && !native.test(input.originRealm)
    || !/^urn:rezics:variant:[0-9a-f-]{36}$/.test(input.variantId)
    || (deleted ? input.expectedHead === null
      : body.document ? !hasDocumentContent(body.document) : !body.body)) {
    throw new ContentConflict('invalid member reply draft');
  }
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['comment:create']);
  if (input.originRealm && !admittedOrigin) {
    if (!access.withRealmPolicy) throw new AdmissionDenied('Realm policy owner is unavailable');
    return access.withRealmPolicy(principal, input.actingSubject, input.originRealm, 'reply', async permit => {
      const policy = await readRealmPolicy(env, input.originRealm!);
      if (!policy || policy.visibility !== 'public' && !permit.member) throw new AdmissionDenied('Realm is unavailable');
      return saveMemberReplyDraft(env, content, account, access, request, input, key, true);
    });
  }
  const proveRoot = async (creating: boolean) => {
    try {
      const readable = await targetRead(env, { access, principal, actingSubject: input.actingSubject },
        session => (creating ? replyRoot : readReplyRoot)(session, input.rootTarget, input.rootRevision));
      if (!readable) throw new AdmissionDenied('reply root is unavailable');
    } catch (error) {
      if (error instanceof WorkReadMissing) throw new AdmissionDenied('reply root is unavailable');
      throw error;
    }
  };
  await proveRoot(false);
  const command: SaveDraftCommand = { operationId: '', variant: { id: input.variantId,
    resourceId: input.reply, language: { kind: 'tag', tag: input.language, originalTag: input.language },
    direction: input.direction }, expectedHead: input.expectedHead, model: 'member-reply-v1',
    sourceRevision: input.rootRevision, provenance: {}, serializedJson: JSON.stringify({ ...body,
      deleted, rootTarget: input.rootTarget, rootRevision: input.rootRevision,
      ...(input.originRealm ? { originRealm: input.originRealm } : {}) }) };
  const digest = contentDraftIntentDigest(command, input.actingSubject);
  const scope = `content:draft:${input.reply}`;
  const admission = await access.register({ principal, actingSubject: input.actingSubject, action: 'content.draft', scope,
    baselineRelatedWork: input.rootTarget, baselineSourceRevision: input.rootRevision,
    idempotencyKey: key, requestDigest: digest });
  command.operationId = `content-draft:${admission.id}`;
  const creating = input.expectedHead === null && !await content.readDraftReceipt(command.operationId);
  command.provenance = { kind: 'admitted-original-contribution-v1', author: input.actingSubject,
    admissionId: admission.id, authorityEpoch: admission.authorityEpoch, scope, requestDigest: digest,
    expectedHead: input.expectedHead, rightsBasis: 'original-contribution' };
  if (admission.state !== 'sealed') {
    try {
      if (!admission.dispatchEligible) throw new AdmissionDenied('reply draft dispatch is fenced');
      await access.claim(admission.id, digest, principal);
    } catch (error) {
      if (!await content.readDraftReceipt(command.operationId)) {
        await access.recordGraphOutcome(admission.id, await sealContentDraftAdmission(content, admission));
        throw error;
      }
    }
  }
  try { await proveRoot(creating); }
  catch (error) {
    await access.recordGraphOutcome(admission.id, await sealContentDraftAdmission(content, admission));
    throw error;
  }
  let saved;
  try { saved = await content.saveDraft(command); }
  catch (error) {
    if (error instanceof ContentConflict) {
      await access.recordGraphOutcome(admission.id, await sealContentDraftAdmission(content, admission));
    }
    throw error;
  }
  await access.recordGraphOutcome(admission.id, { admissionId: admission.id, requestDigest: digest,
    authorityEpoch: admission.authorityEpoch, scope, receipt: contentDraftReceiptIri(admission.id),
    outcome: saved.outcome === 'succeeded' ? 'succeeded' : 'cancelled',
    dataEpoch: saved.position.dataEpoch, sequence: saved.position.sequence });
  if (saved.outcome === 'stale_head') throw new ContentDraftStale('reply head changed');
  if (saved.outcome !== 'succeeded') throw new AdmissionDenied('reply draft was cancelled');
  return { reply: input.reply, variantId: input.variantId, revisionId: saved.revisionId!,
    revisionDigest: createHash('sha256').update(command.serializedJson).digest('hex'),
    predecessor: saved.predecessor, deleted,
    sourcePosition: saved.position, replayed: admission.replayed || saved.replayed };
}
