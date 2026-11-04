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

test('the installed appeal command sends the statement and request credentials', async () => {
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://kernel.test/v1/moderation-decisions/decision-1:appeal');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ statement: 'Please reconsider' });
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('idempotency-key')).toBe('appeal-key');
    return Response.json({ id: 'appeal-1' }, { status: 201 });
  }) as typeof globalThis.fetch;
  const client = createKernelClient('https://kernel.test', { fetch });
  const result = await client['moderation-decisions']({ id: 'decision-1' }).$appeal.post(
    { statement: 'Please reconsider' },
    { headers: { authorization: 'Bearer access-token', 'idempotency-key': 'appeal-key' } },
  );
  expect(result.error).toBeNull();
  expect(result.data).toEqual({ id: 'appeal-1' });
});
