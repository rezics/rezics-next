import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import type { ErasureIntent, ErasureEnqueue, ErasureOperation, ErasureRead } from '../src/threads/author-erasure';
import type { AuthorErasureAdmission } from '../src/threads/author-erasure-admission';
import type { AuthorErasureTransport } from '../src/threads/author-erasure-lifetime';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const threadA = id(1);
const threadB = id(2);
const threadC = id(3);
const operationA = id(4);
const operationB = id(5);
const authorA = id(6);
const authorB = id(7);
type ErasureAdmissionReader = (threadId: string, isCurrent?: () => boolean) => Promise<AuthorErasureAdmission>;

function operation(operationId: string, authorId: string, processed: number): ErasureOperation {
  return {
    name: `operations/${operationId}`,
    done: false,
    metadata: {
      type: 'content.author_erasure',
      threadId: threadA,
      authorId,
      processedPosts: processed,
      erasedRevisions: processed * 2,
      steps: processed ? 1 : 0,
    },
  };
}

async function withUi(run: (ui: Awaited<ReturnType<typeof createUi>>) => Promise<void>) {
  const ui = await createUi();
  try {
    await run(ui);
  } finally {
    await ui.close();
  }
}

async function createUi() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/threads/example', width: 1280, height: 900 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { AuthorErasureEntry } = await import('../src/threads/author-erasure-entry');
  const { AuthorErasureOperationPage } = await import('../src/threads/author-erasure-operation');
  const { sessionQuery } = await import('../src/session/query');
  const { dispatchAuthorErasure } = await import('../src/threads/author-erasure-lifetime');
  const { m } = await import('../src/paraglide/messages.js');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = async (node: ReactNode) =>
    act(async () => {
      root.render(createElement(QueryClientProvider, { client }, node));
      await Promise.resolve();
    });
  const renderWithClient = async (queryClient: InstanceType<typeof QueryClient>, node: ReactNode) =>
    act(async () => {
      root.render(createElement(QueryClientProvider, { client: queryClient }, node));
      await Promise.resolve();
    });
  const flush = async () =>
    act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  const button = (label: string) => {
    const found = [...window.document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
    expect(found).toBeDefined();
    return found!;
  };
  const click = async (label: string) =>
    act(async () => {
      button(label).click();
      await Promise.resolve();
    });
  const confirm = async () => {
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).toBeDefined();
    if (!checkbox!.checked) await act(async () => checkbox!.click());
  };
  const setSession = (session: { state: string; subject?: string | null; csrfToken: string | null }) =>
    client.setQueryData(sessionQuery.queryKey, session);
  const close = async () => {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return {
    window,
    host,
    client,
    newClient: () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    root,
    render,
    renderWithClient,
    flush,
    button,
    click,
    confirm,
    setSession,
    close,
    m,
    AuthorErasureEntry,
    AuthorErasureOperationPage,
    dispatchAuthorErasure,
  };
}

test('The complete author erasure caller retires private admission command callbacks and operation progress across target account session readiness and unmount changes without resetting current refresh bounds or retry intent', async () => {
  await withUi(async (ui) => {
    const { dispatchAuthorErasure } = ui;
    const queuedImport = gate<AuthorErasureTransport>();
    let current = true;
    let transported = 0;
    const queued = dispatchAuthorErasure(
      { threadId: threadA, idempotencyKey: 'one-original-key' },
      'caller-csrf',
      () => current,
      () => queuedImport.promise,
    );
    current = false;
    queuedImport.resolve(async (_intent, _token) => {
      transported += 1;
      return { kind: 'accepted', operationId: operationA };
    });
    expect(await queued).toBeUndefined();
    expect(transported).toBe(0);

    ui.setSession({ state: 'signed-in', subject: authorA, csrfToken: 'csrf-a' });
    const lateAdmission = gate<AuthorErasureAdmission>();
    const currentAdmission = gate<AuthorErasureAdmission>();
    let admissionReads = 0;
    const readAdmission: ErasureAdmissionReader = () => {
      admissionReads += 1;
      return admissionReads === 1
        ? lateAdmission.promise
        : admissionReads === 2
          ? currentAdmission.promise
          : Promise.resolve({ kind: 'current', authorId: authorA, mayErase: true });
    };
    const lateAcknowledgement = gate<{ kind: 'accepted'; operationId: string } | { kind: 'uncertain' }>();
    const targetRetirement = gate<{ kind: 'uncertain' } | { kind: 'accepted'; operationId: string }>();
    const csrfRetirement = gate<{ kind: 'accepted'; operationId: string }>();
    const readinessRetirement = gate<{ kind: 'accepted'; operationId: string }>();
    const unmountRetirement = gate<{ kind: 'accepted'; operationId: string }>();
    const sent: { threadId: string; idempotencyKey: string }[] = [];
    let callbacks = 0;
    const send = async (intent: { threadId: string; idempotencyKey: string }) => {
      sent.push(intent);
      switch (sent.length) {
        case 1:
          return lateAcknowledgement.promise;
        case 2:
          return { kind: 'uncertain' as const };
        case 3:
          return { kind: 'accepted' as const, operationId: operationA };
        case 4:
          return targetRetirement.promise;
        case 5:
          return csrfRetirement.promise;
        case 6:
          return readinessRetirement.promise;
        default:
          return unmountRetirement.promise;
      }
    };
    const renderEntry = (threadId: string) =>
      createElement(ui.AuthorErasureEntry, {
        threadId,
        viewerId: authorA,
        readAdmission,
        send,
        onAccepted: () => {
          callbacks += 1;
        },
      });

    await ui.render(renderEntry(threadA));
    await ui.click(ui.m.author_erasure_action());
    expect(admissionReads).toBe(1);
    await act(async () => {
      ui.setSession({ state: 'signed-in', subject: authorB, csrfToken: 'csrf-b' });
      ui.setSession({ state: 'signed-in', subject: authorA, csrfToken: 'csrf-a' });
    });
    lateAdmission.resolve({ kind: 'current', authorId: authorA, mayErase: true });
    await ui.flush();
    expect(ui.host.textContent).not.toContain(ui.m.author_erasure_forbidden());
    await ui.click(ui.m.author_erasure_check_again());
    await ui.flush();
    expect(admissionReads).toBe(2);
    expect(ui.button(ui.m.author_erasure_confirm()).disabled).toBe(true);
    currentAdmission.resolve({ kind: 'current', authorId: authorA, mayErase: true });
    await ui.flush();
    await ui.confirm();
    expect(ui.button(ui.m.author_erasure_confirm()).disabled).toBe(false);
    await act(async () => {
      ui.button(ui.m.author_erasure_confirm()).click();
      ui.button(ui.m.author_erasure_confirm()).click();
      await Promise.resolve();
    });
    expect(sent).toHaveLength(1);
    await act(async () => {
      ui.setSession({ state: 'signed-in', subject: authorB, csrfToken: 'csrf-b' });
      ui.setSession({ state: 'signed-in', subject: authorA, csrfToken: 'csrf-a' });
    });
    lateAcknowledgement.resolve({ kind: 'accepted', operationId: operationA });
    await ui.flush();
    expect(callbacks).toBe(0);
    expect(ui.host.textContent).not.toContain(ui.m.author_erasure_view_progress());

    expect(ui.host.textContent).toContain(ui.m.author_erasure_uncertain());
    await ui.click(ui.m.author_erasure_retry());
    await ui.flush();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    expect(ui.host.textContent).toContain(ui.m.author_erasure_uncertain());
    await act(async () => ui.setSession({ state: 'unavailable', subject: null, csrfToken: null }));
    await ui.flush();
    expect(ui.host.textContent).toContain(ui.m.author_erasure_uncertain());
    await act(async () => ui.setSession({ state: 'signed-in', subject: authorA, csrfToken: 'csrf-a' }));
    await ui.flush();
    expect(ui.host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    await ui.click(ui.m.author_erasure_close());
    await ui.click(ui.m.author_erasure_action());
    await ui.flush();
    expect(ui.host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    await ui.click(ui.m.author_erasure_retry());
    await ui.flush();
    expect(sent).toHaveLength(3);
    expect(sent[1]).toEqual(sent[2]);
    expect(callbacks).toBe(1);

    await ui.render(renderEntry(threadB));
    await ui.click(ui.m.author_erasure_action());
    await ui.flush();
    await ui.confirm();
    await ui.click(ui.m.author_erasure_confirm());
    await ui.render(renderEntry(threadA));
    targetRetirement.resolve({ kind: 'uncertain' });
    await ui.flush();
    expect(ui.host.textContent).not.toContain(ui.m.author_erasure_uncertain());
    expect(callbacks).toBe(1);

    await ui.render(renderEntry(threadC));
    await ui.click(ui.m.author_erasure_action());
    await ui.flush();
    await ui.confirm();
    await ui.click(ui.m.author_erasure_confirm());
    await act(async () => {
      ui.setSession({ state: 'signed-in', subject: authorA, csrfToken: 'csrf-a-replaced' });
    });
    csrfRetirement.resolve({ kind: 'accepted', operationId: operationA });
    await ui.flush();
    expect(callbacks).toBe(1);
    expect(ui.host.textContent).not.toContain(ui.m.author_erasure_view_progress());

    expect(ui.host.textContent).toContain(ui.m.author_erasure_uncertain());
    await ui.click(ui.m.author_erasure_retry());
    expect(sent[4]).toEqual(sent[5]);
    await act(async () => ui.setSession({ state: 'signed-out', subject: null, csrfToken: null }));
    readinessRetirement.resolve({ kind: 'accepted', operationId: operationA });
    await ui.flush();
    expect(callbacks).toBe(1);
    await ui.render(null);
    ui.setSession({ state: 'signed-in', subject: authorA, csrfToken: 'csrf-a-replaced' });
    await ui.render(renderEntry(threadC));
    await ui.click(ui.m.author_erasure_action());
    await ui.flush();
    await ui.confirm();
    await ui.click(ui.m.author_erasure_confirm());
    await act(async () => ui.root.render(null));
    unmountRetirement.resolve({ kind: 'accepted', operationId: operationA });
    await ui.flush();
    expect(callbacks).toBe(1);
  });
});

for (const replacement of ['equal', 'invalidate', 'fetch'] as const) {
  test(`${replacement} session replacement retires admission and command results while explicit retry keeps its credential`, async () => {
    await withUi(async (ui) => {
      const owner = { state: 'signed-in' as const, subject: authorA, csrfToken: 'original-command-token' };
      ui.setSession(owner);
      const replace = async () =>
        act(async () => {
          if (replacement === 'invalidate')
            await ui.client.invalidateQueries({ queryKey: ['session'], refetchType: 'none' });
          if (replacement === 'fetch')
            await ui.client.fetchQuery({ queryKey: ['session'], queryFn: async () => owner, staleTime: 0 });
          ui.setSession(owner);
        });
      const admission = gate<AuthorErasureAdmission>();
      const acknowledgement = gate<ErasureEnqueue>();
      const sent: { intent: ErasureIntent; token: string }[] = [];
      let reads = 0;
      const accepted: string[] = [];
      await ui.render(
        createElement(ui.AuthorErasureEntry, {
          threadId: threadA,
          viewerId: authorA,
          readAdmission: async () =>
            ++reads === 1 ? admission.promise : { kind: 'current', authorId: authorA, mayErase: true },
          send: async (intent, token) => {
            sent.push({ intent, token });
            return sent.length === 1
              ? acknowledgement.promise
              : sent.length === 2
                ? { kind: 'uncertain' }
                : { kind: 'accepted', operationId: operationA };
          },
          onAccepted: (id) => {
            accepted.push(id);
          },
        }),
      );
      await ui.click(ui.m.author_erasure_action());
      await replace();
      admission.resolve({ kind: 'current', authorId: authorA, mayErase: true });
      await ui.flush();
      await ui.confirm();
      expect(ui.button(ui.m.author_erasure_confirm()).disabled).toBe(true);
      await ui.click(ui.m.author_erasure_check_again());
      await ui.click(ui.m.author_erasure_confirm());
      expect(sent).toHaveLength(1);
      await replace();
      await act(async () => ui.setSession({ ...owner, csrfToken: 'replacement-token' }));
      acknowledgement.resolve({ kind: 'accepted', operationId: operationA });
      await ui.flush();
      expect(accepted).toEqual([]);
      expect(ui.host.textContent).not.toContain(ui.m.author_erasure_view_progress());
      expect(ui.host.textContent).toContain(ui.m.author_erasure_uncertain());
      await ui.click(ui.m.author_erasure_retry());
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
      await ui.click(ui.m.author_erasure_close());
      await ui.click(ui.m.author_erasure_action());
      await ui.click(ui.m.author_erasure_retry());
      expect(sent[2]).toEqual(sent[0]);
      expect(accepted).toEqual([operationA]);
    });
  });
}

test('browser away/back retires a queued entry import and a progress read without reviving them on return', async () => {
  await withUi(async (ui) => {
    ui.setSession({ state: 'signed-in', subject: authorA, csrfToken: 'csrf-a' });
    const imported = gate<AuthorErasureTransport>();
    let transported = 0;
    const accepted: string[] = [];
    await ui.render(
      createElement(ui.AuthorErasureEntry, {
        threadId: threadA,
        viewerId: authorA,
        admission: { kind: 'current', authorId: authorA, mayErase: true },
        send: async (intent, token, current) =>
          (await ui.dispatchAuthorErasure(intent, token, current, () => imported.promise)) ?? { kind: 'uncertain' },
        onAccepted: (id) => {
          accepted.push(id);
        },
      }),
    );
    const departAndReturn = async () =>
      act(async () => {
        const original = ui.window.location.href;
        ui.window.history.pushState(null, '', '/fr/threads/another');
        ui.window.dispatchEvent(new ui.window.PopStateEvent('popstate'));
        ui.window.history.pushState(null, '', original);
        ui.window.dispatchEvent(new ui.window.PopStateEvent('popstate'));
      });
    await ui.click(ui.m.author_erasure_action());
    await ui.confirm();
    await ui.click(ui.m.author_erasure_confirm());
    await departAndReturn();
    imported.resolve(async () => {
      transported += 1;
      return { kind: 'accepted', operationId: operationA };
    });
    await ui.flush();
    expect(transported).toBe(0);
    expect(accepted).toEqual([]);
    expect(ui.host.textContent).toContain(ui.m.author_erasure_uncertain());
    expect(ui.button(ui.m.author_erasure_retry()).disabled).toBe(true);

    await ui.render(null);
    const progress = gate<ErasureRead>();
    let reads = 0;
    await ui.render(
      createElement(ui.AuthorErasureOperationPage, {
        initial: { kind: 'unavailable' },
        operationId: operationA,
        read: () => {
          reads += 1;
          return progress.promise;
        },
      }),
    );
    await ui.click(ui.m.author_erasure_check_again());
    expect(reads).toBe(1);
    await departAndReturn();
    progress.resolve({ kind: 'available', operation: operation(operationA, authorA, 91234) });
    await ui.flush();
    expect(ui.host.querySelector('dl')).toBeNull();
    expect(ui.host.textContent).not.toContain('91234');
    expect(ui.button(ui.m.author_erasure_check_again()).disabled).toBe(true);
    expect(reads).toBe(1);
  });
});

test('operation initial, reader and session source replacements withhold prior private progress until a current read', async () => {
  await withUi(async (ui) => {
    ui.setSession({ state: 'signed-in', subject: authorA, csrfToken: 'csrf-a' });
    const firstCurrentRead = gate<ErasureRead>();
    const sourceCurrentRead = gate<ErasureRead>();
    let reads = 0;
    const replacementReader = () => {
      reads += 1;
      return reads === 1 ? firstCurrentRead.promise : sourceCurrentRead.promise;
    };
    const initial = { kind: 'available' as const, operation: operation(operationA, authorA, 93177) };
    const replacementInitial = {
      kind: 'available' as const,
      operation: operation(operationA, authorA, 77777),
    };
    const renderOperation = (value: ErasureRead, reader: () => Promise<ErasureRead>) =>
      createElement(ui.AuthorErasureOperationPage, {
        initial: value,
        operationId: operationA,
        navigationKey: 'same-operation-visit',
        read: reader,
      });

    await ui.render(renderOperation(initial, async () => initial));
    expect(ui.host.textContent).toContain('93177');
    await ui.render(renderOperation(replacementInitial, replacementReader));
    expect(ui.host.textContent).not.toContain('93177');
    expect(ui.host.textContent).not.toContain('77777');
    expect(reads).toBe(1);
    firstCurrentRead.resolve({ kind: 'available', operation: operation(operationA, authorA, 81266) });
    await ui.flush();
    expect(ui.host.textContent).toContain('81266');

    const otherClient = ui.newClient();
    const { sessionQuery } = await import('../src/session/query');
    otherClient.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: authorA,
      csrfToken: 'csrf-a-on-another-query-client',
    });
    await ui.renderWithClient(otherClient, renderOperation(replacementInitial, replacementReader));
    expect(ui.host.textContent).not.toContain('81266');
    expect(ui.host.textContent).not.toContain('77777');
    expect(reads).toBe(2);
    sourceCurrentRead.resolve({ kind: 'available', operation: operation(operationA, authorA, 83377) });
    await ui.flush();
    expect(ui.host.textContent).toContain('83377');
    otherClient.clear();
  });
});

test('operation progress is withheld across operation, account and CSRF replacement until the current read returns', async () => {
  await withUi(async (ui) => {
    ui.setSession({ state: 'signed-in', subject: authorA, csrfToken: 'csrf-a' });
    const oldRead = gate<ErasureRead>();
    const replacementRead = gate<ErasureRead>();
    const replacedSessionRead = gate<ErasureRead>();
    const laterRead = gate<ErasureRead>();
    const accountRead = gate<ErasureRead>();
    let oldReads = 0;
    let replacementReads = 0;
    const replacementReader = () => {
      replacementReads += 1;
      return replacementReads === 1
        ? replacementRead.promise
        : replacementReads === 2
          ? laterRead.promise
          : replacementReads === 3
            ? replacedSessionRead.promise
            : accountRead.promise;
    };
    const originalReader = () => {
      oldReads += 1;
      return oldRead.promise;
    };
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(ui.window.document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    const timers = createRefreshTimers();
    const initialA: ErasureRead = { kind: 'available', operation: operation(operationA, authorA, 93177) };
    const initialB: ErasureRead = { kind: 'available', operation: operation(operationB, authorA, 82266) };
    const renderOperation = (initial: ErasureRead, id: string, read: () => Promise<ErasureRead>) =>
      createElement(ui.AuthorErasureOperationPage, { initial, operationId: id, read, navigationKey: 'visit-one' });
    try {
      await ui.render(renderOperation(initialA, operationA, originalReader));
      expect(ui.host.textContent).toContain('93177');
      await timers.fireNext();
      expect(oldReads).toBe(1);
      await ui.render(renderOperation(initialB, operationB, replacementReader));
      expect(ui.host.textContent).not.toContain('93177');
      expect(ui.host.textContent).not.toContain('82266');
      await ui.flush();
      expect(replacementReads).toBe(1);
      oldRead.resolve({ kind: 'available', operation: operation(operationA, authorA, 99999) });
      await ui.flush();
      expect(ui.host.textContent).not.toContain('99999');
      replacementRead.resolve({ kind: 'available', operation: operation(operationB, authorA, 82266) });
      await ui.flush();
      expect(ui.host.textContent).toContain('82266');

      await timers.fireNext();
      expect(replacementReads).toBe(2);
      await act(async () => ui.setSession({ state: 'signed-in', subject: authorA, csrfToken: 'csrf-a-replaced' }));
      await ui.flush();
      expect(ui.host.textContent).not.toContain('82266');
      expect(replacementReads).toBe(3);
      laterRead.resolve({ kind: 'available', operation: operation(operationB, authorA, 77777) });
      await ui.flush();
      expect(ui.host.textContent).not.toContain('77777');
      replacedSessionRead.resolve({ kind: 'available', operation: operation(operationB, authorA, 83377) });
      await ui.flush();
      expect(ui.host.textContent).toContain('83377');
      await act(async () => ui.setSession({ state: 'signed-in', subject: authorB, csrfToken: 'csrf-b' }));
      await ui.flush();
      expect(ui.host.textContent).not.toContain('83377');
      expect(replacementReads).toBe(4);
      await act(async () => ui.root.render(null));
      accountRead.resolve({ kind: 'available', operation: operation(operationB, authorB, 99988) });
      await ui.flush();
      expect(ui.host.textContent).toBe('');
    } finally {
      timers.restore();
    }
  });
});

test('operation refreshes stay visible-only and capped through authentication hydration, with manual recovery intact', async () => {
  await withUi(async (ui) => {
    const operationId = id(8);
    const owner = { state: 'signed-in' as const, subject: authorA, csrfToken: 'csrf-a' };
    ui.setSession(owner);
    let visibility: DocumentVisibilityState = 'hidden';
    Object.defineProperty(ui.window.document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    let reads = 0;
    let pollCount = 0;
    let terminal = false;
    const reader = async (): Promise<ErasureRead> => {
      reads += 1;
      return terminal
        ? {
            kind: 'available',
            operation: {
              ...operation(operationId, authorA, reads),
              done: true,
              response: { processedPosts: reads, erasedRevisions: reads * 2 },
            },
          }
        : { kind: 'available', operation: operation(operationId, authorA, reads) };
    };
    const timers = createRefreshTimers(() => {
      pollCount += 1;
    });
    try {
      await ui.render(
        createElement(ui.AuthorErasureOperationPage, {
          initial: { kind: 'available', operation: operation(operationId, authorA, 0) },
          operationId,
          navigationKey: 'hydrate-once',
          read: reader,
        }),
      );
      expect(timers.pending()).toBe(0);
      visibility = 'visible';
      await act(async () => ui.window.document.dispatchEvent(new ui.window.Event('visibilitychange')));
      expect(timers.pending()).toBe(1);
      await timers.fireNext();
      expect(pollCount).toBe(1);
      expect(reads).toBe(1);

      await act(async () => {
        await ui.client.invalidateQueries({ queryKey: ['session'], refetchType: 'none' });
        ui.client.removeQueries({ queryKey: ['session'] });
      });
      await ui.flush();
      expect(ui.host.textContent).not.toContain('83377');
      await act(async () => ui.setSession(owner));
      await ui.flush();
      // The hydration recovery is one required current read. It does not recreate the four-read budget.
      expect(reads).toBe(2);
      expect(timers.pending()).toBe(1);
      await timers.fireNext();
      await timers.fireNext();
      await timers.fireNext();
      expect(pollCount).toBe(4);
      expect(reads).toBe(5);
      expect(timers.pending()).toBe(0);
      expect(ui.button(ui.m.author_erasure_check_again()).disabled).toBe(false);

      terminal = true;
      await ui.click(ui.m.author_erasure_check_again());
      await ui.flush();
      expect(reads).toBe(6);
      expect(ui.host.textContent).toContain(ui.m.author_erasure_success());
      expect(ui.host.querySelector('button')).toBeNull();
      expect(timers.pending()).toBe(0);
    } finally {
      timers.restore();
    }
  });
});

function createRefreshTimers(onFire?: () => void) {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const queued = new Map<number, () => void>();
  let nextId = 0;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 2000 && typeof handler === 'function') {
      const id = ++nextId;
      queued.set(id, () => handler(...args));
      return id as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSet(handler, timeout, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    if (typeof timer === 'number' && queued.delete(timer)) return;
    originalClear(timer);
  }) as typeof clearTimeout;
  return {
    pending: () => queued.size,
    async fireNext() {
      const next = queued.entries().next().value as [number, () => void] | undefined;
      expect(next).toBeDefined();
      queued.delete(next![0]);
      onFire?.();
      await act(async () => {
        next![1]();
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    restore() {
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
      queued.clear();
    },
  };
}
