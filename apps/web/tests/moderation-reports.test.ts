import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { readModerationReports, resolveReportTargets } = await import('../src/moderation/reports-read');
const { dismissReport, takeDownReport } = await import('../src/moderation/actions');
const { ModerationReportsView } = await import('../src/moderation/reports-page');

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;

function report(
  n: number,
  target: { kind: 'post' | 'thread'; id: string },
  outcome: 'actioned' | 'dismissed' | null = null,
) {
  return {
    id: id(n),
    target,
    revisionId: null,
    reason: `Reason ${n}`,
    evidence: null,
    createdAt: `2026-01-0${n}T12:00:00.000Z`,
    outcome,
    resolvedAt: outcome ? '2026-01-10T12:00:00.000Z' : null,
    reporterId: `private-reporter-${n}`,
  };
}

test('board report pages retain their cursor, omit reporter identity, and resolve each distinct target once', async () => {
  const calls: string[] = [];
  const reports = [
    report(1, { kind: 'post', id: id(50) }),
    report(2, { kind: 'post', id: id(50) }),
    report(3, { kind: 'thread', id: id(51) }),
  ];
  const page = await readModerationReports(
    {
      boardReports: async (boardId, cursor) => {
        calls.push(`board:${boardId}:${cursor ?? ''}`);
        return { reports, next: 'next+page==' };
      },
      threadReports: async () => ({ reports: [], next: null }),
    },
    { boardId: id(1), cursor: 'current/page==' },
  );
  const targets = await resolveReportTargets(page.reports, {
    post: async (targetId) => {
      calls.push(`post:${targetId}`);
      return {
        body: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reported post text' }] }],
        },
      };
    },
    thread: async (targetId) => {
      calls.push(`thread:${targetId}`);
      return { title: 'Reported thread' };
    },
  });

  expect(page.next).toBe('next+page==');
  expect(calls).toEqual([`board:${id(1)}:current/page==`, `post:${id(50)}`, `thread:${id(51)}`]);
  expect(targets).toHaveLength(2);
  expect(JSON.stringify(page)).not.toContain('private-reporter');
  expect(JSON.stringify(targets)).toContain('Reported post text');
});

test('thread scope reads reports from the thread endpoint and the read owns outcomes', async () => {
  const calls: string[] = [];
  const page = await readModerationReports(
    {
      boardReports: async () => {
        calls.push('board');
        return { reports: [], next: null };
      },
      threadReports: async (threadId, cursor) => {
        calls.push(`thread:${threadId}:${cursor ?? ''}`);
        return { reports: [report(1, { kind: 'thread', id: threadId }, 'dismissed')], next: null };
      },
    },
    { boardId: id(1), threadId: id(2), cursor: 'thread-cursor' },
  );
  expect(calls).toEqual([`thread:${id(2)}:thread-cursor`]);
  expect(page.reports[0]?.outcome).toBe('dismissed');
});

test('pages of five and twenty reports read each repeated target once', async () => {
  for (const count of [5, 20]) {
    let targetReads = 0;
    const repeated = Array.from({ length: count }, (_, index) => report(index + 1, { kind: 'post', id: id(77) }));
    const page = await readModerationReports(
      {
        boardReports: async () => ({ reports: repeated, next: null }),
        threadReports: async () => ({ reports: [], next: null }),
      },
      { boardId: id(1) },
    );
    const targets = await resolveReportTargets(page.reports, {
      post: async () => {
        targetReads += 1;
        return { post: { body: 'same target' } };
      },
      thread: async () => {
        targetReads += 1;
        return null;
      },
      board: async () => {
        targetReads += 1;
        return null;
      },
    });
    expect(page.reports).toHaveLength(count);
    expect(targets).toHaveLength(1);
    expect(targetReads).toBe(1);
  }
});

test('take down and dismiss send their established commands and return to read outcomes', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const fetcher = async (path: string, body: unknown) => {
    calls.push({ path, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ outcome: path.includes('dismiss') ? 'dismissed' : 'actioned' }),
    };
  };
  await takeDownReport(fetcher, {
    reportId: id(1),
    targetKind: 'board',
    targetId: id(2),
    reason: 'Policy reason',
    statement: 'Decision',
  });
  await dismissReport(fetcher, { reportId: id(3) });
  expect(calls).toEqual([
    { path: `/v1/boards/${id(2)}:takeDown`, body: { reason: 'Policy reason\n\nDecision' } },
    { path: `/v1/reports/${id(3)}:dismiss`, body: {} },
  ]);
});

test('the reports page renders target, reason, report time and read outcomes without reporter identity', () => {
  const reports = [
    report(1, { kind: 'post', id: id(50) }, 'actioned'),
    report(2, { kind: 'thread', id: id(51) }, 'dismissed'),
  ];
  const markup = renderToStaticMarkup(
    createElement(ModerationReportsView, {
      reports,
      targets: [
        { key: `post:${id(50)}`, kind: 'post', value: { post: { body: 'Reported post content' } } },
        { key: `thread:${id(51)}`, kind: 'thread', value: { thread: { title: 'Reported thread title' } } },
      ],
      next: null,
    }),
  );

  expect(markup).toContain('Reported post content');
  expect(markup).toContain('Reported thread title');
  expect(markup).toContain('Reason 1');
  expect(markup).toContain('dateTime="2026-01-01T12:00:00.000Z"');
  expect(markup).toContain('Actioned');
  expect(markup).toContain('Dismissed');
  expect(markup).not.toContain('private-reporter');
  expect(markup).not.toContain('Dismiss</button>');
});

test('open reports require a reason and statement for take down and offer dismissal', () => {
  const markup = renderToStaticMarkup(
    createElement(ModerationReportsView, {
      reports: [report(1, { kind: 'post', id: id(50) })],
      targets: [{ key: `post:${id(50)}`, kind: 'post', value: { post: { body: 'Reported post content' } } }],
      next: null,
    }),
  );
  expect(markup).toContain('Take down');
  expect(markup).toContain('Dismiss');
  expect(markup).toContain('name="reason" required');
  expect(markup).toContain('name="statement" required');
});

test('withheld and deleted report targets use the existing content placeholders', () => {
  const markup = renderToStaticMarkup(
    createElement(ModerationReportsView, {
      reports: [report(1, { kind: 'post', id: id(50) }), report(2, { kind: 'post', id: id(51) })],
      targets: [
        { key: `post:${id(50)}`, kind: 'post', value: { post: { availability: 'withheld' } } },
        { key: `post:${id(51)}`, kind: 'post', value: { post: { availability: 'erased' } } },
      ],
      next: null,
    }),
  );
  expect(markup).toContain('data-slot="withheld"');
  expect(markup).toContain('data-slot="tombstone"');
});

test('the reports route is signed-in, noindex, private, and maps a refused read to not found', async () => {
  const route = await Bun.file(new URL('../src/routes/boards/$id_.moderation.tsx', import.meta.url)).text();
  const read = await Bun.file(new URL('../src/moderation/reports-read.ts', import.meta.url)).text();
  expect(route).toContain('beforeLoad: requireSignedIn');
  expect(route).toContain("robots: 'noindex, nofollow'");
  expect(read).toContain("setResponseHeader('cache-control', 'private, no-store')");
  expect(read).toContain('if (result.error || !result.data) throw notFound()');
});

test('the board actions menu exposes moderation only to signed-in viewers', async () => {
  const boardRoute = await Bun.file(new URL('../src/routes/boards/$id.tsx', import.meta.url)).text();
  expect(boardRoute).toContain("session === 'signed-in' ? (");
  expect(boardRoute).toContain('href={`/${locale}/boards/${id}/moderation`}');
});
