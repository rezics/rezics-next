type PreparedReactionInput = {
  target: 'thread' | 'post' | 'subject';
  id: string;
  kind: 'upvote' | 'downvote' | 'like' | 'love' | 'laugh' | 'insightful' | 'sad' | null;
  expectedReader?: string;
};

export async function changeReaction(_input: PreparedReactionInput): Promise<{ ok: true }> {
  return { ok: true };
}
