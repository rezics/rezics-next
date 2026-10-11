import { direction } from '@rezics/main/language';
import {
  documentText,
  fromMarkdown,
  identifiableNodeNames,
  normalizeDocument,
  parseStoredDocument,
  withDocumentIds,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import { browserMainApi } from '../api/browser.ts';
import { banSchedule } from '../realm-appeal/view.ts';

/** `work` is the resource the post is about: a Work (named with its `mainVersion`, whose selected draft roots the
 *  post) or any other target (named with the `revision` its page gave, which roots the post itself). */
export interface PostIntent {
  realm: string;
  work: string;
  mainVersion: string | null;
  revision?: string;
  title: string;
  body: string;
  spoiler: boolean;
  /** The language the writer chose; never the interface locale. */
  language: string;
  actingSubject: string;
}
export interface PostProgress {
  key: string;
  reply: string;
  variantId: string;
  rootRevision?: string;
  revisionId?: string;
  identified?: boolean;
  digest?: string;
  /** A confirmed refusal seals this attempt. The next Post needs a new operation key. */
  restartRequired?: true;
}
export type PostOutcome =
  | { kind: 'posted'; reply: string }
  | { kind: 'refused' }
  | { kind: 'banned'; progress: PostProgress }
  | { kind: 'failed'; progress: PostProgress };

export function newPostProgress(): PostProgress {
  return {
    key: crypto.randomUUID(),
    reply: `https://rezics.com/id/${crypto.randomUUID()}`,
    variantId: `urn:rezics:variant:${crypto.randomUUID()}`,
  };
}

/** Keep the writer's title as the first text unit without flattening the body. Spoilers are a separate declaration. */
export function postDocument(intent: PostIntent, progress: PostProgress): DocumentSnapshot {
  const stored = parseStoredDocument(intent.body);
  const source = stored ?? fromMarkdown(intent.body.trim(), 'blocks');
  let index = 0;
  const imported = (node: DocumentNode): DocumentNode => ({
    ...node,
    ...(identifiableNodeNames.has(node.type)
      ? { attrs: { ...node.attrs, id: `${progress.key}-body-${index++}` } }
      : {}),
    ...(node.content ? { content: node.content.map(imported) } : {}),
  });
  // Import IDs are derived from the operation key, so a lost draft response retries identical content.
  const body = stored ? source.doc : imported(source.doc);
  const title = intent.title.trim();
  return normalizeDocument({
    ...source,
    profile: 'blocks',
    doc: withDocumentIds(
      {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { id: `${progress.key}-title`, level: 1 },
            content: [{ type: 'text', text: title }],
          },
          ...(body.content ?? []),
        ],
      },
      () => `${progress.key}-new-${index++}`,
    ),
  });
}

/** One post is a root Realm reply; each durable step uses a key from the same intent. */
export async function submitPost(
  intent: PostIntent,
  original: PostProgress,
  onProgress: (progress: PostProgress) => void,
  main = browserMainApi(),
): Promise<PostOutcome> {
  const step = { ...original };
  if (step.restartRequired) {
    step.key = crypto.randomUUID();
    delete step.restartRequired;
    onProgress({ ...step });
  }
  const keyed = (suffix: string) => ({ headers: { 'idempotency-key': `${step.key}:${suffix}` } });
  const refuseAttempt = () => {
    step.restartRequired = true;
    onProgress({ ...step });
  };
  const terminalRefusal = (error: { status?: number; value?: unknown } | undefined) => {
    if (error?.status === 403) return true;
    const value = error?.value;
    return (
      error?.status === 409 &&
      typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof value.code === 'string' &&
      ['stale_head', 'content_conflict', 'realm_reply_stale'].includes(value.code)
    );
  };
  const banned = async (status: number | undefined): Promise<boolean> => {
    if (status !== 403) return false;
    // A generic denial does not identify its cause. Only the member's own ban read can.
    try {
      const { data } = await main.v1.realms({ realm: intent.realm.slice(-36) })['member-ban'].get({
        query: { actingSubject: intent.actingSubject },
      });
      return (
        !!data &&
        data.realm === intent.realm &&
        !(data.appeal.state === 'decided' && data.appeal.outcome === 'reversed') &&
        banSchedule(data, Date.now()) !== 'ended'
      );
    } catch {
      return false;
    }
  };
  try {
    const document = postDocument(intent, step);
    const text = documentText(document);
    if (!step.rootRevision) {
      if (intent.revision) step.rootRevision = intent.revision;
      else if (intent.mainVersion) {
        // The post's root is the Work's own default revision; the language written in has no say in which.
        const { data } = await main.v1['main-versions']({
          mainVersion: intent.mainVersion.slice(-36),
        }).selection.get({ query: {} });
        if (!data || data.work !== intent.work) return { kind: 'failed', progress: step };
        step.rootRevision = data.selectedDraft;
      } else return { kind: 'failed', progress: step };
      onProgress({ ...step });
    }
    const draft = (deleted: boolean, expectedHead: string | null, suffix: string) =>
      main.v1['member-reply-drafts'].post(
        {
          profile: 'member-reply-draft-v1',
          reply: step.reply,
          variantId: step.variantId,
          rootTarget: intent.work,
          rootRevision: step.rootRevision!,
          originRealm: intent.realm,
          language: intent.language,
          direction: direction(intent.language, text),
          spoiler: intent.spoiler,
          expectedHead,
          ...(deleted ? { body: null } : { document }),
          actingSubject: intent.actingSubject,
        },
        keyed(suffix),
      );
    if (!step.revisionId || !step.digest) {
      // Replay also recovers older saved progress that retained the revision without its digest.
      const { data, error } = await draft(false, null, 'draft');
      if (!data) {
        // A denied new draft can be sealed as cancelled. A known successful revision
        // still needs its original receipt when recovering a missing digest.
        if (terminalRefusal(error) && !step.revisionId) refuseAttempt();
        return { kind: (await banned(error?.status)) ? 'banned' : 'failed', progress: step };
      }
      if (step.revisionId && step.revisionId !== data.revisionId)
        return { kind: 'failed', progress: step };
      step.revisionId = data.revisionId;
      step.digest = data.revisionDigest;
      onProgress({ ...step });
    }
    if (!step.identified) {
      const { data, error } = await main.v1['realm-replies'].post(
        {
          profile: 'realm-reply-identity-v1',
          reply: step.reply,
          variantId: step.variantId,
          revisionId: step.revisionId,
          author: intent.actingSubject,
          rootTarget: intent.work,
          rootRevision: step.rootRevision,
          parentReply: null,
          parentRevision: null,
          contextRevision: null,
          spoiler: intent.spoiler,
        },
        keyed('identity'),
      );
      if (!data) {
        if (terminalRefusal(error)) refuseAttempt();
        return { kind: (await banned(error?.status)) ? 'banned' : 'failed', progress: step };
      }
      step.identified = true;
      onProgress({ ...step });
    }
    const { data, error } = await main.v1['realm-reply-placements'].post(
      {
        profile: 'realm-reply-placement-v1',
        realm: intent.realm,
        reply: step.reply,
        revisionId: step.revisionId,
        revisionDigest: step.digest,
        reviewDecisionId: null,
        expectedHead: null,
        actingSubject: intent.actingSubject,
      },
      keyed('place'),
    );
    if (data) return { kind: 'posted', reply: data.reply };
    if (terminalRefusal(error)) refuseAttempt();
    if (await banned(error?.status)) return { kind: 'banned', progress: step };
    if (error?.status !== 403) return { kind: 'failed', progress: step };
    // A refused root must not linger as a published reply to its Work.
    await draft(true, step.revisionId, 'withdraw').catch(() => undefined);
    return { kind: 'refused' };
  } catch {
    return { kind: 'failed', progress: step };
  }
}
