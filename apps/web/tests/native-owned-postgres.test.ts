import { expect, test } from 'bun:test';
import {
  isolatedOwnedPostgresUrl,
  nativeOwnedPostgresIsolated,
  networkInterfaceNames,
  ownedPostgresIsolated,
} from './native/owned-postgres.ts';

test('a loopback-only netns is isolated from published PostgreSQL host ports', () => {
  expect(
    nativeOwnedPostgresIsolated({
      pid: 4321,
      interfaceNames: ['lo'],
      ownNamespace: 'net:[1]',
      pid1Namespace: 'net:[1]',
    }),
  ).toBe(true);
});

test('an unreadable PID 1 netns is isolation even when other interfaces exist', () => {
  expect(
    nativeOwnedPostgresIsolated({
      pid: 99,
      interfaceNames: ['lo', 'eth0'],
      ownNamespace: 'net:[2]',
    }),
  ).toBe(true);
});

test('the shared host netns keeps the published PostgreSQL port', () => {
  expect(
    nativeOwnedPostgresIsolated({
      pid: 7,
      interfaceNames: ['lo', 'eth0'],
      ownNamespace: 'net:[3]',
      pid1Namespace: 'net:[3]',
    }),
  ).toBe(false);
});

test('an isolated socket URL uses the host directory instead of a TCP port', () => {
  expect(isolatedOwnedPostgresUrl('/tmp/native-owned-pg-socket')).toBe(
    'postgres://rezics:rezics@localhost/rezics?host=/tmp/native-owned-pg-socket&sslmode=disable',
  );
});

test('/proc/net/dev interface names include loopback', () => {
  expect(networkInterfaceNames()).toContain('lo');
});

test('a private-network process is isolated from published PostgreSQL host ports', () => {
  const names = networkInterfaceNames();
  if (names.length > 0 && names.every((name) => name === 'lo')) expect(ownedPostgresIsolated()).toBe(true);
});
