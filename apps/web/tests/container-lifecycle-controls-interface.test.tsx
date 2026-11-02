import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import {
  lifecycleControlsPresentation,
  type ContainerLifecycleAdapter,
  type LifecycleState,
} from '../src/community/container-lifecycle';

const target = { kind: 'space', id: 'space-one' } as const;
const unresolvedRemoval = {
  read: { kind: 'ready', snapshot: { target, head: 'head-one', contextId: null, state: 'removed', actions: [] } },
  reason: 'Repeated disruption',
  intent: {
    target,
    action: 'remove',
    expectedHead: 'head-one',
    idempotencyKey: 'operation-one',
    reason: 'Repeated disruption',
    contextId: null,
  },
  outcome: 'uncertain',
  problem: null,
  destination: null,
  busy: false,
  reviewed: true,
} satisfies LifecycleState;

test('an uncertain lifecycle operation stays available when the latest read offers no action', () => {
  expect(lifecycleControlsPresentation(unresolvedRemoval)).toEqual({ visible: true, readOnly: false, canRetry: true });
});

test('keyboard lifecycle confirmation keeps focus on cancel and the current result', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/community/space-one' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { ContainerLifecycleControls } = await import('../src/community/container-lifecycle-controls');
  const { m } = await import('../src/paraglide/messages.js');
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const target = { kind: 'space', id: 'space-one' } as const;
  let snapshotState: 'active' | 'removed' = 'active';
  let finishRestore: (() => void) | null = null;
  let restoreStarted!: () => void;
  const restoreRequest = new Promise<void>((resolve) => (restoreStarted = resolve));
  const adapter: ContainerLifecycleAdapter = {
    async read() {
      const state = snapshotState;
      return {
        kind: 'ready',
        snapshot: {
          target,
          head: state === 'active' ? 'head-active' : 'head-removed',
          contextId: null,
          state,
          actions: state === 'active' ? ['remove'] : ['restore'],
        },
      };
    },
    change(intent) {
      if (intent.action === 'remove') {
        snapshotState = 'removed';
        return Promise.resolve({
          kind: 'confirmed',
          target,
          action: intent.action,
          head: 'head-removed',
          contextId: null,
        });
      }
      restoreStarted();
      return new Promise((resolve) => {
        finishRestore = () => {
          snapshotState = 'active';
          resolve({ kind: 'confirmed', target, action: intent.action, head: 'head-active', contextId: null });
        };
      });
    },
    async destination() {
      return { kind: 'unavailable' };
    },
  };
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label.trim())!;
  const flush = () =>
    act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  try {
    await act(async () =>
      root.render(
        <>
          <ContainerLifecycleControls target={target} title="A community space" adapter={adapter} />
          <button type="button">Elsewhere</button>
        </>,
      ),
    );
    await flush();
    await act(async () => user.type(host.querySelector('textarea')!, 'Repeated disruption'));
    const remove = button(m.container_lifecycle_remove());
    await act(async () => {
      remove.focus();
      await user.keyboard('{Enter}');
    });
    expect(document.activeElement).toBe(button(m.container_lifecycle_cancel()));
    await act(async () => user.keyboard('{Enter}'));
    expect(document.activeElement).toBe(remove);

    await act(async () => user.keyboard('{Enter}'));
    await act(async () => {
      button(m.container_lifecycle_confirm()).focus();
      await user.keyboard('{Enter}');
    });
    await flush();
    const result = [...host.querySelectorAll<HTMLElement>('[role="status"]')].find((node) =>
      node.textContent?.includes(m.container_lifecycle_removed()),
    );
    expect(result).toBeDefined();
    expect(document.activeElement).toBe(result);
    expect(button(m.container_lifecycle_remove())).toBeUndefined();

    const restore = button(m.container_lifecycle_restore());
    await act(async () => {
      restore.focus();
      await user.keyboard('{Enter}');
    });
    await act(async () => {
      button(m.container_lifecycle_confirm()).focus();
      await user.keyboard('{Enter}');
    });
    await restoreRequest;
    const elsewhere = button('Elsewhere');
    await act(async () => user.click(elsewhere));
    finishRestore!();
    finishRestore = null;
    await flush();
    expect(document.activeElement).toBe(elsewhere);
  } finally {
    if (finishRestore) finishRestore();
    await act(async () => root.unmount());
    host.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
