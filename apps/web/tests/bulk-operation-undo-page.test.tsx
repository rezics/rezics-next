import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const id = '12345678-1234-4234-8234-123456789abc';
const rows = ['one', 'two', 'expired', 'no-evidence'].map((subjectId, ordinal) => ({
  ordinal: String(ordinal),
  subjectId,
  state: 'applied',
  memberId: null,
  resultingMemberId: null,
  reason: null,
  deletion:
    ordinal === 3
      ? null
      : { deletionId: id, revision: 12, restoreUntil: ordinal === 2 ? '2000-01-01T00:00:00Z' : '2099-11-04T00:00:00Z' },
}));
const reads: { resolve: (value: unknown) => void }[] = [];
const preparations: { data: { subjectId: string }; headers: Headers }[] = [];
const sends: { data: { subjectId: string; credential: string }; headers: Headers }[] = [];
mock.module('../src/library/bulk-operation-recovery-server', () => ({
  readBulkOperation: () => new Promise((resolve) => reads.push({ resolve })),
}));
mock.module('../src/library/bulk-operation-undo-server', () => ({
  prepareBulkOperationUndo: async (input: (typeof preparations)[number]) => {
    preparations.push(input);
    return {
      state: 'ready',
      undo: {
        subjectId: input.data.subjectId,
        ...rows[0]!.deletion!,
        idempotencyKey: crypto.randomUUID(),
        credential: 'encrypted_original',
      },
    };
  },
}));
mock.module('../src/library/entries-actions', () => ({
  restorePersonalLibraryEntryAction: async (input: (typeof sends)[number]) => {
    sends.push(input);
    return { ok: false, reason: 'unavailable' };
  },
}));

test('reopened page reads without CSRF, offers explicit eligible targets, and retains uncertain commands across read recovery', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.test/en/library/operations/${id}/undo` });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { sessionQuery } = await import('../src/session/query');
  const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const { BulkOperationUndoPage } = await import('../src/library/bulk-operation-undo-page');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = (csrfToken: string | null) =>
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken });
  session(null);
  const lifetime = viewerExposureLifetime(client);
  const stop = lifetime.subscribe(() => {});
  const expose = (admitted: string[]) => {
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state === 'signed-in')
      client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, { subject: 'alice', admitted });
  };
  expose(['personal_library', 'library_entry.restore']);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const ready = {
    state: 'ready',
    operation: { id, action: 'remove_from_library', phase: 'completed' },
    page: { outcomes: rows, next: null },
  };
  const buttons = (label: string) =>
    [...host.querySelectorAll('button')].filter((button) => button.textContent === label);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <BulkOperationUndoPage id={id} href={`/en/library/operations/${id}/undo`} />
        </QueryClientProvider>,
      ),
    );
    await act(async () => reads.at(-1)!.resolve(ready));
    expect(host.textContent).toContain('no-evidence');
    expect(buttons(m.editor_undo())).toHaveLength(2);
    expect(buttons(m.editor_undo()).every((button) => button.disabled)).toBe(true);
    expect(preparations).toHaveLength(0);
    await act(async () => session('original-csrf'));
    await act(async () => buttons(m.editor_undo())[0]!.click());
    expect(preparations).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.data.subjectId).toBe('one');
    await act(async () => session('new-csrf'));
    await act(async () => buttons(m.bulk_operation_recover())[0]!.click());
    await act(async () => reads.at(-1)!.resolve(ready));
    const form = host.querySelector('form')!;
    expect(form.querySelector<HTMLInputElement>('[name="credential"]')!.value).toBe('encrypted_original');
    expect(form.querySelector<HTMLInputElement>('[name="csrf_token"]')!.value).toBe('original-csrf');
    await act(async () => {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(sends).toHaveLength(2);
    expect(sends[1]!.data).toBe(sends[0]!.data);
    expect([...sends[1]!.headers]).toEqual([...sends[0]!.headers]);
    await act(async () => expose(['personal_library']));
    expect(host.textContent).toContain('one');
    expect(buttons(m.editor_undo())).toHaveLength(0);
    expect(host.querySelector('form')).toBeNull();
    await act(async () => expose([]));
    expect(host.textContent).not.toContain('no-evidence');
  } finally {
    await act(async () => root.unmount());
    stop();
    client.clear();
    setLocale(oldLocale, { reload: false });
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
  }
});
