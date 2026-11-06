import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isolatedOwnedPostgresUrl,
  isolatedReyloPostgresUrl,
  listenOwnedPostgresSocketProxy,
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

test('Reylo analysis on an isolated socket uses loopback TCP instead of libpq host', () => {
  expect(isolatedReyloPostgresUrl(54329, 'native_web_analysis_abc')).toBe(
    'postgres://rezics:rezics@127.0.0.1:54329/native_web_analysis_abc?sslmode=disable',
  );
  expect(() => isolatedReyloPostgresUrl(0, 'native_web_analysis_abc')).toThrow('TCP port');
  expect(() => isolatedReyloPostgresUrl(54329, 'native-web;drop')).toThrow('Unsafe analysis database name');
});

test('a loopback proxy reaches a unix-socket PostgreSQL listener', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-pg-proxy-'));
  const received: Buffer[] = [];
  const listener = createServer((socket) => {
    socket.on('data', (chunk) => received.push(chunk));
    socket.write('from-socket');
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(join(directory, '.s.PGSQL.5432'), () => {
      listener.off('error', reject);
      resolve();
    });
  });
  try {
    const proxy = await listenOwnedPostgresSocketProxy(directory);
    try {
      const client = connect({ port: proxy.port, host: '127.0.0.1' });
      const reply = await new Promise<string>((resolve, reject) => {
        client.once('error', reject);
        client.once('data', (chunk) => resolve(chunk.toString()));
        client.write('from-tcp');
      });
      expect(reply).toBe('from-socket');
      expect(Buffer.concat(received).toString()).toBe('from-tcp');
      client.end();
    } finally {
      await proxy.close();
    }
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('/proc/net/dev interface names include loopback', () => {
  expect(networkInterfaceNames()).toContain('lo');
});

test('a private-network process is isolated from published PostgreSQL host ports', () => {
  const names = networkInterfaceNames();
  if (names.length > 0 && names.every((name) => name === 'lo')) expect(ownedPostgresIsolated()).toBe(true);
});
