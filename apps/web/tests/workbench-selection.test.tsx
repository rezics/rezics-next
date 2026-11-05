import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import type { Report } from '../src/moderation/reports-read';
import { m } from '../src/paraglide/messages.js';

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
const { workbenchSearch } = await import('../src/moderation/workbench-queue/scope');
const { readWorkbench } = await import('../src/moderation/workbench-queue/read');
const { workbenchLoadedReports, createWorkbenchSelection, WorkbenchSelection } =
  await import('../src/moderation/workbench-selection');
const { WorkbenchView } = await import('../src/moderation/workbench-queue/view');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');

const pending = (id: string, extra: Partial<Report> = {}): Report => ({
  id,
  target: { kind: 'post', id: `post-${id}` },
  revisionId: `revision-${id}`,
  reason: 'spam',
  evidence: null,
  createdAt: '2026-10-01T09:30:00.000Z',
  outcome: null,
  resolvedAt: null,
  ...extra,
});

const boardSearch = workbenchSearch({ board: 'board-club', queue: 'reports' });

async function mount(node: React.ReactNode) {
  const host = document.createElement('main');
  document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return host;
}

test('selection keeps original revision fields and excludes appeals, resolved cases and catalogue', async () => {
  const reports = [
    pending('r1'),
    pending('r2', { outcome: 'dismissed', resolvedAt: '2026-10-02T00:00:00.000Z' }),
    ...Array.from({ length: 21 }, (_, index) => pending(`extra-${index}`)),
  ];
  const page = await readWorkbench(
    {
      async realms() {
        return { items: [], next: null };
      },
      async boards() {
        return { items: [], next: null };
      },
      async boardReports() {
        return { reports: reports.slice(0, 20), next: 'more' };
      },
      async boardAppeals() {
        return { appeals: [], next: null };
      },
      async catalogueReports() {
        return {
          reports: [{ ...pending('cat'), target: { kind: 'subject' as const, id: 'subject-1' } }],
          next: null,
        };
      },
    },
    boardSearch,
  );
  expect(page.reports[0]?.revisionId).toBe('revision-r1');
  expect(page.reports[1]?.resolvedAt).toBe('2026-10-02T00:00:00.000Z');
  const loaded = workbenchLoadedReports(page.reports, boardSearch);
  expect(loaded.map((report) => report.id)).toEqual([
    'r1',
    ...Array.from({ length: 18 }, (_, index) => `extra-${index}`),
  ]);
  expect(loaded).toHaveLength(19);
  expect(workbenchLoadedReports(page.reports, workbenchSearch({ board: 'board-club', queue: 'appeals' }))).toEqual([]);
  expect(workbenchLoadedReports(page.reports, workbenchSearch({ board: 'board-club', queue: 'resolved' }))).toEqual([]);
  expect(workbenchLoadedReports(page.reports, workbenchSearch({ scope: 'catalogue', queue: 'reports' }))).toEqual([]);
});

test('review names the board and selected reports, confirm stops after a failure, and retry keeps the original command', async () => {
  const reports = [pending('r1'), pending('r2'), pending('r3')];
  let current = true;
  const commands: unknown[] = [];
  const controller = createWorkbenchSelection(reports, boardSearch, () => current);
  controller.selectLoaded();
  controller.toggle('r3');
  expect(controller.getSnapshot().selected).toEqual(['r1', 'r2']);
  controller.review();
  const host = await mount(
    <WorkbenchSelection
      controller={controller}
      boardId="board-club"
      reports={reports}
      onAction={async (command) => {
        commands.push(command);
        if (command.reportId === 'r1') return { ok: true };
        return { ok: false, state: 'conflict' };
      }}
    />,
  );
  expect(host.textContent).toContain(
    m.moderation_workbench_selection_identity({ board: 'board-club', reports: 'r1, r2' }),
  );
  await act(async () => {
    await controller.confirm(async (command) => {
      commands.push(command);
      if (command.reportId === 'r1') return { ok: true };
      return { ok: false, state: 'conflict' };
    });
  });
  const snapshot = controller.getSnapshot();
  expect(snapshot.items.map((item) => [item.reportId, item.state])).toEqual([
    ['r1', 'dismissed'],
    ['r2', 'conflict'],
  ]);
  expect(commands).toHaveLength(2);
  const retry = createWorkbenchSelection(reports, boardSearch, () => current);
  retry.toggle('r1');
  retry.toggle('r2');
  retry.review();
  const keys: string[] = [];
  await retry.confirm(async (command) => {
    keys.push(command.idempotencyKey);
    return command.reportId === 'r1' ? { ok: true } : { ok: false, state: 'uncertain' };
  });
  expect(retry.getSnapshot().items.map((item) => item.state)).toEqual(['dismissed', 'uncertain']);
  await retry.retry('r2', async (command) => {
    expect(command.idempotencyKey).toBe(keys[1]);
    expect(command.reportId).toBe('r2');
    return { ok: true };
  });
  expect(retry.getSnapshot().items.map((item) => item.state)).toEqual(['dismissed', 'dismissed']);
  current = false;
  const retired = createWorkbenchSelection(reports, boardSearch, () => current);
  retired.selectLoaded();
  expect(retired.getSnapshot().selected).toEqual([]);
});

test('replacing the workbench reading retires selection, and locales keep interpolation', async () => {
  const reports = [pending('r1')];
  const controller = createWorkbenchSelection(reports, boardSearch, () => true);
  controller.selectLoaded();
  const host = await mount(
    <WorkbenchView
      page={{
        state: 'ready',
        search: boardSearch,
        realms: [],
        realmsNext: null,
        boards: [],
        boardsNext: null,
        cases: [
          {
            kind: 'report',
            id: 'r1',
            createdAt: '2026-10-01T09:30:00.000Z',
            outcome: null,
            reason: 'spam',
            evidence: null,
            statement: null,
            decisionId: null,
            target: { kind: 'post', id: 'post-r1' },
          },
        ],
        reports,
        next: null,
      }}
      onSearch={() => {}}
      selection={controller}
      onAction={async () => ({ ok: true })}
    />,
  );
  expect(host.querySelector('a[href*="/moderation/cases/r1"]')).toBeTruthy();
  expect(host.textContent).toContain(m.moderation_bulk_select_report({ number: 1 }));
  controller.retire();
  expect(controller.selectable('r1')).toBe(false);
  const locale = getLocale();
  try {
    for (const next of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const) {
      await setLocale(next, { reload: false });
      const text = m.moderation_workbench_selection_identity({ board: 'board-club', reports: 'r1' });
      expect(text).toContain('board-club');
      expect(text).toContain('r1');
    }
  } finally {
    await setLocale(locale, { reload: false });
  }
});
