import { expect, test } from 'bun:test';
import {
  isolatedNetworkNamespacePath,
  nativeOwnedPostgresIsolation,
  networkInterfaceNames,
} from './native/owned-postgres.ts';

test('a loopback-only netns joins PostgreSQL on that namespace instead of a published host port', () => {
  expect(
    nativeOwnedPostgresIsolation({
      pid: 4321,
      interfaceNames: ['lo'],
      ownNamespace: 'net:[1]',
      pid1Namespace: 'net:[1]',
    }),
  ).toBe('/proc/4321/ns/net');
});

test('an unreadable PID 1 netns is isolation even when other interfaces exist', () => {
  expect(
    nativeOwnedPostgresIsolation({
      pid: 99,
      interfaceNames: ['lo', 'eth0'],
      ownNamespace: 'net:[2]',
    }),
  ).toBe('/proc/99/ns/net');
});

test('the shared host netns keeps the published PostgreSQL port', () => {
  expect(
    nativeOwnedPostgresIsolation({
      pid: 7,
      interfaceNames: ['lo', 'eth0'],
      ownNamespace: 'net:[3]',
      pid1Namespace: 'net:[3]',
    }),
  ).toBeUndefined();
});

test('/proc/net/dev interface names include loopback', () => {
  expect(networkInterfaceNames()).toContain('lo');
});

test('a private-network process joins its own netns instead of publishing a host port', () => {
  const names = networkInterfaceNames();
  if (names.length > 0 && names.every((name) => name === 'lo'))
    expect(isolatedNetworkNamespacePath()).toBe(`/proc/${process.pid}/ns/net`);
});
