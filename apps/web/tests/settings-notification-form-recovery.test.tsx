import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type {
  NotificationChange,
  NotificationPreferences,
  NotificationWriteResult,
  PreferencePage,
  SettingsPage,
} from '../src/settings/preferences';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

function settingsPage(
  notifications: NotificationPreferences,
  version: number,
  writable = true,
  extras: PreferencePage['kinds'] = [],
): PreferencePage {
  return {
    version,
    kinds: [
      ...Object.entries(notifications).map(([kind, enabled]) => ({
        kind,
        optional: true,
        default: true,
        enabled,
      })),
      ...extras,
      { kind: 'moderation_decision', optional: false, default: true, enabled: true },
    ],
    actions: writable
      ? [
          { name: 'edit', expectedVersion: version },
          { name: 'reset', expectedVersion: version },
        ]
      : [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function controlledManagedDeadlines() {
  const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
  const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const pending = new Map<ReturnType<typeof setTimeout>, { delay: number; fire: () => void }>();
  const managedHandles = new Set<ReturnType<typeof setTimeout>>();
  let next = 0;
  const schedule = spyOn(globalThis, 'setTimeout').mockImplementation(
    ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
      if (delay !== 10_000) return originalSetTimeout(handler, delay, ...args);
      const handle = (++next) as unknown as ReturnType<typeof setTimeout>;
      const callback = handler as (...values: unknown[]) => void;
      managedHandles.add(handle);
      pending.set(handle, { delay, fire: () => callback(...args) });
      return handle;
    }) as typeof setTimeout,
  );
  const cancel = spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
    if (managedHandles.has(handle)) {
      managedHandles.delete(handle);
      pending.delete(handle);
    } else originalClearTimeout(handle);
  });
  return {
    fire() {
      const entry = [...pending.entries()].at(-1);
      expect(entry).toBeDefined();
      expect(entry![1].delay).toBe(10_000);
      pending.delete(entry![0]);
      entry![1].fire();
    },
    restore() {
      cancel.mockRestore();
      schedule.mockRestore();
    },
  };
}

test('native kind forms own each field once; hydration retains choices and recovers only the intended operation', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/settings' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    ...Object.fromEntries(
      [
        'HTMLElement',
        'HTMLInputElement',
        'HTMLButtonElement',
        'Element',
        'Node',
        'Document',
        'DocumentFragment',
        'MutationObserver',
        'ResizeObserver',
        'FormData',
      ].map((key) => [key, (window as any)[key]]),
    ),
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { hydrateRoot } = await import('react-dom/client');
  const { renderToString } = await import('react-dom/server');
  const { NotificationsCard } = await import('../src/settings/notifications');
  const initial = { reply: true, mention: false, weekly_digest: true };
  const current = { reply: false, mention: true, weekly_digest: false };
  const initialPage = settingsPage(initial, 7);
  const initialCurrentPage = settingsPage(current, 9);
  const recoveredCurrentPage = settingsPage(current, 10);
  let currentPage = initialCurrentPage;
  const receiptPage = settingsPage(current, 9);
  const readOnlyCurrentPage = { ...initialCurrentPage, actions: [] };
  const editOnlyCurrentPage = { ...recoveredCurrentPage, actions: [{ name: 'edit' as const, expectedVersion: 10 }] };
  const calls: NotificationChange[] = [];
  let refuseCurrentRead = false;
  let currentReadPage: PreferencePage = currentPage;
  let refuseNextReset = false;
  const io = {
    save: async (input: NotificationChange) => {
      calls.push(input);
      if (refuseNextReset && input.notifications === null) {
        refuseNextReset = false;
        return { ok: false as const, reason: 'conflict' as const, page: editOnlyCurrentPage };
      }
      if (calls.length === 1) return { ok: false as const, reason: 'invalid' as const };
      if (calls.length === 3) throw new Error('response lost');
      if (calls.length === 4) return { ok: true as const, version: 9, notifications: current, page: receiptPage };
      if (calls.length === 6) return { ok: false as const, reason: 'conflict' as const, page: currentPage };
      return { ok: true as const, version: currentPage.version, notifications: current, page: currentPage };
    },
    read: async () =>
      refuseCurrentRead
        ? {
            signedIn: true as const,
            state: 'unavailable' as const,
            failure: { status: 403, code: 'forbidden', retryable: false, requestId: 'current-read' },
            securityHref: null,
          }
        : {
            signedIn: true as const,
            preferences: { spoilerLevel: 1 as const, suitability: 'blur' as const, version: currentReadPage.version },
            notifications: current,
            page: currentReadPage,
            securityHref: null,
          },
  };
  const card = (
    <NotificationsCard
      initial={initialPage}
      version={7}
      csrfToken="token"
      action="/en/settings"
      io={io}
      onVersionChange={() => {}}
    />
  );
  const host = window.document.createElement('main');
  window.document.body.append(host);
  host.innerHTML = renderToString(card);
  expect(host.querySelectorAll('form')).toHaveLength(4);
  for (const [index, form] of [...host.querySelectorAll('form')].entries()) {
    const kind = Object.keys(initial)[index];
    expect([...new window.FormData(form)]).toEqual([
      ['csrf_token', 'token'],
      ['expectedVersion', '7'],
      ...(kind
        ? [['notificationKind', kind], ...(initial[kind as keyof typeof initial] ? [['enabled', 'true']] : [])]
        : []),
      ['action', kind ? 'save' : 'restore'],
    ]);
  }
  const readOnlyHost = window.document.createElement('main');
  readOnlyHost.innerHTML = renderToString(
    <NotificationsCard
      initial={{ ...initialPage, actions: [] }}
      version={7}
      csrfToken="token"
      action="/en/settings"
      io={io}
      onVersionChange={() => {}}
    />,
  );
  expect(readOnlyHost.textContent).toContain('current account access does not allow changes');
  expect(
    [...readOnlyHost.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((input) => input.disabled),
  ).toBe(true);
  expect([...readOnlyHost.querySelectorAll('button')].every((button) => (button as HTMLButtonElement).disabled)).toBe(
    true,
  );
  host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = false;
  let root: ReturnType<typeof hydrateRoot> | undefined;
  const click = async (text: string) =>
    act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === text && !button.closest('[hidden]'))!
        .click(),
    );
  try {
    await act(async () => {
      root = hydrateRoot(host as unknown as HTMLElement, card);
    });
    expect(calls.map((call) => call.notifications)).toEqual([{ reply: false }]);
    expect(host.querySelector<HTMLInputElement>('input[name="enabled"]')!.checked).toBe(false);
    currentReadPage = readOnlyCurrentPage;
    await click('Reload');
    expect(host.textContent).toContain('current account access does not allow changes');
    expect(host.textContent).toContain('Current account access does not allow this retained operation');
    const blockedSave = [...host.querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find(
      (button) => button.textContent === 'Save reviewed choices',
    );
    expect(blockedSave).toBeDefined();
    expect(blockedSave!.disabled).toBe(true);
    expect(calls).toHaveLength(1);
    currentReadPage = currentPage;
    await click('Reload');
    const reviewedSave = () =>
      [...host.querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find(
        (button) => button.textContent === 'Save reviewed choices',
      );
    expect(reviewedSave().disabled).toBe(false);
    await click('Save reviewed choices');
    expect(calls[1]!.notifications).toEqual({ reply: false });
    await click('Restore defaults');
    refuseCurrentRead = true;
    await click('Retry original save');
    expect(calls[3]).toBe(calls[2]);
    expect(calls[3]!.notifications).toBeNull();
    expect(host.textContent).toContain('The original save was confirmed');
    expect(host.textContent).toContain('This sign-in does not have access to read notification settings');
    expect(host.querySelector('[data-response-status="403"]')).not.toBeNull();
    expect(
      [...host.querySelectorAll('button')].some(
        (button) => button.textContent === 'Retry original save' && !button.closest('[hidden]'),
      ),
    ).toBe(false);
    refuseCurrentRead = false;
    currentPage = recoveredCurrentPage;
    currentReadPage = recoveredCurrentPage;
    await click('Reload');
    expect(host.textContent).toContain('Review current settings');
    expect(host.textContent).toContain('Restore defaults');
    expect(calls).toHaveLength(4);
    expect(
      [...host.querySelectorAll('button')].some(
        (button) => button.textContent === 'Retry original save' && !button.closest('[hidden]'),
      ),
    ).toBe(false);
    await click('Use current values');
    await click('Restore defaults');
    expect(calls[4]!.notifications).toBeNull();
    expect(calls[4]!.expectedVersion).toBe(10);
    expect(host.textContent).toContain('Saved');
    await click('Restore defaults');
    await click('Reload');
    expect(
      [...host.querySelectorAll('button')].filter(
        (button) => button.textContent === 'Restore defaults' && !button.closest('[hidden]'),
      ),
    ).toHaveLength(1);
    await click('Restore defaults');
    expect(calls[6]!.notifications).toBeNull();

    refuseNextReset = true;
    await click('Restore defaults');
    expect(host.textContent).toContain('Current account access does not allow this retained operation');
    const reviewedRestore = () =>
      [...host.querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find(
        (button) => button.textContent === 'Restore defaults',
      );
    expect(reviewedRestore().disabled).toBe(true);
    expect(calls).toHaveLength(8);
    currentReadPage = currentPage;
    await click('Reload');
    expect(reviewedRestore().disabled).toBe(false);
    await click('Restore defaults');
    expect(calls).toHaveLength(9);
    expect(calls[8]!.notifications).toBeNull();
  } finally {
    if (root) await act(async () => root!.unmount());
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
    mock.restore();
  }
});

test('timed-out Save and replay read recover deliberately in the rendered notification editor', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/settings' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    ...Object.fromEntries(
      [
        'HTMLElement',
        'HTMLInputElement',
        'HTMLButtonElement',
        'Element',
        'Node',
        'Document',
        'DocumentFragment',
        'MutationObserver',
        'ResizeObserver',
        'FormData',
      ].map((key) => [key, (window as any)[key]]),
    ),
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { hydrateRoot } = await import('react-dom/client');
  const { renderToString } = await import('react-dom/server');
  const { NotificationsCard } = await import('../src/settings/notifications');
  const original = { reply: true, mention: true, weekly_digest: true };
  const receipt = { reply: false, mention: true, weekly_digest: true };
  const current = { reply: false, mention: true, weekly_digest: false };
  const lateCurrent = { reply: true, mention: true, weekly_digest: true };
  const reviewed = { reply: false, mention: false, weekly_digest: false };
  const initialPage = settingsPage(original, 7);
  const receiptPage = settingsPage(receipt, 8);
  const currentPage = settingsPage(current, 9);
  const reviewedPage = settingsPage(reviewed, 10);
  const asSettingsPage = (notifications: NotificationPreferences, version: number): SettingsPage => ({
    signedIn: true,
    preferences: { spoilerLevel: 1, suitability: 'blur', version },
    notifications,
    page: settingsPage(notifications, version),
    securityHref: null,
  });
  const result = (notifications: NotificationPreferences, version: number, page: PreferencePage) => ({
    ok: true as const,
    version,
    notifications,
    page,
  });
  const firstSave = deferred<NotificationWriteResult>();
  const replaySave = deferred<NotificationWriteResult>();
  const stalledRead = deferred<SettingsPage>();
  const recoveredRead = deferred<SettingsPage>();
  const readStarts = [deferred<void>(), deferred<void>()];
  const calls: NotificationChange[] = [];
  let reads = 0;
  const io = {
    save: (input: NotificationChange) => {
      calls.push(input);
      if (calls.length === 1) return firstSave.promise;
      if (calls.length === 2) return replaySave.promise;
      return Promise.resolve(result(reviewed, 10, reviewedPage));
    },
    read: () => {
      const index = reads++;
      readStarts[index]?.resolve(undefined);
      return index === 0 ? stalledRead.promise : recoveredRead.promise;
    },
  };
  const card = (
    <NotificationsCard
      initial={initialPage}
      version={7}
      csrfToken="token"
      action="/en/settings"
      io={io}
      onVersionChange={() => {}}
    />
  );
  const host = window.document.createElement('main');
  window.document.body.append(host);
  host.innerHTML = renderToString(card);
  let root: ReturnType<typeof hydrateRoot> | undefined;
  let deadlines: ReturnType<typeof controlledManagedDeadlines> | undefined;
  const visibleButton = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === text && !button.closest('[hidden]'),
    );
  const click = async (text: string) => act(async () => visibleButton(text)!.click());
  const inputFor = (kind: string) =>
    [...host.querySelectorAll<HTMLFormElement>('form')]
      .find((form) => form.querySelector<HTMLInputElement>('input[name="notificationKind"]')?.value === kind)!
      .querySelector<HTMLInputElement>('input[name="enabled"]')!;
  const submitKind = async (kind: string, enabled: boolean) =>
    act(async () => {
      const input = inputFor(kind);
      input.checked = enabled;
      input.form!.requestSubmit();
    });
  const expectedVersionFor = (kind: string) =>
    inputFor(kind).form!.querySelector<HTMLInputElement>('input[name="expectedVersion"]')!.value;
  try {
    await act(async () => {
      root = hydrateRoot(host as unknown as HTMLElement, card);
    });
    deadlines = controlledManagedDeadlines();
    await submitKind('reply', false);
    const originalInput = calls[0]!;
    expect(originalInput).toMatchObject({ expectedVersion: 7, notifications: { reply: false } });
    await act(async () => {
      deadlines!.fire();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(visibleButton('Retry original save')).toBeDefined();
    expect(reads).toBe(0);

    await act(async () => {
      firstSave.resolve(result(receipt, 8, receiptPage));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(visibleButton('Retry original save')).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(reads).toBe(0);
    await submitKind('mention', false);
    expect(calls).toHaveLength(1);

    await click('Retry original save');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(originalInput);
    expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);
    await act(async () => {
      replaySave.resolve(result(receipt, 8, receiptPage));
      await Promise.resolve();
      await Promise.resolve();
    });
    await readStarts[0]!.promise;
    expect(reads).toBe(1);
    await act(async () => {
      deadlines!.fire();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('The original save was confirmed');
    expect(visibleButton('Retry original save')).toBeUndefined();
    expect(visibleButton('Reload')).toBeDefined();

    await click('Reload');
    await readStarts[1]!.promise;
    recoveredRead.resolve(asSettingsPage(current, 9));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Review current settings');
    expect(expectedVersionFor('reply')).toBe('9');
    expect(inputFor('reply').checked).toBe(false);
    expect(inputFor('mention').checked).toBe(false);
    expect(inputFor('weekly_digest').checked).toBe(false);

    await act(async () => {
      stalledRead.resolve(asSettingsPage(lateCurrent, 11));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(expectedVersionFor('reply')).toBe('9');
    expect(inputFor('reply').checked).toBe(false);
    expect(inputFor('mention').checked).toBe(false);
    expect(inputFor('weekly_digest').checked).toBe(false);
    expect(reads).toBe(2);

    await click('Save reviewed choices');
    expect(calls.map(({ expectedVersion, notifications }) => ({ expectedVersion, notifications }))).toEqual([
      { expectedVersion: 7, notifications: { reply: false } },
      { expectedVersion: 7, notifications: { reply: false } },
      { expectedVersion: 9, notifications: { mention: false } },
    ]);
    expect(calls[0]).toBe(calls[1]);
    expect(calls[2]!.idempotencyKey).not.toBe(calls[0]!.idempotencyKey);
    expect(calls).toHaveLength(3);
    expect(reads).toBe(2);
  } finally {
    if (root) await act(async () => root!.unmount());
    deadlines?.restore();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
    mock.restore();
  }
});

test('a stale first-send receipt is consumed before a failed read and later reviewed edit', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/settings' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    ...Object.fromEntries(
      [
        'HTMLElement',
        'HTMLInputElement',
        'HTMLButtonElement',
        'Element',
        'Node',
        'Document',
        'DocumentFragment',
        'MutationObserver',
        'ResizeObserver',
        'FormData',
      ].map((key) => [key, (window as any)[key]]),
    ),
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { hydrateRoot } = await import('react-dom/client');
  const { renderToString } = await import('react-dom/server');
  const { NotificationsCard } = await import('../src/settings/notifications');
  const original = { reply: true, mention: true };
  const receipt = { reply: false, mention: true };
  const current = { reply: true, mention: true };
  const reviewed = { reply: true, mention: false };
  const initialPage = settingsPage(original, 7);
  const receiptPage = settingsPage(receipt, 8);
  const currentPage = settingsPage(current, 10);
  const reviewedPage = settingsPage(reviewed, 11);
  const calls: NotificationChange[] = [];
  let resolveFirst!: (result: NotificationWriteResult) => void;
  let reads = 0;
  const io = {
    save: async (input: NotificationChange) => {
      calls.push(input);
      if (calls.length === 1)
        return await new Promise<NotificationWriteResult>((resolve) => {
          resolveFirst = resolve;
        });
      return { ok: true as const, version: 11, notifications: reviewed, page: reviewedPage };
    },
    read: async () => {
      reads += 1;
      if (reads === 1)
        return {
          signedIn: true as const,
          state: 'unavailable' as const,
          failure: { status: 403, code: 'forbidden', retryable: false, requestId: 'current-read' },
          securityHref: null,
        };
      return {
        signedIn: true as const,
        preferences: { spoilerLevel: 1 as const, suitability: 'blur' as const, version: 10 },
        notifications: current,
        page: currentPage,
        securityHref: null,
      };
    },
  };
  const card = (version: number) => (
    <NotificationsCard
      initial={initialPage}
      version={version}
      csrfToken="token"
      action="/en/settings"
      io={io}
      onVersionChange={() => {}}
    />
  );
  const host = window.document.createElement('main');
  window.document.body.append(host);
  host.innerHTML = renderToString(card(7));
  let root: ReturnType<typeof hydrateRoot> | undefined;
  const click = async (text: string) =>
    act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === text && !button.closest('[hidden]'))!
        .click(),
    );
  const inputFor = (kind: string) =>
    [...host.querySelectorAll<HTMLFormElement>('form')]
      .find((form) => form.querySelector<HTMLInputElement>('input[name="notificationKind"]')?.value === kind)!
      .querySelector<HTMLInputElement>('input[name="enabled"]')!;
  const submitKind = async (kind: string, enabled: boolean) =>
    act(async () => {
      const input = inputFor(kind);
      input.checked = enabled;
      input.form!.requestSubmit();
    });
  try {
    await act(async () => {
      root = hydrateRoot(host as unknown as HTMLElement, card(7));
    });
    await submitKind('reply', false);
    expect(calls).toMatchObject([{ expectedVersion: 7, notifications: { reply: false } }]);
    await act(async () => {
      root!.render(card(9));
    });
    await act(async () => {
      resolveFirst({ ok: true, version: 8, notifications: receipt, page: receiptPage });
      await Promise.resolve();
    });
    await click('Reload');
    expect(reads).toBe(1);
    expect(calls).toHaveLength(1);
    await submitKind('mention', false);
    expect(calls).toHaveLength(1);
    await click('Reload');
    expect(reads).toBe(2);
    expect(calls).toHaveLength(1);
    expect(inputFor('reply').checked).toBe(true);
    expect(inputFor('mention').checked).toBe(false);
    expect(host.textContent).toContain('Review current settings');
    await click('Save reviewed choices');
    expect(calls).toHaveLength(2);
    expect(calls.map(({ expectedVersion, notifications }) => ({ expectedVersion, notifications }))).toEqual([
      { expectedVersion: 7, notifications: { reply: false } },
      { expectedVersion: 10, notifications: { mention: false } },
    ]);
    expect(calls[1]!.idempotencyKey).not.toBe(calls[0]!.idempotencyKey);
  } finally {
    if (root) await act(async () => root!.unmount());
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
    mock.restore();
  }
});

test('a later edit survives historical receipt and current read until the whole remaining patch is admitted', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/settings' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    ...Object.fromEntries(
      [
        'HTMLElement',
        'HTMLInputElement',
        'HTMLButtonElement',
        'Element',
        'Node',
        'Document',
        'DocumentFragment',
        'MutationObserver',
        'ResizeObserver',
        'FormData',
      ].map((key) => [key, (window as any)[key]]),
    ),
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { hydrateRoot } = await import('react-dom/client');
  const { renderToString } = await import('react-dom/server');
  const { NotificationsCard } = await import('../src/settings/notifications');
  const extra = [{ kind: 'legacy_digest', optional: true, default: false, enabled: true }] as PreferencePage['kinds'];
  const initial = { reply: true, mention: true, legacy_digest: true };
  const receipt = { reply: false, mention: true };
  const current = { reply: false, mention: true };
  const initialPage = settingsPage(initial, 7, true, extra);
  const receiptPage = settingsPage(receipt, 9);
  const currentPage = settingsPage(current, 10);
  const calls: NotificationChange[] = [];
  let refuseCurrentRead = true;
  const io = {
    save: async (input: NotificationChange) => {
      calls.push(input);
      if (calls.length === 1) throw new Error('response lost');
      return { ok: true as const, version: 9, notifications: receipt, page: receiptPage };
    },
    read: async () =>
      refuseCurrentRead
        ? {
            signedIn: true as const,
            state: 'unavailable' as const,
            failure: { status: 403, code: 'forbidden', retryable: false, requestId: 'current-read' },
            securityHref: null,
          }
        : {
            signedIn: true as const,
            preferences: { spoilerLevel: 1 as const, suitability: 'blur' as const, version: 10 },
            notifications: current,
            page: currentPage,
            securityHref: null,
          },
  };
  const card = (
    <NotificationsCard
      initial={initialPage}
      version={7}
      csrfToken="token"
      action="/en/settings"
      io={io}
      onVersionChange={() => {}}
    />
  );
  const host = window.document.createElement('main');
  window.document.body.append(host);
  host.innerHTML = renderToString(card);
  host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = false;
  let root: ReturnType<typeof hydrateRoot> | undefined;
  const click = async (text: string) =>
    act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === text && !button.closest('[hidden]'))!
        .click(),
    );
  const switchNamed = (name: string) =>
    [...host.querySelectorAll<HTMLElement>('[role="switch"]')].find(
      (control) => control.getAttribute('aria-label') === name,
    )!;
  const submitKind = async (kind: string, enabled: boolean) => {
    await act(async () => {
      const form = [...host.querySelectorAll('form')].find((entry) =>
        [...entry.querySelectorAll<HTMLInputElement>('input[name="notificationKind"]')].some(
          (input) => input.value === kind,
        ),
      )!;
      const input = form.querySelector<HTMLInputElement>('input[name="enabled"]');
      if (input) input.checked = enabled;
      form.requestSubmit();
    });
  };
  try {
    await act(async () => {
      root = hydrateRoot(host as unknown as HTMLElement, card);
    });
    expect(calls[0]!.notifications).toEqual({ reply: false });
    const original = calls[0]!;
    await submitKind('mention', false);
    await submitKind('legacy_digest', false);
    expect(switchNamed('Mentions of you').getAttribute('aria-checked')).toBe('false');
    await click('Retry original save');
    expect(calls[1]).toBe(original);
    expect(host.textContent).toContain('The original save was confirmed');
    expect(host.querySelector('[data-response-status="403"]')).not.toBeNull();
    refuseCurrentRead = false;
    await click('Reload');
    expect(host.textContent).toContain('Always sent');
    expect(host.textContent).toContain('Moderation, report and appeal outcomes');
    expect(host.textContent).toContain('legacy_digest');
    expect(switchNamed('Mentions of you').getAttribute('aria-checked')).toBe('false');
    expect(
      [...host.querySelectorAll('[role="switch"]')].some(
        (control) => control.getAttribute('aria-label') === 'legacy_digest',
      ),
    ).toBe(false);
    const reviewedSave = () =>
      [...host.querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find(
        (button) => button.textContent === 'Save reviewed choices',
      )!;
    expect(reviewedSave().disabled).toBe(true);
    expect(calls).toHaveLength(2);
    await click('Discard this choice');
    expect(reviewedSave().disabled).toBe(false);
    await click('Save reviewed choices');
    expect(calls[2]).toMatchObject({ expectedVersion: 10, notifications: { mention: false } });
  } finally {
    if (root) await act(async () => root!.unmount());
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
    mock.restore();
  }
});

test('native failure bodies retain per-kind choices or Restore, replay unknown commands and review refused commands', async () => {
  const preferences = await import('../src/settings/preferences');
  const kernel = await import('../src/kernel/client');
  const { submitNotificationForm } = await import('../src/settings/actions.server');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window();
  const current = { reply: true, mention: false };
  const writes: NotificationChange[] = [];
  let refused = true;
  const save = spyOn(preferences, 'changeNotifications').mockImplementation(async (_client, _request, _env, input) => {
    writes.push(input);
    return refused
      ? { ok: false, reason: input.notifications === null ? 'conflict' : 'unavailable' }
      : { ok: true, version: 12, notifications: current, page: settingsPage(current, 12) };
  });
  const read = spyOn(preferences, 'loadSettingsPage').mockResolvedValue({
    signedIn: true,
    securityHref: null,
    preferences: { spoilerLevel: 1, suitability: 'blur', version: 11 },
    notifications: current,
    page: settingsPage(current, 11),
  });
  const client = spyOn(kernel, 'kernelClient').mockReturnValue({} as ReturnType<typeof kernel.kernelClient>);
  const post = (fields: URLSearchParams) =>
    submitNotificationForm(
      new Request('https://site.test/en/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: fields,
      }),
    );
  const fields = async (response: Response) => {
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    window.document.body.innerHTML = await response.text();
    return new URLSearchParams([...new window.FormData(window.document.querySelector('form')!)] as [string, string][]);
  };
  try {
    for (const action of ['save', 'restore']) {
      writes.length = 0;
      refused = true;
      let form = await fields(
        await post(
          new URLSearchParams({
            action,
            csrf_token: 'token',
            expectedVersion: '7',
            ...(action === 'save' ? { notificationKind: 'reply' } : {}),
          }),
        ),
      );
      if (action === 'restore') {
        form = await fields(await post(form));
        expect(writes).toHaveLength(1);
        expect(form.get('expectedVersion')).toBe('11');
        expect(form.get('idempotencyKey')).not.toBe(writes[0]!.idempotencyKey);
      }
      refused = false;
      expect((await post(form)).status).toBe(303);
      expect(writes[1]!.notifications).toEqual(action === 'save' ? { reply: false } : null);
      if (action === 'save') expect(writes[1]).toEqual(writes[0]);
    }
  } finally {
    save.mockRestore();
    read.mockRestore();
    client.mockRestore();
    await window.happyDOM.close();
  }
});
