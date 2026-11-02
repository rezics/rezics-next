import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const requests: { data: { id: string; viewer: string; cursor?: string }; resolve: (value: unknown) => void }[] = [];
const commands: unknown[] = [];
mock.module('../src/library/bulk-operation-recovery-server', () => ({
  readBulkOperation: (input: { data: { id: string; viewer: string; cursor?: string } }) => new Promise((resolve) => requests.push({ ...input, resolve })),
  cancelBulkOperation: (input: unknown) => { commands.push(input); return Promise.resolve({ state: 'uncertain' }); },
}));

test('mounted reader retires private results across exposure, address, viewer and locale changes', async () => {
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
  const window = new Window({ url: 'https://site.test/en/library/operations/12345678-1234-4234-8234-123456789abc' });
  const globals = { window, document: window.document, navigator: window.navigator, location: window.location,
    HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { sessionQuery } = await import('../src/session/query');
  const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const { BulkOperationPage } = await import('../src/library/bulk-operation-recovery-page');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken: 'original-csrf' });
  const lifetime = viewerExposureLifetime(client);
  const stop = lifetime.subscribe(() => {});
  const expose = (admitted: string[]) => {
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state === 'signed-in') client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, { subject: snapshot.observation.subject, admitted });
  };
  expose(['personal_library']);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const id = '12345678-1234-4234-8234-123456789abc';
  let href = `/en/library/operations/${id}`;
  const render = () => root.render(<StrictMode><QueryClientProvider client={client}><BulkOperationPage id={id} href={href} /></QueryClientProvider></StrictMode>);
  const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
  const click = (label: string) => button(label).click();
  const ready = { state: 'ready', operation: {
    id, action: 'set_status', phase: 'applying', state: 'planned', collectionId: null, cancelRequested: false,
    counts: { targets: 2, applied: 1, no_effect: 0, pending: 1, reconciling: 0, failed: 0, denied: 0, conflict: 0, cancelled: 0 },
    admittedAt: '2026-11-03T00:00:00Z', expiresAt: '2026-11-04T00:00:00Z', resultsExpireAt: '2026-11-05T00:00:00Z',
  }, page: { outcomes: [{ ordinal: '1', subjectId: 'private-target', state: 'applied', reason: null }], next: 'native-cursor' } };
  try {
    await act(async () => render());
    expect(requests.length).toBeGreaterThan(0);
    // Strict Mode may retire its first mounted read. Only its replacement can disclose.
    await act(async () => { requests.forEach((request) => request.resolve(ready)); });
    expect(host.textContent).toContain('private-target');
    expect(host.textContent).toContain(ready.operation.expiresAt);
    await act(async () => click(m.bulk_operation_more()));
    expect(requests.at(-1)!.data).toEqual({ id, viewer: 'alice', cursor: 'native-cursor' });
    await act(async () => { expose([]); expose(['personal_library']); });
    await act(async () => requests.at(-1)!.resolve(ready));
    expect(host.textContent).not.toContain('private-target');
    await act(async () => click(m.bulk_operation_recover()));
    await act(async () => requests.at(-1)!.resolve(ready));
    await act(async () => click(m.bulk_operation_cancel()));
    await act(async () => click(m.bulk_operation_retry_cancel()));
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]).toMatchObject({ data: { id, viewer: 'alice', csrf: 'original-csrf' }, headers: { 'X-CSRF-Token': 'original-csrf' } });
    await act(async () => { href = href + '?retired=1'; render(); });
    expect(host.textContent).not.toContain('private-target');
    await act(async () => { client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'bob', csrfToken: 'bob-csrf' }); expose(['personal_library']); });
    await act(async () => requests.at(-1)!.resolve(ready));
    await act(async () => { setLocale('fr', { reload: false }); render(); });
    expect(host.textContent).not.toContain('private-target');
  } finally {
    await act(async () => root.unmount());
    stop(); client.clear(); setLocale(oldLocale, { reload: false });
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
  }
});
