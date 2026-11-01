export const subjectReactionKinds = ['like', 'love', 'laugh', 'insightful', 'sad'] as const;
export type ReactionFailure = { ok: false; reason: 'unavailable' };
export type ReactionKind = 'upvote' | 'downvote' | (typeof subjectReactionKinds)[number];
export type ChangeReactionInput = {
  target: 'thread' | 'post' | 'subject';
  id: string;
  kind: ReactionKind | null;
  expectedReader?: string;
};
