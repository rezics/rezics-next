import { afterAll, expect, mock, test } from 'bun:test';
import * as start from '../.storybook/react-start';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { QueryClient } = await import('@tanstack/react-query');
const { libraryApplication } = await import('../src/session/library-application');
const { holdCompletedArchive, completedArchiveFor, bindArchiveCustodyOwner } =
  await import('../src/library/private-export/custody');
afterAll(() => mock.restore());

const session = (subject: string) => ({ state: 'signed-in', subject, csrfToken: `csrf-${subject}` });

test('archive callbacks distinguish equal observations, ABA and removed/recreated session queries', () => {
  const client = new QueryClient();
  client.setQueryData(['session'], session('A'));
  const observer = libraryApplication.recoveryObservation(client);
  const original = observer.read();
  expect(observer.read()).toBe(original);
  client.setQueryData(['unrelated'], 'public');
  expect(observer.read()).toBe(original);
  client.setQueryData(['session'], session('A'));
  expect(observer.read().identity).not.toBe(original.identity);
  const replacement = observer.read();
  client.setQueryData(['session'], session('B'));
  client.setQueryData(['session'], session('A'));
  expect(observer.read().identity).not.toBe(replacement.identity);
  const beforeRemoval = observer.read();
  client.removeQueries({ queryKey: ['session'], exact: true });
  client.setQueryData(['session'], session('A'));
  expect(observer.read().identity).not.toBe(beforeRemoval.identity);
  client.clear();
});

test('application observation retires completed private bytes synchronously before account return', () => {
  const client = new QueryClient();
  client.setQueryData(['session'], session('A'));
  const observer = libraryApplication.recoveryObservation(client);
  const stop = observer.subscribe(() => bindArchiveCustodyOwner(observer.read().subject ?? ''));
  // Custody owns a copy of the downloaded bytes and erases it at reader replacement.
  holdCompletedArchive(
    'A',
    {
      filename: 'archive.json',
      mediaType: 'application/json',
      bytes: new Uint8Array([65, 66]),
    },
    { exportId: 'export', capturedAt: '2026-11-07T00:00:00Z', version: 4 },
  );
  const held = completedArchiveFor('A')!;
  client.setQueryData(['session'], session('B'));
  expect(completedArchiveFor('A')).toBeNull();
  expect([...held.bytes]).toEqual([0, 0]);
  client.setQueryData(['session'], session('A'));
  expect(completedArchiveFor('A')).toBeNull();
  stop();
  client.clear();
});

test('installed Library composition keeps recovery sections independent and erases custody before React catches up', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const { act, createElement, Fragment } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClientProvider } = await import('@tanstack/react-query');
  const { LibraryApplicationBoundary } = await import('../src/session/library-application');
  const { useRecoveryLifetime } = await import('../src/library/recovery-lifetime');
  const window = new Window({ url: 'https://site.test/en/library/archive' });
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(window.document.createElement('div'));
  const client = new QueryClient();
  client.setQueryData(['session'], session('A'));
  const sections = new Map<string, ReturnType<typeof useRecoveryLifetime>>();
  function Section({ name }: { name: string }) {
    sections.set(name, useRecoveryLifetime(`/en/library/archive/${name}`, 'en'));
    return null;
  }
  try {
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            LibraryApplicationBoundary,
            null,
            createElement(
              Fragment,
              null,
              createElement(Section, { name: 'entries' }),
              createElement(Section, { name: 'progress' }),
            ),
          ),
        ),
      );
    });
    const entries = sections.get('entries')!;
    const progress = sections.get('progress')!;
    expect(entries.current()).toBe(true);
    expect(progress.current()).toBe(true);
    entries.retire();
    expect(entries.current()).toBe(false);
    expect(progress.current()).toBe(true);
    let retired = false;
    progress.onRetire(() => {
      retired = true;
    });
    const same = client.getQueryData(['session']);
    const updatedAt = client.getQueryState(['session'])!.dataUpdatedAt;
    await act(async () => {
      client.setQueryData(['session'], same, { updatedAt });
      expect(retired).toBe(true);
      expect(progress.current()).toBe(false);
    });
    holdCompletedArchive(
      'A',
      { filename: 'archive.json', mediaType: 'application/json', bytes: new Uint8Array([1, 2]) },
      { exportId: 'installed', capturedAt: '2026-11-07T00:00:00Z', version: 4 },
    );
    const held = completedArchiveFor('A')!;
    await act(async () => {
      client.setQueryData(['session'], { state: 'signed-out', csrfToken: null });
      expect(completedArchiveFor('A')).toBeNull();
      expect([...held.bytes]).toEqual([0, 0]);
      client.setQueryData(['session'], session('A'));
      expect(completedArchiveFor('A')).toBeNull();
    });
    expect(progress.current()).toBe(false);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.close();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
