import { afterAll, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ComponentProps, type ReactNode } from 'react';
import type { userEvent } from 'storybook/test';
import * as start from '../.storybook/react-start';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { selectedQueueFixture, postReport } from '../src/stories/patterns/board-report-queue/fixture';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
afterAll(() => mock.restore());
const { ModerationReportsPage, ModerationReportsView } = await import('../src/moderation/reports-page');
const { DEFAULT_REPORT_SELECTION, loadModerationReportsRequest, prepareModerationReportRead } =
  await import('../src/moderation/reports-read');
type Props = ComponentProps<typeof ModerationReportsView>;
type Selection = NonNullable<Props['selection']>;

// Authored UNRUN. Happy DOM checks mounted semantics and interaction; real layout, native
// authority and browser accessibility remain integration obligations, with story observations below.
async function withView(
  run: (context: {
    host: HTMLElement;
    cache: QueryClient;
    render: (node: ReactNode) => Promise<void>;
    user: ReturnType<typeof userEvent.setup>;
    window: { document: Document };
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
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLButtonElement: window.HTMLButtonElement,
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
  cache.setQueryData(['session'], { state: 'signed-in', subject: 'moderator', csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA' });
  const locale = getLocale();
  const render = (node: ReactNode) =>
    act(async () => root.render(<QueryClientProvider client={cache}>{node}</QueryClientProvider>));
  try {
    await setLocale('en', { reload: false });
    await run({ host, cache, render, user, window });
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

const scope = { boardId: 'community /?', threadId: 'thread +/雪', postId: 'post?&=é' };
const expectedReports =
  '?thread=thread%20%2B%2F%E9%9B%AA&post=post%3F%26%3D%C3%A9&status=pending&targetKind=post&order=oldest';
const expectedAppeals = '?tab=appeals&thread=thread%20%2B%2F%E9%9B%AA&post=post%3F%26%3D%C3%A9';
function controls(host: HTMLElement) {
  const fieldset = host.querySelector('fieldset')!;
  const selects = [...fieldset.querySelectorAll('select')];
  const reset = fieldset.querySelector('button')!;
  const summary = host.ownerDocument.getElementById(fieldset.getAttribute('aria-describedby')!)!;
  return { fieldset, selects, reset, summary };
}

test('Moderator queue navigation and filter controls remain independently accessible across supplied states', async () => {
  await withView(async ({ host, render, user, window }) => {
    const calls: Selection[] = [];
    const destinations: string[] = [];
    host.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement).closest('a');
      if (link) {
        destinations.push(link.getAttribute('href')!);
        event.preventDefault();
      }
    });
    for (const tab of ['reports', 'appeals'] as const) {
      await render(
        <ModerationReportsView
          key={tab}
          {...selectedQueueFixture}
          {...scope}
          tab={tab}
          next={null}
          onSelection={(value) => {
            calls.push(value);
          }}
        />,
      );
      expect(host.querySelectorAll('h1')).toHaveLength(1);
      expect(host.querySelector('h1')?.textContent).toBe(m.moderation_reports_heading());
      expect(host.querySelector('header p')?.textContent).toBe(m.moderation_queue_post_scope());
      const nav = host.querySelector('nav')!;
      expect(nav.getAttribute('aria-label')).toBe(m.moderation_tabs_label());
      const links = [...nav.querySelectorAll('a')];
      expect(links.map((link) => link.textContent)).toEqual([m.moderation_reports_tab(), m.moderation_appeals_tab()]);
      expect(links.map((link) => link.getAttribute('href'))).toEqual([expectedReports, expectedAppeals]);
      expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
      expect(links[tab === 'reports' ? 0 : 1]!.getAttribute('aria-current')).toBe('page');
      expect(links[tab === 'reports' ? 0 : 1]!.className).toContain('border-primary');
      const back = host.querySelector('header a')!;
      expect(back.getAttribute('href')).toBe('/en/boards/community%20%2F%3F');
      const { fieldset, selects, reset, summary } = controls(host);
      expect(fieldset.querySelector('legend')?.textContent).toBe(m.moderation_filter_label());
      expect(selects.map((select) => select.value)).toEqual(['pending', 'post', 'oldest']);
      expect(selects.map((select) => select.closest('label')?.querySelector('span')?.textContent)).toEqual([
        m.moderation_filter_status(),
        m.moderation_filter_kind(),
        m.moderation_filter_order(),
      ]);
      for (const select of selects) expect(select.closest('label')?.htmlFor).toBe(select.id);
      expect(summary.textContent).toBe(
        m.moderation_controls_details_summary({
          status: m.moderation_filter_pending(),
          kind: m.moderation_queue_post(),
          order: m.moderation_filter_oldest(),
        }),
      );
      for (const control of [back, ...links, ...selects, reset]) {
        expect(control.closest('a a, a button, button a')).toBeNull();
        expect(control.tabIndex).toBe(0);
      }
      for (const link of links) {
        expect(link.className).toContain('min-h-11');
        expect(link.className).toContain('min-w-11');
        expect(link.className).toContain('focus-visible:outline-2');
      }
      for (const select of selects) expect(select.parentElement!.className).toContain('[&_select]:min-h-11');
      expect(reset.className).toContain('min-h-11');
      back.focus();
      for (const next of [...links, ...selects, reset]) {
        await act(async () => user.tab());
        expect(window.document.activeElement).toBe(next);
      }
      for (const link of [back, ...links]) {
        link.focus();
        await act(async () => user.keyboard('{Enter}'));
      }
      expect(calls).toEqual([]);
    }
    expect(destinations).toEqual([
      '/en/boards/community%20%2F%3F',
      expectedReports,
      expectedAppeals,
      '/en/boards/community%20%2F%3F',
      expectedReports,
      expectedAppeals,
    ]);
    const changes = [
      { index: 0, value: 'resolved', expected: { status: 'resolved', targetKind: 'post', order: 'oldest' } },
      { index: 1, value: 'thread', expected: { status: 'pending', targetKind: 'thread', order: 'oldest' } },
      { index: 2, value: 'newest', expected: { status: 'pending', targetKind: 'post', order: 'newest' } },
    ] as const;
    for (const change of changes) {
      await render(
        <ModerationReportsView
          key={change.index}
          {...selectedQueueFixture}
          next={null}
          onSelection={(value) => {
            calls.push(value);
          }}
        />,
      );
      const { selects, summary } = controls(host);
      const originalSummary = summary.textContent;
      await act(async () => user.selectOptions(selects[change.index]!, change.value));
      expect(calls.at(-1)).toEqual(change.expected);
      expect(summary.textContent).toBe(originalSummary); // Display follows supplied props only.
      await render(
        <ModerationReportsView
          key={change.index}
          {...selectedQueueFixture}
          selection={change.expected}
          next={null}
          onSelection={(value) => {
            calls.push(value);
          }}
        />,
      );
      const supplied = controls(host);
      for (const select of supplied.selects)
        expect(supplied.summary.textContent).toContain(select.selectedOptions[0]!.textContent!);
    }
    await render(
      <ModerationReportsView
        key="reset"
        {...selectedQueueFixture}
        next={null}
        onSelection={(value) => {
          calls.push(value);
        }}
      />,
    );
    controls(host).reset.focus();
    await act(async () => user.keyboard('{Enter}'));
    expect(calls).toHaveLength(4);
    expect(calls.at(-1)).toBe(DEFAULT_REPORT_SELECTION);
  });
});

test('Localized selected labels remain complete in wrapping control groups at phone/desktop widths and in RTL', async () => {
  await withView(async ({ host, render }) => {
    for (const locale of ['en', 'de', 'fr', 'es', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const) {
      await setLocale(locale, { reload: false });
      for (const width of [390, 1280])
        for (const dir of ['ltr', 'rtl'] as const) {
          await render(
            <div dir={dir} style={{ width, maxWidth: '100%' }}>
              <ModerationReportsView
                {...scope}
                reports={[]}
                targets={[]}
                next="PRIVATE_CURSOR"
                onSelection={() => {}}
              />
            </div>,
          );
          const { fieldset, selects, summary, reset } = controls(host);
          expect(host.querySelector('nav')?.className).toContain('flex-wrap');
          expect(fieldset.className).toContain('flex-wrap');
          expect(fieldset.className).toContain('min-w-0');
          for (const select of selects) {
            expect(select.closest('label')?.className).toContain('min-w-0');
            expect(select.parentElement!.className).toContain('max-w-full');
            expect(summary.textContent).toContain(select.selectedOptions[0]!.textContent!);
          }
          expect(reset.className).toContain('whitespace-normal');
          expect(summary.closest('article')?.className).toContain('[overflow-wrap:anywhere]');
          expect(summary.className).not.toMatch(/truncate|line-clamp|sr-only/);
          expect(summary.textContent).toBe(
            m.moderation_controls_details_summary({
              status: m.moderation_filter_all_status(),
              kind: m.moderation_filter_all_kinds(),
              order: m.moderation_filter_newest(),
            }),
          );
          for (const text of [
            summary.textContent!,
            ...[...host.querySelectorAll('h1, h2, h3')].map((h) => h.textContent!),
          ])
            for (const privateValue of [
              'PRIVATE_CURSOR',
              scope.boardId,
              scope.threadId,
              scope.postId,
              'targetKind',
              'newest',
            ])
              expect(text).not.toContain(privateValue);
          expect(host.textContent).not.toContain('PRIVATE_CURSOR');
        }
    }
  });
});

test('Pending selection and missing handlers disable only filters while read states and session withholding retain their projections', async () => {
  await withView(async ({ host, render, user, cache }) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: Selection[] = [];
    await render(
      <ModerationReportsView
        {...selectedQueueFixture}
        boardId="community"
        next={null}
        onSelection={(value) => {
          calls.push(value);
          return pending;
        }}
      />,
    );
    await act(async () => user.selectOptions(controls(host).selects[0]!, 'resolved'));
    expect(controls(host).fieldset.disabled).toBe(true);
    expect(host.textContent).toContain(m.moderation_queue_loading());
    expect(host.textContent).not.toContain(postReport.evidence!);
    for (const link of host.querySelectorAll('header a, nav a')) {
      link.focus();
      expect(host.ownerDocument.activeElement).toBe(link);
    }
    await act(async () => user.click(controls(host).reset));
    expect(calls).toHaveLength(1);
    await act(async () => release());
    expect(controls(host).fieldset.disabled).toBe(false);
    await render(<ModerationReportsView key="no-handler" {...selectedQueueFixture} next={null} />);
    expect(controls(host).fieldset.disabled).toBe(true);
    await act(async () => user.click(controls(host).reset));
    expect(calls).toHaveLength(1);
    for (const [state, message] of [
      ['loading', m.moderation_queue_loading()],
      ['denied', m.moderation_queue_read_denied()],
      ['stale', m.moderation_queue_stale()],
      ['error', m.moderation_queue_error()],
    ] as const) {
      await render(<ModerationReportsView key={state} {...selectedQueueFixture} state={state} next="PRIVATE_CURSOR" />);
      expect(host.textContent).toContain(message);
      for (const secret of [
        postReport.evidence!,
        postReport.id,
        postReport.target.id,
        postReport.revisionId!,
        'PRIVATE_CURSOR',
      ])
        expect(host.innerHTML).not.toContain(secret);
      expect(host.querySelector('textarea, ol')).toBeNull();
      expect(host.querySelectorAll('nav a')).toHaveLength(2);
    }
    await render(
      <ModerationReportsView
        key="withheld"
        {...selectedQueueFixture}
        next={null}
        targets={[
          {
            key: `post:${postReport.target.id}`,
            kind: 'post',
            value: { post: { availability: 'withheld', body: 'PRIVATE_BODY' } },
          },
        ]}
        revisions={[
          { reportId: postReport.id, value: { post: { availability: 'withheld', body: 'PRIVATE_REVISION' } } },
        ]}
      />,
    );
    expect(host.querySelectorAll('[data-slot="withheld"]')).toHaveLength(2);
    expect(host.innerHTML).not.toContain('PRIVATE_BODY');
    expect(host.innerHTML).not.toContain('PRIVATE_REVISION');
    for (const state of ['signed-out', 'unavailable', 'denied', 'unknown'] as const) {
      await act(async () => cache.setQueryData(['session'], { state, subject: null, csrfToken: null }));
      await render(<ModerationReportsView key={state} {...selectedQueueFixture} viewerId="moderator" next={null} />);
      expect(host.querySelector('[role="status"] h2')?.textContent).toBe(m.moderation_target_unavailable());
      expect(host.querySelector('nav, fieldset, ol, textarea, a')).toBeNull();
      expect(host.innerHTML).not.toContain(postReport.id);
      expect(host.textContent).not.toContain(postReport.evidence!);
    }
  });
});

test('An actual prepared Reports visit retires its controls, records and references on session replacement', async () => {
  await withView(async ({ host, cache, render }) => {
    const { createKernelClient } = await import('@rezics/client');
    const input = { boardId: 'community', ...selectedQueueFixture.selection };
    const native = createKernelClient('https://kernel.test', {
      fetch: async (url, init) => {
        const path = new URL(new Request(url, init).url).pathname;
        return path.endsWith('/reports')
          ? Response.json({ reports: [postReport], next: 'PRIVATE_CURSOR' })
          : Response.json({ code: 'not_found' }, { status: 404 });
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
            subject: 'moderator',
            accessToken: 'moderator',
            csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
          }),
        }),
      },
    } as unknown as import('../src/session/client').SessionEnv;
    const page = await prepareModerationReportRead(
      cache,
      input,
      (data) =>
        loadModerationReportsRequest(
          new Request('https://site.test/boards/community/moderation', {
            headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
          }),
          environment,
          data,
          () => native,
        ),
      new AbortController().signal,
    );
    await render(<ModerationReportsPage page={page} input={input} onSelection={() => {}} />);
    expect(host.textContent).toContain(postReport.evidence!);
    expect(host.querySelectorAll('nav a')).toHaveLength(2);
    await act(async () =>
      cache.setQueryData(['session'], {
        state: 'signed-in',
        subject: 'moderator',
        csrfToken: 'BBBBBBBBBBBBBBBBBBBBBB',
      }),
    );
    expect(host.textContent).toContain(m.moderation_target_unavailable());
    expect(host.querySelector('nav, fieldset, ol, textarea, a')).toBeNull();
    for (const secret of [
      postReport.id,
      postReport.target.id,
      postReport.revisionId!,
      postReport.evidence!,
      'PRIVATE_CURSOR',
    ])
      expect(host.innerHTML).not.toContain(secret);
  });
});
