import { direction } from '@rezics/main/language';
import { browserMainApi } from '../api/browser.ts';
import { UNSPECIFIED } from '../content-language/writing-language.ts';

export interface PostIntent { realm: string; work: string; mainVersion: string;
  title: string; body: string; spoiler: boolean;
  /** The language the writer chose; never the interface locale. */
  language: string; actingSubject: string }
export interface PostProgress { key: string; reply: string; variantId: string;
  rootRevision?: string; revisionId?: string; identified?: boolean; digest?: string }
export type PostOutcome = { kind: 'posted'; reply: string } | { kind: 'refused' }
  | { kind: 'failed'; progress: PostProgress };

export function newPostProgress(): PostProgress {
  return { key: crypto.randomUUID(), reply: `https://rezics.com/id/${crypto.randomUUID()}`,
    variantId: `urn:rezics:variant:${crypto.randomUUID()}` };
}

/** One post is a root Realm reply; each durable step uses a key from the same intent. */
export async function submitPost(intent: PostIntent, original: PostProgress,
  onProgress: (progress: PostProgress) => void,
  main = browserMainApi()): Promise<PostOutcome> {
  const step = { ...original };
  const keyed = (suffix: string) => ({ headers: { 'idempotency-key': `${step.key}:${suffix}` } });
  const text = `${intent.spoiler ? 'Spoilers: ' : ''}${intent.title.trim()}\n${intent.body.trim()}`.trim();
  try {
    if (!step.rootRevision) {
      const { data } = await main.v1['main-versions']({ mainVersion: intent.mainVersion.slice(-36) })
        .selection.get({ query: intent.language === UNSPECIFIED ? {} : { language: intent.language } });
      if (!data || data.work !== intent.work) return { kind: 'failed', progress: step };
      step.rootRevision = data.selectedDraft;
      onProgress({ ...step });
    }
    const draft = (body: string | null, expectedHead: string | null, suffix: string) =>
      main.v1['member-reply-drafts'].post({ profile: 'member-reply-draft-v1',
        reply: step.reply, variantId: step.variantId, rootTarget: intent.work,
        rootRevision: step.rootRevision!, originRealm: intent.realm,
        language: intent.language, direction: direction(intent.language, text), expectedHead, body,
        actingSubject: intent.actingSubject }, keyed(suffix));
    if (!step.revisionId) {
      const { data } = await draft(text, null, 'draft');
      if (!data) return { kind: 'failed', progress: step };
      step.revisionId = data.revisionId;
      onProgress({ ...step });
    }
    if (!step.identified) {
      const { data } = await main.v1['realm-replies'].post({ profile: 'realm-reply-identity-v1',
        reply: step.reply, variantId: step.variantId, revisionId: step.revisionId,
        author: intent.actingSubject, rootTarget: intent.work, rootRevision: step.rootRevision,
        parentReply: null, parentRevision: null, contextRevision: null }, keyed('identity'));
      if (!data) return { kind: 'failed', progress: step };
      step.identified = true;
      onProgress({ ...step });
    }
    if (!step.digest) {
      const { data } = await main.v1['member-replies']({ reply: step.reply.slice(-36) })
        .get({ query: { actingSubject: intent.actingSubject } });
      if (!data) return { kind: 'failed', progress: step };
      step.digest = data.revisionDigest;
      onProgress({ ...step });
    }
    const { data, error } = await main.v1['realm-reply-placements'].post({
      profile: 'realm-reply-placement-v1', realm: intent.realm, reply: step.reply,
      revisionId: step.revisionId, revisionDigest: step.digest,
      reviewDecisionId: null, expectedHead: null, actingSubject: intent.actingSubject }, keyed('place'));
    if (data) return { kind: 'posted', reply: data.reply };
    if (error?.status !== 403) return { kind: 'failed', progress: step };
    // A refused root must not linger as a published reply to its Work.
    await draft(null, step.revisionId, 'withdraw').catch(() => undefined);
    return { kind: 'refused' };
  } catch { return { kind: 'failed', progress: step }; }
}
