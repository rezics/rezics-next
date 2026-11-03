import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import type { Report, ReportReadState, ReportTargetValue, ResolvedReportTarget } from '../src/moderation/reports-read';
import { WorkbenchCaseDetail } from '../src/moderation/workbench-case';
import {
  parseWorkbenchCaseSearch,
  workbenchCaseFromPage,
  workbenchCaseHref,
  workbenchCaseInput,
  workbenchCaseQueueHref,
} from '../src/moderation/workbench-case/read-model';

const report: Report = {
  id: 'report-1',
  target: { kind: 'post', id: 'post-1' },
  revisionId: 'revision-1',
  reason: 'spam',
  evidence: 'Reporter evidence available to this case.',
  createdAt: '2026-10-01T09:30:00.000Z',
  outcome: null,
  resolvedAt: null,
};
const target: ResolvedReportTarget = {
  key: 'post:post-1',
  kind: 'post',
  value: { post: { id: 'post-1', body: 'Independently readable current target.' } },
};
const revision: ReportTargetValue = { post: { id: 'post-1', body: 'The exact reported revision.' } };

test('case references preserve their exact scoped report queue', () => {
  const search = parseWorkbenchCaseSearch({
    boardId: 'board/one',
    thread: 'thread-1',
    post: 'post-1',
    cursor: 'cursor one',
    status: 'pending',
    targetKind: 'post',
    order: 'oldest',
  });
  expect(search).not.toBeNull();
  const input = workbenchCaseInput(search!);
  expect(workbenchCaseHref(report.id, input)).toContain('/moderation/cases/report-1?');
  expect(workbenchCaseHref(report.id, input)).toContain('boardId=board%2Fone');
  expect(workbenchCaseHref(report.id, input)).toContain('thread=thread-1');
  expect(workbenchCaseQueueHref(input)).toBe(
    '/moderation/workbench?queue=reports&board=board%2Fone&targetKind=post&order=oldest&cursor=cursor+one',
  );
  expect(parseWorkbenchCaseSearch({ boardId: 'board-1', targetKind: 'subject' })).toBeNull();
});

test('one board case shows the report, exact revision, current target and native decision control', () => {
  const page = {
    state: 'ready' as ReportReadState,
    reports: [report],
    targets: [target],
    revisions: [{ reportId: report.id, value: revision }],
  };
  const result = workbenchCaseFromPage(page, report.id);
  expect(result.state).toBe('ready');
  if (result.state !== 'ready') throw new Error('Expected the exact case on this queue page');
  const markup = renderToStaticMarkup(
    createElement(WorkbenchCaseDetail, {
      report: result.report,
      target: result.target,
      revision: result.revision,
      queueHref: '/moderation/workbench?queue=reports&board=board-1',
      isCurrent: () => true,
      register: () => () => {},
      onAction: async () => ({ ok: true }),
    }),
  );
  expect(markup).toContain(m.moderation_reported_revision_label());
  expect(markup).toContain('The exact reported revision.');
  expect(markup).toContain(m.moderation_current_target_label());
  expect(markup).toContain('Independently readable current target.');
  expect(markup).toContain('Reporter evidence available to this case.');
  expect(markup).toContain('href="/moderation/workbench?queue=reports&amp;board=board-1"');
  expect(markup).toContain('report-1');
  expect(markup).toContain(m.moderation_queue_post());
});

test('a missing or subject report cannot be shown as a board target case', () => {
  const base = { state: 'ready' as const, reports: [report], targets: [], revisions: [] };
  expect(workbenchCaseFromPage({ ...base, reports: [] }, report.id).state).toBe('empty');
  expect(workbenchCaseFromPage(base, 'different-report').state).toBe('unavailable');
  const subject = { ...report, target: { kind: 'subject', id: 'subject-1' } } as unknown as Report;
  expect(workbenchCaseFromPage({ ...base, reports: [subject] }, subject.id).state).toBe('unavailable');
});
