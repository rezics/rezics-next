import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createElement, act, useState } from 'react';
import * as start from '../.storybook/react-start';
import copyRecording from '../src/kernel/recorded/library-copies.json';
import type { CopyItem } from '../src/library/copies-read';

// Reuse the DOM implementation already installed for the Web editor; no browser or service is started.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/copies' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'MutationObserver',
  'ResizeObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const value = window[name as keyof typeof window];
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: typeof value === 'function' && /^[a-z]/.test(name) ? value.bind(window) : value,
  });
}
originals.set('IS_REACT_ACT_ENVIRONMENT', Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

const ownerRequest = new Request(window.location.href, { headers: { authorization: 'Bearer owner' } });
mock.module('cloudflare:workers', () => ({ env: { KERNEL_ORIGIN: 'https://kernel.test' } }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({ ...start, getRequest: () => ownerRequest }));
const { CopyForm } = await import('../src/library/copies-page');
const { suggestionResponse } = await import('../src/search/suggestions');
const { createRoot } = await import('react-dom/client');
const { m } = await import('../src/paraglide/messages.js');
const oldFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = oldFetch;
  await window.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}
const fields = { location: null, source: null, acquiredOn: null, disposedOn: null, note: null };

test('Add copy by finding and selecting a recognisable edition', async () => {
  const first = { id: id(1), type: 'schema:Book', labels: { en: 'The Little Prince — first edition' } };
  const second = { id: id(2), type: 'EBook', labels: { en: 'Kokoro — English edition' } };
  const release = {
    types: { 'schema:Book': { library: { profileId: 'print' } }, EBook: { library: { profileId: 'digital' } } },
    properties: {},
    libraryProfiles: {
      print: {
        copies: {
          kinds: [{ id: 'print', labels: { en: 'Print' }, statuses: [{ id: 'shelf', labels: { en: 'On shelf' } }] }],
        },
      },
      digital: {
        copies: {
          kinds: [
            { id: 'digital', labels: { en: 'Digital' }, statuses: [{ id: 'available', labels: { en: 'Available' } }] },
          ],
        },
      },
    },
  };
  const oldSearch = deferred<Response>();
  const oldProfile = deferred<Response>();
  const calls: Request[] = [];
  const writes: Record<string, unknown>[] = [];
  const writeKeys: string[] = [];
  const created: CopyItem[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(
      new URL(String(input instanceof Request ? input.url : input), window.location.href),
      init,
    );
    const url = new URL(request.url);
    if (url.pathname === '/api/search/suggestions') {
      // The default client reaches the actual authorised BFF, then the native suggestion transport below.
      return suggestionResponse(
        new Request(url, { headers: { authorization: 'Bearer owner' }, signal: request.signal }),
        {},
      );
    }
    calls.push(request);
    if (url.pathname === '/v1/subjects:suggest') {
      expect(request.headers.get('authorization')).toBe('Bearer owner');
      const query = url.searchParams.get('q');
      if (query === 'Old') return oldSearch.promise; // Deliberately ignores cancellation.
      const subject = query === 'Prince' ? first : second;
      return Response.json({
        subjects: [
          {
            ...subject,
            facts: {},
            summary: {
              id: subject.id,
              type: subject.type,
              types: [subject.type],
              label: { value: Object.values(subject.labels)[0]!, language: 'en' },
              creativeWork: true,
              cover: copyRecording.copies[1]!.subject.cover,
            },
          },
        ],
        as_of: '2026-11-01T00:00:00.000Z',
      });
    }
    if (url.pathname === `/v1/subjects/${first.id}`) return oldProfile.promise;
    if (url.pathname === `/v1/subjects/${second.id}`) {
      expect(request.headers.get('authorization')).toBe('Bearer owner');
      return Response.json({ subject: second });
    }
    if (url.pathname === '/v1/definitions/active') return Response.json({ digest: 'edition-test' });
    if (url.pathname === '/v1/definitions/releases/edition-test')
      return Response.json({ digest: 'edition-test', release });
    if (url.pathname === '/v1/copies' && request.method === 'POST') {
      expect(request.headers.get('authorization')).toBe('Bearer owner');
      writeKeys.push(request.headers.get('idempotency-key')!);
      const body = (await request.json()) as Record<string, unknown>;
      writes.push(body);
      return Response.json({ copy: { ...body, id: id(200 + writes.length), revision: 1 } }, { status: 201 });
    }
    throw new Error(`Unexpected transport: ${request.method} ${url}`);
  }) as typeof fetch;

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Form() {
    const [key, setKey] = useState(id(100));
    return createElement(CopyForm, {
      inline: true,
      subjectId: null,
      addKey: key,
      sendKind: true,
      onKey: setKey,
      onClose() {},
      onCreated: (copy: CopyItem) => {
        created.push(copy);
      },
      onSaved() {},
      onRemoved() {},
    });
  }
  const settle = async (ms = 0) => {
    await act(async () => {
      await Bun.sleep(ms);
    });
  };
  const until = async (read: () => boolean) => {
    for (let n = 0; n < 50 && !read(); n++) await settle(10);
    expect(read(), `${document.body.innerHTML}\n${calls.map((request) => request.url).join('\n')}`).toBe(true);
  };
  const text = (value: string) => document.body.textContent?.includes(value) ?? false;
  const input = () => container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const type = async (value: string) => {
    await act(async () => {
      input().focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
      input().dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    });
  };
  const pick = async (name: string) => {
    await until(() =>
      [...document.querySelectorAll('[role="option"]')].some((item) => item.textContent?.includes(name)),
    );
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
      item.textContent?.includes(name),
    )!;
    await act(async () => {
      option.click();
    });
  };
  const subjectId = () => container.querySelector<HTMLInputElement>('input[name="subjectId"]')!.value;
  const submit = async () => {
    const form = container.querySelector('form')!;
    expect(form.querySelector<HTMLInputElement>('input[name="intent"]')!.value).toBe('create');
    await act(async () => {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  };
  try {
    await act(async () => {
      root.render(createElement(Form));
    });
    await type('Old');
    await settle(270);
    await type('Prince');
    await settle(270);
    await pick(first.labels.en);
    expect(text(m.library_copy_profile_loading())).toBe(true);
    expect(subjectId()).toBe('');
    await submit();
    expect(writes).toHaveLength(0);

    await type('Kokoro');
    expect(subjectId()).toBe('');
    await settle(270);
    await pick(second.labels.en);
    await until(() => subjectId() === second.id);
    expect(container.querySelector('select[name="status"]')?.textContent).toBe('Available');
    expect(container.querySelector('[data-slot="cover"]')).not.toBeNull();

    // Both an older query and an older point read finish after the current selection.
    oldSearch.resolve(Response.json({ subjects: [first], types: {} }));
    oldProfile.resolve(Response.json({ subject: first }));
    await settle();
    expect(subjectId()).toBe(second.id);
    expect(container.querySelector('select[name="status"]')?.textContent).toBe('Available');
    expect(text(first.labels.en)).toBe(false);

    await type('Kokoro edited');
    expect(subjectId()).toBe('');
    expect(container.querySelector('select[name="status"]')).toBeNull();
    await submit();
    expect(writes).toHaveLength(0);
    await type('Kokoro');
    await settle(270);
    await pick(second.labels.en);
    await until(() => subjectId() === second.id);
    await submit();
    await until(() => created.length === 1);
    await submit();
    await until(() => created.length === 2);
    expect(writes).toEqual(
      Array.from({ length: 2 }, () => ({ subjectId: second.id, kind: 'digital', status: 'available', ...fields })),
    );
    expect(created[0]!.id).not.toBe(created[1]!.id);
    expect(writeKeys[0]).toBe(JSON.stringify(id(100)));
    expect(writeKeys[1]).not.toBe(writeKeys[0]);
    expect(created[0]!.subject?.label).toBe(second.labels.en);
    expect(created[0]!.subject?.cover).toEqual(copyRecording.copies[1]!.subject.cover);
    expect(calls.filter((call) => new URL(call.url).pathname === `/v1/subjects/${first.id}`)).toHaveLength(1);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
