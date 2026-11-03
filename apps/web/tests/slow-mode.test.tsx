import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';
import type { KernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import type { WriteFailure } from '../src/threads/actions';
import type { SlowModePort, SlowModeRead } from '../src/threads/slow-mode';
import recorded from '../src/kernel/recorded/thread.json';

test('slow-mode units parse native policy and leave missing board methods unavailable', async () => {
  const {
    parseSlowModePolicy,
    SLOW_MODE_INTERVALS,
    remainingSeconds,
    deadlineFromRetryAfter,
    nativeBoardSlowMode,
  } = await import('../src/threads/slow-mode');
  expect(SLOW_MODE_INTERVALS).toEqual([0, 30, 60, 300]);
  expect(parseSlowModePolicy({ intervalSeconds: 30, nextEligibleAt: '2026-11-03T12:00:00.000Z', canChange: true })).toEqual({
    intervalSeconds: 30,
    nextEligibleAt: '2026-11-03T12:00:00.000Z',
    canChange: true,
    exempt: false,
  });
  expect(parseSlowModePolicy({ intervalSeconds: 15 })).toBeUndefined();
  expect(remainingSeconds(deadlineFromRetryAfter(12, 1_000), 1_000)).toBe(12);
  const client = { boards: () => ({ get() {}, reports: {} }) } as unknown as KernelClient;
  expect(nativeBoardSlowMode(client, recorded.thread.boardId)).toBeUndefined();
});

test('setting and composer keep drafts through cooldown, update policy, recover unavailable eligibility and retire private work', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/compose', width: 390, height: 844 });
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
    scrollTo: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  window.scrollTo = () => undefined;
  const previous = new Map(
    [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { PostComposer } = await import('../src/threads/composer');
  const { AuthoringDepartureProvider } = await import('../src/threads/authoring-departure');
  const { sessionQuery } = await import('../src/session/query');
  const { SlowModePortProvider, SlowModeSetting } = await import('../src/threads/slow-mode');
  const { m } = await import('../src/paraglide/messages.js');
  const { documentText } = await import('@rezics/document');
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const body = fromPlainText('A draft that must survive a cooldown refusal.', 'blocks');
  const owner = { state: 'signed-in' as const, subject: recorded.thread.authorId, csrfToken: 'slow-mode-session' };
  let read: SlowModeRead = { kind: 'unavailable' };
  const changes: { intervalSeconds: number; idempotencyKey: string }[] = [];
  const port: SlowModePort = {
    read: async () => read,
    change: async ({ intervalSeconds, idempotencyKey }) => {
      changes.push({ intervalSeconds, idempotencyKey });
      if (read.kind !== 'available') return { kind: 'unavailable' };
      read = { kind: 'available', policy: { ...read.policy, intervalSeconds } };
      return { kind: 'applied', policy: read.policy };
    },
  };
  const submits: { key: string; title: string }[] = [];
  let nextSubmit: WriteFailure | { ok: true; value: { id: string } } = {
    ok: false,
    reason: 'rate-limited',
    retryAfter: 0,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, owner);
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const router = createRouter({
    routeTree: createRootRoute({
      component: function Page() {
        const [key] = useState('0192f3a0-6c1e-7b2a-9d4e-000000000091');
        return (
          <AuthoringDepartureProvider>
            <SlowModePortProvider port={port}>
              <SlowModeSetting boardId={recorded.thread.boardId} />
              <PostComposer
                titleRequired
                boardId={recorded.thread.boardId}
                initialKey={key}
                initialBody={body}
                onSubmit={async (input) => {
                  submits.push({ key: input.idempotencyKey, title: input.title });
                  return nextSubmit;
                }}
                onSuccess={() => undefined}
              />
            </SlowModePortProvider>
          </AuthoringDepartureProvider>
        );
      },
    }),
    history: createMemoryHistory({ initialEntries: ['/en/compose'] }),
  });
  const root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router }))));
  const appeared = async (text: string) => {
    for (let attempt = 0; attempt < 25; attempt++) {
      if (host.textContent?.includes(text)) return;
      await act(async () => { await Promise.resolve(); });
    }
    expect(host.textContent).toContain(text);
  };
  try {
    await appeared(m.slow_mode_unavailable());
    expect(host.textContent).toContain(m.slow_mode_next_unavailable());
    read = {
      kind: 'available',
      policy: { intervalSeconds: 0, nextEligibleAt: null, canChange: true, exempt: false },
    };
    const reloads = [...host.querySelectorAll('button')].filter((button) => button.textContent === m.slow_mode_retry());
    expect(reloads.length).toBeGreaterThan(0);
    await act(async () => { await user.click(reloads[0]!); });
    await act(async () => { await Promise.resolve(); });
    const thirty = [...host.querySelectorAll('label')].find((label) => label.textContent === m.slow_mode_interval_seconds({ seconds: 30 }));
    expect(thirty).toBeDefined();
    await act(async () => { await user.click(thirty!); });
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent === m.slow_mode_apply());
    await act(async () => { await user.click(save!); });
    expect(changes).toEqual([{ intervalSeconds: 30, idempotencyKey: changes[0]!.idempotencyKey }]);
    expect(host.textContent).toContain(m.slow_mode_interval_label({ label: m.slow_mode_interval_seconds({ seconds: 30 }) }));
    await act(async () => user.type(host.querySelector('#thread-title')!, 'Cooldown draft'));
    const send = [...host.querySelectorAll('button')].find((button) => button.textContent === m.thread_write_send());
    await act(async () => { await user.click(send!); });
    expect(submits).toHaveLength(1);
    expect(host.textContent).toContain('A draft that must survive a cooldown refusal.');
    expect(host.textContent).toContain(m.slow_mode_guidance());
    expect(host.querySelector('#thread-title')).toHaveProperty('value', 'Cooldown draft');
    nextSubmit = { ok: true, value: { id: recorded.thread.id } };
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === m.thread_write_retry());
    await act(async () => { await user.click(retry!); });
    expect(submits).toHaveLength(2);
    expect(submits[1]!.key).not.toBe(submits[0]!.key);
    expect(host.textContent).toContain(m.slow_mode_saved());
    client.setQueryData(sessionQuery.queryKey, { ...owner, csrfToken: 'replacement-session' });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).not.toContain(m.slow_mode_saved());
    expect(documentText(body)).toContain('cooldown');
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    window.happyDOM.abort();
  }
});
