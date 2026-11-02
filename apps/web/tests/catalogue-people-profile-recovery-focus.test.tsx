import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import type { PeopleRead } from '../src/features/catalogue/people-profile';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('People correction reload hands off only current keyboard focus intent', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/person/people' });
  const globals = {
    window,
    ...Object.fromEntries(
      [
        'document',
        'navigator',
        'HTMLElement',
        'HTMLInputElement',
        'HTMLSelectElement',
        'Element',
        'Node',
        'MutationObserver',
        'ResizeObserver',
        'Document',
        'DocumentFragment',
      ].map((key) => [key, Reflect.get(window, key)]),
    ),
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { PeopleProfileEditor } = await import('../src/features/catalogue/people-profile-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { peopleProfileFixture } = await import('../src/kernel/fake/catalogue-people-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const fixture = peopleProfileFixture('ready', 'en', 'person');
  const initial = await fixture.transport.load();
  if (!initial.ok) throw new Error('Expected a current Person profile');
  let loads = 0;
  let nextRead: Promise<PeopleRead> | undefined;
  const transport = {
    ...fixture.transport,
    load: async () => {
      loads++;
      return loads === 1 ? initial : await nextRead!;
    },
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const outside = window.document.createElement('button');
  outside.textContent = 'Outside';
  window.document.body.append(outside);
  const root = createRoot(host);
  const settle = (action: () => void = () => {}) =>
    act(async () => {
      action();
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  const show = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary observed={{ state: 'signed-in', subject: 'viewer', csrfToken: 'token' }} address={fixture.id}>
            <PeopleProfileEditor
              id={fixture.id}
              locale="en"
              session="signed-in"
              transport={transport}
              propose={fixture.propose}
              review={fixture.review}
              onNavigate={() => {}}
            />
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
  const reload = () => within(host).getByRole('button', { name: m.correction_reload() });
  const next = () => {
    let finish!: (read: PeopleRead) => void;
    nextRead = new Promise((resolve) => (finish = resolve));
    return finish;
  };
  try {
    await show();
    await settle();
    const success = next();
    reload().focus();
    await act(async () => user.keyboard('{Enter}'));
    expect(within(host).getByRole('status').textContent).toBe(m.catalogue_create_loading());
    await settle(() => success(initial));
    const heading = within(host).getByRole('heading', { level: 1 });
    expect(window.document.activeElement).toBe(heading);

    const failure = next();
    reload().focus();
    await act(async () => user.keyboard('{Enter}'));
    await settle(() => failure({ ok: false, reason: 'unavailable' }));
    const retry = within(host).getByRole('button', { name: m.correction_retry() });
    expect(window.document.activeElement).toBe(retry);

    const moved = next();
    retry.focus();
    await act(async () => user.keyboard('{Enter}'));
    outside.focus();
    await settle(() => moved(initial));
    expect(window.document.activeElement).toBe(outside);

    const pointer = next();
    await act(async () => user.click(reload()));
    await settle(() => pointer(initial));
    expect(window.document.activeElement).not.toBe(within(host).getByRole('heading', { level: 1 }));

    const retired = next();
    reload().focus();
    await act(async () => user.keyboard('{Enter}'));
    await act(async () => root.render(null));
    outside.focus();
    await settle(() => retired(initial));
    expect(window.document.activeElement).toBe(outside);
    expect(host.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
