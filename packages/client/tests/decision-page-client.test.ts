import { expect, expectTypeOf, test } from 'bun:test';
import { createKernelClient, type KernelClient, type ModerationDecisionPage } from '../src/index.ts';

type DecisionPageRead = Awaited<ReturnType<ReturnType<KernelClient['moderation-decisions']>['get']>>['data'];

expectTypeOf<DecisionPageRead>().toEqualTypeOf<ModerationDecisionPage | null>();

const populated: ModerationDecisionPage = {
  id: 'decision-1',
  targetKind: 'post',
  targetId: 'post-1',
  action: 'takedown',
  statement: 'Retained decision statement',
  decidedAt: '2026-11-04T00:00:00.000Z',
  appealDeadline: '2027-05-06T00:00:00.000Z',
  appeal: null,
  viewer: {
    affectedAuthor: true,
    observedAt: '2026-11-04T00:00:00.000Z',
    appeal: { state: 'permitted' },
  },
  targetContext: {
    state: 'available',
    kind: 'thread',
    threadId: 'thread-1',
    postId: 'post-1',
    boardId: 'board-1',
    threadTitle: 'Thread title',
    boardTitle: 'Board title',
  },
};

test('the installed client returns available, concealed and unavailable target context', async () => {
  const pages = [
    populated,
    { ...populated, targetContext: { state: 'concealed' } },
    { ...populated, targetContext: { state: 'unavailable' } },
  ] satisfies ModerationDecisionPage[];
  let index = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://kernel.test/v1/moderation-decisions/decision-1');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-token');
    return Response.json(pages[index++]);
  }) as typeof globalThis.fetch;
  const client = createKernelClient('https://kernel.test', { fetch });

  for (const page of pages) {
    const result = await client['moderation-decisions']({ id: 'decision-1' }).get({
      headers: { authorization: 'Bearer access-token' },
    });
    expect(result.error).toBeNull();
    expect(result.data).toEqual(page);
  }
});
