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
