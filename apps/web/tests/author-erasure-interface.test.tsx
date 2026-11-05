import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import type { ErasureOperation, ErasureRead } from '../src/threads/author-erasure';

test('author erasure production views keep their named shared anatomy, bounded copy, independent controls and withheld state', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/threads/example', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
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
    [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  let networkRequests = 0;
  globalThis.fetch = (async () => {
    networkRequests += 1;
    throw new Error('The interface regression must not make network requests');
  }) as typeof fetch;
  mock.module('cloudflare:workers', () => ({ env: {} }));

  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { AuthorErasureEntry } = await import('../src/threads/author-erasure-entry');
  const { AuthorErasureOperationPage } = await import('../src/threads/author-erasure-operation');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale } = await import('../src/paraglide/runtime.js');

  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const authorId = '0192f3a0-6c1e-7b2a-9d4e-000000000006';
  const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  const operationId = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
  const operation: ErasureOperation = {
    name: `operations/${operationId}`,
    done: false,
    metadata: {
      type: 'content.author_erasure',
      threadId,
      authorId,
      processedPosts: 8,
      erasedRevisions: 19,
      steps: 2,
    },
  };
  const available: ErasureRead = { kind: 'available', operation };
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: authorId, csrfToken: 'fixture-token' });
  const render = async (node: ReactNode) =>
    act(async () => {
      root.render(createElement(QueryClientProvider, { client }, node));
      await Promise.resolve();
      await Promise.resolve();
    });
  const button = (label: string): HTMLButtonElement => {
    const match = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
    expect(match).toBeDefined();
    return match!;
  };
  const click = async (label: string) =>
    act(async () => {
      button(label).click();
      await Promise.resolve();
      await Promise.resolve();
    });

  try {
    let admissionReads = 0;
    let settleLateAdmission!: () => void;
    const intents: { threadId: string; idempotencyKey: string }[] = [];
    let acceptedOperation = '';
    const send = async (intent: { threadId: string; idempotencyKey: string }) => {
      intents.push(intent);
      return intents.length === 1 ? ({ kind: 'uncertain' } as const) : ({ kind: 'accepted', operationId } as const);
    };
    await render(
      createElement(AuthorErasureEntry, {
        threadId,
        viewerId: authorId,
        readAdmission: async () => {
          admissionReads += 1;
          if (admissionReads === 2) await new Promise<void>((resolve) => (settleLateAdmission = resolve));
          return { kind: 'current', authorId, mayErase: true } as const;
        },
        send,
        onAccepted: (id: string) => {
          acceptedOperation = id;
        },
      }),
    );
    await click(m.author_erasure_action());

    const confirmation = host.querySelector('[data-slot="content-item-frame"]');
    const opener = button(m.author_erasure_action());
    expect(confirmation).not.toBeNull();
    expect(opener.getAttribute('aria-controls')).toBe(confirmation?.id);
    expect(window.document.activeElement).toBe(host.querySelector('h2'));
    expect(confirmation?.classList.contains('border')).toBe(false);
    expect(confirmation?.classList.contains('bg-card')).toBe(false);
    expect(host.querySelector('h2')?.textContent).toBe(m.author_erasure_confirm_title());
    const scope = [...host.querySelectorAll('p')].find((item) => item.textContent === m.author_erasure_scope());
    const irreversible = [...host.querySelectorAll('p')].find(
      (item) => item.textContent === m.author_erasure_irreversible(),
    );
    expect(scope).toBeDefined();
    expect(irreversible).toBeDefined();
    expect(scope?.classList.contains('break-words')).toBe(true);
    expect(irreversible?.classList.contains('break-words')).toBe(true);
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox?.closest('label')?.textContent).toContain(m.author_erasure_confirmation());
    await act(async () => checkbox?.click());
    expect(button(m.author_erasure_close())).toBeDefined();
    expect(button(m.author_erasure_check_again())).toBeDefined();
    expect(button(m.author_erasure_confirm()).disabled).toBe(false);

    for (const width of [390, 1280]) {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      expect(window.innerWidth).toBe(width);
      expect(scope?.textContent).toBe(m.author_erasure_scope());
      expect(scope?.classList.contains('break-words')).toBe(true);
    }
    for (const control of [checkbox!, button(m.author_erasure_check_again()), button(m.author_erasure_close())]) {
      control.focus();
      expect(window.document.activeElement).toBe(control);
    }

    await click(m.author_erasure_check_again());
    expect(admissionReads).toBe(2);
    await click(m.author_erasure_close());
    await act(async () => {
      settleLateAdmission();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-slot="content-item-frame"]')).toBeNull();
    expect(window.document.activeElement).toBe(opener);
    expect(intents).toHaveLength(0);
    await click(m.author_erasure_action());
    const reopenedCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(reopenedCheckbox.checked).toBe(true);
    await click(m.author_erasure_confirm());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.author_erasure_uncertain());
    await click(m.author_erasure_retry());
    expect(intents).toHaveLength(2);
    expect(intents[1]).toEqual(intents[0]);
    expect(acceptedOperation).toBe(operationId);
    const progressLink = host.querySelector<HTMLAnchorElement>('a[href*="/operations/"]');
    expect(progressLink?.getAttribute('href')).toBe(`/${getLocale()}/operations/${encodeURIComponent(operationId)}`);

    let progressReads = 0;
    const read = async () => {
      progressReads += 1;
      return available;
    };
    await render(
      createElement(AuthorErasureOperationPage, {
        initial: available,
        operationId,
        read,
      }),
    );
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toBe(m.author_erasure_operation_title());
    expect(host.querySelector('h2')?.textContent).toBe(m.author_erasure_running());
    expect(host.querySelector('[data-slot="content-item-frame"]')).not.toBeNull();
    expect(host.querySelector('dl')?.textContent).toContain(m.author_erasure_processed());
    expect(host.querySelector('dl')?.textContent).toContain('8');
    expect(host.querySelector('dl')?.textContent).toContain('19');
    expect(host.querySelector('dl')?.textContent).toContain('2');
    expect(host.querySelector('progress')).toBeNull();
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    const details = host.querySelector('details');
    const summary = details?.querySelector('summary');
    expect(summary?.textContent).toBe(m.author_erasure_interface_count_details());
    expect(details?.textContent).toContain(m.author_erasure_interface_count_details_copy());
    summary?.focus();
    expect(window.document.activeElement).toBe(summary);
    await act(async () => summary?.click());
    expect(details?.open).toBe(true);
    const operationFrame = host.querySelector('[data-slot="content-item-frame"]');
    expect(operationFrame?.classList.contains('border')).toBe(false);
    expect(operationFrame?.classList.contains('bg-card')).toBe(false);
    const headerScope = [...host.querySelectorAll('header p')].find(
      (item) => item.textContent === m.author_erasure_scope(),
    );
    expect(headerScope?.classList.contains('break-words')).toBe(true);
    for (const width of [390, 1280]) {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      expect(window.innerWidth).toBe(width);
      expect(headerScope?.textContent).toBe(m.author_erasure_scope());
      expect(headerScope?.classList.contains('break-words')).toBe(true);
    }
    expect(progressReads).toBe(0);

    const refusals = [
      { kind: 'signed-out', copy: m.author_erasure_sign_in() },
      { kind: 'forbidden', copy: m.author_erasure_forbidden() },
      { kind: 'not-found', copy: m.author_erasure_not_found() },
      { kind: 'conflict', copy: m.author_erasure_conflict() },
      { kind: 'unavailable', copy: m.author_erasure_unavailable() },
    ] as const;
    for (const refusal of refusals) {
      await render(
        createElement(AuthorErasureOperationPage, {
          key: refusal.kind,
          initial: { kind: refusal.kind },
          operationId,
          read: async () => ({ kind: refusal.kind }),
        }),
      );
      expect(host.textContent).toContain(refusal.copy);
      expect(host.textContent).not.toContain(authorId);
      expect(host.textContent).not.toContain(threadId);
      expect(host.textContent).not.toContain(operationId);
      expect(host.querySelector('dl')).toBeNull();
      expect(button(m.author_erasure_check_again()).disabled).toBe(false);
    }

    await render(
      createElement(AuthorErasureOperationPage, {
        key: 'pending-read',
        initial: { kind: 'unavailable' },
        operationId,
        read: () => new Promise<ErasureRead>(() => {}),
      }),
    );
    await click(m.author_erasure_check_again());
    expect(button(m.author_erasure_checking()).disabled).toBe(true);
    expect(host.querySelector('dl')).toBeNull();
    expect(host.textContent).not.toContain(authorId);
    expect(host.textContent).not.toContain(threadId);
    expect(host.textContent).not.toContain(operationId);
    expect(networkRequests).toBe(0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    if (originalFetch) globalThis.fetch = originalFetch;
  }
});
