import { direction } from '@rezics/main/language';
import { browserMainApi } from '../api/browser.ts';
import { bodyInput, bodyText } from '../document-editor/body.ts';
import type { MainClient } from './types.ts';

// Replying in a Realm thread through the BFF, as the session's Agent. Main
// takes a reply in four steps: the body as a Content draft, the reply's
// identity under its parent, the exact revision's digest, then its placement
// in the Realm. Each step has its own idempotency key derived from one intent,
// so "Try again" resumes where a lost response left off instead of posting twice.

export interface ReplyInput {
  realm: string;
  work: string;
  rootRevision: string;
  /** The reply answered, and the exact revision of it the reader saw. */
  parent: { reply: string; revisionId: string };
  /** The language the writer chose for the reply; never the interface locale. */
  body: string;
  language: string;
  /** The author's spoiler declaration, when the writer set the control. */
  spoiler?: boolean;
  actingSubject: string;
}

/** What one intent has done so far; the composer keeps it across retries. */
export interface ReplyProgress {
  key: string;
  reply: string;
  variantId: string;
  /** Canonical origin inherited from the exact parent reply; null for independent replies. */
  originRealm?: string | null;
  /** Missing on saved intents whose draft payload predates parent-origin binding. */
  originVersion?: 1;
  /** The draft request was sent, even if its response did not provide a revision ID. */
  draftStarted?: boolean;
  revisionId?: string;
  identified?: boolean;
  digest?: string;
}

export type ReplyOutcome =
  | { kind: 'placed'; reply: string; placement: string }
  /** The Realm would not place it: it needs a moderator or membership. The draft is withdrawn. */
  | { kind: 'refused' }
  | { kind: 'failed'; progress: ReplyProgress };

export interface ThreadApi {
  reply(input: ReplyInput, progress: ReplyProgress): Promise<ReplyOutcome>;
  /** Takes back a reply that was saved but never placed, so it does not linger as a public reply to the Work. */
  withdraw(input: ReplyInput, progress: ReplyProgress): Promise<void>;
}

export function replyProgress(): ReplyProgress {
  return {
    key: crypto.randomUUID(),
    reply: `https://rezics.com/id/${crypto.randomUUID()}`,
    variantId: `urn:rezics:variant:${crypto.randomUUID()}`,
    originVersion: 1,
  };
}

export function mainThreadApi(main: () => MainClient = browserMainApi): ThreadApi {
  const headers = (key: string, step: string) => ({
    headers: { 'idempotency-key': `${key}:${step}` },
  });
  const draft = (
    input: ReplyInput,
    step: ReplyProgress,
    body: string | null,
    expectedHead: string | null,
    name: string,
  ) =>
    main().v1['member-reply-drafts'].post(
      {
        profile: 'member-reply-draft-v1',
        reply: step.reply,
        variantId: step.variantId,
        rootTarget: input.work,
        rootRevision: input.rootRevision,
        ...(step.originRealm !== undefined ? { originRealm: step.originRealm } : {}),
        language: input.language,
        direction: direction(input.language, bodyText(body ?? input.body)),
        expectedHead,
        ...(input.spoiler !== undefined ? { spoiler: input.spoiler } : {}),
        ...(body === null ? { body: null } : bodyInput(body)),
        actingSubject: input.actingSubject,
      },
      headers(step.key, name),
    );
  const withdraw = async (input: ReplyInput, step: ReplyProgress) => {
    if (step.revisionId)
      await draft(input, step, null, step.revisionId, 'withdraw').catch(() => undefined);
  };
  return {
    withdraw,
    async reply(input, progress) {
      const api = main().v1;
      let step = { ...progress };
      try {
        if (step.originRealm === undefined) {
          const { data } = await api['member-replies']({ reply: input.parent.reply.slice(-36) }).get({
            query: { actingSubject: input.actingSubject },
          });
          if (!data) return { kind: 'failed', progress: step };
          const parentOriginRealm = data.originRealm ?? null;
          const legacyNullOrigin = step.originVersion !== 1;
          // Recover legacy writes with the original null-origin payload before
          // changing their intent. The old key cannot be replayed with a Realm origin.
          if (legacyNullOrigin && (!step.revisionId || (!parentOriginRealm && !step.digest))) {
            step.draftStarted = true;
            const { data: recovered } = await draft(input, step, input.body, null, 'draft');
            if (!recovered || (step.revisionId && recovered.revisionId !== step.revisionId))
              return { kind: 'failed', progress: step };
            step.revisionId = recovered.revisionId;
            step.digest = recovered.revisionDigest;
          }
          if (step.revisionId && (legacyNullOrigin
            ? parentOriginRealm !== null
            : (step.originRealm ?? null) !== parentOriginRealm)) {
            await withdraw(input, step);
            step = replyProgress();
          }
          step.originRealm = parentOriginRealm;
          step.originVersion = 1;
        }
        if (!step.revisionId) {
          step.draftStarted = true;
          const { data, error } = await draft(input, step, input.body, null, 'draft');
          if (!data && error?.status === 403) {
            await withdraw(input, step);
            return { kind: 'refused' };
          }
          if (!data) return { kind: 'failed', progress: step };
          step.revisionId = data.revisionId;
          step.digest = data.revisionDigest;
        } else if (!step.digest) {
          // Same-key replay recovers the digest from older saved progress.
          step.draftStarted = true;
          const { data, error } = await draft(input, step, input.body, null, 'draft');
          if (!data && error?.status === 403) {
            await withdraw(input, step);
            return { kind: 'refused' };
          }
          if (!data || data.revisionId !== step.revisionId)
            return { kind: 'failed', progress: step };
          step.digest = data.revisionDigest;
        }
        if (!step.identified) {
          const { data, error } = await api['realm-replies'].post(
            {
              profile: 'realm-reply-identity-v1',
              reply: step.reply,
              variantId: step.variantId,
              revisionId: step.revisionId,
              author: input.actingSubject,
              rootTarget: input.work,
              rootRevision: input.rootRevision,
              parentReply: input.parent.reply,
              parentRevision: input.parent.revisionId,
              contextRevision: null,
              ...(input.spoiler !== undefined ? { spoiler: input.spoiler } : {}),
            },
            headers(step.key, 'identity'),
          );
          if (!data && error?.status === 403) {
            await withdraw(input, step);
            return { kind: 'refused' };
          }
          if (!data) return { kind: 'failed', progress: step };
          step.identified = true;
        }
        const { data, error } = await api['realm-reply-placements'].post(
          {
            profile: 'realm-reply-placement-v1',
            realm: input.realm,
            reply: step.reply,
            revisionId: step.revisionId,
            revisionDigest: step.digest,
            reviewDecisionId: null,
            expectedHead: null,
            actingSubject: input.actingSubject,
          },
          headers(step.key, 'place'),
        );
        if (data) return { kind: 'placed', reply: data.reply, placement: data.placement };
        if (error?.status !== 403) return { kind: 'failed', progress: step };
        // Nothing places it here, so it must not linger as a public reply to the Work.
        await withdraw(input, step);
        return { kind: 'refused' };
      } catch {
        return { kind: 'failed', progress: step };
      }
    },
  };
}
