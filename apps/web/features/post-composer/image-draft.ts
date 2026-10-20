import { documentText } from '@rezics/document';
import { direction } from '@rezics/main/language';
import { browserMainApi } from '../api/browser.ts';
import type { ReplyImageDraft } from '../document-editor/image-target.ts';
import { newPostProgress, postDocument, postWriteState, type PostIntent, type PostProgress } from './api.ts';

/** Authoring has no Realm identity or placement. Its receipt must survive independently of publication. */
export interface PostImageDraft {
  intent: PostIntent;
  progress: PostProgress;
}

export function sameImageDraftContext(intent: PostIntent, record: Pick<PostImageDraft, 'intent'> | null | undefined) {
  const saved = record?.intent;
  return !!saved && saved.actingSubject === intent.actingSubject && saved.realm === intent.realm
    && saved.work === intent.work && saved.mainVersion === intent.mainVersion
    && saved.revision === intent.revision && saved.language === intent.language;
}

/** Obtain Content's native reply/head before any image write; an uncertain request replays byte for byte. */
export async function preparePostImageDraft(
  intent: PostIntent,
  stored: PostImageDraft | null,
  persist: (record: PostImageDraft) => void,
  main = browserMainApi(),
): Promise<ReplyImageDraft> {
  const record = stored && sameImageDraftContext(intent, stored)
    ? { intent: stored.intent, progress: { ...stored.progress } }
    : { intent, progress: newPostProgress() };
  const step = record.progress;
  const basis = (): ReplyImageDraft => ({ reply: step.reply, variantId: step.variantId,
    revisionId: step.revisionId!, rootTarget: record.intent.work, rootRevision: step.rootRevision!,
    originRealm: record.intent.realm });
  if (step.revisionId && step.rootRevision && postWriteState(step) === 'acknowledged') return basis();
  if (postWriteState(step) === 'none') {
    record.intent = intent;
    if (step.restartRequired) { step.key = crypto.randomUUID(); delete step.restartRequired; }
  }
  const source = record.intent;
  if (!step.rootRevision) {
    if (source.revision) step.rootRevision = source.revision;
    else if (source.mainVersion) {
      const { data } = await main.v1['main-versions']({ mainVersion: source.mainVersion.slice(-36) }).selection.get({ query: {} });
      if (!data || data.work !== source.work) throw new Error('image-draft-unavailable');
      step.rootRevision = data.selectedDraft;
    } else throw new Error('image-draft-unavailable');
  }
  const document = postDocument(source, step);
  const pending: PostImageDraft = { intent: source, progress: { ...step, writeState: 'unknown', pendingStep: 'draft' } };
  // A synchronous device receipt precedes dispatch; failure leaves every owner untouched.
  persist(pending);
  Object.assign(step, pending.progress);
  const { data, error } = await main.v1['member-reply-drafts'].post({
    profile: 'member-reply-draft-v1', reply: step.reply, variantId: step.variantId,
    rootTarget: source.work, rootRevision: step.rootRevision!, originRealm: source.realm,
    language: source.language, direction: direction(source.language, documentText(document)),
    spoiler: source.spoiler, expectedHead: null, document, actingSubject: source.actingSubject,
  }, { headers: { 'idempotency-key': `${step.key}:draft` } });
  if (!data) {
    if (error?.status === 403) {
      step.writeState = 'none'; step.restartRequired = true; delete step.pendingStep;
      persist({ intent: source, progress: { ...step } });
    }
    throw new Error('image-draft-unavailable');
  }
  if (data.reply !== step.reply || data.variantId !== step.variantId || data.deleted
    || !/^[0-9a-f-]{36}$/.test(data.revisionId) || !data.revisionDigest)
    throw new Error('image-draft-receipt-mismatch');
  step.revisionId = data.revisionId;
  step.digest = data.revisionDigest;
  step.writeState = 'acknowledged'; delete step.pendingStep;
  persist({ intent: source, progress: { ...step } });
  return basis();
}
