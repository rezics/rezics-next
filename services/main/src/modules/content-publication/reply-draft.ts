import { ContentConflict, contentDraftIntentDigest, type ContentCore,
  type SaveDraftCommand } from '../../../../content/src/core.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { publicReplyRoot } from '../realm-reply/root.ts';
import { readRealmPolicy } from '../space/policy.ts';
import { ContentDraftStale, contentDraftReceiptIri, sealContentDraftAdmission } from './draft.ts';

export const MEMBER_REPLY_COST = { bodyBytes: 8192, pageSize: 32,
  graphQueries: 7, graphResponseBytes: 16_384, ownerRowLocks: 12 } as const;
export interface MemberReplyDraft {
  originRealm?: string | null;
  reply: string; variantId: string; rootTarget: string; rootRevision: string;
  language: string; direction: 'ltr' | 'rtl' | 'none'; expectedHead: string | null;
  body: string | null; actingSubject: string;
}

/** The author/root binding and every edit/delete use Content's draft CAS and
 * immutable receipts. Deletion is a tombstone revision; retained history and
 * moderation evidence remain intact. A later edit never inherits Realm review. */
export async function saveMemberReplyDraft(env: WorkActivationEnvironment, content: ContentCore,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>
    & Partial<Pick<AccessAdmissionRegistry, 'withRealmPolicy'>>,
  request: Request, input: MemberReplyDraft, key: string, admittedOrigin = false): Promise<{
    reply: string; variantId: string; revisionId: string; predecessor: string | null; deleted: boolean;
    sourcePosition: { dataEpoch: string; sequence: string }; replayed: boolean }> {
  const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
  if (![input.reply, input.rootTarget, input.rootRevision, input.actingSubject].every(value => native.test(value))
    || input.originRealm != null && !native.test(input.originRealm)
    || !/^urn:rezics:variant:[0-9a-f-]{36}$/.test(input.variantId)
    || (input.body === null ? input.expectedHead === null : !input.body || Buffer.byteLength(input.body, 'utf8') > MEMBER_REPLY_COST.bodyBytes)) {
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
  if (!await publicReplyRoot(env.fuseki, input.rootTarget, input.rootRevision)) throw new AdmissionDenied('reply root is not public');
  const command: SaveDraftCommand = { operationId: '', variant: { id: input.variantId,
    resourceId: input.reply, language: { kind: 'tag', tag: input.language, originalTag: input.language },
    direction: input.direction }, expectedHead: input.expectedHead, model: 'member-reply-v1',
    sourceRevision: input.rootRevision, provenance: {}, serializedJson: JSON.stringify({ body: input.body ?? '',
      deleted: input.body === null, rootTarget: input.rootTarget, rootRevision: input.rootRevision,
      ...(input.originRealm ? { originRealm: input.originRealm } : {}) }) };
  const digest = contentDraftIntentDigest(command, input.actingSubject);
  const scope = `content:draft:${input.reply}`;
  const admission = await access.register({ principal, actingSubject: input.actingSubject, action: 'content.draft', scope,
    baselineRelatedWork: input.rootTarget, baselineSourceRevision: input.rootRevision,
    idempotencyKey: key, requestDigest: digest });
  command.operationId = `content-draft:${admission.id}`;
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
  if (!await publicReplyRoot(env.fuseki, input.rootTarget, input.rootRevision)) {
    await access.recordGraphOutcome(admission.id, await sealContentDraftAdmission(content, admission));
    throw new AdmissionDenied('reply root changed');
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
    predecessor: saved.predecessor, deleted: input.body === null,
    sourcePosition: saved.position, replayed: admission.replayed || saved.replayed };
}
