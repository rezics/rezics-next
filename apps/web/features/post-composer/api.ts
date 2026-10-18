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
import { gateFor, type OperationGate } from '../api/platform-access.ts';

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
  /** Persisted before dispatch. Missing on old drafts, whose unacknowledged writes are uncertain. */
  writeState?: 'none' | 'acknowledged' | 'unknown';
  pendingStep?: 'draft' | 'identity' | 'place';
  /** A confirmed refusal seals this attempt. The next Post needs a new operation key. */
  restartRequired?: true;
}

export function postWriteState(progress: PostProgress | null): 'none' | 'acknowledged' | 'unknown' {
  if (!progress) return 'none';
  if (progress.writeState === 'unknown') return 'unknown';
  if (progress.revisionId || progress.identified) return 'acknowledged';
  return progress.writeState ?? (progress.restartRequired ? 'none' : 'unknown');
}
export type PostOutcome =
  | { kind: 'posted'; reply: string }
  | { kind: 'refused' }
  | { kind: 'banned'; progress: PostProgress }
  | { kind: 'failed'; progress: PostProgress };

const projectionReadAttempts = 3;
const projectionReadDelayMs = 250;

async function placedReplyIsVisible(
  realm: string,
  reply: string,
  actingSubject: string,
  main: ReturnType<typeof browserMainApi>,
): Promise<boolean> {
  for (let attempt = 0; attempt < projectionReadAttempts; attempt++) {
    try {
      const threads = main.v1.realms({ realm: realm.slice(-36) }).threads;
      if (typeof threads !== 'function') return false;
      const { data } = await threads({ reply: reply.slice(-36) }).get({
        query: { actingSubject },
      });
      if (data) return true;
    } catch {
      // Placement is already confirmed. A lagging or unavailable read only delays navigation.
    }
    if (attempt + 1 < projectionReadAttempts)
      await new Promise<void>((resolve) => setTimeout(resolve, projectionReadDelayMs));
  }
  return false;
}

export function newPostProgress(): PostProgress {
  return {
    writeState: 'none',
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
  onPlaced?: (reply: string) => void,
  onProjection?: (visible: boolean) => void,
  operationOpen: OperationGate = gateFor(null),
): Promise<PostOutcome> {
  const step = { ...original };
  if (step.restartRequired) {
    step.key = crypto.randomUUID();
    delete step.restartRequired;
    onProgress({ ...step });
  }
  const keyed = (suffix: string) => ({ headers: { 'idempotency-key': `${step.key}:${suffix}` } });
  const beforeWrite = (pendingStep: NonNullable<PostProgress['pendingStep']>) => {
    const pending: PostProgress = { ...step, writeState: 'unknown', pendingStep };
    // The caller must finish the device write before a request can leave the browser.
    onProgress(pending);
    Object.assign(step, pending);
  };
  const acknowledged = () => {
    step.writeState = 'acknowledged';
    delete step.pendingStep;
    onProgress({ ...step });
  };
  const refuseAttempt = () => {
    step.restartRequired = true;
    step.writeState = step.revisionId ? 'acknowledged' : 'none';
    delete step.pendingStep;
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
    if (operationOpen('getV1RealmsByRealmMember-ban')) {
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
    }
    return false;
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
      beforeWrite('draft');
      const { data, error } = await draft(false, null, 'draft');
      if (!data) {
        // A denied new draft can be sealed as cancelled. A known successful revision
        // still needs its original receipt when recovering a missing digest.
        if (terminalRefusal(error) && !step.revisionId) refuseAttempt();
        return { kind: (await banned(error?.status)) ? 'banned' : 'failed', progress: step };
      }
      if (step.revisionId && step.revisionId !== data.revisionId) {
        // A mismatched replay is no receipt for this draft. Retain its last trusted revision.
        onProgress({ ...original });
        return { kind: 'failed', progress: original };
      }
      step.revisionId = data.revisionId;
      step.digest = data.revisionDigest;
      acknowledged();
    }
    if (!step.identified) {
      beforeWrite('identity');
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
      acknowledged();
    }
    beforeWrite('place');
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
    if (data) {
      // Navigation and projection reads follow the authoritative receipt, even if device storage fails.
      step.writeState = 'acknowledged';
      delete step.pendingStep;
      try { onProgress({ ...step }); } catch { /* The pending same-key retry is still durable. */ }
      try {
        onPlaced?.(data.reply);
      } catch {
        // A UI callback cannot undo the placement receipt.
      }
      const visible = await placedReplyIsVisible(
        intent.realm,
        data.reply,
        intent.actingSubject,
        main,
      ).catch(() => false);
      try {
        onProjection?.(visible);
      } catch {
        // A UI callback cannot change the placement outcome.
      }
      return { kind: 'posted', reply: data.reply };
    }
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
