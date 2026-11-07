import type { ComponentType, ReactNode } from 'react';

/** Closed reaction vocabulary the profile action host already admits. */
export type ContributionReactionKind = 'upvote' | 'downvote' | 'like' | 'love' | 'laugh' | 'insightful' | 'sad';

export type ContributionCommandLease<Operation extends string = string> = {
  reader: string;
  operation: Operation;
  current: () => boolean;
  credential: () => string | null;
};

export type ContributionWatchOwner = Readonly<{
  threadId: string;
  viewerId: string;
  sessionStamp: string;
  csrfToken?: string;
  isCurrent?: () => boolean;
}>;

export type ContributionWatchNative = {
  read(
    request: ContributionWatchOwner & Readonly<{ fetch: Readonly<{ cache: 'no-store' }> }>,
  ): Promise<{ kind: 'confirmed'; state: { watching: boolean } } | { kind: 'access-lost' | 'unavailable' | 'unknown' }>;
  set(
    command: ContributionWatchOwner & Readonly<{ watching: boolean }>,
  ): Promise<
    { kind: 'confirmed' | 'unknown' } | { kind: 'refused'; reason: 'access-lost' | 'refused' | 'unavailable' }
  >;
};

/** One admitted watch visit. ThreadWatch remains the command owner. */
export type ContributionWatchMount = {
  threadId: string;
  session: string;
  sessionKnown: boolean;
  viewerId: string;
  sessionStamp: string;
  admitted: boolean;
  canStart: () => boolean;
  allowDiscard: boolean;
  initialWatching: boolean;
  returnTo: string;
  readAuthority: object;
  isCurrent: () => boolean;
  refreshAdvice?: () => Promise<void>;
  native?: ContributionWatchNative;
};

export type ContributionReactionChange = {
  target: 'thread' | 'post' | 'subject';
  id: string;
  kind: ContributionReactionKind | null;
  expectedReader?: string;
};

export type ContributionReactionTransport = {
  change(input: {
    data: ContributionReactionChange;
    headers: HeadersInit;
  }): Promise<{ ok: true } | { ok: false; reason: string; retryAfter?: number }>;
  read(input: { data: ContributionReactionChange; headers: HeadersInit }): Promise<
    | {
        ok: true;
        value: ContributionReactionKind | null;
        counts: Partial<Record<ContributionReactionKind, number>>;
        reactionsAsOf?: { epoch: number; position: string };
      }
    | { ok: false; reason: string; retryAfter?: number }
  >;
};

/** One admitted reaction visit. ThreadReactions remains the command owner. */
export type ContributionReactionMount = {
  target: { kind: 'thread' | 'post'; id: string };
  counts: Partial<Record<ContributionReactionKind, number>>;
  value: ContributionReactionKind | null;
  signedIn: boolean;
  personalReady: boolean;
  readAuthority: object;
  canStart: boolean;
  allowDiscard: boolean;
  returnTo: string;
  locale: string;
  optimistic: boolean;
  settleWithRead: boolean;
  reactionOrigin: { key: string; reader: string | null; isCurrent(): boolean };
  sourceWatermark?: { epoch: number; position: string };
  onDiscard?: () => void;
  onMutation?: () => Promise<void>;
  preparedTransport?: ContributionReactionTransport;
};

export type ContributionReplyCommand<Context = unknown> = {
  title: string;
  body: unknown;
  mediaIds: string[];
  idempotencyKey: string;
  parentId?: string;
  submissionContext?: Context;
};

/** One admitted reply visit. PostComposer remains the draft and uncertain-command owner. */
export type ContributionReplyMount<Context = unknown> = {
  initialKey: string;
  localDraft: boolean;
  canSubmit: boolean;
  canStart: boolean;
  containerId: string;
  boardId: string;
  replyTargetId: string;
  submissionContext: Context;
  replyContext: ReactNode;
  credential: () => string | null;
  canDispatch: (command: ContributionReplyCommand<Context>) => boolean;
  onPendingChange: (pending: boolean) => void;
  onIntentLockChange: (locked: boolean) => void;
  onSuccess: () => void;
};

export type ThreadContributionActions = {
  Watch: ComponentType<ContributionWatchMount>;
  Reaction: ComponentType<ContributionReactionMount>;
  Reply: ComponentType<ContributionReplyMount>;
};
