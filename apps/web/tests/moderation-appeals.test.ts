import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { readModerationAppeals, resolveAppealTargets } = await import('../src/moderation/appeals-read');
const { resolveModerationAppeal } = await import('../src/moderation/actions');
const { ModerationAppealsView } = await import('../src/moderation/appeals-tab');

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;

function appeal(n: number, targetId: string, outcome: 'uphold' | 'reverse' | null = null) {
  return {
    id: id(n),
    decisionId: id(n + 100),
    appellantId: `private-author-${n}`,
    statement: `Author reason ${n}`,
    createdAt: `2026-01-0${n}T12:00:00.000Z`,
    decision: {
      id: id(n + 100),
      targetKind: 'post' as const,
      targetId,
      statement: `Moderator decision ${n}`,
      deciderId: `decider-${n}`,
      appeal: outcome
        ? {
            outcome: outcome === 'uphold' ? ('upheld' as const) : ('reversed' as const),
            statement: `Resolution statement ${n}`,
            resolvedAt: '2026-01-10T12:00:00.000Z',
          }
        : null,
    },
  };
}

test('board appeal pages keep their cursor, show decision and author statements, and resolve repeated targets once', async () => {
  const calls: string[] = [];
  const appeals = [appeal(1, id(50)), appeal(2, id(50)), appeal(3, id(51))];
  const page = await readModerationAppeals(
    {
      boardAppeals: async (boardId, cursor) => {
        calls.push(`board:${boardId}:${cursor ?? ''}`);
        return { appeals, next: 'next+page==' };
      },
      threadAppeals: async () => ({ appeals: [], next: null }),
    },
    { boardId: id(1), cursor: 'current/page==' },
  );
  const targets = await resolveAppealTargets(page.appeals, {
    post: async (targetId) => {
      calls.push(`post:${targetId}`);
      return { post: { body: `Target ${targetId}` } };
    },
    thread: async () => null,
  });
  const markup = renderToStaticMarkup(
    createElement(ModerationAppealsView, { appeals: page.appeals, targets, next: page.next }),
  );

  expect(page.next).toBe('next+page==');
  expect(calls).toEqual([`board:${id(1)}:current/page==`, `post:${id(50)}`, `post:${id(51)}`]);
  expect(markup).toContain('Moderator decision 1');
  expect(markup).toContain('Author reason 1');
  expect(markup).toContain(`Target ${id(50)}`);
  expect(markup).not.toContain('private-author');
});

test('thread filter reads the thread appeals endpoint and returns its page', async () => {
  const calls: string[] = [];
  const page = await readModerationAppeals(
    {
      boardAppeals: async () => {
        calls.push('board');
        return { appeals: [], next: null };
      },
      threadAppeals: async (threadId, cursor) => {
        calls.push(`thread:${threadId}:${cursor ?? ''}`);
        return { appeals: [appeal(1, id(50))], next: 'thread-next' };
      },
    },
    { boardId: id(1), threadId: id(2), cursor: 'thread-cursor' },
  );
  expect(calls).toEqual([`thread:${id(2)}:thread-cursor`]);
  expect(page.next).toBe('thread-next');
});

test('pages of five and twenty appeals read the page and each distinct target once', async () => {
  for (const count of [5, 20]) {
    let kernelReads = 0;
    const appeals = Array.from({ length: count }, (_, index) => appeal(index + 1, id(77)));
    const page = await readModerationAppeals(
      {
        boardAppeals: async () => {
          kernelReads += 1;
          return { appeals, next: null };
        },
        threadAppeals: async () => ({ appeals: [], next: null }),
      },
      { boardId: id(1) },
    );
    const targets = await resolveAppealTargets(page.appeals, {
      post: async () => {
        kernelReads += 1;
        return { post: { body: 'same target' } };
      },
      thread: async () => {
        kernelReads += 1;
        return null;
      },
    });
    expect(page.appeals).toHaveLength(count);
    expect(targets).toHaveLength(1);
    expect(kernelReads).toBe(2);
  }
});

test('uphold and reverse post the chosen outcome and moderator statement', async () => {
  const calls: { path: string; body: unknown }[] = [];
  await resolveModerationAppeal(
    async (path, body) => {
      calls.push({ path, body });
      return { ok: true };
    },
    { id: id(1), outcome: 'uphold', statement: 'Keep the decision.' },
  );
  await resolveModerationAppeal(
    async (path, body) => {
      calls.push({ path, body });
      return { ok: true };
    },
    { id: id(2), outcome: 'reverse', statement: 'Restore the post.' },
  );
  expect(calls).toEqual([
    { path: `/v1/moderation-appeals/${id(1)}:resolve`, body: { outcome: 'uphold', statement: 'Keep the decision.' } },
    { path: `/v1/moderation-appeals/${id(2)}:resolve`, body: { outcome: 'reverse', statement: 'Restore the post.' } },
  ]);
});

test('pending appeals offer resolution only when the viewer can resolve and is not the original decider', () => {
  const pending = appeal(1, id(50));
  const resolvable = renderToStaticMarkup(
    createElement(ModerationAppealsView, {
      appeals: [pending],
      targets: [{ key: `post:${id(50)}`, kind: 'post', value: { post: { body: 'Taken down post' } } }],
      next: null,
      viewerId: 'another-moderator',
      canResolve: () => true,
    }),
  );
  const originalDecider = renderToStaticMarkup(
    createElement(ModerationAppealsView, {
      appeals: [pending],
      targets: [],
      next: null,
      viewerId: 'decider-1',
      canResolve: () => true,
    }),
  );
  const unauthorized = renderToStaticMarkup(
    createElement(ModerationAppealsView, {
      appeals: [pending],
      targets: [],
      next: null,
      viewerId: 'another-moderator',
      canResolve: () => false,
    }),
  );
  const resolved = renderToStaticMarkup(
    createElement(ModerationAppealsView, {
      appeals: [appeal(1, id(50), 'reverse')],
      targets: [],
      next: null,
      viewerId: 'another-moderator',
      canResolve: () => true,
    }),
  );
  expect(resolvable).toContain('Uphold');
  expect(resolvable).toContain('Reverse');
  expect(originalDecider).toContain('Another moderator must resolve this appeal.');
  expect(originalDecider).not.toContain('Uphold');
  expect(originalDecider).not.toContain('Reverse');
  expect(unauthorized).not.toContain('Uphold');
  expect(unauthorized).not.toContain('Reverse');
  expect(resolved).toContain('Resolution statement 1');
  expect(resolved).not.toContain('Uphold');
});

test('the appeals tab is addressable and keeps reports as the default tab', async () => {
  const reportsPage = await Bun.file(new URL('../src/moderation/reports-page.tsx', import.meta.url)).text();
  const route = await Bun.file(new URL('../src/routes/boards/$id_.moderation.tsx', import.meta.url)).text();
  const markup = renderToStaticMarkup(createElement(ModerationAppealsView, { appeals: [], targets: [], next: null }));
  expect(markup).toContain('aria-current="page"');
  expect(markup).toContain('href="?"');
  expect(reportsPage).toContain('?tab=appeals');
  expect(route).toContain("search.tab === 'appeals'");
  expect(route).toContain("deps.tab === 'appeals'");
});

test('a successful resolution returns the outcome and statement rendered on the appeal', async () => {
  const resolution = await resolveModerationAppeal(async () => ({ id: id(1) }), {
    id: id(1),
    outcome: 'reverse',
    statement: 'Restore the post.',
  });
  const resolvedAppeal = {
    ...appeal(1, id(50)),
    decision: {
      ...appeal(1, id(50)).decision,
      appeal: {
        outcome: resolution.outcome === 'uphold' ? ('upheld' as const) : ('reversed' as const),
        statement: resolution.statement,
        resolvedAt: '2026-01-10T12:00:00.000Z',
      },
    },
  };
  const markup = renderToStaticMarkup(
    createElement(ModerationAppealsView, { appeals: [resolvedAppeal], targets: [], next: null }),
  );
  expect(resolution).toEqual({ outcome: 'reverse', statement: 'Restore the post.' });
  expect(markup).toContain('Restore the post.');
  expect(markup).not.toContain('Uphold</button>');
});

test('the API decision target shape resolves posts and threads without a decision or permission read', async () => {
  const calls: string[] = [];
  const appeals = [
    {
      ...appeal(1, id(50)),
      decision: { statement: 'Post decision', target: { kind: 'post' as const, id: id(50) } },
      canResolve: true,
    },
    {
      ...appeal(2, id(51)),
      decision: { statement: 'Thread decision', target: { kind: 'thread' as const, id: id(51) } },
      canResolve: false,
    },
  ];
  const targets = await resolveAppealTargets(appeals, {
    post: async (targetId) => {
      calls.push(`post:${targetId}`);
      return { post: { body: 'Post target' } };
    },
    thread: async (targetId) => {
      calls.push(`thread:${targetId}`);
      return { thread: { title: 'Thread target' } };
    },
  });
  expect(calls).toEqual([`post:${id(50)}`, `thread:${id(51)}`]);
  const markup = renderToStaticMarkup(createElement(ModerationAppealsView, { appeals, targets, next: null }));
  expect(markup).toContain('Post target');
  expect(markup).toContain('Thread target');
  expect(markup.match(/>Uphold<\/button>/g)).toHaveLength(1);
  expect(markup).toContain('Another moderator must resolve this appeal.');
});

test('a list denial cannot be overridden by a local resolution predicate', () => {
  const markup = renderToStaticMarkup(
    createElement(ModerationAppealsView, {
      appeals: [{ ...appeal(1, id(50)), canResolve: false }],
      targets: [],
      next: null,
      canResolve: () => true,
    }),
  );
  expect(markup).toContain('Another moderator must resolve this appeal.');
  expect(markup).not.toContain('Uphold');
  expect(markup).not.toContain('Reverse');
});

test('a forbidden resolution survives the server boundary as data, while other failures stay retryable', async () => {
  const { submitModerationAppealResolution } = await import('../src/moderation/actions');
  const input = { id: id(1), outcome: 'reverse' as const, statement: 'Independent review.' };
  expect(
    await submitModerationAppealResolution(async () => {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }, input),
  ).toEqual({ state: 'forbidden' });
  expect(await submitModerationAppealResolution(async () => ({ id: id(1) }), input)).toEqual({
    state: 'resolved',
    outcome: 'reverse',
    statement: 'Independent review.',
  });
  await expect(
    submitModerationAppealResolution(async () => {
      throw Object.assign(new Error('Unavailable'), { status: 503 });
    }, input),
  ).rejects.toThrow('Unavailable');
});
