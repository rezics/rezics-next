import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { ReporterStatusPage, ReporterStatusView } from '../src/moderation/reporter-status-view';
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

test('the served receipt explains its actioned disposition and separates submitted evidence, timeline and copyable reference', () => {
  const report = reporterStatusResponse({
    report: {
      ...submission,
      outcome: 'actioned',
      resolvedAt: '2026-10-31T10:00:00.000Z',
      moderatorNotes: 'Private moderator discussion',
      otherReports: ['Another reporter’s evidence'],
      body: 'Currently withheld target body',
      appeal: { outcome: 'reversed' },
    },
  });
  const html = renderToStaticMarkup(createElement(ReporterStatusPage, { report }));
  for (const value of [
    'Your report',
    'Actioned',
    'a later appeal does not change it',
    'Submitted',
    'Reviewed',
    'Your submission',
    'Evidence you submitted',
    'The original evidence I submitted.',
    'This content is unavailable.',
    'Report reference',
    'Copy reference',
    'Back to inbox',
  ])
    expect(html).toContain(value);
  expect(html).toContain(`dateTime="${submission.createdAt}"`);
  expect(html).toContain('dateTime="2026-10-31T10:00:00.000Z"');
  expect(html).toContain('<details');
  expect(html).toContain(submission.id);
  expect(html).toContain('post post-1');
  expect(html).toContain('revision-1');
  expect(html.match(/href=/g)).toHaveLength(1);
  expect(html).toMatch(/href="(?:\/en)?\/inbox"/);
  for (const hidden of [
    'Private moderator discussion',
    'Another reporter’s evidence',
    'Currently withheld target body',
    'reversed',
    submission.reporterId,
  ])
    expect(html).not.toContain(hidden);
});

test('the served error state offers an explicit retry and inbox return without a fabricated report', () => {
  const html = renderToStaticMarkup(createElement(ReporterStatusPage, { onRetry: () => undefined }));
  expect(html).toContain('Your report');
  expect(html).toContain('role="alert"');
  expect(html).toContain('Your report could not be loaded. Try again.');
  expect(html).toContain('Try again');
  expect(html).toContain('Back to inbox');
  for (const value of [
    'Pending review',
    'Actioned',
    'Dismissed',
    'Report reference',
    submission.evidence ?? 'missing evidence',
  ])
    expect(html).not.toContain(value);
});
