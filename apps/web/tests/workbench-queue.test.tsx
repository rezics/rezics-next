import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/moderation/workbench' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { m } = await import('../src/paraglide/messages.js');
const { isSignedInPath } = await import('../src/session/guard');
const { workbenchCaseHref, workbenchSearch } = await import('../src/moderation/workbench-queue/scope');
const { readWorkbench, type WorkbenchNativeSource } = await import('../src/moderation/workbench-queue/read');
const { WorkbenchView, WorkbenchPreparing } = await import('../src/moderation/workbench-queue/view');

const reportId = '0192f3a0-6c1e-7b2a-9d4e-000000000401';
const appealId = '0192f3a0-6c1e-7b2a-9d4e-000000000501';
const boardId = 'board-club';
const report = {
  id: reportId,
  target: { kind: 'post' as const, id: 'post-1' },
  revisionId: null,
  reason: 'other',
  evidence: 'Private evidence for the moderator list.',
  createdAt: '2026-10-28T10:00:00.000Z',
  outcome: null,
  resolvedAt: null,
};
const appeal = {
  id: appealId,
  decisionId: 'decision-1',
  appellantId: 'author-1',
  statement: 'Please restore the post.',
  createdAt: '2026-10-29T10:00:00.000Z',
  decision: { statement: 'Taken down', target: { kind: 'post' as const, id: 'post-1' } },
  canResolve: true,
};

function source(overrides: Partial<WorkbenchNativeSource> = {}): WorkbenchNativeSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async realms() {
      calls.push('realms');
      return { items: [{ id: 'realm-1', title: 'Writers' }], next: null };
    },
    async boards() {
      calls.push('boards');
      return { items: [{ id: boardId, title: 'Club' }], next: null };
    },
    async boardReports(_id, cursor, selection) {
      calls.push(`boardReports:${selection.status}:${cursor ?? ''}`);
      return { reports: [report], next: cursor ? null : 'native-report-cursor' };
    },
    async boardAppeals(_id, cursor) {
      calls.push(`boardAppeals:${cursor ?? ''}`);
      return { appeals: [appeal], next: null };
    },
    async catalogueReports() {
      calls.push('catalogue');
      throw new Error('catalogue must not run for a board queue');
    },
    ...overrides,
  };
}

const ready = {
  state: 'ready' as const,
  realms: [] as [],
  realmsNext: null,
  boards: [] as [],
  boardsNext: null,
  cases: [] as [],
  next: null,
};

async function mount(node: React.ReactNode) {
  const host = document.createElement('main');
  document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return host;
}

test('workbench is a signed-in route and keeps catalogue off a board scope', () => {
  expect(isSignedInPath('/en/moderation/workbench')).toBe(true);
  const board = workbenchSearch({ board: boardId, realm: 'realm-1', queue: 'reports', scope: 'catalogue' });
  expect(board.scope).toBe('catalogue');
  expect(board.board).toBeUndefined();
  expect(workbenchSearch({ board: boardId, queue: 'resolved' }).status).toBe('resolved');
  expect(workbenchSearch({ board: boardId, queue: 'reports' }).status).toBe('pending');
  expect(workbenchCaseHref({ kind: 'board', boardId }, 'report')).toBe(`/boards/${boardId}/moderation`);
  expect(workbenchCaseHref({ kind: 'board', boardId }, 'appeal')).toBe(`/boards/${boardId}/moderation?tab=appeals`);
  expect(workbenchCaseHref({ kind: 'catalogue' }, 'report')).toBe('/moderation/catalogue');
});

test('board queues stay distinct, continue with the native cursor, and never call catalogue', async () => {
  const native = source();
  const reports = await readWorkbench(native, workbenchSearch({ board: boardId, queue: 'reports' }));
  expect(reports.cases.map((item) => item.id)).toEqual([reportId]);
  expect(reports.cases[0]?.evidence).toBe(report.evidence);
  expect(reports.next).toBe('native-report-cursor');
  const continued = await readWorkbench(
    native,
    workbenchSearch({ board: boardId, queue: 'reports', cursor: 'native-report-cursor' }),
  );
  expect(native.calls.filter((call) => call.startsWith('boardReports'))).toEqual([
    'boardReports:pending:',
    'boardReports:pending:native-report-cursor',
  ]);
  expect(continued.next).toBeNull();
  const appeals = await readWorkbench(native, workbenchSearch({ board: boardId, queue: 'appeals' }));
  expect(appeals.cases.map((item) => [item.kind, item.id])).toEqual([['appeal', appealId]]);
  expect(appeals.cases[0]?.evidence).toBeNull();
  const resolved = await readWorkbench(native, workbenchSearch({ board: boardId, queue: 'resolved' }));
  expect(native.calls).toContain('boardReports:resolved:');
  expect(resolved.cases[0]?.kind).toBe('report');
  expect(native.calls).not.toContain('catalogue');
});

test('catalogue denial stays denied without cases, and catalogue appeals do not invent a list', async () => {
  const denied = source({
    async catalogueReports() {
      const error = new Error('denied') as Error & { state: 'denied' };
      error.state = 'denied';
      throw error;
    },
  });
  await expect(readWorkbench(denied, workbenchSearch({ scope: 'catalogue', queue: 'reports' }))).rejects.toMatchObject({
    state: 'denied',
  });
  const idle = source({
    async catalogueReports() {
      throw new Error('catalogue appeals have no native list');
    },
  });
  const appeals = await readWorkbench(idle, workbenchSearch({ scope: 'catalogue', queue: 'appeals' }));
  expect(appeals.cases).toEqual([]);
  expect(idle.calls).not.toContain('catalogue');
});

test('the workbench view covers preparation, empty, denied, unavailable recovery and a case link', async () => {
  const searches: unknown[] = [];
  const retries: number[] = [];
  const search = workbenchSearch({ board: boardId, queue: 'reports' });
  const preparing = await mount(<WorkbenchPreparing />);
  expect(preparing.textContent).toContain(m.moderation_workbench_preparing());
  const empty = await mount(
    <WorkbenchView page={{ ...ready, search }} onSearch={(value) => searches.push(value)} />,
  );
  expect(empty.textContent).toContain(m.moderation_workbench_empty());
  const denied = await mount(
    <WorkbenchView page={{ ...ready, state: 'denied', search }} onSearch={(value) => searches.push(value)} />,
  );
  expect(denied.textContent).toContain(m.moderation_workbench_denied());
  expect(denied.textContent).not.toContain(report.evidence);
  const unavailable = await mount(
    <WorkbenchView
      page={{ ...ready, state: 'unavailable', search }}
      onSearch={(value) => searches.push(value)}
      onRetry={() => retries.push(1)}
    />,
  );
  expect(unavailable.textContent).toContain(m.moderation_workbench_unavailable());
  await act(async () => {
    unavailable.querySelector('button')?.click();
  });
  expect(retries).toEqual([1]);
  const loaded = await mount(
    <WorkbenchView
      page={{
        ...ready,
        search,
        cases: [
          {
            kind: 'report',
            id: reportId,
            createdAt: report.createdAt,
            outcome: null,
            reason: report.reason,
            evidence: report.evidence,
            statement: null,
            decisionId: null,
            target: report.target,
          },
        ],
        next: 'native-report-cursor',
      }}
      onSearch={(value) => searches.push(value)}
    />,
  );
  const link = loaded.querySelector(`a[href*="/boards/${boardId}/moderation"]`);
  expect(link?.textContent).toContain(reportId);
  expect(loaded.textContent).toContain(report.evidence);
  await act(async () => {
    [...loaded.querySelectorAll('button')].find((button) => button.textContent === m.threads_next_page())?.click();
  });
  expect(searches.at(-1)).toMatchObject({ cursor: 'native-report-cursor', board: boardId, queue: 'reports' });
});
