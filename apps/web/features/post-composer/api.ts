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
}
export type PostOutcome =
  | { kind: 'posted'; reply: string }
  | { kind: 'refused' }
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
  const keyed = (suffix: string) => ({ headers: { 'idempotency-key': `${step.key}:${suffix}` } });
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
    if (!step.revisionId) {
      const { data } = await draft(false, null, 'draft');
      if (!data) return { kind: 'failed', progress: step };
      step.revisionId = data.revisionId;
      onProgress({ ...step });
    }
    if (!step.identified) {
      const { data } = await main.v1['realm-replies'].post(
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
      if (!data) return { kind: 'failed', progress: step };
      step.identified = true;
      onProgress({ ...step });
    }
    if (!step.digest) {
      const { data } = await main.v1['member-replies']({ reply: step.reply.slice(-36) }).get({
        query: { actingSubject: intent.actingSubject },
      });
      if (!data) return { kind: 'failed', progress: step };
      step.digest = data.revisionDigest;
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
    if (error?.status !== 403) return { kind: 'failed', progress: step };
    // A refused root must not linger as a published reply to its Work.
    await draft(true, step.revisionId, 'withdraw').catch(() => undefined);
    return { kind: 'refused' };
  } catch {
    return { kind: 'failed', progress: step };
  }
}
