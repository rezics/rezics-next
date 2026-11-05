import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';
import { fromPlainText } from '@rezics/document';
import type { WriteFailure } from '../src/threads/actions';
import type { SlowModePort, SlowModeRead } from '../src/threads/slow-mode';
import recorded from '../src/kernel/recorded/thread.json';

test('slow-mode native policy is complete, closed and independent of UI presets', async () => {
  const { parseSlowModePolicy, SLOW_MODE_INTERVALS, remainingSeconds, deadlineFromRetryAfter } =
    await import('../src/threads/slow-mode');
  expect(SLOW_MODE_INTERVALS).toEqual([0, 30, 60, 300]);
  const native = {
    intervalSeconds: 45,
    retryAt: null,
    nextEligibleAt: null,
    canChange: false,
    exempt: false,
    admissionState: 'pending',
    retryAfterSeconds: 1,
  };
  for (const intervalSeconds of [0, 45, 300, 86400])
    expect(parseSlowModePolicy({ ...native, intervalSeconds })).toEqual({ ...native, intervalSeconds });
  for (const body of [
    {},
    { ...native, intervalSeconds: -1 },
    { ...native, intervalSeconds: 86401 },
    { ...native, intervalSeconds: 0.5 },
    { ...native, exempt: undefined },
    { policy: native },
    { ...native, admissionState: 'allowed' },
    { ...native, extra: true },
  ])
    expect(parseSlowModePolicy(body)).toBeUndefined();
  expect(remainingSeconds(deadlineFromRetryAfter(86400, 1000), 1000)).toBe(86400);
});

test('mounted visits retire on equal session replacement, invalidation and fetching', async () => {
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
  const window = new Window({ url: 'https://site.test/en/compose' });
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { sessionQuery } = await import('../src/session/query');
  const { useSlowModeVisit, type SlowModeVisit } = await import('../src/threads/slow-mode/caller');
  const client = new QueryClient();
  const owner = { state: 'signed-in' as const, subject: recorded.thread.authorId, csrfToken: 'original' };
  client.setQueryData(sessionQuery.queryKey, owner);
  let visit: SlowModeVisit | null = null;
  function Probe() { visit = useSlowModeVisit(recorded.thread.boardId); return null; }
  const root = createRoot(window.document.createElement('div'));
  try {
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(Probe))));
    for (const replace of [
      () => client.setQueryData(sessionQuery.queryKey, { ...owner }),
      async () => {
        await client.invalidateQueries({ queryKey: sessionQuery.queryKey, refetchType: 'none' });
        client.setQueryData(sessionQuery.queryKey, { ...owner });
      },
      () => client.fetchQuery({ ...sessionQuery, staleTime: 0, queryFn: async () => ({ ...owner }) }),
    ]) {
      const original = visit!;
      expect(original.current()).toBe(true);
      await act(async () => { await replace(); });
      expect(original.current()).toBe(false);
      expect(original.controller.signal.aborted).toBe(true);
      expect(visit!.id).not.toBe(original.id);
      expect(visit!.current()).toBe(true);
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    window.happyDOM.abort();
  }
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
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider, useLocation } =
    await import('@tanstack/react-router');
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
  let readCalls = 0;
  let heldReads = 0;
  const delayedReads: ((value: SlowModeRead) => void)[] = [];
  const changes: {
    intervalSeconds: number;
    idempotencyKey: string;
    subject: string;
    csrfToken: string;
    credentialMode: string;
    scopeKey: string;
  }[] = [];
  const acknowledgedIntervals: number[] = [];
  const port: SlowModePort = {
    read: async () => {
      readCalls++;
      if (heldReads === 0) return read;
      heldReads--;
      return new Promise((resolve) => delayedReads.push(resolve));
    },
    change: async ({ intervalSeconds, idempotencyKey, subject, csrfToken, credentialMode, scopeKey }) => {
      changes.push({ intervalSeconds, idempotencyKey, subject, csrfToken, credentialMode, scopeKey });
      if (changes.length === 1) return { kind: 'unknown' };
      if (read.kind !== 'available') return { kind: 'unavailable' };
      acknowledgedIntervals.push(intervalSeconds);
      return { kind: 'applied', policy: { ...read.policy, intervalSeconds } };
    },
  };
  const submits: { key: string; title: string }[] = [];
  let nextSubmit: WriteFailure | { ok: true; value: { id: string } } = {
    ok: false,
    reason: 'rate-limited',
    retryAfter: 12,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, owner);
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const router = createRouter({
    routeTree: createRootRoute({
      component: function Page() {
        const [key] = useState('0192f3a0-6c1e-7b2a-9d4e-000000000091');
        const location = useLocation();
        return (
          <AuthoringDepartureProvider>
            <SlowModePortProvider port={port}>
              <SlowModeSetting boardId={recorded.thread.boardId} scopeKey={location.href} credentialMode="session" />
              <PostComposer
                titleRequired
                boardId={recorded.thread.boardId}
                slowModeScopeKey={location.href}
                slowModeCredentialMode="session"
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
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router }))),
  );
  const appeared = async (text: string) => {
    for (let attempt = 0; attempt < 25; attempt++) {
      if (host.textContent?.includes(text)) return;
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(host.textContent).toContain(text);
  };
  try {
    await appeared(m.slow_mode_unavailable());
    expect(host.textContent).toContain(m.slow_mode_next_unavailable());
    read = {
      kind: 'available',
      policy: {
        intervalSeconds: 45,
        retryAt: null,
        nextEligibleAt: null,
        canChange: true,
        exempt: false,
        admissionState: 'pending',
        retryAfterSeconds: 1,
      },
    };
    const reloads = [...host.querySelectorAll('button')].filter((button) => button.textContent === m.slow_mode_retry());
    expect(reloads.length).toBeGreaterThan(0);
    await act(async () => {
      await user.click(reloads[0]!);
    });
    await appeared(m.slow_mode_setting_legend());
    expect(host.textContent).toContain(m.slow_mode_interval_seconds({ seconds: 45 }));
    expect(host.textContent).not.toContain(m.slow_mode_next_now());
    const thirty = [...host.querySelectorAll('label')].find(
      (label) => label.textContent === m.slow_mode_interval_seconds({ seconds: 30 }),
    );
    expect(thirty).toBeDefined();
    await act(async () => {
      await user.click(thirty!);
    });
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent === m.slow_mode_apply());
    await act(async () => {
      await user.click(save!);
    });
    await appeared(m.slow_mode_unknown());
    const sameKeyRetry = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.slow_mode_retry(),
    );
    const readsBeforeAcknowledgement = readCalls;
    await act(async () => {
      await user.click(sameKeyRetry!);
    });
    await appeared(m.slow_mode_saved());
    expect(changes).toEqual(Array(2).fill(changes[0]));
    expect(changes[0]).toMatchObject({
      intervalSeconds: 30,
      subject: owner.subject,
      csrfToken: owner.csrfToken,
      credentialMode: 'session',
    });
    expect(acknowledgedIntervals).toEqual([30]);
    expect(readCalls).toBe(readsBeforeAcknowledgement);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['board-slow-mode'] });
    });
    expect(readCalls).toBeGreaterThan(readsBeforeAcknowledgement);
    expect(
      client
        .getQueryCache()
        .findAll({ queryKey: ['board-slow-mode'] })
        .some((query) => {
          const current = query.state.data as SlowModeRead | undefined;
          return current?.kind === 'available' && current.policy.intervalSeconds === 45;
        }),
    ).toBe(true);
    expect(host.textContent).toContain(m.slow_mode_saved());
    await act(async () => user.type(host.querySelector('#thread-title')!, 'Cooldown draft'));
    const send = [...host.querySelectorAll('button')].find((button) => button.textContent === m.thread_write_send());
    await act(async () => {
      await user.click(send!);
    });
    expect(submits).toHaveLength(1);
    expect(host.textContent).toContain('A draft that must survive a cooldown refusal.');
    await appeared(m.slow_mode_guidance());
    expect(host.querySelector('#thread-title')).toHaveProperty('value', 'Cooldown draft');
    nextSubmit = { ok: true, value: { id: recorded.thread.id } };
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === m.thread_write_retry());
    await act(async () => {
      await user.click(retry!);
    });
    expect(submits).toHaveLength(2);
    expect(submits[1]!.key).toBe(submits[0]!.key);
    expect(host.textContent).toContain(m.slow_mode_saved());
    heldReads = 2;
    await act(async () => {
      await router.navigate({ to: '/en/other' as never });
    });
    for (let attempt = 0; attempt < 25 && delayedReads.length < 2; attempt++)
      await act(async () => {
        await Promise.resolve();
      });
    expect(delayedReads).toHaveLength(2);
    await act(async () => {
      await router.navigate({ to: '/en/compose' as never });
    });
    await appeared(m.slow_mode_interval_label({ label: m.slow_mode_interval_seconds({ seconds: 45 }) }));
    const latePolicy: SlowModeRead = {
      kind: 'available',
      policy: {
        intervalSeconds: 86400,
        retryAt: null,
        nextEligibleAt: null,
        canChange: true,
        exempt: false,
        admissionState: 'ready',
        retryAfterSeconds: 0,
      },
    };
    await act(async () => delayedReads.forEach((resolve) => resolve(latePolicy)));
    expect(host.textContent).not.toContain(m.slow_mode_interval_seconds({ seconds: 86400 }));
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { ...owner, csrfToken: 'replacement-session' });
    });
    for (let attempt = 0; attempt < 25 && host.textContent?.includes(m.slow_mode_saved()); attempt++)
      await act(async () => {
        await Promise.resolve();
      });
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
