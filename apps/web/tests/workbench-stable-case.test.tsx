import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Appeal } from '../src/moderation/appeals-read';
import type { Report } from '../src/moderation/reports-read';
import { workbenchAppealFromPage } from '../src/moderation/workbench-appeal';
import {
  parseWorkbenchCaseSearch,
  workbenchCaseFromPage,
  workbenchCaseHref,
  workbenchCaseInput,
  workbenchCaseQueueHref,
} from '../src/moderation/workbench-case/read-model';
import { WorkbenchCaseDetail } from '../src/moderation/workbench-case';
import type { WorkbenchNativeSource } from '../src/moderation/workbench-queue/read';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { workbenchCaseHref: workbenchRowHref, workbenchQueueHref, workbenchSearch } = await import(
  '../src/moderation/workbench-queue/scope'
);
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
  expect(workbenchCaseQueueHref(search!)).toBe(
    '/moderation/workbench?queue=reports&board=board%2Fone&targetKind=post&order=oldest&cursor=cursor+one&realm=realm-1',
  );
  expect(workbenchCaseInput(search!).boardId).toBe(boardId);
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

test('an absent selected appeal on the exact page is unavailable and later pages are not scanned', async () => {
  const targets: string[] = [];
  const page = await readWorkbench(
    source({
      async readTarget(kind, id) {
        targets.push(`${kind}:${id}`);
        return { post: { id, body: 'Independent current target.' } };
      },
    }),
    workbenchSearch({ board: boardId, queue: 'appeals', case: appeal.id }),
  );
  expect(workbenchAppealFromPage(page, appeal.id).state).toBe('ready');
  expect(targets).toEqual(['post:post-1']);
  expect(workbenchAppealFromPage(page, 'missing-appeal').state).toBe('unavailable');
  const missing = await readWorkbench(
    source({
      async boardAppeals() {
        return { appeals: [appeal], next: 'later-page' };
      },
      async readTarget() {
        throw new Error('do not read a target for a missing selection');
      },
    }),
    workbenchSearch({ board: boardId, queue: 'appeals', case: 'missing-appeal' }),
  );
  expect(missing.next).toBe('later-page');
  expect(workbenchAppealFromPage(missing, 'missing-appeal').state).toBe('unavailable');
  expect(workbenchAppealFromPage({ state: 'ready', appeals: [] }, appeal.id).state).toBe('empty');
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
