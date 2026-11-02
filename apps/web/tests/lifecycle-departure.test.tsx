import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import type { Intent, Outcome, Page } from '../src/accounts/lifecycle-controls/data';

test('lifecycle departure preserves review on Stay, retires local work on Leave and revokes replaced authority', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/' });
  const globals = Object.fromEntries(
    'document navigator HTMLElement HTMLFormElement Element Node Document DocumentFragment MutationObserver ResizeObserver'
      .split(' ')
      .map((key) => [key, Reflect.get(window, key)]),
  );
  Object.assign(globals, {
    window,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const routerModule = await import('@tanstack/react-router');
  let block!: (input: { current: { pathname: string }; next: { pathname: string } }) => boolean | Promise<boolean>;
  mock.module('@tanstack/react-router', () => ({
    ...routerModule,
    useRouter: () => ({}),
    useBlocker: (options: { shouldBlockFn: typeof block }) => {
      block = options.shouldBlockFn;
    },
  }));
  const { AuthoringDepartureProvider } = await import('../src/threads/authoring-departure');
  const { AccountLifecyclePage } = await import('../src/accounts/lifecycle-controls/page');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const client = new QueryClient();
  const session = { state: 'signed-in' as const, subject: 'operator', csrfToken: 'original' };
  client.setQueryData(sessionQuery.queryKey, session);
  const ready: Page = {
    status: 'ready',
    account: { id: '01a1a000-0000-7000-8000-000000000101', kind: 'actor', displayName: 'Reader', handle: 'reader' },
    offered: ['suspend', 'reinstate'],
    currentState: 'unavailable',
  };
  let finish!: (outcome: Outcome) => void;
  const commands: Intent[] = [];
  const signals: AbortSignal[] = [];
  const io = {
    read: async () => ready,
    change: (intent: Intent, signal: AbortSignal) => {
      commands.push(intent);
      signals.push(signal);
      return new Promise<Outcome>((resolve) => {
        finish = resolve;
      });
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const click = async (label: string) =>
    act(async () =>
      user.click([...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)!),
    );
  const settle = async (condition: () => boolean) => {
    for (let n = 0; n < 100 && !condition(); n++)
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    expect(condition()).toBe(true);
  };
  let show = true;
  const render = () =>
    root.render(
      <QueryClientProvider client={client}>
        <AuthoringDepartureProvider sessionBound={false}>
          {show ? <AccountLifecyclePage initial={ready} io={io} /> : <p>Away</p>}
        </AuthoringDepartureProvider>
      </QueryClientProvider>,
    );
  const navigate = async () => {
    await act(async () => {
      void Promise.resolve(block({ current: { pathname: '/' }, next: { pathname: '/away' } })).then((stay) => {
        if (!stay) {
          show = false;
          render();
        }
      });
    });
    await settle(() => !show || !!dialog());
  };
  const back = () =>
    act(async () => {
      show = true;
      initial = ready;
      render();
    });
  const blocked = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const dialog = () => document.querySelector('[role="alertdialog"]');
  const draft = async () => act(async () => user.type(host.querySelector('textarea')!, '  private reason  '));
  try {
    await act(async () => render());
    host.querySelector('textarea')!.focus();
    expect(blocked()).toBe(false);
    await draft();
    await act(async () => user.selectOptions(host.querySelector('select')!, 'reinstate'));
    expect(blocked()).toBe(true);
    const reason = host.querySelector('textarea')!;
    reason.focus();
    await navigate();
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(dialog()!.textContent).toContain(m.lifecycle_leave_unsaved());
    await click(m.thread_authoring_stay());
    await settle(() => !dialog() && document.activeElement === reason);
    expect(reason.value).toBe('  private reason  ');
    expect(host.querySelector('select')!.value).toBe('reinstate');
    await click(m.lifecycle_review());
    await click(m.lifecycle_confirm());
    await navigate();
    expect(dialog()!.textContent).toContain(m.container_lifecycle_leave_pending());
    await click(m.thread_authoring_stay());
    expect(commands).toHaveLength(1);
    expect(commands[0]!.reason).toBe('  private reason  ');
    expect(host.querySelector('section')!.textContent).toContain(commands[0]!.key);
    await navigate();
    await click(m.thread_authoring_leave());
    expect(signals[0]!.aborted).toBe(true);
    await back();
    await draft();
    await act(async () => finish({ status: 'recorded', receiptId: 'late', current: ready }));
    expect(host.querySelector('textarea')!.value).toBe('  private reason  ');
    expect(host.textContent).not.toContain('late');
    await click(m.lifecycle_review());
    await click(m.lifecycle_confirm());
    await act(async () =>
      finish({
        status: 'recorded',
        receiptId: 'complete',
        current: ready,
        effects: {
          state: 'complete',
          operator: 'complete',
          sessionRevocation: 'not_required',
          sessionRevocationAuthorization: 'not_required',
          accountAgentSynchronization: 'unknown',
          inspectedPages: 0,
          terminalSubjects: 0,
        },
      }),
    );
    expect(blocked()).toBe(false);
    await navigate();
    await back();
    await draft();
    await navigate();
    await act(async () => client.setQueryData(sessionQuery.queryKey, { ...session, csrfToken: 'replacement' }));
    await settle(() => !show && !dialog());
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
