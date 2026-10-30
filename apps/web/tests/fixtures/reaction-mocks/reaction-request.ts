export const subjectReactionKinds = ['like', 'love', 'laugh', 'insightful', 'sad'] as const;
export type ReactionFailure = { ok: false; reason: 'unavailable' };
