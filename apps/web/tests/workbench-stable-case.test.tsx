import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Appeal } from '../src/moderation/appeals-read';
import type { Report } from '../src/moderation/reports-read';
import type { WorkbenchNativeSource } from '../src/moderation/workbench-queue/read';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { workbenchAppealFromPage } = await import('../src/moderation/workbench-appeal');
const {
  parseWorkbenchCaseSearch,
  workbenchCaseFromPage,
  workbenchCaseHref,
  workbenchCaseInput,
  workbenchCaseQueueHref,
} = await import('../src/moderation/workbench-case/read-model');
const { WorkbenchCaseDetail } = await import('../src/moderation/workbench-case');
const { WorkbenchQueueWindowHistory, workbenchReaderFence } = await import(
  '../src/moderation/workbench-queue/window-history'
);
const {
  workbenchCaseHref: workbenchRowHref,
  workbenchQueueHref,
  workbenchSearch,
} = await import('../src/moderation/workbench-queue/scope');
const { readWorkbench } = await import('../src/moderation/workbench-queue/read');

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
const appeal: Appeal = {
  id: 'appeal-1',
  decisionId: 'decision-1',
  appellantId: 'author-1',
  statement: 'Please restore the post.',
  createdAt: '2026-10-29T10:00:00.000Z',
  decision: { statement: 'Taken down', target: { kind: 'post', id: 'post-1' } },
  canResolve: true,
};
const boardId = 'board/one';

function source(overrides: Partial<WorkbenchNativeSource> = {}): WorkbenchNativeSource {
  return {
    async realms() {
      return { items: [], next: null };
    },
    async boards() {
      return { items: [], next: null };
    },
    async boardReports() {
      return { reports: [report], next: null };
    },
    async boardAppeals() {
      return { appeals: [appeal], next: 'later-page' };
    },
    async catalogueReports() {
      throw new Error('catalogue must not run for a board case');
    },
    ...overrides,
  };
}

test('selected report references keep the native ID and return to the captured workbench queue', () => {
  const search = parseWorkbenchCaseSearch({
    boardId,
    realm: 'realm-1',
    directory: true,
    directoryCursor: 'directory-frontier',
    directoryRealm: 'directory-realm',
    cursor: 'cursor one',
    status: 'pending',
    targetKind: 'post',
    order: 'oldest',
    queue: 'reports',
  });
  expect(search).not.toBeNull();
  const href = workbenchCaseHref(report.id, search!);
  expect(href).toContain('/moderation/cases/report-1?');
  expect(href).toContain('boardId=board%2Fone');
  expect(href).toContain('cursor=cursor+one');
  expect(href).toContain('targetKind=post');
  expect(href).toContain('order=oldest');
  expect(href).toContain('queue=reports');
  expect(href).toContain('realm=realm-1');
  expect(href).toContain('directory=true');
  expect(href).toContain('directoryCursor=directory-frontier');
  expect(href).toContain('directoryRealm=directory-realm');
  expect(workbenchCaseQueueHref(search!)).toBe(
    '/moderation/workbench?queue=reports&board=board%2Fone&targetKind=post&order=oldest&realm=realm-1&directory=true&directoryCursor=directory-frontier&directoryRealm=directory-realm&cursor=cursor+one',
  );
  expect(workbenchCaseInput(search!).boardId).toBe(boardId);
});

test('same-session exact case return rereads the captured queue and restores its private predecessor independently of directory', () => {
  const history = new WorkbenchQueueWindowHistory();
  const privatePage = {
    readerBinding: {
      id: 'binding-case-window',
      source: 'reader-case-window',
      revision: 9,
      key: 'queue-case-window',
      placement: 'browser' as const,
      expected: null,
      retired: false,
    },
    readerOrigin: { subject: 'moderator', csrfFingerprint: 'private' },
  };
  const first = workbenchSearch({
    board: boardId,
    realm: 'realm-1',
    queue: 'reports',
    targetKind: 'post',
    order: 'oldest',
    directory: true,
    directoryCursor: 'directory-frontier',
    directoryRealm: 'directory-realm',
  });
  const firstPage = { ...privatePage, state: 'ready' as const, next: 'queue-cursor-2' };
  history.admitQueue({ visitId: 'queue-visit-1', page: firstPage, search: first, locale: 'en', admitted: true });

  const current = workbenchSearch({ ...first, cursor: firstPage.next ?? undefined });
  const currentPage = { ...privatePage, state: 'ready' as const, next: 'queue-cursor-3' };
  expect(
    history.beginMove({
      visitId: 'queue-visit-1',
      search: first,
      fence: workbenchReaderFence(firstPage, 'en'),
      move: 'next',
      keyboard: false,
    }),
  ).toBe(true);
  expect(
    history.navigate(
      'queue-visit-1',
      { pathname: '/moderation/workbench', search: current as unknown as Record<string, unknown> },
      first,
      firstPage,
    ),
  ).toBe(true);
  history.admitQueue({ visitId: 'queue-visit-2', page: currentPage, search: current, locale: 'en', admitted: true });

  const captured = parseWorkbenchCaseSearch({
    boardId,
    realm: 'realm-1',
    queue: 'reports',
    status: 'pending',
    targetKind: 'post',
    order: 'oldest',
    cursor: 'queue-cursor-2',
    directory: true,
    directoryCursor: 'directory-frontier',
    directoryRealm: 'directory-realm',
  })!;
  const caseHref = workbenchCaseHref(report.id, captured);
  const caseUrl = new URL(caseHref, 'https://workbench.test');
  expect(
    history.beginCaseDeparture({
      visitId: 'queue-visit-2',
      search: current,
      fence: workbenchReaderFence(currentPage, 'en'),
      reportId: report.id,
    }),
  ).toBe(true);
  expect(
    history.navigate(
      'queue-visit-2',
      { pathname: caseUrl.pathname, search: Object.fromEntries(caseUrl.searchParams) },
      current,
      currentPage,
    ),
  ).toBe(true);
  expect(
    history.admitCase({
      visitId: 'case-visit',
      page: privatePage,
      search: captured,
      reportId: report.id,
      locale: 'en',
    }),
  ).toBe(true);

  const returnHref = workbenchCaseQueueHref(captured);
  const returnUrl = new URL(returnHref, 'https://workbench.test');
  expect(returnUrl.searchParams.get('cursor')).toBe('queue-cursor-2');
  expect(returnUrl.searchParams.get('directoryCursor')).toBe('directory-frontier');
  expect(returnUrl.searchParams.get('directoryRealm')).toBe('directory-realm');
  expect(
    history.beginCaseReturn({
      visitId: 'case-visit',
      page: privatePage,
      search: captured,
      reportId: report.id,
      locale: 'en',
    }),
  ).toBe(true);
  const returned = workbenchSearch(Object.fromEntries(returnUrl.searchParams));
  expect(
    history.navigate(
      'case-visit',
      { pathname: returnUrl.pathname, search: Object.fromEntries(returnUrl.searchParams) },
      captured,
      privatePage,
    ),
  ).toBe(true);
  const admittedReturn = { ...privatePage, state: 'ready' as const, next: 'queue-cursor-3' };
  history.admitQueue({ visitId: 'queue-return-visit', page: admittedReturn, search: returned, locale: 'en', admitted: true });
  expect(history.previousAddress('queue-return-visit', returned)).toBeNull();
  expect(returned.cursor).toBe('queue-cursor-2');
  expect(returned.directoryCursor).toBe('directory-frontier');
  expect(returned.targetKind).toBe('post');
  expect(returned.order).toBe('oldest');
});

test('workbench rows open the exact report or appeal and catalogue stays on catalogue', () => {
  const reports = workbenchSearch({ board: boardId, realm: 'realm-1', queue: 'reports', cursor: 'page-2' });
  expect(workbenchRowHref({ kind: 'report', id: report.id }, reports)).toContain(`/moderation/cases/${report.id}`);
  expect(workbenchRowHref({ kind: 'report', id: report.id }, reports)).toContain('cursor=page-2');
  const appeals = workbenchSearch({ board: boardId, queue: 'appeals', cursor: 'appeal-cursor' });
  const appealHref = workbenchRowHref({ kind: 'appeal', id: appeal.id }, appeals);
  expect(appealHref).toContain('/moderation/workbench?');
  expect(appealHref).toContain(`case=${appeal.id}`);
  expect(appealHref).toContain('cursor=appeal-cursor');
  expect(appealHref).toContain(`board=${encodeURIComponent(boardId)}`);
  expect(workbenchRowHref({ kind: 'report', id: report.id }, workbenchSearch({ scope: 'catalogue' }))).toBe(
    '/moderation/catalogue',
  );
  expect(workbenchQueueHref({ ...appeals, case: undefined })).not.toContain('case=');
});

test('exact appeal inspection stays independent of the captured sparse page and never scans', async () => {
  const calls: unknown[] = [];
  const page = await readWorkbench(
    source({
      async boardAppeals(board, cursor, inspect) {
        calls.push([board, cursor, inspect]);
        return { appeals: [], next: 'later-page', selectedAppeal: appeal };
      },
    }),
    workbenchSearch({ board: boardId, queue: 'appeals', cursor: 'captured-page', case: appeal.id }),
  );
  expect(calls).toEqual([[boardId, 'captured-page', appeal.id]]);
  expect(workbenchAppealFromPage(page, appeal.id).state).toBe('ready');
  expect(page.next).toBe('later-page');
  expect(workbenchAppealFromPage(page, 'missing-appeal').state).toBe('unavailable');
  expect(workbenchAppealFromPage({ state: 'ready', appeals: [appeal] }, appeal.id).state).toBe('unavailable');
  expect(workbenchAppealFromPage({ state: 'ready', appeals: [] }, appeal.id).state).toBe('unavailable');
});

test('the selected report page returns to the workbench snapshot', () => {
  const markup = renderToStaticMarkup(
    createElement(WorkbenchCaseDetail, {
      report,
      target: undefined,
      revision: null,
      queueHref: '/moderation/workbench?queue=reports&board=board-1',
      isCurrent: () => true,
      register: () => () => {},
      onAction: async () => ({ ok: true }),
    }),
  );
  expect(markup).toContain('href="/moderation/workbench?queue=reports&amp;board=board-1"');
  expect(markup).toContain(m.moderation_workbench_history_return());
  expect(workbenchCaseFromPage({ state: 'ready', reports: [report], targets: [], revisions: [] }, 'other').state).toBe(
    'unavailable',
  );
});
