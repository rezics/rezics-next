import { afterAll, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { userEvent } from 'storybook/test';
import * as start from '../.storybook/react-start';
import { ReportsBulkControls, ReportsBulkRefreshFailure } from '../src/moderation/reports-bulk-controls';
import { createReportsBulkAction, type BulkItemState } from '../src/moderation/reports-bulk-action';
import type { ReportQueueAction } from '../src/moderation/reports-view-action';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { moderationQueueFixture, postReport } from '../src/stories/patterns/board-report-queue/fixture';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
afterAll(() => mock.restore());
const { BoardReportQueue } = await import('../src/stories/patterns/board-report-queue/board-report-queue');
const { ModerationReportsView } = await import('../src/moderation/reports-page');
const reports = [...moderationQueueFixture.reports, { ...postReport, id: 'PRIVATE_THIRD_REPORT' }];
type Props = ComponentProps<typeof ReportsBulkControls>;

// Authored UNRUN. Real components and controllers with supplied public callback outcomes.
// DOM observations cannot prove geometry, native authorization or physical accessibility.
function Controls(props: Omit<Props, 'snapshot'>) {
  const snapshot = useSyncExternalStore(
    props.controller.subscribe,
    props.controller.getSnapshot,
    props.controller.getSnapshot,
  );
  return <ReportsBulkControls {...props} snapshot={snapshot} />;
}

async function withView(
  run: (context: {
    host: HTMLElement;
    render: (node: ReactNode) => Promise<void>;
    user: ReturnType<typeof userEvent.setup>;
    flush: () => Promise<void>;
  }) => Promise<void>,
) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/boards/community/moderation' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    ShadowRoot: window.ShadowRoot,
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
  const require = createRequire(import.meta.url);
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const locale = getLocale();
  const render = (node: ReactNode) =>
    act(async () => root.render(<QueryClientProvider client={cache}>{node}</QueryClientProvider>));
  const flush = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  try {
    await setLocale('en', { reload: false });
    await run({ host, render, user, flush });
  } finally {
    await act(async () => root.unmount());
    cache.clear();
    await setLocale(locale, { reload: false });
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function button(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
  expect(found, label).toBeDefined();
  return found!;
}
function publicOnly(surface: HTMLElement, keys: readonly string[] = []) {
  expect(surface.querySelector('details, [hidden], textarea, input, a')).toBeNull();
  for (const report of reports)
    for (const secret of [report.id, report.target.id, report.revisionId, report.evidence, ...keys])
      if (secret) expect(surface.outerHTML).not.toContain(secret);
}
function wrappingControls(surface: HTMLElement) {
  expect(surface.className).toContain('min-w-0');
  expect(surface.className).toContain('[overflow-wrap:anywhere]');
  for (const control of surface.querySelectorAll('button')) {
    for (const token of [
      'h-auto',
      'min-h-11',
      'min-w-11',
      'max-w-full',
      'whitespace-normal',
      'focus-visible:outline-2',
    ])
      expect(control.classList.contains(token)).toBe(true);
    expect(control.closest('a, details')).toBeNull();
  }
  for (const text of surface.querySelectorAll('h2, h3, p, li, span'))
    expect(text.className).not.toMatch(/truncate|line-clamp|sr-only/);
}

test('Complete usable bulk moderation controls', async () => {
  await withView(async ({ host, render, user }) => {
    const controller = createReportsBulkAction(reports);
    const calls: Parameters<ReportQueueAction>[0][] = [];
    await render(
      <Controls
        controller={controller}
        onAction={async (input) => {
          calls.push(input);
          return { ok: true };
        }}
      />,
    );
    const article = host.querySelector('article')!;
    const select = button(host, m.moderation_bulk_select_loaded());
    expect(button(host, m.moderation_bulk_clear()).disabled).toBe(true);
    expect(button(host, m.moderation_bulk_review()).disabled).toBe(true);
    expect(article.textContent).toContain(m.moderation_bulk_bound());
    wrappingControls(article);
    publicOnly(article);
    select.focus();
    await act(async () => user.keyboard('{Enter}'));
    expect(article.textContent).toContain(m.moderation_bulk_selected({ count: 3 }));
    await act(async () => user.tab());
    expect(host.ownerDocument.activeElement).toBe(button(host, m.moderation_bulk_clear()));
    await act(async () => user.keyboard(' '));
    expect(controller.getSnapshot().selected).toEqual([]);
    select.focus();
    await act(async () => user.keyboard('{Enter}'));
    await act(async () => {
      await user.tab();
      await user.tab();
      await user.keyboard('{Enter}');
    });
    const group = host.querySelector('[role="group"]')!;
    expect(host.ownerDocument.activeElement).toBe(group);
    expect(group.textContent).toContain(m.moderation_bulk_confirmation({ count: 3 }));
    expect(group.closest('details')).toBeNull();
    expect(group.className).toContain('focus-visible:outline-2');
    wrappingControls(article);
    await act(async () => user.tab());
    expect(host.ownerDocument.activeElement).toBe(button(host, m.moderation_bulk_confirm({ count: 3 })));
    await act(async () => user.tab());
    expect(host.ownerDocument.activeElement).toBe(button(host, m.moderation_bulk_cancel()));
    await act(async () => user.keyboard(' '));
    expect(host.ownerDocument.activeElement).toBe(button(host, m.moderation_bulk_review()));
    expect(calls).toEqual([]);
    expect(controller.getSnapshot().selected).toHaveLength(3);
  });
});

test('Partial and uncertain receipts stay visible; explicit retry preserves the same command and never resumes later rows', async () => {
  await withView(async ({ host, render, user, flush }) => {
    const controller = createReportsBulkAction(reports);
    const calls: Parameters<ReportQueueAction>[0][] = [];
    let refreshes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onAction: ReportQueueAction = async (input) => {
      calls.push(input);
      if (calls.length === 1) await gate;
      if (calls.length === 2) throw new TypeError('Failed to fetch');
      return { ok: true };
    };
    const onRefresh = async () => {
      refreshes++;
      throw new Error('PRIVATE_REFRESH_FAILURE');
    };
    await render(<Controls controller={controller} onAction={onAction} onRefresh={onRefresh} />);
    await act(async () => user.click(button(host, m.moderation_bulk_select_loaded())));
    await act(async () => user.click(button(host, m.moderation_bulk_review())));
    await act(async () => user.click(button(host, m.moderation_bulk_confirm({ count: 3 }))));
    expect(host.textContent).toContain(m.moderation_bulk_running());
    expect(host.textContent).toContain(m.moderation_bulk_pending());
    expect(host.querySelector('button')).toBeNull();
    expect(calls).toHaveLength(1);
    await act(async () => release());
    await flush();
    expect(calls).toHaveLength(2);
    expect(refreshes).toBe(0);
    expect(host.textContent).toContain(m.moderation_bulk_uncertain());
    expect(host.textContent).toContain(m.moderation_bulk_unattempted());
    expect(host.querySelector('ol')?.getAttribute('aria-live')).toBe('polite');
    expect(host.querySelector('[tabindex="-1"]')).toBe(host.ownerDocument.activeElement);
    const article = host.querySelector('article')!;
    publicOnly(
      article,
      calls.map((call) => call.idempotencyKey),
    );
    wrappingControls(article);
    expect([...article.querySelectorAll('button')].map((node) => node.textContent)).toEqual([
      m.moderation_bulk_retry(),
    ]);
    button(host, m.moderation_bulk_retry()).focus();
    await act(async () => user.keyboard('{Enter}'));
    await flush();
    expect(calls).toHaveLength(3);
    expect(calls[2]).toBe(calls[1]);
    expect(calls.some((call) => call.reportId === reports[2]!.id)).toBe(false);
    expect(refreshes).toBe(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.moderation_bulk_stale());
    expect([...host.querySelectorAll('ol > li')].map((node) => node.textContent)).toEqual([
      `${m.moderation_bulk_item({ number: 1 })} ${m.moderation_bulk_dismissed()}`,
      `${m.moderation_bulk_item({ number: 2 })} ${m.moderation_bulk_dismissed()}`,
      `${m.moderation_bulk_item({ number: 3 })} ${m.moderation_bulk_unattempted()}`,
    ]);
    publicOnly(article, ['PRIVATE_REFRESH_FAILURE', ...calls.map((call) => call.idempotencyKey)]);
    wrappingControls(article);
    await act(async () => user.click(button(host, m.moderation_bulk_refresh())));
    expect(refreshes).toBe(2);
    expect(calls).toHaveLength(3);
  });
});

test('Localized selection and confirmation labels wrap completely at 390/1280 and RTL without issuing commands', async () => {
  await withView(async ({ host, render }) => {
    let calls = 0;
    const onAction: ReportQueueAction = async () => {
      calls++;
      return { ok: true };
    };
    for (const locale of ['en', 'de', 'fr', 'es', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const) {
      await setLocale(locale, { reload: false });
      for (const width of [390, 1280])
        for (const dir of ['ltr', 'rtl'] as const) {
          const controller = createReportsBulkAction(reports);
          await render(
            <div dir={dir} style={{ width, maxWidth: '100%' }}>
              <Controls key={`${locale}-${width}-${dir}`} controller={controller} onAction={onAction} />
            </div>,
          );
          const article = host.querySelector('article')!;
          expect([...article.querySelectorAll('button')].map((node) => node.textContent)).toEqual([
            m.moderation_bulk_select_loaded(),
            m.moderation_bulk_clear(),
            m.moderation_bulk_review(),
          ]);
          wrappingControls(article);
          await act(async () => {
            controller.selectLoaded();
            controller.review();
          });
          expect(article.querySelector('h3')?.textContent).toBe(m.moderation_bulk_confirmation({ count: 3 }));
          expect([...article.querySelectorAll('button')].map((node) => node.textContent)).toEqual([
            m.moderation_bulk_confirm({ count: 3 }),
            m.moderation_bulk_cancel(),
          ]);
          wrappingControls(article);
          publicOnly(article);
        }
    }
    expect(calls).toBe(0);
  });
});

test('All public receipt states retain their supplied positions and complete localized text at 390/1280 and RTL', async () => {
  await withView(async ({ host, render }) => {
    const outcomes: [BulkItemState, () => string][] = [
      ['unattempted', m.moderation_bulk_unattempted],
      ['pending', m.moderation_bulk_pending],
      ['dismissed', m.moderation_bulk_dismissed],
      ['uncertain', m.moderation_bulk_uncertain],
      ['conflict', m.moderation_bulk_conflict],
      ['forbidden', m.moderation_bulk_forbidden],
      ['sign-in', m.moderation_bulk_sign_in],
      ['unavailable', m.moderation_bulk_unavailable],
      ['error', m.moderation_bulk_error],
    ];
    const items = outcomes.map(([state], index) => ({
      reportId: `PRIVATE_RECEIPT_ID_${index}`,
      position: index * 2 + 1,
      state,
      evidence: 'PRIVATE_EVIDENCE',
      idempotencyKey: 'PRIVATE_KEY',
      authorization: 'PRIVATE_AUTHORITY',
    }));
    for (const locale of ['en', 'de', 'fr', 'es', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const) {
      await setLocale(locale, { reload: false });
      for (const width of [390, 1280])
        for (const dir of ['ltr', 'rtl'] as const) {
          await render(
            <div dir={dir} style={{ width, maxWidth: '100%' }}>
              <ReportsBulkRefreshFailure items={items} />
            </div>,
          );
          const receipt = host.querySelector<HTMLElement>('[role="alert"]')!;
          expect(host.ownerDocument.getElementById(receipt.getAttribute('aria-labelledby')!)?.textContent).toBe(
            m.moderation_bulk_stale(),
          );
          expect([...receipt.querySelectorAll('li')].map((node) => node.textContent)).toEqual(
            outcomes.map(
              ([, label], index) => `${m.moderation_bulk_item({ number: items[index]!.position })} ${label()}`,
            ),
          );
          expect(receipt.querySelector('button')).toBeNull();
          expect(receipt.innerHTML).not.toContain('PRIVATE_');
          wrappingControls(receipt);
          publicOnly(receipt);
        }
    }
  });
});

test('Failed replacement reads keep public partial receipts while queue replacement retires all results and private data', async () => {
  await withView(async ({ host, render, user, flush }) => {
    let calls = 0;
    let refreshes = 0;
    const onAction: ReportQueueAction = async () => (++calls === 1 ? { ok: true } : { ok: false, state: 'forbidden' });
    const props = {
      ...moderationQueueFixture,
      reports,
      queueIdentity: 'one-original-visit',
      onAction,
      onRefresh: async () => {
        refreshes++;
        throw new Error('PRIVATE_REPLACEMENT_ERROR');
      },
    };
    await render(<BoardReportQueue {...props} />);
    await act(async () => user.click(button(host, m.moderation_bulk_select_loaded())));
    await act(async () => user.click(button(host, m.moderation_bulk_review())));
    await act(async () => user.click(button(host, m.moderation_bulk_confirm({ count: 3 }))));
    await flush();
    expect(calls).toBe(2);
    expect(refreshes).toBe(1);
    expect(host.textContent).toContain(m.moderation_bulk_forbidden());
    await render(<BoardReportQueue {...props} state="error" />);
    const receipt = [...host.querySelectorAll<HTMLElement>('[role="alert"]')].find((node) => node.querySelector('ol'))!;
    expect(receipt.textContent).toContain(m.moderation_bulk_stale());
    expect(receipt.textContent).toContain(m.moderation_bulk_dismissed());
    expect(receipt.textContent).toContain(m.moderation_bulk_forbidden());
    expect(receipt.textContent).toContain(m.moderation_bulk_unattempted());
    publicOnly(receipt, ['PRIVATE_REPLACEMENT_ERROR']);
    expect(host.innerHTML).not.toContain(postReport.evidence!);
    for (const state of ['loading', 'denied', 'stale', 'error'] as const) {
      await render(<BoardReportQueue {...props} queueIdentity={`replacement-${state}`} state={state} />);
      expect(host.innerHTML).not.toContain(postReport.evidence!);
      expect(host.innerHTML).not.toContain(postReport.id);
      expect(host.textContent).not.toContain(m.moderation_bulk_dismissed());
      expect(host.querySelector('ol, textarea, [role="checkbox"]')).toBeNull();
    }
    expect(calls).toBe(2);
    expect(refreshes).toBe(1);
  });
});

const warns = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
const departure = (host: HTMLElement) => host.ownerDocument.querySelector<HTMLElement>('[role="alertdialog"]')!;

test('Stay retains exact loaded selection and review; Cancel and Clear stay local; Leave fences the running bulk loop', async () => {
  await withView(async ({ host, render, user, flush }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0,
      refreshes = 0,
      nexts = 0;
    await render(
      <BoardReportQueue
        {...moderationQueueFixture}
        reports={reports}
        onNext={() => {
          nexts++;
        }}
        onRefresh={async () => {
          refreshes++;
        }}
        onAction={async () => {
          calls++;
          await gate;
          return { ok: true };
        }}
      />,
    );
    await act(async () =>
      user.click(
        [...host.querySelectorAll('button')].filter((node) => node.textContent === m.moderation_queue_review())[1]!,
      ),
    );
    const otherReason = host.querySelectorAll('textarea')[1]!;
    await act(async () => user.type(otherReason, 'Another local review.'));
    const boxes = [...host.querySelectorAll<HTMLElement>('[role="checkbox"]')];
    await act(async () => {
      await user.click(boxes[0]!);
      await user.click(boxes[2]!);
    });
    await act(async () => user.click(button(host, m.moderation_bulk_review())));
    await act(async () => user.click(button(host, m.threads_next_page())));
    expect(departure(host).textContent).toContain(m.moderation_review_leave_unsaved());
    await act(async () => user.click(button(departure(host), m.thread_authoring_stay())));
    expect(otherReason.value).toBe('Another local review.');
    expect(boxes.map((box) => box.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true']);
    expect(host.querySelector('[role="group"]')?.textContent).toContain(m.moderation_bulk_confirmation({ count: 2 }));
    await act(async () => user.click(button(host, m.moderation_bulk_cancel())));
    expect(warns()).toBe(true);
    await act(async () => user.click(button(host, m.moderation_bulk_clear())));
    expect(warns()).toBe(true);
    await act(async () => user.clear(otherReason));
    expect(warns()).toBe(false);
    await act(async () => user.click(button(host, m.moderation_bulk_select_loaded())));
    await act(async () => user.click(button(host, m.moderation_bulk_review())));
    await act(async () => user.click(button(host, m.moderation_bulk_confirm({ count: 3 }))));
    await act(async () => user.click(button(host, m.threads_next_page())));
    expect(departure(host).textContent).toContain(m.moderation_review_leave_pending());
    await act(async () => user.click(button(departure(host), m.thread_authoring_leave())));
    await act(async () => release());
    await flush();
    expect([calls, refreshes, nexts]).toEqual([1, 0, 1]);
    expect(host.textContent).not.toContain(postReport.evidence!);
    expect(warns()).toBe(false);
  });
});

test('Mixed bulk results keep exact retry and unattempted work protected during the follow-up read', async () => {
  await withView(async ({ host, render, user, flush }) => {
    const calls: Parameters<ReportQueueAction>[0][] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let selections = 0,
      refreshes = 0;
    await render(
      <ModerationReportsView
        {...moderationQueueFixture}
        reports={reports}
        onSelection={() => {
          selections++;
        }}
        onRefresh={async () => {
          refreshes++;
          await gate;
        }}
        onAction={async (input) => {
          calls.push(input);
          if (calls.length === 2) throw new TypeError('Failed to fetch');
          return { ok: true };
        }}
      />,
    );
    await act(async () => user.click(button(host, m.moderation_bulk_select_loaded())));
    await act(async () => user.click(button(host, m.moderation_bulk_review())));
    await act(async () => user.click(button(host, m.moderation_bulk_confirm({ count: 3 }))));
    await flush();
    await act(async () => user.click(button(host, m.moderation_filter_reset())));
    await act(async () => user.click(button(departure(host), m.thread_authoring_stay())));
    expect(host.textContent).toContain(m.moderation_bulk_uncertain());
    expect(host.textContent).toContain(m.moderation_bulk_unattempted());
    await act(async () => user.click(button(host, m.moderation_bulk_retry())));
    await flush();
    expect(calls).toHaveLength(3);
    expect(calls[2]).toBe(calls[1]);
    expect(calls.some((call) => call.reportId === reports[2]!.id)).toBe(false);
    expect(refreshes).toBe(1);
    expect(warns()).toBe(true);
    await act(async () => user.click(button(host, m.moderation_filter_reset())));
    expect(departure(host).textContent).toContain(m.moderation_review_leave_unsaved());
    await act(async () => user.click(button(departure(host), m.thread_authoring_leave())));
    await act(async () => release());
    await flush();
    expect(selections).toBe(1);
    expect(host.textContent).not.toContain(postReport.evidence!);
  });
});

test('Individual browsing and receipts do not warn; Stay preserves the reason and exact uncertain command', async () => {
  await withView(async ({ host, render, user, flush }) => {
    const calls: Parameters<ReportQueueAction>[0][] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let selections = 0;
    await render(
      <ModerationReportsView
        {...moderationQueueFixture}
        reports={[postReport]}
        onSelection={() => {
          selections++;
        }}
        onRefresh={async () => gate}
        onAction={async (input) => {
          calls.push(input);
          if (calls.length === 1) throw new TypeError('Failed to fetch');
          return { ok: true };
        }}
      />,
    );
    await act(async () => user.click(button(host, m.moderation_queue_review())));
    expect(warns()).toBe(false);
    const reason = host.querySelector('textarea')!;
    await act(async () => user.type(reason, 'Preserve this exact reason.'));
    await act(async () => user.click(button(host, m.moderation_filter_reset())));
    await act(async () => user.click(button(departure(host), m.thread_authoring_stay())));
    expect(reason.value).toBe('Preserve this exact reason.');
    await act(async () => user.click(button(host, m.moderation_take_down())));
    await flush();
    await act(async () => user.click(button(host, m.moderation_filter_reset())));
    expect(departure(host).textContent).toContain(m.moderation_review_leave_pending());
    await act(async () => user.click(button(departure(host), m.thread_authoring_stay())));
    expect(reason.value).toBe('Preserve this exact reason.');
    await act(async () => user.click(button(host, m.moderation_queue_retry_action())));
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
    expect(Object.isFrozen(calls[0])).toBe(true);
    expect(warns()).toBe(false);
    await act(async () => user.click(button(host, m.moderation_filter_reset())));
    expect(departure(host)).toBeNull();
    expect(selections).toBe(1);
    await act(async () => release());
  });
});

test('An enclosing shared owner blocks search-only route reads and retires report continuations before Leave proceeds', async () => {
  await withView(async ({ host, render, user }) => {
    const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
      await import('@tanstack/react-router');
    const { AuthoringDepartureProvider } = await import('../src/threads/authoring-departure');
    let reads = 0,
      calls = 0;
    let stale!: HTMLButtonElement;
    const shell = createRootRoute({
      component: () => (
        <AuthoringDepartureProvider sessionBound={false}>
          <Outlet />
        </AuthoringDepartureProvider>
      ),
    });
    const route = createRoute({
      getParentRoute: () => shell,
      path: '/review',
      validateSearch: (search: Record<string, unknown>) => ({
        tab: search.tab === 'appeals' ? ('appeals' as const) : ('reports' as const),
      }),
      loaderDeps: ({ search }) => search,
      loader: () => {
        reads++;
        if (stale) stale.click();
        return null;
      },
      component: Review,
    });
    function Review() {
      return (
        <ModerationReportsView
          {...moderationQueueFixture}
          tab={route.useSearch().tab}
          onAction={async () => {
            calls++;
            return { ok: true };
          }}
        />
      );
    }
    const router = createRouter({
      routeTree: shell.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ['/review'] }),
    });
    await router.load();
    await render(<RouterProvider router={router} />);
    await act(async () => user.click(host.querySelector<HTMLElement>('[role="checkbox"]')!));
    stale = [...host.querySelectorAll('button')].filter((node) => node.textContent === m.moderation_dismiss())[1]!;
    let navigation!: Promise<void>;
    await act(async () => {
      navigation = router.navigate({ to: '/review', search: { tab: 'appeals' } });
    });
    expect(departure(host).textContent).toContain(m.moderation_review_leave_unsaved());
    expect(reads).toBe(1);
    await act(async () => user.click(button(departure(host), m.thread_authoring_stay())));
    await navigation;
    expect(reads).toBe(1);
    expect(host.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      navigation = router.navigate({ to: '/review', search: { tab: 'appeals' } });
    });
    await act(async () => user.click(button(departure(host), m.thread_authoring_leave())));
    await act(async () => navigation);
    expect(reads).toBe(2);
    expect(calls).toBe(0);
  });
});
