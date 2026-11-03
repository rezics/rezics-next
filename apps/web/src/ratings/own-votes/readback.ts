import type { KernelClient } from '@rezics/client';

export type OwnVoteReadback =
  | { kind: 'current'; units: number; revision: number; at: string }
  | { kind: 'cleared' }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

/** Read exactly the original Subject/question pair. A public figure never participates. */
export async function readOriginalOwnVote(
  client: KernelClient,
  authorization: string,
  targetId: string,
  questionId: string,
  after: 'PUT' | 'DELETE' | 'REVIEW',
): Promise<OwnVoteReadback> {
  try {
    const result = await client.subjects({ id: targetId }).ratings({ questionId }).vote.get({
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (result.status === 404) return after === 'DELETE' ? { kind: 'cleared' } : { kind: 'missing' };
    if (result.status !== 200 || !result.data) return { kind: 'unavailable' };
    const { units, revision, at } = result.data;
    return Number.isSafeInteger(units) && Number.isSafeInteger(revision) && typeof at === 'string'
      ? { kind: 'current', units, revision, at }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

export function commandOutcome(status: number, error: unknown): 'acknowledged' | 'rejected' | 'uncertain' {
  if (status === 200 || status === 204) return 'acknowledged';
  if (status === 0 || status >= 500 || error instanceof TypeError) return 'uncertain';
  return 'rejected';
}
