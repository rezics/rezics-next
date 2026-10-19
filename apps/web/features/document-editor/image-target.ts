import type { browserMainApi } from '../api/browser.ts';

type DraftOperation = ReturnType<typeof browserMainApi>['v1']['member-reply-drafts']['post'];
type DraftInput = Parameters<DraftOperation>[0];
type DraftReceipt = NonNullable<Awaited<ReturnType<DraftOperation>>['data']>;

/** Only the acknowledged Content receipt can supply the reply's current image basis. */
export type ReplyImageDraft = Pick<DraftReceipt, 'reply' | 'variantId' | 'revisionId'>
  & Pick<DraftInput, 'rootTarget' | 'rootRevision'>;
export type ImageUseTarget = string | {
  /** The opening document's Uses belong to this same persisted reply draft. */
  retained: boolean;
  prepare: () => Promise<ReplyImageDraft>;
};

/** Member images use the authoring reply, while ordinary Work images retain their publish operation. */
export async function imageUseTarget(target: ImageUseTarget) {
  if (typeof target === 'string') return { target };
  const draft = await target.prepare();
  return {
    target: draft.reply,
    memberReplyDraft: {
      profile: 'member-reply-draft-image-v1' as const,
      variantId: draft.variantId,
      expectedHead: draft.revisionId,
      rootTarget: draft.rootTarget,
      rootRevision: draft.rootRevision,
    },
  };
}

/** The typed public operation owns the common command and, when composed, the optional reply basis. */
export function imageUseCommand(command: Awaited<ReturnType<typeof imageUseTarget>> & {
  actingSubject: string; representation: string; occurrence: string; conceal: boolean;
}) {
  const input: Parameters<ReturnType<typeof browserMainApi>['v1']['media']['uses']['post']>[0] = command;
  return input;
}
