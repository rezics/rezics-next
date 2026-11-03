import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, Profiler, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Appeal } from '../src/moderation/appeals-read';
import type { Report } from '../src/moderation/reports-read';
import type { ReportQueueAction } from '../src/moderation/reports-view-action';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';

mock.module('cloudflare:workers', () => ({ env: {} }));

let restoreModerationRenderDiagnosis: (() => void) | undefined;
afterEach(() => {
  restoreModerationRenderDiagnosis?.();
  restoreModerationRenderDiagnosis = undefined;
});

const { loadModerationReportsRequest, prepareModerationReportRead } = await import('../src/moderation/reports-read');

const reportId = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const longEvidence = `Full submitted evidence starts here.\n${'The evidence remains complete across its original paragraph. '.repeat(80)}End of submitted evidence.`;
const longRevision = `Historical reported revision starts here.\n${'The historic revision is kept separately from the current target. '.repeat(50)}End of historical revision.`;
const longCurrent = `Current target starts here.\n${'The current target is independently supplied and disclosed. '.repeat(50)}End of current target.`;
const linkedTargetBody = {
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'moderation-target-source' },
        content: [
          { type: 'text', text: longCurrent },
          {
            type: 'text',
            text: ' independently linked source',
            marks: [{ type: 'link', attrs: { href: 'https://example.test/source' } }],
          },
        ],
      },
    ],
  },
};

const reportRows: Report[] = [
  {
    id: reportId(1),
    target: { kind: 'post', id: reportId(50) },
    revisionId: reportId(51),
    reason: 'other',
    evidence: longEvidence,
    createdAt: '2026-10-29T08:30:00.000Z',
    outcome: null,
    resolvedAt: null,
  },
  {
    id: reportId(2),
    target: { kind: 'post', id: reportId(52) },
    revisionId: reportId(53),
    reason: 'illegal',
    evidence: 'A submitted statement about withheld content.',
    createdAt: '2026-10-29T09:30:00.000Z',
    outcome: null,
    resolvedAt: null,
  },
  {
    id: reportId(3),
    target: { kind: 'thread', id: reportId(54) },
    revisionId: null,
    reason: 'spam',
    evidence: null,
    createdAt: '2026-10-29T10:30:00.000Z',
    outcome: 'dismissed',
    resolvedAt: '2026-10-30T10:30:00.000Z',
  },
];

const longDecision = `Original decision statement.\n${'The entire decision rationale remains part of the case. '.repeat(45)}End of original decision.`;
const longAppeal = `Appeal statement.\n${'The complete appeal statement remains available to the reviewer. '.repeat(45)}End of appeal statement.`;
const longResolution = `Resolution statement.\n${'The complete resolution statement is retained in the receipt. '.repeat(45)}End of resolution.`;
const appeals: Appeal[] = [
  {
    id: reportId(101),
    decisionId: reportId(201),
    appellantId: 'PRIVATE_APPELLANT',
    statement: longAppeal,
    createdAt: '2026-10-30T01:00:00.000Z',
    decision: {
      statement: longDecision,
      target: { kind: 'post', id: reportId(250) },
      appeal: null,
    },
    canResolve: true,
  },
  {
    id: reportId(102),
    decisionId: reportId(202),
    appellantId: 'PRIVATE_APPELLANT_2',
    statement: 'A separate resolved appeal statement.',
    createdAt: '2026-10-30T02:00:00.000Z',
    decision: {
      statement: 'A separate original moderator decision.',
      target: { kind: 'post', id: reportId(251) },
      appeal: {
        outcome: 'upheld',
        statement: longResolution,
        resolvedAt: '2026-10-31T03:00:00.000Z',
      },
    },
    canResolve: true,
  },
];

const currentSession = {
  state: 'signed-in' as const,
  subject: 'moderator',
  csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
};

async function withDom(
  run: (context: {
    window: Awaited<ReturnType<typeof makeWindow>>['window'];
    host: HTMLDivElement;
    root: Root;
    cache: QueryClient;
    render: (node: ReactNode) => Promise<void>;
    flush: () => Promise<void>;
  }) => Promise<void>,
) {
  const { window, restore } = await makeWindow();
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['session'], currentSession);
  const flush = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const render = async (node: ReactNode) =>
    act(async () => {
      root.render(createElement(QueryClientProvider, { client: cache, children: node }));
    });
  try {
    await setLocale('en', { reload: false });
    await run({ window, host: host as unknown as HTMLDivElement, root, cache, render, flush });
  } finally {
    await act(async () => root.unmount());
    cache.clear();
    await window.happyDOM.close();
    restore();
  }
}

async function makeWindow() {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/boards/community/moderation' });
  window.document.documentElement.lang = 'en';
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    NodeFilter: window.NodeFilter,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    CSS: window.CSS,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return {
    window,
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((element) => element.textContent === text);
  expect(button, text).toBeDefined();
  return button as HTMLButtonElement;
}

async function clickButton(host: HTMLElement, text: string, flush: () => Promise<void>) {
  await act(async () => buttonByText(host, text).click());
  await flush();
}

test('Reports and Appeals compose complete, independently labelled case frames around real evidence and review controls', async () => {
  await withDom(async ({ host, render }) => {
    const { ModerationAppealsView } = await import('../src/moderation/appeals-tab');
    const { ModerationReportsView } = await import('../src/moderation/reports-page');
    const revisions = [
      { reportId: reportRows[0]!.id, value: { post: { id: reportRows[0]!.target.id, body: longRevision } } },
      {
        reportId: reportRows[1]!.id,
        value: { post: { id: reportRows[1]!.target.id, availability: 'withheld', body: 'PRIVATE_HISTORICAL_BODY' } },
      },
    ];
    const targets = [
      {
        key: `post:${reportRows[0]!.target.id}`,
        kind: 'post' as const,
        value: { post: { id: reportRows[0]!.target.id, body: linkedTargetBody } },
      },
      {
        key: `post:${reportRows[1]!.target.id}`,
        kind: 'post' as const,
        value: { post: { id: reportRows[1]!.target.id, availability: 'withheld', body: 'PRIVATE_CURRENT_BODY' } },
      },
      {
        key: `thread:${reportRows[2]!.target.id}`,
        kind: 'thread' as const,
        value: { thread: { id: reportRows[2]!.target.id, title: 'Resolved thread target' } },
      },
    ];
    await render(
      createElement(ModerationReportsView, {
        boardId: reportId(10),
        reports: reportRows,
        targets,
        revisions,
        next: null,
        onAction: async () => ({ ok: true }),
        onSelection: () => {},
      }),
    );

    expect(host.querySelectorAll('h1')).toHaveLength(1);
    const listItems = [...host.querySelectorAll('ol > li')];
    expect(listItems).toHaveLength(reportRows.length);
    const cards = listItems.map((item) => item.querySelector(':scope > article') as HTMLElement | null);
    expect(cards.every(Boolean)).toBe(true);
    for (const [index, card] of cards.entries()) {
      const row = reportRows[index]!;
      const heading = card!.querySelector(':scope > header h2');
      expect(heading).not.toBeNull();
      expect(card!.textContent).toContain(row.target.id);
      expect(heading?.textContent).not.toContain(row.target.id);
      expect(heading?.closest('a')).toBeNull();
      expect(card!.querySelector('a button, button a, a a')).toBeNull();
    }
    const first = cards[0]!;
    expect(first.textContent).toContain(longEvidence);
    expect(first.textContent).toContain(longRevision);
    expect(first.textContent).toContain(longCurrent);
    const sourceLink = first.querySelector('a[href="https://example.test/source"]');
    expect(sourceLink?.textContent).toContain('independently linked source');
    expect(sourceLink?.querySelector('button')).toBeNull();
    expect(first.querySelectorAll('h3').length).toBeGreaterThanOrEqual(3);
    expect([...first.querySelectorAll('h3')].map((heading) => heading.textContent)).toContain(
      m.moderation_reported_revision_label(),
    );
    expect([...first.querySelectorAll('h3')].map((heading) => heading.textContent)).toContain(
      m.moderation_current_target_label(),
    );
    expect(first.querySelector('time')?.getAttribute('datetime')).toBe(reportRows[0]!.createdAt);
    const review = [...first.querySelectorAll('button')].find(
      (element) => element.textContent === m.moderation_queue_review(),
    );
    expect(review).toBeDefined();
    await act(async () => (review as HTMLButtonElement).click());
    expect(first.querySelector('textarea')?.getAttribute('maxlength')).toBe('1024');
    expect(first.querySelector('form')).not.toBeNull();

    const withheld = cards[1]!;
    expect(withheld.textContent).toContain(reportRows[1]!.target.id);
    expect(withheld.querySelectorAll('[data-slot="withheld"]')).toHaveLength(2);
    expect(withheld.textContent).not.toContain('PRIVATE_HISTORICAL_BODY');
    expect(withheld.textContent).not.toContain('PRIVATE_CURRENT_BODY');
    expect(withheld.textContent).not.toContain('PRIVATE');

    const resolved = cards[2]!;
    expect(resolved.textContent).toContain(m.moderation_dismissed());
    expect(resolved.textContent).toContain('Resolved thread target');
    expect([...resolved.querySelectorAll('time')].map((time) => time.getAttribute('datetime'))).toContain(
      reportRows[2]!.resolvedAt,
    );
    expect(resolved.querySelector('form')).toBeNull();
    expect(
      [...resolved.querySelectorAll('button')].some((button) => button.textContent === m.moderation_queue_review()),
    ).toBe(false);

    const appealTargets = [
      {
        key: `post:${appeals[0]!.decision.target!.id}`,
        kind: 'post' as const,
        value: { post: { id: appeals[0]!.decision.target!.id, body: linkedTargetBody } },
      },
      {
        key: `post:${appeals[1]!.decision.target!.id}`,
        kind: 'post' as const,
        value: { post: { id: appeals[1]!.decision.target!.id, body: 'Resolved appeal target text.' } },
      },
    ];
    await render(
      createElement(ModerationAppealsView, {
        appeals,
        targets: appealTargets,
        next: null,
      }),
    );
    const appealItems = [...host.querySelectorAll('ol > li')];
    expect(appealItems).toHaveLength(appeals.length);
    const appealCards = appealItems.map((item) => item.querySelector(':scope > article') as HTMLElement | null);
    expect(appealCards.every(Boolean)).toBe(true);
    const pending = appealCards[0]!;
    const resolvedAppeal = appealCards[1]!;
    expect(pending.querySelector(':scope > header h2')?.textContent).toContain(m.moderation_queue_post());
    expect(pending.textContent).toContain(appeals[0]!.decision.target!.id);
    expect(pending.textContent).toContain(longDecision);
    expect(pending.textContent).toContain(longAppeal);
    expect(pending.textContent).toContain(longCurrent);
    expect(pending.querySelector('a[href="https://example.test/source"]')).not.toBeNull();
    expect(pending.querySelector('time')?.getAttribute('datetime')).toBe(appeals[0]!.createdAt);
    expect(pending.querySelector('form')).not.toBeNull();
    expect(pending.querySelector('form')?.closest('section')).toBeNull();
    expect(pending.querySelector('a button, button a, a a')).toBeNull();
    expect(resolvedAppeal.textContent).toContain(longResolution);
    expect(resolvedAppeal.textContent).toContain(m.moderation_appeal_upheld());
    expect([...resolvedAppeal.querySelectorAll('time')].map((time) => time.getAttribute('datetime'))).toContain(
      appeals[1]!.decision.appeal!.resolvedAt,
    );
    expect(resolvedAppeal.querySelector('form')).toBeNull();
    expect(resolvedAppeal.querySelector('textarea')).toBeNull();
    expect(host.textContent).not.toContain('PRIVATE_APPELLANT');
  });
});

test('report and appeal sparse, loading, denied, stale, unavailable and closed states disclose no case content', async () => {
  await withDom(async ({ cache }) => {
    const { BoardReportQueue } = await import('../src/stories/patterns/board-report-queue/board-report-queue');
    const { ModerationAppealsView } = await import('../src/moderation/appeals-tab');
    const renderStatic = (node: ReactNode) =>
      renderToStaticMarkup(createElement(QueryClientProvider, { client: cache, children: node }));
    const privateReport: Report = { ...reportRows[0]!, evidence: 'PRIVATE_REPORT_EVIDENCE' };
    for (const [state, message] of [
      ['loading', m.moderation_queue_loading()],
      ['denied', m.moderation_queue_read_denied()],
      ['stale', m.moderation_queue_stale()],
      ['error', m.moderation_queue_error()],
    ] as const) {
      const markup = renderStatic(
        createElement(BoardReportQueue, {
          reports: [privateReport],
          targets: [
            {
              key: `post:${privateReport.target.id}`,
              kind: 'post',
              value: { post: { body: 'PRIVATE_REPORT_TARGET' } },
            },
          ],
          revisions: [],
          next: 'opaque/private/cursor==',
          state,
          onAction: async () => {},
          onRetry() {},
          onRestart() {},
        }),
      );
      expect(markup).toContain(message);
      expect(markup).toContain('data-content-item-slot="title"');
      expect(markup).not.toContain('PRIVATE_REPORT_EVIDENCE');
      expect(markup).not.toContain('PRIVATE_REPORT_TARGET');
      expect(markup).not.toContain('opaque/private/cursor==');
      expect(markup).not.toContain('<textarea');
    }
    const sparseReports = renderStatic(
      createElement(BoardReportQueue, {
        reports: [],
        targets: [],
        revisions: [],
        next: 'opaque/private/cursor==',
        onAction: async () => {},
        onNext() {},
      }),
    );
    expect(sparseReports).toContain(m.moderation_reports_empty());
    expect(sparseReports).toContain(m.moderation_queue_empty_next());
    expect(sparseReports).not.toContain('opaque/private/cursor==');

    for (const [state, message] of [
      ['loading', m.moderation_appeals_read_loading()],
      ['unavailable', m.moderation_appeals_read_unavailable()],
      ['stale', m.moderation_appeals_read_stale()],
      ['closed', m.moderation_appeals_read_closed()],
    ] as const) {
      const markup = renderStatic(
        createElement(ModerationAppealsView, {
          appeals,
          targets: [
            {
              key: `post:${appeals[0]!.decision.target!.id}`,
              kind: 'post',
              value: { post: { body: 'PRIVATE_APPEAL_TARGET' } },
            },
          ],
          next: 'opaque/private/appeal-cursor==',
          state,
          onRetry() {},
          onRestart() {},
        }),
      );
      expect(markup).toContain(message);
      expect(markup).toContain('data-content-item-slot="title"');
      expect(markup).not.toContain(longAppeal);
      expect(markup).not.toContain(longDecision);
      expect(markup).not.toContain('PRIVATE_APPEAL_TARGET');
      expect(markup).not.toContain('opaque/private/appeal-cursor==');
      expect(markup).not.toContain('<textarea');
    }
    const sparseAppeals = renderStatic(
      createElement(ModerationAppealsView, { appeals: [], targets: [], next: 'opaque/private/appeal-cursor==' }),
    );
    expect(sparseAppeals).toContain(m.moderation_appeals_read_sparse());
    expect(sparseAppeals).not.toContain('opaque/private/appeal-cursor==');
    const finalAppeals = renderStatic(createElement(ModerationAppealsView, { appeals: [], targets: [], next: null }));
    expect(finalAppeals).toContain(m.moderation_appeals_empty());
    expect(finalAppeals).not.toContain(m.moderation_appeals_read_sparse());
  });
});

test('loaded bulk reports keep the page bound, restore review and cancel focus, and retry only the exact uncertain item', async () => {
  await withDom(async ({ host, render, flush, window }) => {
    let stage = 'mount';
    const bulkModule = await import('../src/moderation/reports-bulk-action');
    const originalFactory = bulkModule.createReportsBulkAction;
    const renderObserverHost = globalThis as typeof globalThis & {
      __moderationRenderObserver?: (component: string) => void;
    };
    const originalRenderObserver = renderObserverHost.__moderationRenderObserver;
    const renderCounts = new Map<string, number>();
    renderObserverHost.__moderationRenderObserver = (component) => {
      const count = (renderCounts.get(component) ?? 0) + 1;
      renderCounts.set(component, count);
      if (count >= 500) throw new Error(`DIAGNOSTIC_RENDER_BUDGET:${component}-${stage}:${count}`);
    };
    let bulkNotifications = 0;
    let bulkSnapshotReads = 0;
    const factorySpy = spyOn(bulkModule, 'createReportsBulkAction').mockImplementation((...args) => {
      const controller = originalFactory(...args);
      const getSnapshot = controller.getSnapshot;
      controller.getSnapshot = () => {
        bulkSnapshotReads++;
        if (bulkSnapshotReads >= 5_000)
          throw new Error(`DIAGNOSTIC_BUDGET:bulk-snapshot:${stage}:${bulkSnapshotReads}`);
        return getSnapshot();
      };
      const subscribe = controller.subscribe;
      controller.subscribe = (listener) =>
        subscribe(() => {
          bulkNotifications++;
          if (bulkNotifications >= 100)
            throw new Error(`DIAGNOSTIC_BUDGET:bulk-notification:${stage}:${bulkNotifications}`);
          listener();
        });
      return controller;
    });
    const { AuthoringDepartureState } = await import('../src/threads/authoring-departure');
    const departurePrototype = AuthoringDepartureState.prototype as unknown as { notify: () => void };
    const originalNotify = departurePrototype.notify;
    let departureNotifications = 0;
    departurePrototype.notify = function (this: InstanceType<typeof AuthoringDepartureState>) {
      departureNotifications++;
      if (departureNotifications >= 200)
        throw new Error(`DIAGNOSTIC_BUDGET:departure-notification:${stage}:${departureNotifications}`);
      originalNotify.call(this);
    };
    restoreModerationRenderDiagnosis = () => {
      factorySpy.mockRestore();
      departurePrototype.notify = originalNotify;
      if (originalRenderObserver) renderObserverHost.__moderationRenderObserver = originalRenderObserver;
      else delete renderObserverHost.__moderationRenderObserver;
    };
    const { BoardReportQueue } = await import('../src/stories/patterns/board-report-queue/board-report-queue');
    const setStage = (next: string) => {
      stage = next;
      console.error(`DIAGNOSTIC_STAGE:${stage}`);
    };
    let commits = 0;
    const onRender = () => {
      commits++;
      if (commits >= 80) throw new Error(`DIAGNOSTIC_RENDER_BUDGET:${stage}:${commits}`);
    };
    const rows = Array.from({ length: 22 }, (_, index): Report => ({
      ...reportRows[0]!,
      id: reportId(300 + index),
      target: { kind: 'post', id: reportId(400 + index) },
      evidence: `Bulk row ${index + 1}`,
    }));
    const calls: Parameters<ReportQueueAction>[0][] = [];
    let refreshes = 0;
    let lostSecond = true;
    const onAction: ReportQueueAction = async (input) => {
      calls.push(input);
      if (input.reportId === rows[1]!.id && lostSecond) {
        lostSecond = false;
        throw new TypeError('Failed to fetch');
      }
      return { ok: true };
    };
    setStage(stage);
    await render(
      createElement(
        Profiler,
        { id: 'moderation-bulk', onRender },
        createElement(BoardReportQueue, {
          reports: rows,
          targets: [],
          next: 'opaque/next/page==',
          onAction,
          onRefresh: async () => {
            refreshes++;
          },
        }),
      ),
    );
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(20);
    setStage('select-loaded');
    await clickButton(host, m.moderation_bulk_select_loaded(), flush);
    expect(host.textContent).toContain(m.moderation_bulk_selected({ count: 20 }));
    setStage('clear');
    await clickButton(host, m.moderation_bulk_clear(), flush);

    const select = async (number: number) => {
      const label = [...host.querySelectorAll('label')].find(
        (element) => element.textContent === m.moderation_bulk_select_report({ number }),
      );
      expect(label).toBeDefined();
      const checkbox = host.querySelector(`[id="${label!.htmlFor}"]`) as unknown as HTMLElement;
      await act(async () => checkbox.click());
    };
    setStage('select-one');
    await select(1);
    setStage('select-two');
    await select(2);
    setStage('select-three');
    await select(3);
    setStage('review-click');
    await act(async () => buttonByText(host, m.moderation_bulk_review()).click());
    setStage('review-flush-start');
    await act(async () => {
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          setStage('review-flush-tick');
          resolve();
        }, 0),
      );
    });
    setStage('review-flush-done');
    const reviewGroup = host.querySelector('[role="group"][tabindex="-1"]') as HTMLElement;
    expect(reviewGroup.textContent).toContain(m.moderation_bulk_confirmation({ count: 3 }));
    expect(window.document.activeElement).toBe(reviewGroup);
    setStage('cancel');
    await clickButton(host, m.moderation_bulk_cancel(), flush);
    expect(window.document.activeElement).toBe(buttonByText(host, m.moderation_bulk_review()));
    expect(calls).toHaveLength(0);

    setStage('confirm');
    await clickButton(host, m.moderation_bulk_review(), flush);
    await clickButton(host, m.moderation_bulk_confirm({ count: 3 }), flush);
    expect(host.textContent).toContain(m.moderation_bulk_dismissed());
    expect(host.textContent).toContain(m.moderation_bulk_uncertain());
    expect(host.textContent).toContain(m.moderation_bulk_unattempted());
    expect(calls).toHaveLength(2);
    expect(calls[0]!.reportId).toBe(rows[0]!.id);
    expect(calls[1]!.reportId).toBe(rows[1]!.id);
    expect(refreshes).toBe(0);

    setStage('exact-retry');
    await clickButton(host, m.moderation_bulk_retry(), flush);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(calls[1]);
    expect(calls[1]!.idempotencyKey).toBe(calls[2]!.idempotencyKey);
    expect(calls.some((call) => call.reportId === rows[2]!.id)).toBe(false);
    expect(refreshes).toBe(1);
    expect(host.textContent).toContain(m.moderation_bulk_unattempted());
    expect(host.textContent).not.toContain('Bulk row 1');
    expect(commits).toBeLessThan(80);
    expect(bulkNotifications).toBeLessThan(100);
    expect(bulkSnapshotReads).toBeLessThan(5_000);
    expect(departureNotifications).toBeLessThan(200);
  });
});

test('the default Reports visit hides its private case when the same account receives a replacement session', async () => {
  await withDom(async ({ host, render, flush, cache }) => {
    const { ModerationReportsPage } = await import('../src/moderation/reports-page');
    const input = {
      boardId: reportId(600),
      status: 'pending' as const,
      targetKind: 'post' as const,
      order: 'newest' as const,
    };
    // The prior hand-authored browserRevision DTO is replaced by actual Request preparation.
    const { createKernelClient } = await import('@rezics/client');
    const { fromPlainText } = await import('@rezics/document');
    const row = { ...reportRows[0]!, evidence: 'PRIVATE_SESSION_EVIDENCE' };
    const post = {
      id: row.target.id,
      threadId: reportId(700),
      revisionId: row.revisionId ?? reportId(701),
      authorId: reportId(702),
      availability: 'available',
      createdAt: row.createdAt,
      revisedAt: null,
      licence: 'CC-BY-SA-4.0',
      sha256: 'a'.repeat(64),
      mediaIds: [],
      body: fromPlainText('PRIVATE_SESSION_TARGET', 'blocks'),
    };
    const native = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const path = new URL(new Request(input, init).url).pathname;
        if (path.endsWith('/reports'))
          return Response.json({ reports: [row], next: 'opaque/private/session-cursor==' });
        if (path.startsWith(`/v1/posts/${post.id}`)) return Response.json({ post });
        return Response.json({ code: 'not_found' }, { status: 404 });
      },
    });
    const environment = {
      AUTH_ISSUER: 'https://auth.test',
      API_RESOURCE: 'https://kernel.test',
      WEBSITE_SCOPES: 'openid',
      WEBSITE_CLIENT_ID: 'web',
      WEBSITE_CLIENT_KEY: '{}',
      SESSIONS: {
        idFromName: (name: string) => name,
        get: () => ({
          credential: async () => ({
            status: 'active',
            subject: currentSession.subject,
            accessToken: 'moderator',
            csrfToken: currentSession.csrfToken,
          }),
        }),
      },
    } as unknown as import('../src/session/client').SessionEnv;
    const page = await prepareModerationReportRead(
      cache,
      input,
      (data) =>
        loadModerationReportsRequest(
          new Request('https://site.test/boards/moderation', {
            headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
          }),
          environment,
          data,
          () => native,
        ),
      new AbortController().signal,
    );
    await render(createElement(ModerationReportsPage, { page, input }));
    expect(host.textContent).toContain('PRIVATE_SESSION_EVIDENCE');
    expect(host.textContent).toContain('PRIVATE_SESSION_TARGET');

    await act(async () =>
      cache.setQueryData(['session'], {
        ...currentSession,
        csrfToken: 'BBBBBBBBBBBBBBBBBBBBBB',
      }),
    );
    await flush();
    expect(host.textContent).toContain(m.moderation_target_unavailable());
    expect(host.querySelector('[role="status"] h2[data-content-item-slot="title"]')).not.toBeNull();
    expect(host.textContent).not.toContain('PRIVATE_SESSION_EVIDENCE');
    expect(host.textContent).not.toContain('PRIVATE_SESSION_TARGET');
    expect(host.textContent).not.toContain('opaque/private/session-cursor==');
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('button')).toBeNull();
    expect(host.querySelector('ol')).toBeNull();
  });
});
