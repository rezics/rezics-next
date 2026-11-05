export type DecisionPageAppeal = {
  id: string;
  outcome: 'upheld' | 'reversed' | null;
  statement: string | null;
  resolvedAt: string | null;
};

export type DecisionPageAppealAdvice =
  | { state: 'permitted' }
  | {
      state: 'unavailable';
      reason: 'not_affected_author' | 'already_appealed' | 'deadline_passed' | 'command_unavailable';
    }
  | { state: 'unsupported'; reason: 'board' };

export type DecisionPageTargetContext =
  | { state: 'available'; kind: 'board'; boardId: string; boardTitle: string | null }
  | {
      state: 'available';
      kind: 'thread';
      threadId: string;
      postId: string | null;
      boardId: string;
      threadTitle: string | null;
      boardTitle: string | null;
    }
  | { state: 'concealed' }
  | { state: 'unavailable' };

/** Public response from the exact moderation decision read. */
export type ModerationDecisionPage = {
  id: string;
  targetKind: 'board' | 'thread' | 'post';
  targetId: string;
  action: 'takedown';
  statement: string;
  decidedAt: string;
  appealDeadline: string | null;
  appeal: DecisionPageAppeal | null;
  viewer: {
    affectedAuthor: boolean;
    observedAt: string;
    appeal: DecisionPageAppealAdvice;
  };
  targetContext: DecisionPageTargetContext;
};
