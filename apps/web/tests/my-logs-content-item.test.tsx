import { afterAll, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import recording from '../src/kernel/recorded/library-published-logs.json';
import type { PublishedLog } from '../src/library/logs-read';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
afterAll(() => mock.restore());

// UNRUN: composed presentation assertions; native, browser and acceptance proof remain deferred.
test('My Logs uses shared item anatomy with stable immutable snapshot identity dates full notes and admission controlled log actions', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library/logs' });
  window.document.documentElement.lang = 'en';
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { MyLogsPageView } = await import('../src/library/my-logs-page');
  const { subjectOf } = await import('../src/library/reads');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { fullDateTime } = await import('../src/threads/byline');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'owner', csrfToken: 'csrf' });
  client.setQueryData(exposureQuery.queryKey, ['reading_progress']);
  client.setQueryData(['exposure', 'anonymous'], []);

  const recorded = recording.publishedLogs[0]!;
  const subject = {
    ...subjectOf(recorded.subject)!,
    label: { value: 'こころ — 夏の記録', language: 'ja' },
  };
  const first: PublishedLog = { ...recorded, sessionState: 'active', subject };
  const second: PublishedLog = {
    ...first,
    id: '01a17a3b-70dd-709a-b040-f4cc8099977c',
    sessionState: 'completed',
    startedAt: '2026-10-27T09:00:00.000Z',
    completedAt: '2026-10-28T09:00:00.000Z',
    publishedAt: '2026-10-28T09:05:00.000Z',
    note: `${recorded.note}\n\n再読の記録。 ${'The full note keeps every supplied word. '.repeat(12)}`,
  };
  const show = async (logs: PublishedLog[]) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MyLogsPageView page={{ state: 'loaded', logs, next: null, restarted: false }} />
        </QueryClientProvider>,
      ),
    );
  };
  const rows = () => [...host.querySelectorAll<HTMLLIElement>('ol > li')];
  const logHref = (log: PublishedLog, locale = 'en') => `/${locale}/logs/${encodeURIComponent(log.id)}`;

  try {
    setLocale('en', { reload: false });
    await show([first, second]);
    expect(host.querySelector('h1')?.textContent).toBe(m.library_my_logs_heading());
    expect(host.querySelector('ol')?.getAttribute('aria-label')).toBe(m.library_logs_heading());
    const originalRows = rows();
    expect(originalRows).toHaveLength(2);
    const headingIds: string[] = [];
    for (const [index, log] of [first, second].entries()) {
      const row = originalRows[index]!;
      const title = row.querySelector('h2')!;
      expect(row.getAttribute('data-slot')).toBe('list-row');
      expect(row.querySelectorAll('[data-content-item-slot="title"]')).toHaveLength(1);
      expect(title.textContent).toBe(subject.label.value);
      expect(title.lang).toBe('ja');
      headingIds.push(title.id);
      expect(row.querySelector('li, a a, a button, a summary, summary a')).toBeNull();
      expect(row.querySelector('[data-slot="list-row-link"]')).toBeNull();
      expect(row.querySelector('[data-content-item-slot="visual"] img')?.getAttribute('alt')).toBe('');
      expect(row.querySelector('img')?.getAttribute('src')).toContain(recorded.subject.cover.media);
      const dates = [log.publishedAt, log.startedAt, ...(log.completedAt ? [log.completedAt] : [])];
      expect([...row.querySelectorAll('time')].map((time) => time.dateTime)).toEqual(dates);
      expect([...row.querySelectorAll('time')].map((time) => time.textContent)).toEqual(
        dates.map((date) => fullDateTime(date, 'en')),
      );
      const metadata = row.querySelector('[data-content-item-slot="metadata"]')!;
      expect(metadata.textContent).toContain(m.library_logs_published());
      expect(metadata.textContent).toContain(m.library_logs_started());
      expect(metadata.textContent?.includes(m.library_logs_completed())).toBe(log.completedAt !== null);
      const state = index === 0 ? m.library_progress_state_active() : m.library_progress_state_completed();
      expect(row.querySelector('[data-content-item-slot="state"]')?.textContent).toBe(
        `${m.library_logs_session_state()}: ${state}`,
      );
      const links = [...row.querySelectorAll('a')];
      expect(links.map((link) => link.getAttribute('href'))).toEqual([logHref(log)]);
      expect(links[0]!.getAttribute('aria-label')).toBe(
        m.library_my_logs_read({ title: subject.label.value, date: fullDateTime(log.publishedAt, 'en') }),
      );
      expect(links[0]!.textContent).toBe(m.library_my_logs_open_log());
      expect(row.querySelector('summary [aria-hidden="true"]')?.textContent).toBe(log.note);
      expect(row.querySelector('details > p')?.textContent).toBe(log.note);
    }
    expect(new Set(headingIds).size).toBe(2);

    const details = originalRows[1]!.querySelector('details')!;
    const summary = details.querySelector('summary')!;
    expect(details.open).toBe(false);
    expect(summary.querySelector('[aria-hidden="true"]')?.textContent).toBe(second.note);
    expect(summary.textContent).toContain(m.library_my_logs_full_note());
    // Native summary remains in keyboard order, independently of the log link.
    originalRows[1]!.querySelector<HTMLElement>('a')!.focus();
    await act(async () => user.tab({ shift: true }));
    expect(window.document.activeElement).toBe(summary);
    expect(summary.getAttribute('tabindex')).toBeNull();
    // Happy DOM/user-event supplies summary click toggling, but not native Enter/Space activation.
    await act(async () => user.click(summary));
    expect(details.open).toBe(true);
    expect(details.querySelector('p')?.textContent).toBe(second.note);
    expect(originalRows[0]!.querySelector('details')?.open).toBe(false);
    await act(async () => user.tab());
    expect(window.document.activeElement).toBe(originalRows[1]!.querySelector('a'));

    await show([second, first]);
    expect(rows()[0]).toBe(originalRows[1]);
    expect(rows()[1]).toBe(originalRows[0]);
    expect(rows()[0]!.querySelector('h2')?.id).toBe(headingIds[1]);
    expect(rows()[0]!.querySelector('details')?.open).toBe(true);
    expect(rows()[0]!.querySelector('details > p')?.textContent).toBe(second.note);

    await act(async () => {
      client.setQueryData(exposureQuery.queryKey, []);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rows()).toHaveLength(2);
    expect(host.querySelectorAll('ol a')).toHaveLength(0);
    expect(rows()[0]!.querySelector('details')?.open).toBe(true);
    await act(async () => {
      client.setQueryData(exposureQuery.queryKey, ['reading_progress']);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect([...host.querySelectorAll('ol a')].map((link) => link.getAttribute('href'))).toEqual([
      logHref(second),
      logHref(first),
    ]);

    const unknown: PublishedLog = { ...first, id: 'unknown-snapshot', subject: null, note: null };
    setLocale('fr', { reload: false });
    await show([first, unknown]);
    expect(rows()[0]!.querySelector('h2')?.lang).toBe('ja');
    expect(rows()[0]!.querySelector('h2')?.textContent).toBe(subject.label.value);
    const unknownRow = rows()[1]!;
    expect(unknownRow.querySelector('h2')?.textContent).toBe(m.library_subject_unavailable());
    expect(unknownRow.querySelector('h2')?.hasAttribute('lang')).toBe(false);
    expect(unknownRow.querySelector('[data-content-item-slot="visual"]')).not.toBeNull();
    expect(unknownRow.querySelector('img, details, [role="progressbar"]')).toBeNull();
    expect(unknownRow.querySelectorAll('time')).toHaveLength(2);
    expect([...host.querySelectorAll('ol a')].map((link) => link.getAttribute('href'))).toEqual([
      logHref(first, 'fr'),
      logHref(unknown, 'fr'),
    ]);
    expect(unknownRow.querySelector('a')?.getAttribute('aria-label')).toBe(
      m.library_my_logs_read({
        title: m.library_subject_unavailable(),
        date: fullDateTime(unknown.publishedAt, 'fr'),
      }),
    );
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setLocale('en', { reload: false });
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
