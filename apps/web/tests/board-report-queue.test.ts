import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Report } from '../src/moderation/reports-read';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { resolveReportedRevisions } = await import('../src/moderation/reports-read');
const { reportDecisionReason, takeDownReport } = await import('../src/moderation/actions');
const { BoardReportQueue } = await import('../src/stories/patterns/board-report-queue/board-report-queue');
const report: Report = {
  id: 'report',
  target: { kind: 'post', id: 'known-post' },
  revisionId: 'original-revision',
  reason: 'other',
  evidence: 'Submitted evidence text',
  createdAt: '2026-10-30T12:00:00.000Z',
  outcome: null,
  resolvedAt: null,
};

test('edited targets show original reported content separately and submit one reason within the native cap', async () => {
  const calls: string[][] = [];
  const revisions = await resolveReportedRevisions([report, { ...report, id: 'duplicate' }], async (...ids) => {
    calls.push(ids);
    return { post: { body: 'Original readable revision' } };
  });
  expect(calls).toEqual([['known-post', 'original-revision']]);
  const markup = renderToStaticMarkup(
    createElement(BoardReportQueue, {
      reports: [report],
      revisions,
      targets: [{ key: 'post:known-post', kind: 'post', value: { post: { body: 'Readable current target' } } }],
      onAction: async () => {},
    }),
  );
  expect(markup).toContain('Original readable revision');
  expect(markup).toContain('Readable current target');
  expect(markup).toContain('Submitted evidence text');
  expect(markup.match(/<textarea/g)).toHaveLength(1);
  expect(markup).toContain('maxLength="1024"');
  const commands: unknown[] = [];
  await takeDownReport(
    async (path, body) => {
      commands.push({ path, body });
    },
    {
      reportId: report.id,
      targetKind: 'post',
      targetId: 'known-post',
      reason: 'R'.repeat(1024),
    },
  );
  expect(commands).toEqual([{ path: '/v1/posts/known-post:takeDown', body: { reason: 'R'.repeat(1024) } }]);
  expect(() => reportDecisionReason('R'.repeat(1025))).toThrow();
  expect(() => reportDecisionReason('   ')).toThrow();
});

test('unknown post identity and refused exact revision stay neutrally unavailable', async () => {
  const calls: string[] = [];
  const reports: Report[] = [report, { ...report, id: 'thread-report', target: { kind: 'thread', id: 'thread' } }];
  const revisions = await resolveReportedRevisions(reports, async (postId) => {
    calls.push(postId);
    throw new Error('Not found');
  });
  expect(calls).toEqual(['known-post']);
  expect(revisions).toEqual(reports.map(({ id }) => ({ reportId: id, value: null })));
  const markup = renderToStaticMarkup(
    createElement(BoardReportQueue, {
      reports,
      revisions,
      targets: [],
      onAction: async () => {},
    }),
  );
  expect(markup).not.toContain('original-revision');
  expect(markup).not.toContain('href=');
  expect(markup).not.toContain('Original readable revision');
});

test('review cards keep submitted evidence and native resolution times separate from readable content', () => {
  const markup = renderToStaticMarkup(
    createElement(BoardReportQueue, {
      reports: [{ ...report, outcome: 'dismissed', resolvedAt: '2026-10-31T09:00:00.000Z' }],
      revisions: [{ reportId: report.id, value: { post: { availability: 'unavailable', body: 'Private revision' } } }],
      targets: [{ key: 'post:known-post', kind: 'post', value: { post: { removed: true, body: 'Removed body' } } }],
      onAction: async () => {},
    }),
  );
  expect(markup).toContain('Submitted evidence text');
  expect(markup).toContain('Submitted report');
  expect(markup).toContain('Reported revision');
  expect(markup).toContain('Current target');
  expect(markup).toContain('Dismissed');
  expect(markup).toContain('dateTime="2026-10-31T09:00:00.000Z"');
  expect(markup).not.toContain('Private revision');
  expect(markup).not.toContain('Removed body');
  expect(markup).not.toContain('original-revision');
  expect(markup).not.toContain('<textarea');
});

test('an empty native page keeps continuation while preparation states disclose no report details', () => {
  const empty = renderToStaticMarkup(
    createElement(BoardReportQueue, {
      reports: [],
      targets: [],
      revisions: [],
      next: 'sealed+continuation==',
      onAction: async () => {},
    }),
  );
  expect(empty).toContain('Next page');
  expect(empty).toContain('There may be more reports on the next page.');
  expect(empty).not.toContain('sealed+continuation==');
  for (const state of ['loading', 'error'] as const) {
    const markup = renderToStaticMarkup(
      createElement(BoardReportQueue, {
        reports: [report],
        targets: [],
        next: 'sealed+continuation==',
        state,
        onAction: async () => {},
      }),
    );
    expect(markup).not.toContain(report.evidence!);
    expect(markup).not.toContain('Next page');
    expect(markup).not.toContain('<textarea');
  }
});
