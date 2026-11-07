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
