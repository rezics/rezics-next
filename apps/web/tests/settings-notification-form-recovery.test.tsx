import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { NotificationChange } from '../src/settings/preferences';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

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
  const calls: NotificationChange[] = [];
  const io = {
    save: async (input: NotificationChange) => {
      calls.push(input);
      if (calls.length === 1) return { ok: false as const, reason: 'invalid' as const };
      if (calls.length === 3) throw new Error('response lost');
      if (calls.length === 5) return { ok: false as const, reason: 'conflict' as const };
      return { ok: true as const, version: 9, notifications: current };
    },
    read: async () => ({
      signedIn: true as const,
      preferences: { spoilerLevel: 1 as const, suitability: 'blur' as const, version: 9 },
      notifications: current,
      securityHref: null,
    }),
  };
  const card = (
    <NotificationsCard
      initial={initial}
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
    await click('Reload');
    await click('Save reviewed choices');
    expect(calls[1]!.notifications).toEqual({ reply: false });
    await click('Restore defaults');
    await click('Retry original save');
    expect(calls[3]).toBe(calls[2]);
    expect(calls[3]!.notifications).toBeNull();
    expect(host.textContent).toContain('Saved');
    await click('Restore defaults');
    await click('Reload');
    expect(
      [...host.querySelectorAll('button')].filter(
        (button) => button.textContent === 'Restore defaults' && !button.closest('[hidden]'),
      ),
    ).toHaveLength(1);
    await click('Restore defaults');
    expect(calls[5]!.notifications).toBeNull();
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
  const writes: NotificationChange[] = [];
  let refused = true;
  const save = spyOn(preferences, 'changeNotifications').mockImplementation(async (_client, _request, _env, input) => {
    writes.push(input);
    return refused
      ? { ok: false, reason: input.notifications === null ? 'conflict' : 'unavailable' }
      : { ok: true, version: 12, notifications: { reply: true, mention: false } };
  });
  const read = spyOn(preferences, 'loadSettingsPage').mockResolvedValue({
    signedIn: true,
    securityHref: null,
    preferences: { spoilerLevel: 1, suitability: 'blur', version: 11 },
    notifications: { reply: true, mention: false },
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
