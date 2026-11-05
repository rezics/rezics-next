import { expect, mock, test } from 'bun:test';
import { act, createElement, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  createRealmAppearance,
  realmAppearanceHasUnsavedChanges,
  type RealmAppearanceAdapter,
} from '../src/community/realm-presentation';
import { configured, image, revisionId } from '../src/kernel/fake/community';

test('Realm appearance departure preserves drafts on Stay, retires on Leave, and bypasses retired authority', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/realms/settings', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
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
  const previous = new Map(
    [...Object.keys(globals)].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));

  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { RealmAppearanceDeparture } = await import('../src/community/realm-appearance-departure');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const originalLocale = getLocale();
  setLocale('en', { reload: false });

  const attempts: unknown[] = [];
  let uncertain = false;
  let retireManagement: (() => void) | null = null;
  let lastControl: ReturnType<typeof createRealmAppearance> | null = null;
  const adapter: RealmAppearanceAdapter = {
    read: async () => ({ kind: 'ready', snapshot: configured }),
    change: async (command) => {
      attempts.push(structuredClone(command));
      if (uncertain) throw new Error('save response unavailable');
      return {
        kind: 'confirmed',
        snapshot: { ...configured, head: revisionId, presentation: command.presentation },
      };
    },
    select: async () => ({ kind: 'unavailable' }),
    upload: async () => ({ id: image.id }),
    resume: async () => ({ id: image.id }),
  };

  function SettingsPage() {
    const control = useMemo(
      () => createRealmAppearance(configured.realmId, { kind: 'ready', snapshot: configured }, adapter),
      [],
    );
    lastControl = control;
    const state = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
    const [manager, setManager] = useState(true);
    useEffect(() => control.connect(), [control]);
    useEffect(() => {
      retireManagement = () => setManager(false);
      return () => {
        retireManagement = null;
      };
    }, []);
    const baseline = state.read.kind === 'ready' ? state.read.snapshot.presentation : configured.presentation;
    const active = manager && state.read.kind === 'ready' && state.read.snapshot.canManage;
    const dirty = active && realmAppearanceHasUnsavedChanges(state, baseline);
    return createElement(
      RealmAppearanceDeparture,
      { active, dirty, unresolvedSave: state.phase === 'saving' || state.phase === 'uncertain' },
      createElement(
        'main',
        null,
        active
          ? createElement(
              'div',
              null,
              state.draft ? createElement('p', null, state.draft.presentation.avatarMediaId ?? 'No icon') : null,
              createElement(
                'button',
                { type: 'button', onClick: () => control.choose('avatar', { kind: 'image', image }) },
                'Choose icon',
              ),
              createElement('button', { type: 'button', onClick: () => void control.save() }, 'Save appearance'),
              state.phase === 'uncertain'
                ? createElement('button', { type: 'button', onClick: () => void control.save() }, 'Retry original save')
                : null,
              createElement(Link, { to: '/destination' }, 'Open destination'),
            )
          : createElement('p', null, 'Management retired'),
      ),
    );
  }

  const rootRoute = createRootRoute({ component: () => createElement(Outlet) });
  const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage });
  const destinationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/destination',
    component: () => createElement('p', null, 'Destination'),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute, destinationRoute]),
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const button = (label: string, scope: ParentNode = document) => {
    const match = [...scope.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
    expect(match).toBeDefined();
    return match!;
  };
  const click = async (node: HTMLElement) => act(async () => node.click());
  const frame = async () =>
    act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
  const navigateAway = async () => {
    const link = host.querySelector('a')!;
    link.focus();
    await click(link);
    await frame();
    return link;
  };
  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const protectedUnload = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    await router.load();
    await act(async () => root.render(createElement(RouterProvider, { router })));
    expect(protectedUnload()).toBe(false);
    await click(button('Choose icon'));
    expect(protectedUnload()).toBe(true);
    const stayOrigin = await navigateAway();
    expect(router.state.location.pathname).toBe('/settings');
    expect(dialog()?.textContent).toContain(m.realm_appearance_leave_unsaved());
    await click(button(m.realm_appearance_stay(), dialog()!));
    await frame();
    expect(router.state.location.pathname).toBe('/settings');
    expect(host.textContent).toContain(image.id);
    expect(document.activeElement).toBe(stayOrigin);

    await click(button('Save appearance'));
    await frame();
    expect(attempts).toHaveLength(1);
    expect(protectedUnload()).toBe(false);
    await navigateAway();
    expect(router.state.location.pathname).toBe('/destination');
    expect(dialog()).toBeNull();

    await act(async () => router.navigate({ to: '/settings' }));
    uncertain = true;
    await click(button('Choose icon'));
    await click(button('Save appearance'));
    await frame();
    expect(attempts).toHaveLength(2);
    await navigateAway();
    expect(dialog()?.textContent).toContain(m.realm_appearance_leave_recovery());
    await click(button(m.realm_appearance_stay(), dialog()!));
    await frame();
    expect(host.textContent).toContain(image.id);
    await click(button('Retry original save'));
    await frame();
    expect(attempts).toHaveLength(3);
    expect(attempts[2]).toEqual(attempts[1]);
    await navigateAway();
    await click(button(m.realm_appearance_leave(), dialog()!));
    await frame();
    await act(async () => Promise.resolve());
    expect(router.state.location.pathname).toBe('/destination');
    expect(attempts).toHaveLength(3);
    expect(lastControl?.getSnapshot().draft).toBeNull();

    await act(async () => router.navigate({ to: '/settings' }));
    await click(button('Choose icon'));
    await navigateAway();
    expect(dialog()).not.toBeNull();
    await act(async () => retireManagement?.());
    await frame();
    expect(router.state.location.pathname).toBe('/destination');
    expect(dialog()).toBeNull();

    await act(async () => router.navigate({ to: '/settings' }));
    await click(button('Choose icon'));
    expect(protectedUnload()).toBe(true);
    const signOut = document.createElement('form');
    signOut.method = 'post';
    signOut.action = '/auth/sign-out';
    document.body.append(signOut);
    await act(async () => {
      signOut.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(protectedUnload()).toBe(false);
    expect(host.textContent).not.toContain(image.id);
    signOut.remove();
  } finally {
    await act(async () => root.unmount());
    setLocale(originalLocale, { reload: false });
    window.close();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
