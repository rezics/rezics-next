import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { ReporterStatusView } from '../src/moderation/reporter-status-view';
import { reporterStatusResponse, type ReporterStatus } from '../src/moderation/reporter-status-model';
import { isSignedInPath } from '../src/session/guard';

const submission: ReporterStatus = {
  id: 'report-1',
  target: { kind: 'post', id: 'post-1' },
  revisionId: 'revision-1',
  reason: 'spam',
  evidence: 'The original evidence I submitted.',
  reporterId: 'reporter-1',
  createdAt: '2026-10-30T10:00:00.000Z',
  resolvedAt: null,
  outcome: null,
  targetAvailability: 'unavailable',
};

test('reporter presentation retains submission and reference after removal, with each native status and no target link', () => {
  for (const [outcome, label] of [
    [null, 'Pending review'],
    ['actioned', 'Actioned'],
    ['dismissed', 'Dismissed'],
  ] as const) {
    const report = { ...submission, outcome, resolvedAt: outcome ? '2026-10-31T10:00:00.000Z' : null };
    const html = renderToStaticMarkup(createElement(ReporterStatusView, { report }));
    for (const value of [
      label,
      submission.evidence!,
      submission.target.id,
      submission.revisionId!,
      'This content is unavailable.',
    ])
      expect(html).toContain(value);
    expect(html).toContain(`dateTime="${submission.createdAt}"`);
    expect(html).not.toContain('href=');
    expect(html).not.toContain('reporter-1');
  }
});

test('only the own-submission DTO is accepted and private additions cannot cross the web boundary', () => {
  expect(
    reporterStatusResponse({
      report: { ...submission, moderatorNotes: 'Private note', body: 'Hidden text', otherReports: ['other'] },
    }),
  ).toEqual(submission);
  const { targetAvailability: _availability, ...moderator } = submission;
  expect(() =>
    reporterStatusResponse({ report: { ...moderator, partition: 1, transactionId: 'transaction' } }),
  ).toThrow();
  expect(() => reporterStatusResponse({ report: { ...submission, reporterId: null } })).toThrow();
});

test('successful receipt is retained and the served status route uses the private owning reader', async () => {
  const [actions, route, reader] = await Promise.all([
    readFile(new URL('../src/report/content-actions.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/moderation/reports.$id.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/moderation/reporter-status-read.ts', import.meta.url), 'utf8'),
  ]);
  expect(actions).toContain('setReportId(result.reportId)');
  expect(actions).toContain('/moderation/reports/${reportId}');
  expect(route).toMatch(/beforeLoad:\s*requireSignedIn/);
  expect(route).toContain('noindex, nofollow');
  expect(reader).toContain('private, no-store');
  expect(reader).toContain('result.status === 404');
  expect(isSignedInPath('/en/moderation/reports/report-1')).toBe(true);
});
