import { expect, mock, test } from 'bun:test';
import { act } from 'react';
import * as start from '../.storybook/react-start';
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
import { id, operation, restored } from './bulk-operation-undo-fixtures';
import type { BulkUndoOutcome, BulkUndoRead } from '../src/library/bulk-operation-undo-evidence';
import type { OperationAddress } from '../src/library/bulk-operation-recovery-native';
import type { UndoTarget, RestoreSender } from '../src/library/bulk-operation-undo';
const rows: BulkUndoOutcome[] = ['one', 'two', 'expired', 'no-evidence'].map((subjectId, ordinal) => ({
  ordinal: String(ordinal),
  subjectId,
  state: 'applied',
  memberId: null,
  resultingMemberId: null,
  reason: null,
  memberDeletion: null,
  deletion:
    ordinal === 3
      ? null
      : { deletionId: id, revision: 12, restoreUntil: ordinal === 2 ? '2000-01-01T00:00:00Z' : '2099-11-04T00:00:00Z' },
}));
let currentDeletion = rows[0]!.deletion!;
const reads: { data: OperationAddress; resolve: (value: BulkUndoRead) => void }[] = [];
const preparations: { data: UndoTarget; headers: Headers }[] = [];
const sends: Parameters<RestoreSender>[0][] = [];
let acknowledge = false;
const originalRecoveryServer = { ...(await import('../src/library/bulk-operation-recovery-server')) };
mock.module('../src/library/bulk-operation-recovery-server', () => ({
  ...originalRecoveryServer,
  readBulkOperation: ({ data }: { data: OperationAddress }) =>
    new Promise<BulkUndoRead>((resolve) => reads.push({ data, resolve })),
}));
mock.module('../src/library/bulk-operation-undo-server', () => ({
  prepareBulkOperationUndo: async (input: (typeof preparations)[number]) => {
    preparations.push(input);
    return {
      state: 'ready',
      undo: {
        subjectId: input.data.subjectId,
        ...currentDeletion,
        idempotencyKey: crypto.randomUUID(),
        credential: 'encrypted_original',
      },
    };
  },
}));
mock.module('../src/library/entries-actions', () => ({
  restorePersonalLibraryEntryAction: async (input: (typeof sends)[number]) => {
    sends.push(input);
    return acknowledge ? restored : { ok: false, reason: 'unavailable' };
  },
}));

test('reopened page reads without CSRF, offers explicit eligible targets, and retains uncertain commands across read recovery', async () => {
  const { Window } = await import('happy-dom');
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
  const ready: Extract<BulkUndoRead, { state: 'ready' }> = {
    state: 'ready',
    operation,
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
    await act(async () => expose(['personal_library', 'library_entry.restore']));
    await act(async () => buttons(m.managed_refresh())[0]!.click());
    await act(async () => reads.at(-1)!.resolve({ ...ready, page: { outcomes: rows, next: 'second' } }));
    const move = async (label: string, result: BulkUndoRead) => {
      await act(async () => buttons(label)[0]!.click());
      await act(async () => reads.at(-1)!.resolve(result));
    };
    await move(m.bulk_operation_more(), { ...ready, page: { outcomes: [rows[1]!], next: 'third' } });
    expect(reads.at(-1)!.data.cursor).toBe('second');
    await move(m.bulk_operation_more(), { ...ready, page: { outcomes: [rows[2]!], next: null } });
    expect(reads.at(-1)!.data.cursor).toBe('third');
    expect(host.textContent).toContain(m.library_bulk_undo_expired());
    expect(buttons(m.library_window_previous())[0]!.disabled).toBe(false);
    await move(m.library_window_previous(), { state: 'unavailable' });
    expect(reads.at(-1)!.data.cursor).toBe('second');
    await move(m.library_window_retry(), { ...ready, page: { outcomes: [rows[1]!], next: 'third' } });
    expect(reads.at(-1)!.data.cursor).toBe('second');
    currentDeletion = { ...currentDeletion, revision: 19 };
    const revisited = [{ ...rows[0]!, deletion: currentDeletion }, ...rows.slice(1)];
    await move(m.library_window_previous(), { ...ready, page: { outcomes: revisited, next: 'replacement-next' } });
    expect(reads.at(-1)!.data).not.toHaveProperty('cursor');
    expect(host.textContent).toContain(m.library_bulk_undo_expired());
    await act(async () => buttons(m.editor_undo())[0]!.click());
    expect(preparations).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.data).toMatchObject({ subjectId: 'one', ...currentDeletion });
    expect(preparations[0]!.data).toMatchObject({ id, ordinal: '0', subjectId: 'one' });
    await move(m.bulk_operation_more(), { ...ready, page: { outcomes: [], next: null } });
    expect(reads.at(-1)!.data.cursor).toBe('replacement-next');
    await move(m.managed_refresh(), { ...ready, page: { outcomes: [], next: null } });
    expect(reads.at(-1)!.data.cursor).toBe('replacement-next');
    const form = host.querySelector('form')!;
    expect(form.querySelector<HTMLInputElement>('[name="credential"]')!.value).toBe('encrypted_original');
    expect(form.querySelector<HTMLInputElement>('[name="csrf_token"]')!.value).toBe('original-csrf');
    acknowledge = true;
    const beforeRetry = reads.length;
    await act(async () => {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(sends).toHaveLength(2);
    expect(sends[1]!.data).toBe(sends[0]!.data);
    expect([...sends[1]!.headers]).toEqual([...sends[0]!.headers]);
    expect(reads).toHaveLength(beforeRetry);
    expect(preparations).toHaveLength(1);
    expect(host.textContent).toContain(m.library_bulk_undo_restored());
    await move(m.managed_refresh(), { ...ready, page: { outcomes: [], next: null } });
    expect(host.textContent).toContain(m.library_bulk_undo_restored());
    await move(m.library_window_first(), ready);
    expect(reads.at(-1)!.data).not.toHaveProperty('cursor');
    expect(buttons(m.library_window_previous())[0]!.disabled).toBe(true);
    // An equal native admission replacement retires evidence coordinates, not command receipts.
    await act(async () => expose(['personal_library', 'library_entry.restore']));
    expect(host.textContent).not.toContain('no-evidence');
    expect(host.textContent).toContain(m.library_bulk_undo_restored());
    await move(m.managed_refresh(), ready);
    expect(reads.at(-1)!.data).not.toHaveProperty('cursor');
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
    mock.module('../src/library/bulk-operation-recovery-server', () => originalRecoveryServer);
    mock.restore();
  }
});
